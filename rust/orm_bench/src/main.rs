//! NATIVE-codegen ORM-bench cell (#141 rust-native pilot, epic #123) — self-measure the covered ORM
//! ops through the litedbmodel-GENERATED post-#164 wire-passthrough modules + `litedbmodel_runtime`'s
//! op-agnostic leaves, and print a flat CSV (`cell,dialect,op,iter,us`) the TS collector aggregates.
//!
//! This binary is a litedbmodel-CONSUMER: for each op it calls the sole GENERATED public entry
//! `<method>(<positional params>)` with native arguments (no input box). It supplies NO `node_*`
//! and holds NO hand-written exec seam — the covered runner calls the op-agnostic leaf transports
//! (`execute_sql`/`pluck_keys`/`group_children`) in `litedbmodel_runtime`, which run every DB access
//! through the runtime's central execute/run seam over the AMBIENT execution context the consumer
//! brackets each op with (`with_ambient_context`). Relations are N+1-free: `parents → pluck →
//! executeSQL(WHERE fk IN …) → group` runs 1 batched child query per level (nestedFindAll=2,
//! nestedRelations=3).
//!
//! Usage: `orm_bench [reps] [warmup]`, or `orm_bench safety`. The TARGET DB is a BUILD-time choice
//! (`--features target_postgres` / `target_mysql`, default sqlite), never an argument — see gen/mod.rs.

#[path = "gen/mod.rs"]
mod gen;

use litedbmodel_runtime::{
    clear_middlewares, for_driver, register_middleware, with_ambient_context,
    with_ambient_transaction, Driver, ExecutionContext, MiddlewareDescriptor, SeamResult,
    SqlHookFn, SqliteDriver,
};
#[cfg(feature = "livedb")]
use litedbmodel_runtime::{MysqlDriver, PostgresDriver};
use orm_bench_common::{load_setup as load_setup_at, Setup};
#[cfg(feature = "livedb")]
use orm_bench_common::{mysql_url, postgres_conn};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use gen::active as bg;

// ── the ONE observation seam: statements AND rows ────────────────────────────────────────────────
// Both counters ride the runtime's SQL middleware seam — the SAME lens the go / python / php / ts cells
// use. Every statement the runtime issues funnels through `exec_context::execute`/`run` → the hook,
// including the tx runtime's OWN BEGIN/COMMIT/ROLLBACK, so a tx op is fully observed (BEGIN + body +
// COMMIT). A read's `SeamResult::Rows` hands the row list back (a write's `Run` summary carries none),
// so the same hook totals the rows the op moved — the report's per-row denominator (#170). The N+1
// proof: a batched relation runs 1 parent + 1 batched child per level = 2 / 3 (not 1+N).
//
// Observing at the seam and NOT by decorating the Driver is load-bearing (#238): a Driver decorator can
// only re-enter the runtime's own `prepare`, which on a POOLED live driver checks out a fresh connection
// per statement — BEGIN would land on a connection that is then returned to the pool still holding an
// open transaction. Connection ownership belongs to the driver (`MysqlDriver`/`PostgresDriver`
// `acquire_tx` pin one connection for the whole tx); the bench only observes.
static STMT_COUNT: AtomicUsize = AtomicUsize::new(0);
static ROW_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Run ONE op once, UN-TIMED, with the counting hook registered, and report its `(statements, rows)` —
/// the safety assertion's input and the report's per-row denominator, measured in one place. The hook is
/// unregistered on the way out, so the published latencies never pay to observe it. The caller seeds
/// first; the seed runs on the driver directly (off-seam) and is never counted.
fn probe(d: &dyn Driver, setup: &Setup, op: &str) -> (usize, usize) {
    clear_middlewares();
    register_middleware(MiddlewareDescriptor::sql_only(Box::new(SqlHookFn(
        |sql: &str,
         params: &[behavior_contracts::Value],
         next: &litedbmodel_runtime::middleware::SqlNext| {
            STMT_COUNT.fetch_add(1, Ordering::Relaxed);
            let out = next(sql, params)?;
            if let SeamResult::Rows(rows) = &out {
                ROW_COUNT.fetch_add(rows.len(), Ordering::Relaxed);
            }
            Ok(out)
        },
    ))));
    STMT_COUNT.store(0, Ordering::SeqCst);
    ROW_COUNT.store(0, Ordering::SeqCst);
    let ctx = for_driver(d);
    with_ambient_context(&ctx, || run_op(&ctx, setup, op, 0));
    let tally = (
        STMT_COUNT.load(Ordering::SeqCst),
        ROW_COUNT.load(Ordering::SeqCst),
    );
    clear_middlewares();
    tally
}

// The seed SSoT loader + connection targets are SHARED with the SDK cell (rust/orm_bench_common) —
// both used to carry a verbatim copy.
fn load_setup(dialect: &str) -> Setup {
    load_setup_at(dialect, env!("CARGO_MANIFEST_DIR"))
}

fn open_driver(dialect: &str, setup: &Setup) -> Box<dyn Driver> {
    match dialect {
        "sqlite" => {}
        #[cfg(feature = "livedb")]
        "postgres" => return open_live(PostgresDriver::connect(&postgres_conn()).expect("connect postgres"), setup),
        #[cfg(feature = "livedb")]
        "mysql" => return open_live(MysqlDriver::connect(&mysql_url()).expect("connect mysql"), setup),
        other => panic!(
            "orm_bench: unknown or unbuilt target {other:?} (sqlite|postgres|mysql; the live targets \
             need --features livedb)"
        ),
    }
    Box::new(SqliteDriver::in_memory(&setup.schema).expect("open in-memory sqlite"))
}

/// Apply this dialect's schema to a freshly connected live driver and hand it back boxed.
#[cfg(feature = "livedb")]
fn open_live<D: Driver + 'static>(d: D, setup: &Setup) -> Box<dyn Driver> {
    for s in &setup.schema {
        d.prepare(s)
            .run(&[])
            .unwrap_or_else(|e| panic!("schema `{s}`: {}", e.message));
    }
    Box::new(d)
}

// ── seed: DELETE + INSERT the canonical fixture (schema already applied at open) ────────────────────
// Re-run before each op so reads see a stable seed and writes start clean. Real nested data (users →
// posts → comments; tenant users → tenant posts) so the N+1 proof is meaningful (2/3 queries returning
// real children, not 1+N). Runs on the driver directly (not through the leaves) — no ambient needed.
fn seed(d: &dyn Driver, setup: &Setup) {
    for s in setup.delete.iter().chain(setup.insert.iter()) {
        d.prepare(s)
            .run(&[])
            .unwrap_or_else(|e| panic!("seed `{s}`: {}", e.message));
    }
}

// ── the covered ops. Each runs ONE logical op for iteration `it` (mutating ops vary their UNIQUE
//    column). Reads/single-writes/batches resolve the AMBIENT context (bracketed by the caller). The
//    RETURNING-chained TRANSACTIONS run through the runtime `with_ambient_transaction(ctx, …)` scope
//    (begin_tx → runner → COMMIT on Ok / ROLLBACK on Err) — the consumer's tx-boundary responsibility;
//    the generated runner emits NO BEGIN/COMMIT, so `ctx` is threaded here to open/close the tx. ──
fn run_op(ctx: &ExecutionContext, setup: &Setup, op: &str, it: u64) {
    let inp = setup.op_input(op, it);
    let text = |k: &str| {
        inp[k]
            .as_str()
            .unwrap_or_else(|| panic!("input {op}.{k} is not a string"))
            .to_string()
    };
    let int = |k: &str| {
        inp[k]
            .as_i64()
            .unwrap_or_else(|| panic!("input {op}.{k} is not a number"))
    };
    match op {
        "findAll" => {
            bg::findAll().unwrap();
        }
        "filterPaginateSort" => {
            // `published` is INTEGER (native port `int`); the generated parameter is `i64`.
            bg::filterPaginateSort(int("published")).unwrap();
        }
        "findFirst" => {
            bg::findFirst(text("name")).unwrap();
        }
        "findUnique" => {
            bg::findUnique(text("email")).unwrap();
        }
        "nestedFindAll" => {
            bg::nestedFindAll().unwrap();
        }
        "nestedFindFirst" => {
            bg::nestedFindFirst(text("name")).unwrap();
        }
        "nestedFindUnique" => {
            bg::nestedFindUnique(text("email")).unwrap();
        }
        "nestedRelations" => {
            bg::nestedRelations().unwrap();
        }
        "compositeRelations" => {
            bg::compositeRelations().unwrap();
        }
        "create" => {
            bg::create(text("email"), text("name")).unwrap();
        }
        "update" => {
            bg::update(int("id"), text("name")).unwrap();
        }
        "upsert" => {
            bg::upsert(text("email"), text("name")).unwrap();
        }
        "createMany" => {
            // 10 fresh rows — email is UNIQUE NOT NULL, so vary per iteration to stay insertable.
            bg::createMany(new_users(&inp)).unwrap();
        }
        "upsertMany" => {
            // 10 rows keyed on email (ON CONFLICT DO UPDATE) — idempotent across iterations.
            bg::upsertMany(new_users(&inp)).unwrap();
        }
        "updateMany" => {
            // 10 rows keyed on id (1..=10) — updates the seeded users, no-op for absent ids.
            bg::updateMany(user_patches(&inp)).unwrap();
        }
        // ── RETURNING-chained transactions (#142): each runs THROUGH the runtime tx scope. The runner
        //    executes its 2 body statements via `execute_sql`; `with_ambient_transaction` brackets them
        //    with BEGIN…COMMIT (ROLLBACK on any Err) — the atomicity guarantee. Measurement only here. ──
        "nestedCreate" => {
            // Fresh user per iteration (email is UNIQUE), then INSERT its post — INSERT user RETURNING id
            // → INSERT post (author_id = that id).
            with_ambient_transaction(ctx, || {
                bg::nestedCreate(text("email"), text("name"), text("title"))
            })
            .unwrap();
        }
        "nestedUpsert" => {
            // Existing email (ON CONFLICT DO UPDATE) → INSERT post keyed on the upserted user's id.
            with_ambient_transaction(ctx, || {
                bg::nestedUpsert(text("email"), text("name"), text("title"))
            })
            .unwrap();
        }
        "nestedUpdate" => {
            // UPDATE seeded user 1 RETURNING id → UPDATE that user's posts (author_id = 1 exists in seed).
            with_ambient_transaction(ctx, || {
                bg::nestedUpdate(int("id"), text("name"), text("title"))
            })
            .unwrap();
        }
        "delete" => {
            // Create-then-delete: INSERT a fresh user RETURNING id → DELETE the exact created row
            // (its RETURNING id + inserted email). Fresh email per iteration (UNIQUE).
            with_ambient_transaction(ctx, || bg::delete(text("email"), text("name"))).unwrap();
        }
        other => panic!("unknown op '{other}'"),
    }
}

/// `new_users` / `user_patches` map the DECLARED batch records (.setup/<dialect>.json `inputs`, from the
/// axis SSoT) onto the record types the generated signatures take — the only thing this harness
/// contributes. bc boxes them to the json_each/JSON_TABLE/UNNEST batch param at the leaf boundary.
fn new_users(inp: &serde_json::Value) -> Vec<bg::NewUser> {
    records(inp)
        .iter()
        .map(|r| bg::NewUser {
            email: r["email"].as_str().expect("record.email").to_string(),
            name: r["name"].as_str().expect("record.name").to_string(),
        })
        .collect()
}

fn user_patches(inp: &serde_json::Value) -> Vec<bg::UserPatch> {
    records(inp)
        .iter()
        .map(|r| bg::UserPatch {
            id: r["id"].as_i64().expect("record.id"),
            name: r["name"].as_str().expect("record.name").to_string(),
        })
        .collect()
}

fn records(inp: &serde_json::Value) -> &Vec<serde_json::Value> {
    inp["rows"].as_array().expect("`rows` is a record array")
}

// The covered ops exposed on the combined struct-native path (bg::COMPONENT_NAMES_NATIVE_RAW).
const OPS: &[&str] = &[
    "findAll",
    "filterPaginateSort",
    "findFirst",
    "findUnique",
    "nestedFindAll",
    "nestedFindFirst",
    "nestedFindUnique",
    "nestedRelations",
    "compositeRelations",
    "create",
    "update",
    "upsert",
    "createMany",
    "upsertMany",
    "updateMany",
    "nestedCreate",
    "nestedUpsert",
    "nestedUpdate",
    "delete",
];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("safety") {
        run_safety();
        return;
    }
    let reps: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(300);
    let warmup: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(30);

    // The dialect is NOT an argument: the generated module is chosen at COMPILE time by the cargo
    // feature, so a runtime knob beside it could only ever disagree with the SQL that is already baked
    // in. `gen::TARGET` is that one source — it names the module, the DB to open and the CSV label.
    let dialect = gen::TARGET;
    let setup = load_setup(dialect);
    let driver = open_driver(dialect, &setup);
    let d: &dyn Driver = driver.as_ref();
    println!("cell,dialect,op,iter,us,rows");
    for op in OPS {
        // Re-seed the fixture before each op, then run the whole warmup+timed loop with the ambient
        // driver installed (the covered runner resolves it inside `execute_sql`).
        seed(d, &setup);
        // One UN-TIMED probe measures the rows this op moves — the report's per-row denominator (#170).
        let (_stmts, rows) = probe(d, &setup, op);
        let ctx = for_driver(d);
        with_ambient_context(&ctx, || {
            for it in 0..warmup {
                run_op(&ctx, &setup, op, it + 1);
            }
            for it in 0..reps {
                // Unique iteration id: the probe took 0, so warmup/timed start at 1.
                let g = it + warmup + 1;
                let t = Instant::now();
                run_op(&ctx, &setup, op, g);
                let us = t.elapsed().as_micros();
                println!("native,{dialect},{op},{it},{us},{rows}");
            }
        });
    }
}

// ── The safety + fairness proof: EVERY op's statement count AND the rows it moves. ────────────────
// Both come from the ONE `probe` pass over the runtime SQL seam (which sees the tx-control BEGIN/COMMIT
// too). Covering all 19 ops — not just the guarded ones — is what lets this cell's row yield be compared
// against every other language's, the fairness check #170 had no surface for.
fn run_safety() {
    let dialect = gen::TARGET;
    let setup = load_setup(dialect);
    let driver = open_driver(dialect, &setup);
    let d: &dyn Driver = driver.as_ref();
    // The guarded expectations: a relation op is 1 parent + 1 batched child PER LEVEL (N+1-free,
    // independent of the row count); a batch write is ONE statement for N records (the whole record set
    // rides as one param); a RETURNING-chained tx is BEGIN + 2 body + COMMIT = 4.
    let expected: &[(&str, usize)] = &[
        ("nestedFindAll", 2),
        ("nestedFindFirst", 2),
        ("nestedFindUnique", 2),
        ("nestedRelations", 3),
        ("compositeRelations", 3),
        ("createMany", 1),
        ("upsertMany", 1),
        ("updateMany", 1),
        ("nestedCreate", 4),
        ("nestedUpsert", 4),
        ("nestedUpdate", 4),
        ("delete", 4),
    ];
    println!("op                    statements  rows");
    for op in OPS {
        seed(d, &setup); // clean fixture per op; off-seam, never counted
        let (stmts, rows) = probe(d, &setup, op);
        let want = expected
            .iter()
            .find(|(name, _)| name == op)
            .map(|(_, n)| *n);
        let mark = match want {
            Some(n) if n != stmts => {
                println!("{op:<20}  {stmts:<10}  {rows:<6} STATEMENT-COUNT MISMATCH (want {n})");
                panic!("{op} statement-count regression: got {stmts}, expect {n}");
            }
            _ => "ok",
        };
        // The ONE format every cell prints, so `run-cells.sh` can hold the ten cells to the same
        // statements and rows per op instead of ten human tables being eyeballed.
        println!("proof,native,{dialect},{op},{stmts},{rows}");
        println!("{op:<20}  {stmts:<10}  {rows:<6} {mark}");
    }
}
