//! SDK-baseline ORM-bench cell (#129) — the raw-driver comparison cell for the collector's `sdk` vs
//! native latency comparison. It runs the 19 ORM ops over the shared benchmark seed
//! (the ONE seed SSoT `benchmark/crosslang/.setup/<dialect>.json`, emitted from orm-domain.ts — the
//! SAME fixture the native twin loads), with the SAME CLI, CSV schema, op list/order, per-iteration
//! unique-key strategy, warmup/reps defaults, and re-seed-before-each-op behaviour — but it does NOT go
//! through litedbmodel: every op is hand-written SQL issued straight at the plain driver (rusqlite for
//! sqlite; the `postgres` / `mysql` crates behind `livedb`). The CSV cell label is `sdk`.
//!
//! Relations are N+1-avoided by hand: one parent read + one batched child read per level (batched via an
//! `IN (…)` over the collected parent keys), grouped in memory. Batch writes are a single multi-row
//! statement. The `safety` mode proves those query counts (2 / 2 / 3 / 3 / 1 / 1) via a per-statement
//! counter incremented in the one exec seam (`Db`).
//!
//! Usage: `orm_bench_sdk <dialect> [reps=300] [warmup=30]` or `orm_bench_sdk safety <dialect>`.
//! `<dialect>` is sqlite | postgres | mysql; postgres/mysql need `--features livedb` and take their
//! connection from the TEST_* environment (orm_bench_common), never from a second argv knob.

use orm_bench_common::{load_setup as load_setup_at, Setup};
#[cfg(feature = "livedb")]
use orm_bench_common::{mysql_url, postgres_conn};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use std::time::Instant;

// ── per-statement query counter (safety proof) — every prepared statement the crate issues bumps this
//    in the ONE exec seam below, so the N+1 proof is measured, not asserted. ─────────────────────────
static QUERY_COUNT: AtomicUsize = AtomicUsize::new(0);
// ── per-row counter (#170) — bumped in the SAME seam, once per read, by the rows that seam returned.
//    It is the report's per-row denominator AND the proof this hand-written baseline moved the SAME rows
//    the native cell did: a baseline that quietly fetched fewer would post a flattering ratio.
static ROW_COUNT: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Copy, PartialEq)]
enum Dialect {
    Sqlite,
    // Pg/Mysql are only constructed by the `livedb`-gated drivers; live there, not dead.
    #[cfg_attr(not(feature = "livedb"), allow(dead_code))]
    Pg,
    #[cfg_attr(not(feature = "livedb"), allow(dead_code))]
    Mysql,
}

/// A bind parameter, dialect-agnostic; each driver lowers it to its own param type in the exec seam.
///
/// The three composite variants below are PostgreSQL-only: `pg_params` is the sole reader of their
/// payloads, and it is `livedb`-gated, so a SQLite-only build has no code that can read them. Each is
/// scoped with `cfg_attr(not(livedb))` — the same form `Dialect::Pg`/`Mysql` use above — rather than a
/// blanket allow on the enum, so a payload that goes genuinely unread still warns in the `livedb` build.
#[derive(Clone)]
enum P {
    I(i64),
    S(String),
    /// An ARRAY param the statement casts (`?::int[]` / `?::text[]`) — PostgreSQL's single-key relation
    /// predicate and its batch `UNNEST` form. rust's `postgres` crate maps types strictly, so this must be
    /// bound as a real array rather than as the array literal PDO / psycopg get away with sending as text.
    /// The other two drivers never see it: their statements take a JSON param instead.
    #[cfg_attr(not(feature = "livedb"), allow(dead_code))]
    Ints(Vec<i64>),
    #[cfg_attr(not(feature = "livedb"), allow(dead_code))]
    Strs(Vec<String>),
    /// A JSON param the statement casts (`?::json`) — PostgreSQL's composite-key relation predicate reads
    /// the key tuples with `json_array_elements`. Bound as a real JSON value for the same strict-typing
    /// reason as the array variants. MySQL/SQLite carry the identical JSON text in a plain string param.
    #[cfg_attr(not(feature = "livedb"), allow(dead_code))]
    Json(String),
}

/// A decoded result cell. Reads materialise every selected column (fair vs the native cell, which
/// decodes into typed structs) — the non-key payloads (`F`/`S`/`B`) are intentionally decoded-then-held
/// to pay the real allocation/parse cost even though only `id`/key columns (`I`) are read downstream for
/// batching, so `dead_code` on those payloads is expected.
#[allow(dead_code)]
enum Cell {
    I(i64),
    F(f64),
    S(String),
    B(bool),
    Null,
}
fn cell_i64(c: &Cell) -> i64 {
    match c {
        Cell::I(n) => *n,
        _ => 0,
    }
}

// ── the ONE exec seam. All DB access in this crate rides these three methods, so the query counter and
//    the per-driver param/decode lowering each live in exactly one place per driver. ─────────────────
trait Db {
    fn dialect(&self) -> Dialect;
    /// The ONE counted read seam: every SELECT rides it, so the statement and row counters each live in
    /// exactly one place. A driver supplies only its own fetch ([`Db::fetch`]).
    fn query(&mut self, sql: &str, params: &[P]) -> Vec<Vec<Cell>> {
        QUERY_COUNT.fetch_add(1, Ordering::Relaxed);
        let out = self.fetch(sql, params);
        ROW_COUNT.fetch_add(out.len(), Ordering::Relaxed);
        out
    }
    fn fetch(&mut self, sql: &str, params: &[P]) -> Vec<Vec<Cell>>;
    fn exec(&mut self, sql: &str, params: &[P]);

    /// A write that hands back the id of the row it wrote — the ` RETURNING id` the authored native module
    /// declares for every id-chaining write (`benchmark/crosslang/native-model.ts`). The baseline issues the
    /// SAME statement and reads the SAME row back, so the two surfaces do equal work.
    ///
    /// MySQL has no RETURNING: the runtime's mysql adapter strips the clause and recovers the written rows
    /// with a keyed SELECT on the same connection (`src/scp/makesql/mysql-returning.ts`). `recover` is that
    /// same recovery, and it belongs to the SAME logical statement — the runtime's seam counts a MySQL
    /// RETURNING write as one (its recovery runs below the seam) while counting the row it recovers — so the
    /// rows are tallied and the statement count is not bumped a second time.
    fn write_returning_id(
        &mut self,
        sql: &str,
        params: &[P],
        recover: &str,
        recover_params: &[P],
    ) -> i64 {
        if self.dialect() != Dialect::Mysql {
            let rows = self.query(sql, params);
            return cell_i64(&rows[0][0]);
        }
        // MySQL cannot parse RETURNING: strip the clause (and the /*scp:pk=…*/ hint naming the key) exactly
        // as the runtime's mysql adapter does, then recover the written row with the keyed SELECT.
        let stripped = match sql.to_uppercase().rfind(" RETURNING ") {
            Some(at) => sql[..at].to_string(),
            None => sql.to_string(),
        };
        self.exec(&stripped, params);
        let rows = self.recover_rows(recover, recover_params);
        cell_i64(&rows[0][0])
    }

    /// Fetch belonging to the logical statement just issued: rows tallied, statement count not bumped.
    fn recover_rows(&mut self, sql: &str, params: &[P]) -> Vec<Vec<Cell>> {
        let out = self.fetch(sql, params);
        ROW_COUNT.fetch_add(out.len(), Ordering::Relaxed);
        out
    }
}

// ── sqlite (rusqlite) ───────────────────────────────────────────────────────────────────────────────
struct SqliteDb {
    conn: rusqlite::Connection,
}
fn sqlite_value(p: &P) -> rusqlite::types::Value {
    use rusqlite::types::Value;
    match p {
        P::I(n) => Value::Integer(*n),
        P::S(s) => Value::Text(s.clone()),
        // sqlite/mysql statements bind a key set as ONE JSON *string* param, never as a pg array/json —
        // unreachable.
        P::Ints(_) | P::Strs(_) | P::Json(_) => unreachable!("sqlite takes no array/json param"),
    }
}
impl Db for SqliteDb {
    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }
    fn fetch(&mut self, sql: &str, params: &[P]) -> Vec<Vec<Cell>> {
        // prepare_cached reuses the compiled statement across iterations (rusqlite's built-in per-conn
        // statement cache) — the fair "competent raw-driver user" baseline, matching native's prepared
        // cache. re-preparing per call was the strawman asymmetry.
        let mut stmt = self.conn.prepare_cached(sql).expect("prepare");
        let ncols = stmt.column_count();
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(params.iter().map(sqlite_value)),
                |row| {
                    Ok((0..ncols)
                        .map(|i| match row.get_ref(i).unwrap() {
                            rusqlite::types::ValueRef::Null => Cell::Null,
                            rusqlite::types::ValueRef::Integer(n) => Cell::I(n),
                            rusqlite::types::ValueRef::Real(f) => Cell::F(f),
                            rusqlite::types::ValueRef::Text(t) => {
                                Cell::S(String::from_utf8_lossy(t).into_owned())
                            }
                            rusqlite::types::ValueRef::Blob(_) => Cell::Null,
                        })
                        .collect::<Vec<Cell>>())
                },
            )
            .expect("query");
        rows.map(|r| r.unwrap()).collect()
    }
    fn exec(&mut self, sql: &str, params: &[P]) {
        QUERY_COUNT.fetch_add(1, Ordering::Relaxed);
        if params.is_empty() {
            self.conn
                .execute_batch(sql)
                .unwrap_or_else(|e| panic!("exec `{sql}`: {e}"));
        } else {
            self.conn
                .prepare_cached(sql)
                .expect("prepare")
                .execute(rusqlite::params_from_iter(params.iter().map(sqlite_value)))
                .unwrap_or_else(|e| panic!("exec `{sql}`: {e}"));
        }
    }
}

// ── postgres ─────────────────────────────────────────────────────────────────────────────────────────
#[cfg(feature = "livedb")]
struct PgDb {
    client: postgres::Client,
    // Per-SQL prepared-statement cache (postgres::Statement is a cheap Arc-backed handle) — reused across
    // iterations so the SDK, like native's prepare_cached, parses each SQL once. Keyed by SQL text.
    stmts: std::collections::HashMap<String, postgres::Statement>,
}
/// `?` → `$N`, quote-aware, left to right — the driver rendering PostgreSQL needs. The captured statement
/// carries the canonical `?` (the runtime applies this same rewrite as its final one-pass over the fixed
/// SQL; it cannot happen earlier, since a SKIP fragment changes the shape and so the numbering). A `?`
/// inside a string literal is left alone.
#[cfg(feature = "livedb")]
fn to_dollar_placeholders(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len() + 8);
    let mut in_string = false;
    let mut n = 0;
    for ch in sql.chars() {
        match ch {
            '\'' => {
                in_string = !in_string;
                out.push(ch);
            }
            '?' if !in_string => {
                n += 1;
                out.push('$');
                out.push_str(&n.to_string());
            }
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(feature = "livedb")]
impl PgDb {
    fn prep(&mut self, sql: &str) -> postgres::Statement {
        if let Some(s) = self.stmts.get(sql) {
            return s.clone();
        }
        let rendered = to_dollar_placeholders(sql);
        let s = self
            .client
            .prepare(&rendered)
            .unwrap_or_else(|e| panic!("prepare `{rendered}`: {e}"));
        self.stmts.insert(sql.to_string(), s.clone());
        s
    }
}
/// An integer bind that fits whatever width the target column declares. rust-postgres matches a
/// parameter's Rust type against the column's OID exactly — `i32` is int4 ONLY — so binding an `i32`
/// against the fixture's `published SMALLINT` failed with "error serializing parameter 0". The fixture
/// mixes widths (`published` int2, ids int4), and the seam does not know a column's width at bind
/// time, so the ONE integer encoder narrows per the type PostgreSQL asks for.
#[cfg(feature = "livedb")]
#[derive(Debug)]
struct PgInt(i64);

#[cfg(feature = "livedb")]
impl postgres::types::ToSql for PgInt {
    fn to_sql(
        &self,
        ty: &postgres::types::Type,
        out: &mut bytes::BytesMut,
    ) -> Result<postgres::types::IsNull, Box<dyn std::error::Error + Sync + Send>> {
        match *ty {
            postgres::types::Type::INT2 => (self.0 as i16).to_sql(ty, out),
            postgres::types::Type::INT4 => (self.0 as i32).to_sql(ty, out),
            _ => self.0.to_sql(ty, out),
        }
    }

    fn accepts(ty: &postgres::types::Type) -> bool {
        matches!(
            *ty,
            postgres::types::Type::INT2 | postgres::types::Type::INT4 | postgres::types::Type::INT8
        )
    }

    postgres::types::to_sql_checked!();
}

#[cfg(feature = "livedb")]
fn pg_params(params: &[P]) -> Vec<Box<dyn postgres::types::ToSql + Sync>> {
    params
        .iter()
        .map(|p| match p {
            P::I(n) => Box::new(PgInt(*n)) as Box<dyn postgres::types::ToSql + Sync>,
            P::S(s) => Box::new(s.clone()),
            P::Ints(v) => Box::new(v.iter().map(|n| *n as i32).collect::<Vec<i32>>()),
            P::Strs(v) => Box::new(v.clone()),
            P::Json(s) => {
                Box::new(serde_json::from_str::<serde_json::Value>(s).expect("key set is JSON"))
            }
        })
        .collect()
}
#[cfg(feature = "livedb")]
fn pg_decode(row: &postgres::Row) -> Vec<Cell> {
    row.columns()
        .iter()
        .enumerate()
        .map(|(i, col)| match col.type_().name() {
            "int2" => row
                .get::<_, Option<i16>>(i)
                .map(|v| Cell::I(v as i64))
                .unwrap_or(Cell::Null),
            "int4" => row
                .get::<_, Option<i32>>(i)
                .map(|v| Cell::I(v as i64))
                .unwrap_or(Cell::Null),
            "int8" => row
                .get::<_, Option<i64>>(i)
                .map(Cell::I)
                .unwrap_or(Cell::Null),
            "bool" => row
                .get::<_, Option<bool>>(i)
                .map(Cell::B)
                .unwrap_or(Cell::Null),
            "timestamp" | "timestamptz" => {
                // Pull + decode the value (wire cost is what matters); content is unused downstream.
                let _: Option<std::time::SystemTime> = row.get(i);
                Cell::Null
            }
            _ => row
                .get::<_, Option<String>>(i)
                .map(Cell::S)
                .unwrap_or(Cell::Null),
        })
        .collect()
}
#[cfg(feature = "livedb")]
impl Db for PgDb {
    fn dialect(&self) -> Dialect {
        Dialect::Pg
    }
    fn fetch(&mut self, sql: &str, params: &[P]) -> Vec<Vec<Cell>> {
        let boxed = pg_params(params);
        let refs: Vec<&(dyn postgres::types::ToSql + Sync)> =
            boxed.iter().map(|b| b.as_ref()).collect();
        let stmt = self.prep(sql);
        self.client
            .query(&stmt, &refs)
            .unwrap_or_else(|e| panic!("query `{sql}`: {e}"))
            .iter()
            .map(pg_decode)
            .collect()
    }
    fn exec(&mut self, sql: &str, params: &[P]) {
        QUERY_COUNT.fetch_add(1, Ordering::Relaxed);
        if params.is_empty() {
            // BEGIN/COMMIT + param-free seed statements: run outside the extended protocol.
            self.client
                .batch_execute(sql)
                .unwrap_or_else(|e| panic!("exec `{sql}`: {e}"));
        } else {
            let boxed = pg_params(params);
            let refs: Vec<&(dyn postgres::types::ToSql + Sync)> =
                boxed.iter().map(|b| b.as_ref()).collect();
            let stmt = self.prep(sql);
            self.client
                .execute(&stmt, &refs)
                .unwrap_or_else(|e| panic!("exec `{sql}`: {e}"));
        }
    }
}

// ── mysql ────────────────────────────────────────────────────────────────────────────────────────────
#[cfg(feature = "livedb")]
fn my_params(params: &[P]) -> Vec<mysql::Value> {
    params
        .iter()
        .map(|p| match p {
            P::I(n) => mysql::Value::Int(*n),
            P::S(s) => mysql::Value::Bytes(s.clone().into_bytes()),
            P::Ints(_) | P::Strs(_) | P::Json(_) => unreachable!("mysql takes no array/json param"),
        })
        .collect()
}
#[cfg(feature = "livedb")]
fn my_decode(row: mysql::Row) -> Vec<Cell> {
    row.unwrap()
        .into_iter()
        .map(|v| match v {
            mysql::Value::NULL => Cell::Null,
            mysql::Value::Int(n) => Cell::I(n),
            mysql::Value::UInt(n) => Cell::I(n as i64),
            mysql::Value::Float(f) => Cell::F(f as f64),
            mysql::Value::Double(f) => Cell::F(f),
            mysql::Value::Bytes(b) => Cell::S(String::from_utf8_lossy(&b).into_owned()),
            _ => Cell::Null,
        })
        .collect()
}
#[cfg(feature = "livedb")]
struct MyDb {
    conn: mysql::Conn,
}
#[cfg(feature = "livedb")]
impl Db for MyDb {
    fn dialect(&self) -> Dialect {
        Dialect::Mysql
    }
    fn fetch(&mut self, sql: &str, params: &[P]) -> Vec<Vec<Cell>> {
        use mysql::prelude::Queryable;
        let rows: Vec<mysql::Row> = self
            .conn
            .exec(sql, my_params(params))
            .unwrap_or_else(|e| panic!("query `{sql}`: {e}"));
        rows.into_iter().map(my_decode).collect()
    }
    fn exec(&mut self, sql: &str, params: &[P]) {
        use mysql::prelude::Queryable;
        QUERY_COUNT.fetch_add(1, Ordering::Relaxed);
        if params.is_empty() {
            self.conn
                .query_drop(sql)
                .unwrap_or_else(|e| panic!("exec `{sql}`: {e}"));
        } else {
            self.conn
                .exec_drop(sql, my_params(params))
                .unwrap_or_else(|e| panic!("exec `{sql}`: {e}"));
        }
    }
}

fn load_setup(dialect: &str) -> Setup {
    load_setup_at(dialect, env!("CARGO_MANIFEST_DIR"))
}

#[cfg(feature = "livedb")]
fn open_pg() -> Box<dyn Db> {
    Box::new(PgDb {
        client: postgres::Client::connect(&postgres_conn(), postgres::NoTls)
            .expect("connect postgres"),
        stmts: std::collections::HashMap::new(),
    })
}

#[cfg(feature = "livedb")]
fn open_mysql() -> Box<dyn Db> {
    let opts = mysql::Opts::from_url(&mysql_url()).expect("parse mysql url");
    Box::new(MyDb {
        conn: mysql::Conn::new(opts).expect("connect mysql"),
    })
}

fn open_db(dialect: &str) -> Box<dyn Db> {
    match dialect {
        "sqlite" => {}
        #[cfg(feature = "livedb")]
        "postgres" => return open_pg(),
        #[cfg(feature = "livedb")]
        "mysql" => return open_mysql(),
        other => panic!(
            "orm_bench_sdk: unknown or unbuilt target {other:?} (sqlite|postgres|mysql; the live \
             targets need --features livedb)"
        ),
    }
    // sqlite: an in-memory DB. A FILE-backed sqlite would make the baseline pay fsync/WAL the
    // native in-memory cell never pays, over-crediting native on writes.
    Box::new(SqliteDb {
        conn: rusqlite::Connection::open_in_memory().expect("open sqlite"),
    })
}

fn apply_schema(db: &mut dyn Db, setup: &Setup) {
    for sql in &setup.schema {
        db.exec(sql, &[]);
    }
}
fn reseed(db: &mut dyn Db, setup: &Setup) {
    for sql in setup.delete.iter().chain(setup.insert.iter()) {
        db.exec(sql, &[]);
    }
}

// ── batch-write inputs (mirror ops.ts / the native cell) ──────────────────────────────────────────────
/// The stable 10-record email set `upsertMany` conflicts on — the SAME records the native cell upserts.
fn batch_emails_stable() -> Vec<String> {
    (0..10).map(|k| format!("many{k}@bench.com")).collect()
}

fn batch_emails(it: u64) -> Vec<String> {
    (0..10).map(|k| format!("many{it}_{k}@bench.com")).collect()
}
fn batch_names() -> Vec<String> {
    (0..10).map(|k| format!("Many {k}")).collect()
}

// ── upsert bodies differ only in the conflict clause; the column list + VALUES are shared. ───────────
/// One relation level's key set as the ONE param the captured SQL expects. The generated module binds a
/// batched child read's key set as a single JSON array (`json_each(?)` / `JSON_TABLE(?)` /
/// `UNNEST(?::t[])`), never as N placeholders — so the baseline binds it the same way, or it is running
/// different SQL. A composite key is an array of tuples, a single key an array of scalars.
/// The 10-row batch record set as (email, name) pairs — the same records the native cell passes.
fn user_records(it: u64, stable: bool) -> Vec<(String, String)> {
    let emails = if stable {
        batch_emails_stable()
    } else {
        batch_emails(it)
    };
    let names = batch_names();
    (0..10)
        .map(|k| (emails[k].clone(), names[k].clone()))
        .collect()
}

/// The id-keyed 10-row batch set `updateMany` binds.
fn patch_records() -> Vec<(String, String)> {
    let names = batch_names();
    (0..10)
        .map(|k| ((k + 1).to_string(), names[k].clone()))
        .collect()
}

/// True when the statement casts its param to a PostgreSQL array (`::int[]` / `::text[]`).
fn is_pg_array_cast(sql: &str) -> bool {
    sql.split("::").skip(1).any(|tail| {
        let ident: String = tail
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        !ident.is_empty() && tail[ident.len()..].starts_with("[]")
    })
}

/// One relation level's key set as the ONE param the captured statement expects. The generated module
/// binds a batched child read's key set as a single param, never as N placeholders — so the baseline binds
/// it the same way, or it is running different SQL.
///
/// The statement says which encoding it wants: an ARRAY cast (`?::int[]`, PostgreSQL's single-key
/// predicate) takes a PostgreSQL array literal; a `::json` cast and MySQL/SQLite's json_each / JSON_TABLE
/// take JSON. Reading it off the SQL keeps the encoding tied to the statement.
fn key_param(sql: &str, tuples: &[Vec<i64>]) -> P {
    if is_pg_array_cast(sql) {
        return P::Ints(tuples.iter().map(|t| t[0]).collect());
    }
    let json = json_key_set(tuples);
    if sql.contains("::json") {
        return P::Json(json);
    }
    P::S(json)
}

/// The key set as JSON: an array of scalars for a single key, an array of tuples for a composite one.
fn json_key_set(tuples: &[Vec<i64>]) -> String {
    let body: Vec<String> = tuples
        .iter()
        .map(|t| {
            if t.len() == 1 {
                t[0].to_string()
            } else {
                format!(
                    "[{}]",
                    t.iter()
                        .map(|v| v.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                )
            }
        })
        .collect();
    format!("[{}]", body.join(","))
}

/// A batch write's record set as the param(s) the captured statement expects: ONE JSON array on
/// MySQL/SQLite, one array PER COLUMN on PostgreSQL (its `UNNEST` form takes column arrays). The payload
/// repeats once per `?` — updateMany's SET subquery and its WHERE each read it.
fn batch_params(dialect: Dialect, sql: &str, records: &[(String, String)], keyed: bool) -> Vec<P> {
    let one: Vec<P> = if dialect == Dialect::Pg {
        // `UNNEST(?::int[], ?::text[])` — one array PER COLUMN, bound as a real array (the `postgres` crate
        // maps types strictly). A keyed batch's first column is the id.
        let first = if keyed {
            P::Ints(
                records
                    .iter()
                    .map(|(a, _)| a.parse().expect("id"))
                    .collect(),
            )
        } else {
            P::Strs(records.iter().map(|(a, _)| a.clone()).collect())
        };
        vec![
            first,
            P::Strs(records.iter().map(|(_, b)| b.clone()).collect()),
        ]
    } else {
        // MySQL/SQLite take the whole record set as ONE JSON array param.
        let key = if keyed { "id" } else { "email" };
        let quote = |v: &str| format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""));
        let objs: Vec<String> = records
            .iter()
            .map(|(a, b)| {
                let first = if keyed { a.clone() } else { quote(a) };
                format!("{{\"{key}\":{first},\"name\":{}}}", quote(b))
            })
            .collect();
        vec![P::S(format!("[{}]", objs.join(",")))]
    };
    let reps = (sql.matches('?').count() / one.len()).max(1);
    (0..reps).flat_map(|_| one.clone()).collect()
}

/// The keyed SELECTs the runtime's MySQL adapter recovers a RETURNING write's rows with
/// (src/scp/makesql/mysql-returning.ts): the conflict key for an upsert, the AUTO_INCREMENT range for an
/// insert, the write's own WHERE for an update. Only MySQL runs them — the others have RETURNING.
const RECOVER_BY_EMAIL: &str = "SELECT id FROM benchmark_users WHERE email = ?";
const RECOVER_BY_LAST_INSERT_ID: &str =
    "SELECT id FROM benchmark_users WHERE id = LAST_INSERT_ID()";
const RECOVER_BY_ID: &str = "SELECT id FROM benchmark_users WHERE id = ?";

// ── the 19 ORM ops (contract.ts order). Each runs ONE logical op for iteration `it`; mutating ops vary
//    their UNIQUE column by `it`. Fixed inputs mirror ops.ts (the SCP SSoT). ──────────────────────────
/// Run ONE op, issuing the statements the GENERATED module issues for this dialect (`sql` =
/// `setup.ops[op]`, captured at the runtime seam). The baseline hand-writes no SQL: the report divides
/// native by sdk, which only isolates the runtime's cost if both send the DB the same statements. What
/// stays hand-written is what a raw-driver user writes: param binding, decode, grouping children into
/// parents, and the transaction bracket.
fn run_op(op: &str, it: u64, db: &mut dyn Db, sql: &[String]) {
    let dialect = db.dialect();
    match op {
        "findAll" => {
            let rows = decode_users(db.query(&sql[0], &[]));
            std::hint::black_box(&rows);
        }
        "filterPaginateSort" => {
            // `published` is an integer column on every dialect (sqlite INTEGER / mysql TINYINT(1) /
            // pg SMALLINT — see orm-domain.ts `ddl`), and the seed binds 1/0 everywhere.
            let rows = decode_posts_full(db.query(&sql[0], &[P::I(1)]));
            std::hint::black_box(&rows);
        }
        "findFirst" => {
            let rows = decode_users(db.query(&sql[0], &[P::S("User%".into())]));
            std::hint::black_box(&rows);
        }
        "findUnique" => {
            let rows = decode_users(db.query(&sql[0], &[P::S("user500@example.com".into())]));
            std::hint::black_box(&rows);
        }
        "nestedFindAll" => {
            let users = db.query(&sql[0], &[]);
            let roots = materialize_users_posts(db, users, &sql[1]);
            std::hint::black_box(&roots);
        }
        "nestedFindFirst" => {
            let users = db.query(&sql[0], &[P::S("User%".into())]);
            let roots = materialize_users_posts(db, users, &sql[1]);
            std::hint::black_box(&roots);
        }
        "nestedFindUnique" => {
            let users = db.query(&sql[0], &[P::S("user1@example.com".into())]);
            let roots = materialize_users_posts(db, users, &sql[1]);
            std::hint::black_box(&roots);
        }
        "nestedRelations" => {
            let users = db.query(&sql[0], &[]);
            let roots = materialize_users_posts_comments(db, users, &sql[1], &sql[2]);
            std::hint::black_box(&roots);
        }
        "compositeRelations" => {
            let roots = materialize_composite(db, sql);
            std::hint::black_box(&roots);
        }
        "create" => {
            db.exec(
                &sql[0],
                &[P::S(format!("new{it}@bench.com")), P::S("New".into())],
            );
        }
        "update" => {
            db.exec(&sql[0], &[P::S("Updated 1".into()), P::I(1)]);
        }
        "upsert" => {
            // The captured statement declares ` RETURNING id`, so the baseline reads the id back too.
            let _ = db.write_returning_id(
                &sql[0],
                &[
                    P::S("user1@example.com".into()),
                    P::S("Upserted One".into()),
                ],
                RECOVER_BY_EMAIL,
                &[P::S("user1@example.com".into())],
            );
        }
        "createMany" => {
            let recs = user_records(it, false);
            db.exec(&sql[0], &batch_params(dialect, &sql[0], &recs, false));
        }
        "upsertMany" => {
            // The SAME 10 records the native module upserts.
            let recs = user_records(it, true);
            db.exec(&sql[0], &batch_params(dialect, &sql[0], &recs, false));
        }
        "updateMany" => {
            let recs = patch_records();
            db.exec(&sql[0], &batch_params(dialect, &sql[0], &recs, true));
        }
        "nestedCreate" => {
            db.exec("BEGIN", &[]);
            let uid = db.write_returning_id(
                &sql[0],
                &[P::S(format!("nc{it}@bench.com")), P::S("NC".into())],
                RECOVER_BY_LAST_INSERT_ID,
                &[],
            );
            db.exec(&sql[1], &[P::I(uid), P::S("NC Post".into())]);
            db.exec("COMMIT", &[]);
        }
        "nestedUpsert" => {
            db.exec("BEGIN", &[]);
            let uid = db.write_returning_id(
                &sql[0],
                &[P::S("user1@example.com".into()), P::S("NUp".into())],
                RECOVER_BY_EMAIL,
                &[P::S("user1@example.com".into())],
            );
            db.exec(&sql[1], &[P::I(uid), P::S("NUp Post".into())]);
            db.exec("COMMIT", &[]);
        }
        "nestedUpdate" => {
            db.exec("BEGIN", &[]);
            // The generated runner chains the dependent UPDATE off the id the first UPDATE returned;
            // taking the id from the input instead would skip a statement's worth of work.
            let uid = db.write_returning_id(
                &sql[0],
                &[P::S("NU".into()), P::I(1)],
                RECOVER_BY_ID,
                &[P::I(1)],
            );
            db.exec(&sql[1], &[P::S("NU Post".into()), P::I(uid)]);
            db.exec("COMMIT", &[]);
        }
        "delete" => {
            db.exec("BEGIN", &[]);
            let uid = db.write_returning_id(
                &sql[0],
                &[P::S(format!("del{it}@bench.com")), P::S("Del".into())],
                RECOVER_BY_LAST_INSERT_ID,
                &[],
            );
            db.exec(&sql[1], &[P::I(uid)]);
            db.exec("COMMIT", &[]);
        }
        other => panic!("unknown op {other:?}"),
    }
}

// ── nested materialization (fair vs the native cell) ──────────────────────────────────────────────────
// The native ORM assembles a nested TYPED object graph: each parent record shallow-copied with its child
// list nested under the relation key (the runtime `group_children` builds it; the generated de-box holds
// it). The SDK mirrors that here — decode every selected column into a plain typed struct and ATTACH the
// grouped children into their parent BY MOVE (drain the group map into `parent.children`, no per-parent
// clone). The fully-assembled `Vec<Parent-with-children>` is what the op arm holds via `black_box(&roots)`.
//
// The struct payload fields (email/name/title/body) are decoded-then-held (the same de-box the native
// pays) but never read downstream — only the key columns drive the grouping — so `dead_code` is expected.
#[allow(dead_code)]
struct SdkUser {
    id: i64,
    email: Option<String>,
    name: Option<String>,
    posts: Vec<SdkPost>,
}
/// `filterPaginateSort`'s row — the FULL projection the native module declares as `PostFullRow`. A read is
/// only usable as data once its columns are in typed fields, so the baseline decodes into this exactly as
/// the native cell de-boxes into its own row type; stopping at the driver's generic `Vec<Cell>` would
/// compare a decode against no decode.
#[allow(dead_code)]
struct SdkPostFull {
    id: i64,
    title: Option<String>,
    content: Option<String>,
    published: i64,
    author_id: i64,
    created_at: Option<String>,
}

fn decode_posts_full(rows: Vec<Vec<Cell>>) -> Vec<SdkPostFull> {
    rows.into_iter()
        .map(|r| {
            let mut it = r.into_iter();
            SdkPostFull {
                id: take_i64(it.next().unwrap()),
                title: take_string(it.next().unwrap()),
                content: take_string(it.next().unwrap()),
                published: take_i64(it.next().unwrap()),
                author_id: take_i64(it.next().unwrap()),
                created_at: take_string(it.next().unwrap()),
            }
        })
        .collect()
}

#[allow(dead_code)]
struct SdkPost {
    id: i64,
    title: Option<String>,
    author_id: Option<i64>,
    comments: Vec<SdkComment>,
}
#[allow(dead_code)]
struct SdkComment {
    id: i64,
    body: Option<String>,
    post_id: Option<i64>,
}
#[allow(dead_code)]
struct SdkTenantUser {
    tenant_id: i64,
    user_id: i64,
    name: Option<String>,
    posts: Vec<SdkTenantPost>,
}
#[allow(dead_code)]
struct SdkTenantPost {
    tenant_id: i64,
    post_id: i64,
    user_id: i64,
    title: Option<String>,
    comments: Vec<SdkTenantComment>,
}
#[allow(dead_code)]
struct SdkTenantComment {
    tenant_id: i64,
    comment_id: i64,
    post_id: i64,
    body: Option<String>,
}

// De-box a single result Cell into a typed struct field (moving the payload out — no clone).
fn take_i64(c: Cell) -> i64 {
    match c {
        Cell::I(n) => n,
        _ => 0,
    }
}
fn take_opt_i64(c: Cell) -> Option<i64> {
    match c {
        Cell::I(n) => Some(n),
        _ => None,
    }
}
fn take_string(c: Cell) -> Option<String> {
    match c {
        Cell::S(s) => Some(s),
        _ => None,
    }
}

fn decode_users(rows: Vec<Vec<Cell>>) -> Vec<SdkUser> {
    rows.into_iter()
        .map(|r| {
            let mut it = r.into_iter();
            SdkUser {
                id: take_i64(it.next().unwrap()),
                email: take_string(it.next().unwrap()),
                name: take_string(it.next().unwrap()),
                posts: Vec::new(),
            }
        })
        .collect()
}
fn decode_posts(rows: Vec<Vec<Cell>>) -> Vec<SdkPost> {
    rows.into_iter()
        .map(|r| {
            let mut it = r.into_iter();
            SdkPost {
                id: take_i64(it.next().unwrap()),
                title: take_string(it.next().unwrap()),
                author_id: take_opt_i64(it.next().unwrap()),
                comments: Vec::new(),
            }
        })
        .collect()
}
fn decode_comments(rows: Vec<Vec<Cell>>) -> Vec<SdkComment> {
    rows.into_iter()
        .map(|r| {
            let mut it = r.into_iter();
            SdkComment {
                id: take_i64(it.next().unwrap()),
                body: take_string(it.next().unwrap()),
                post_id: take_opt_i64(it.next().unwrap()),
            }
        })
        .collect()
}

/// Read the batched child posts for `users`, decode them into typed `SdkPost` structs, and attach each
/// group into its parent user BY MOVE (2 queries total; the parent read already happened in the op arm).
fn materialize_users_posts(
    db: &mut dyn Db,
    users: Vec<Vec<Cell>>,
    child_sql: &str,
) -> Vec<SdkUser> {
    let mut users = decode_users(users);
    let ids: Vec<Vec<i64>> = users.iter().map(|u| vec![u.id]).collect();
    if ids.is_empty() {
        return users;
    }
    let posts = decode_posts(db.query(child_sql, &[key_param(child_sql, &ids)]));
    // group posts by author_id, then MOVE each group into its parent user.
    let mut by_author: HashMap<i64, Vec<SdkPost>> = HashMap::new();
    for p in posts {
        by_author
            .entry(p.author_id.unwrap_or(0))
            .or_default()
            .push(p);
    }
    for u in &mut users {
        u.posts = by_author.remove(&u.id).unwrap_or_default();
    }
    users
}

/// 3-level chain: read batched posts then batched comments, assemble the full nested typed graph
/// (comments MOVED into posts by post_id, posts MOVED into users by author_id). 3 queries total.
fn materialize_users_posts_comments(
    db: &mut dyn Db,
    users: Vec<Vec<Cell>>,
    post_sql: &str,
    comment_sql: &str,
) -> Vec<SdkUser> {
    let mut users = decode_users(users);
    let uids: Vec<Vec<i64>> = users.iter().map(|u| vec![u.id]).collect();
    if uids.is_empty() {
        return users;
    }
    let mut posts = decode_posts(db.query(post_sql, &[key_param(post_sql, &uids)]));
    let pids: Vec<Vec<i64>> = posts.iter().map(|p| vec![p.id]).collect();
    if !pids.is_empty() {
        let comments = decode_comments(db.query(comment_sql, &[key_param(comment_sql, &pids)]));
        let mut by_post: HashMap<i64, Vec<SdkComment>> = HashMap::new();
        for c in comments {
            by_post.entry(c.post_id.unwrap_or(0)).or_default().push(c);
        }
        for p in &mut posts {
            p.comments = by_post.remove(&p.id).unwrap_or_default();
        }
    }
    let mut by_author: HashMap<i64, Vec<SdkPost>> = HashMap::new();
    for p in posts {
        by_author
            .entry(p.author_id.unwrap_or(0))
            .or_default()
            .push(p);
    }
    for u in &mut users {
        u.posts = by_author.remove(&u.id).unwrap_or_default();
    }
    users
}

/// compositeRelations: tenant_users(tenant=1) → batched tenant_posts by (tenant_id,user_id) → batched
/// tenant_comments by (tenant_id,post_id). 3 queries; assembled into the nested typed graph keyed on the
/// FULL composite (tenant_id,*) tuple (comments MOVED into posts, posts MOVED into users).
fn materialize_composite(db: &mut dyn Db, sql: &[String]) -> Vec<SdkTenantUser> {
    let mut tusers: Vec<SdkTenantUser> = db
        .query(&sql[0], &[])
        .into_iter()
        .map(|r| {
            let mut it = r.into_iter();
            SdkTenantUser {
                tenant_id: take_i64(it.next().unwrap()),
                user_id: take_i64(it.next().unwrap()),
                name: take_string(it.next().unwrap()),
                posts: Vec::new(),
            }
        })
        .collect();
    if tusers.is_empty() {
        return tusers;
    }
    // batched posts by (tenant_id, user_id) — the key set as ONE param, as the generated module binds it
    let ukeys: Vec<Vec<i64>> = tusers
        .iter()
        .map(|u| vec![u.tenant_id, u.user_id])
        .collect();
    let mut tposts: Vec<SdkTenantPost> = db
        .query(&sql[1], &[key_param(&sql[1], &ukeys)])
        .into_iter()
        .map(|r| {
            let mut it = r.into_iter();
            SdkTenantPost {
                tenant_id: take_i64(it.next().unwrap()),
                post_id: take_i64(it.next().unwrap()),
                user_id: take_i64(it.next().unwrap()),
                title: take_string(it.next().unwrap()),
                comments: Vec::new(),
            }
        })
        .collect();
    if !tposts.is_empty() {
        // batched comments by (tenant_id, post_id)
        let pkeys: Vec<Vec<i64>> = tposts
            .iter()
            .map(|p| vec![p.tenant_id, p.post_id])
            .collect();
        let tcomments: Vec<SdkTenantComment> = db
            .query(&sql[2], &[key_param(&sql[2], &pkeys)])
            .into_iter()
            .map(|r| {
                let mut it = r.into_iter();
                SdkTenantComment {
                    tenant_id: take_i64(it.next().unwrap()),
                    comment_id: take_i64(it.next().unwrap()),
                    post_id: take_i64(it.next().unwrap()),
                    body: take_string(it.next().unwrap()),
                }
            })
            .collect();
        let mut by_post: HashMap<(i64, i64), Vec<SdkTenantComment>> = HashMap::new();
        for c in tcomments {
            by_post.entry((c.tenant_id, c.post_id)).or_default().push(c);
        }
        for p in &mut tposts {
            p.comments = by_post
                .remove(&(p.tenant_id, p.post_id))
                .unwrap_or_default();
        }
    }
    let mut by_user: HashMap<(i64, i64), Vec<SdkTenantPost>> = HashMap::new();
    for p in tposts {
        by_user.entry((p.tenant_id, p.user_id)).or_default().push(p);
    }
    for u in &mut tusers {
        u.posts = by_user
            .remove(&(u.tenant_id, u.user_id))
            .unwrap_or_default();
    }
    tusers
}

const OPS: &[&str] = &[
    "findAll",
    "filterPaginateSort",
    "findFirst",
    "findUnique",
    "nestedFindAll",
    "nestedFindFirst",
    "nestedFindUnique",
    "create",
    "nestedCreate",
    "update",
    "nestedUpdate",
    "upsert",
    "nestedUpsert",
    "delete",
    "createMany",
    "upsertMany",
    "updateMany",
    "nestedRelations",
    "compositeRelations",
];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("safety") {
        let dialect = args.get(2).expect("safety <dialect>").clone();
        run_safety(&dialect);
        return;
    }
    let dialect = args
        .get(1)
        .expect("usage: orm_bench_sdk <dialect> [reps] [warmup]")
        .clone();
    let reps: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(300);
    let warmup: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(30);

    let setup = load_setup(&dialect);
    let ops = setup.ops.clone();
    let mut db = open_db(&dialect);
    apply_schema(db.as_mut(), &setup);
    println!("cell,dialect,op,iter,us,rows");
    for op in OPS {
        // Re-seed before each op so reads see the seed state and writes start clean.
        reseed(db.as_mut(), &setup);
        // One UN-TIMED probe measures the rows this op moves — the per-row denominator (#170).
        ROW_COUNT.store(0, Ordering::SeqCst);
        run_op(op, 0, db.as_mut(), &ops[*op]);
        let rows = ROW_COUNT.load(Ordering::SeqCst);
        for it in 0..warmup {
            run_op(op, it + 1, db.as_mut(), &ops[*op]);
        }
        for it in 0..reps {
            // Unique iteration id: the probe took 0, so warmup/timed start at 1.
            let g = it + warmup + 1;
            let t = Instant::now();
            run_op(op, g, db.as_mut(), &ops[*op]);
            let us = t.elapsed().as_micros();
            println!("sdk,{dialect},{op},{it},{us},{rows}");
        }
    }
}

// ── The safety + fairness proof: EVERY op's statement count AND the rows it moves, both from the ONE
// exec seam. Covering all 19 ops (the earlier form printed 6 and asserted none of them) is what lets this
// baseline's row yield be compared against the native cell's — the check #170 had no surface for.
fn run_safety(dialect: &str) {
    let setup = load_setup(dialect);
    let ops = setup.ops.clone();
    let mut db = open_db(dialect);
    apply_schema(db.as_mut(), &setup);
    // A relation op is 1 parent + 1 batched child PER LEVEL (N+1-free, independent of the row count); a
    // batch write is ONE statement for 10 records.
    let expected: &[(&str, usize)] = &[
        ("nestedFindAll", 2),
        ("nestedFindFirst", 2),
        ("nestedFindUnique", 2),
        ("nestedRelations", 3),
        ("compositeRelations", 3),
        ("createMany", 1),
        ("upsertMany", 1),
        ("updateMany", 1),
    ];
    println!("op                    statements  rows");
    for op in OPS {
        reseed(db.as_mut(), &setup); // clean fixture per op
        QUERY_COUNT.store(0, Ordering::SeqCst);
        ROW_COUNT.store(0, Ordering::SeqCst);
        run_op(op, 0, db.as_mut(), &ops[*op]);
        let stmts = QUERY_COUNT.load(Ordering::SeqCst);
        let rows = ROW_COUNT.load(Ordering::SeqCst);
        if let Some((_, n)) = expected.iter().find(|(name, _)| name == op) {
            assert_eq!(stmts, *n, "{op} statement-count regression");
        }
        println!("{op:<20}  {stmts:<10}  {rows:<6} ok");
    }
}
