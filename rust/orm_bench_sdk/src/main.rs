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

use orm_bench_common::{load_setup as load_setup_at, mysql_url, postgres_conn, Setup};
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
enum P {
    I(i64),
    S(String),
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

/// Placeholder emitter: `?` for sqlite/mysql, `$1,$2,…` for postgres (positional per statement).
struct Ph {
    dialect: Dialect,
    n: usize,
}
impl Ph {
    fn new(d: Dialect) -> Self {
        Ph { dialect: d, n: 0 }
    }
    fn next(&mut self) -> String {
        self.n += 1;
        match self.dialect {
            Dialect::Pg => format!("${}", self.n),
            _ => "?".to_string(),
        }
    }
    /// `ph,ph,…` for a flat `IN (…)` list of `count` scalars.
    fn list(&mut self, count: usize) -> String {
        (0..count)
            .map(|_| self.next())
            .collect::<Vec<_>>()
            .join(",")
    }
    /// A row-tuple IN body over `rows` tuples of `cols` columns each, in the form each dialect accepts:
    /// pg/mysql `((?,?),(?,?),…)`, sqlite `(VALUES (?,?),(?,?),…)`.
    fn tuple_in(&mut self, rows: usize, cols: usize) -> String {
        let body = (0..rows)
            .map(|_| format!("({})", self.list(cols)))
            .collect::<Vec<_>>()
            .join(",");
        match self.dialect {
            Dialect::Sqlite => format!("(VALUES {body})"),
            _ => format!("({body})"),
        }
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
            let rows = self.query(&format!("{sql} RETURNING id"), params);
            return cell_i64(&rows[0][0]);
        }
        self.exec(sql, params);
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
#[cfg(feature = "livedb")]
impl PgDb {
    fn prep(&mut self, sql: &str) -> postgres::Statement {
        if let Some(s) = self.stmts.get(sql) {
            return s.clone();
        }
        let s = self
            .client
            .prepare(sql)
            .unwrap_or_else(|e| panic!("prepare `{sql}`: {e}"));
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
fn batch_emails(it: u64) -> Vec<String> {
    (0..10).map(|k| format!("many{it}_{k}@bench.com")).collect()
}
fn batch_names() -> Vec<String> {
    (0..10).map(|k| format!("Many {k}")).collect()
}

// ── upsert bodies differ only in the conflict clause; the column list + VALUES are shared. ───────────
fn upsert_conflict(dialect: Dialect) -> &'static str {
    match dialect {
        Dialect::Mysql => " ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name)",
        _ => " ON CONFLICT (email) DO UPDATE SET email = excluded.email, name = excluded.name",
    }
}

// ── the 19 ORM ops (contract.ts order). Each runs ONE logical op for iteration `it`; mutating ops vary
//    their UNIQUE column by `it`. Fixed inputs mirror ops.ts (the SCP SSoT). ──────────────────────────
fn run_op(op: &str, it: u64, db: &mut dyn Db) {
    let dialect = db.dialect();
    match op {
        "findAll" => {
            db.query(
                "SELECT id, email, name FROM benchmark_users ORDER BY id ASC LIMIT 100",
                &[],
            );
        }
        "filterPaginateSort" => {
            let mut ph = Ph::new(dialect);
            // `published` is an integer column on every dialect (sqlite INTEGER / mysql TINYINT(1) /
            // pg SMALLINT — see orm-domain.ts `ddl`), and the seed binds 1/0 everywhere. Binding a
            // pg `bool` here failed with "error serializing parameter 0".
            let published = P::I(1);
            let sql = format!(
                "SELECT id, title, content, published, author_id, created_at FROM benchmark_posts \
                 WHERE published = {} ORDER BY created_at DESC LIMIT 20 OFFSET 10",
                ph.next()
            );
            db.query(&sql, &[published]);
        }
        "findFirst" => {
            let mut ph = Ph::new(dialect);
            let sql = format!(
                "SELECT id, email, name FROM benchmark_users WHERE name LIKE {} LIMIT 1",
                ph.next()
            );
            db.query(&sql, &[P::S("User%".into())]);
        }
        "findUnique" => {
            let mut ph = Ph::new(dialect);
            let sql = format!(
                "SELECT id, email, name FROM benchmark_users WHERE email = {} LIMIT 1",
                ph.next()
            );
            db.query(&sql, &[P::S("user500@example.com".into())]);
        }
        // ── nested reads: primary + ONE batched child (2 queries), assembled into the SAME nested
        //    typed object graph the native cell returns (users each holding their Vec<Post>). ───────
        "nestedFindAll" => {
            let users = db.query(
                "SELECT id, email, name FROM benchmark_users ORDER BY id ASC LIMIT 100",
                &[],
            );
            let roots = materialize_users_posts(db, users);
            std::hint::black_box(&roots);
        }
        "nestedFindFirst" => {
            let mut ph = Ph::new(dialect);
            let sql = format!(
                "SELECT id, email, name FROM benchmark_users WHERE name LIKE {} LIMIT 1",
                ph.next()
            );
            let users = db.query(&sql, &[P::S("User%".into())]);
            let roots = materialize_users_posts(db, users);
            std::hint::black_box(&roots);
        }
        "nestedFindUnique" => {
            let mut ph = Ph::new(dialect);
            let sql = format!(
                "SELECT id, email, name FROM benchmark_users WHERE email = {} LIMIT 1",
                ph.next()
            );
            let users = db.query(&sql, &[P::S("user1@example.com".into())]);
            let roots = materialize_users_posts(db, users);
            std::hint::black_box(&roots);
        }
        // ── 3-level chain: users → posts → comments (3 queries), fully assembled (each user holds its
        //    Vec<Post>, each Post its Vec<Comment>). ──────────────────────────────────────────────────
        "nestedRelations" => {
            let users = db.query(
                "SELECT id, email, name FROM benchmark_users ORDER BY id ASC LIMIT 100",
                &[],
            );
            let roots = materialize_users_posts_comments(db, users);
            std::hint::black_box(&roots);
        }
        // ── composite 3-level: tenant_users → tenant_posts → tenant_comments (3 queries), assembled by
        //    the composite (tenant_id,*) key into the nested typed graph. ─────────────────────────────
        "compositeRelations" => {
            let roots = materialize_composite(db);
            std::hint::black_box(&roots);
        }
        "create" => {
            let mut ph = Ph::new(dialect);
            let sql = format!(
                "INSERT INTO benchmark_users (email, name) VALUES ({}, {})",
                ph.next(),
                ph.next()
            );
            db.exec(
                &sql,
                &[P::S(format!("new{it}@bench.com")), P::S("New".into())],
            );
        }
        "nestedCreate" => {
            db.exec("BEGIN", &[]);
            let uid = insert_user(db, format!("nc{it}@bench.com"), "NC");
            insert_post(db, uid, "NC Post");
            db.exec("COMMIT", &[]);
        }
        "update" => {
            let mut ph = Ph::new(dialect);
            let sql = format!(
                "UPDATE benchmark_users SET name = {} WHERE id = {}",
                ph.next(),
                ph.next()
            );
            db.exec(&sql, &[P::S("Updated 1".into()), P::I(1)]);
        }
        "nestedUpdate" => {
            db.exec("BEGIN", &[]);
            let mut ph = Ph::new(dialect);
            let s1 = format!(
                "UPDATE benchmark_users SET name = {} WHERE id = {}",
                ph.next(),
                ph.next()
            );
            let mut rph = Ph::new(dialect);
            let recover = format!("SELECT id FROM benchmark_users WHERE id = {}", rph.next());
            // The native module chains the dependent UPDATE off the id the first UPDATE returned; taking
            // the id from the input instead would skip a statement's worth of work.
            let uid = db.write_returning_id(
                &s1,
                &[P::S("NU".into()), P::I(1)],
                &recover, // recovered by the write's own WHERE
                &[P::I(1)],
            );
            let mut ph = Ph::new(dialect);
            let s2 = format!(
                "UPDATE benchmark_posts SET title = {} WHERE author_id = {}",
                ph.next(),
                ph.next()
            );
            db.exec(&s2, &[P::S("NU Post".into()), P::I(uid)]);
            db.exec("COMMIT", &[]);
        }
        "upsert" => {
            // The native module declares ` RETURNING id` here, so the baseline reads the id back too.
            let _ = upsert_user(db, "user1@example.com", "Upserted One");
        }
        "nestedUpsert" => {
            db.exec("BEGIN", &[]);
            let uid = upsert_user(db, "user1@example.com", "NUp");
            insert_post(db, uid, "NUp Post");
            db.exec("COMMIT", &[]);
        }
        "delete" => {
            db.exec("BEGIN", &[]);
            let uid = insert_user(db, format!("del{it}@bench.com"), "Del");
            let mut ph = Ph::new(dialect);
            let del = format!("DELETE FROM benchmark_users WHERE id = {}", ph.next());
            db.exec(&del, &[P::I(uid)]);
            db.exec("COMMIT", &[]);
        }
        "createMany" => {
            let emails = batch_emails(it);
            let names = batch_names();
            let mut ph = Ph::new(dialect);
            let rows: Vec<String> = (0..10)
                .map(|_| format!("({}, {})", ph.next(), ph.next()))
                .collect();
            let sql = format!(
                "INSERT INTO benchmark_users (email, name) VALUES {}",
                rows.join(",")
            );
            let mut params = Vec::with_capacity(20);
            for k in 0..10 {
                params.push(P::S(emails[k].clone()));
                params.push(P::S(names[k].clone()));
            }
            db.exec(&sql, &params);
        }
        "upsertMany" => {
            let emails: Vec<String> = (0..10).map(|k| format!("many{k}@bench.com")).collect();
            let names = batch_names();
            let mut ph = Ph::new(dialect);
            let rows: Vec<String> = (0..10)
                .map(|_| format!("({}, {})", ph.next(), ph.next()))
                .collect();
            let sql = format!(
                "INSERT INTO benchmark_users (email, name) VALUES {}{}",
                rows.join(","),
                upsert_conflict(dialect)
            );
            let mut params = Vec::with_capacity(20);
            for k in 0..10 {
                params.push(P::S(emails[k].clone()));
                params.push(P::S(names[k].clone()));
            }
            db.exec(&sql, &params);
        }
        "updateMany" => update_many(db),
        other => panic!("unknown op '{other}'"),
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
fn materialize_users_posts(db: &mut dyn Db, users: Vec<Vec<Cell>>) -> Vec<SdkUser> {
    let mut users = decode_users(users);
    let ids: Vec<i64> = users.iter().map(|u| u.id).collect();
    if ids.is_empty() {
        return users;
    }
    let mut ph = Ph::new(db.dialect());
    let sql = format!(
        "SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN ({}) ORDER BY id ASC",
        ph.list(ids.len())
    );
    let posts = decode_posts(db.query(&sql, &ids.iter().map(|i| P::I(*i)).collect::<Vec<_>>()));
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
fn materialize_users_posts_comments(db: &mut dyn Db, users: Vec<Vec<Cell>>) -> Vec<SdkUser> {
    let mut users = decode_users(users);
    let uids: Vec<i64> = users.iter().map(|u| u.id).collect();
    if uids.is_empty() {
        return users;
    }
    let mut ph = Ph::new(db.dialect());
    let psql = format!(
        "SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN ({}) ORDER BY id ASC",
        ph.list(uids.len())
    );
    let mut posts =
        decode_posts(db.query(&psql, &uids.iter().map(|i| P::I(*i)).collect::<Vec<_>>()));
    let pids: Vec<i64> = posts.iter().map(|p| p.id).collect();
    if !pids.is_empty() {
        let mut ph = Ph::new(db.dialect());
        let csql = format!(
            "SELECT id, body, post_id FROM benchmark_comments WHERE post_id IN ({}) ORDER BY id ASC",
            ph.list(pids.len())
        );
        let comments =
            decode_comments(db.query(&csql, &pids.iter().map(|i| P::I(*i)).collect::<Vec<_>>()));
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
fn materialize_composite(db: &mut dyn Db) -> Vec<SdkTenantUser> {
    // The native module's parent window: ordered by user_id and capped at 100 ACROSS tenants. A
    // single-tenant scan happens to return the same row count, but it is a different query and it does not
    // exercise the composite key this op exists for (post_id/comment_id RESTART per tenant).
    let sql = "SELECT tenant_id, user_id, name FROM benchmark_tenant_users ORDER BY user_id ASC LIMIT 100";
    let mut tusers: Vec<SdkTenantUser> = db
        .query(sql, &[])
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
    // batched posts by (tenant_id, user_id)
    let mut ph = Ph::new(db.dialect());
    let body = ph.tuple_in(tusers.len(), 2);
    let psql = format!(
        "SELECT tenant_id, post_id, user_id, title FROM benchmark_tenant_posts WHERE (tenant_id, user_id) IN {body}"
    );
    let mut pparams = Vec::new();
    for u in &tusers {
        pparams.push(P::I(u.tenant_id));
        pparams.push(P::I(u.user_id));
    }
    let mut tposts: Vec<SdkTenantPost> = db
        .query(&psql, &pparams)
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
        let mut ph = Ph::new(db.dialect());
        let body = ph.tuple_in(tposts.len(), 2);
        let csql = format!(
            "SELECT tenant_id, comment_id, post_id, body FROM benchmark_tenant_comments WHERE (tenant_id, post_id) IN {body}"
        );
        let mut cparams = Vec::new();
        for p in &tposts {
            cparams.push(P::I(p.tenant_id));
            cparams.push(P::I(p.post_id));
        }
        let tcomments: Vec<SdkTenantComment> = db
            .query(&csql, &cparams)
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

// ── write helpers ─────────────────────────────────────────────────────────────────────────────────────
fn insert_user(db: &mut dyn Db, email: String, name: &str) -> i64 {
    let mut ph = Ph::new(db.dialect());
    let sql = format!(
        "INSERT INTO benchmark_users (email, name) VALUES ({}, {})",
        ph.next(),
        ph.next()
    );
    db.write_returning_id(
        &sql,
        &[P::S(email), P::S(name.into())],
        "SELECT id FROM benchmark_users WHERE id = LAST_INSERT_ID()", // AUTO_INCREMENT recovery
        &[],
    )
}

/// The upsert every write op above shares, reading its id back the way the native module's RETURNING does.
fn upsert_user(db: &mut dyn Db, email: &str, name: &str) -> i64 {
    let mut ph = Ph::new(db.dialect());
    let sql = format!(
        "INSERT INTO benchmark_users (email, name) VALUES ({}, {}){}",
        ph.next(),
        ph.next(),
        upsert_conflict(db.dialect())
    );
    let mut rph = Ph::new(db.dialect());
    let recover = format!(
        "SELECT id FROM benchmark_users WHERE email = {}",
        rph.next()
    );
    db.write_returning_id(
        &sql,
        &[P::S(email.into()), P::S(name.into())],
        &recover, // the runtime's conflict-key recovery
        &[P::S(email.into())],
    )
}
fn insert_post(db: &mut dyn Db, author_id: i64, title: &str) {
    let mut ph = Ph::new(db.dialect());
    let sql = format!(
        "INSERT INTO benchmark_posts (author_id, title) VALUES ({}, {})",
        ph.next(),
        ph.next()
    );
    db.exec(&sql, &[P::I(author_id), P::S(title.into())]);
}

/// updateMany: ONE statement setting names for ids 1..=10. sqlite/mysql use a `CASE id` expression with
/// an `id IN (…)` guard; pg uses a `FROM (VALUES …)` join. All single-statement (N+1-avoided).
fn update_many(db: &mut dyn Db) {
    let names = batch_names();
    match db.dialect() {
        Dialect::Pg => {
            let mut ph = Ph::new(Dialect::Pg);
            // Cast the first tuple so postgres infers the VALUES column types.
            let mut tuples: Vec<String> = Vec::with_capacity(10);
            for k in 0..10 {
                if k == 0 {
                    tuples.push(format!("({}::integer, {}::varchar)", ph.next(), ph.next()));
                } else {
                    tuples.push(format!("({}, {})", ph.next(), ph.next()));
                }
            }
            let sql = format!(
                "UPDATE benchmark_users AS t SET name = v.name FROM (VALUES {}) AS v(id, name) WHERE t.id = v.id",
                tuples.join(",")
            );
            let mut params = Vec::with_capacity(20);
            for k in 0..10 {
                params.push(P::I((k + 1) as i64));
                params.push(P::S(names[k].clone()));
            }
            db.exec(&sql, &params);
        }
        _ => {
            let mut ph = Ph::new(db.dialect());
            let mut whens = String::new();
            let mut params: Vec<P> = Vec::with_capacity(30);
            for k in 0..10 {
                whens.push_str(&format!(" WHEN {} THEN {}", ph.next(), ph.next()));
                params.push(P::I((k + 1) as i64));
                params.push(P::S(names[k].clone()));
            }
            let in_list = ph.list(10);
            for k in 0..10 {
                params.push(P::I((k + 1) as i64));
            }
            let sql = format!(
                "UPDATE benchmark_users SET name = CASE id{whens} END WHERE id IN ({in_list})"
            );
            db.exec(&sql, &params);
        }
    }
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
    let mut db = open_db(&dialect);
    apply_schema(db.as_mut(), &setup);
    println!("cell,dialect,op,iter,us,rows");
    for op in OPS {
        // Re-seed before each op so reads see the seed state and writes start clean.
        reseed(db.as_mut(), &setup);
        // One UN-TIMED probe measures the rows this op moves — the per-row denominator (#170).
        ROW_COUNT.store(0, Ordering::SeqCst);
        run_op(op, 0, db.as_mut());
        let rows = ROW_COUNT.load(Ordering::SeqCst);
        for it in 0..warmup {
            run_op(op, it + 1, db.as_mut());
        }
        for it in 0..reps {
            // Unique iteration id: the probe took 0, so warmup/timed start at 1.
            let g = it + warmup + 1;
            let t = Instant::now();
            run_op(op, g, db.as_mut());
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
        run_op(op, 0, db.as_mut());
        let stmts = QUERY_COUNT.load(Ordering::SeqCst);
        let rows = ROW_COUNT.load(Ordering::SeqCst);
        if let Some((_, n)) = expected.iter().find(|(name, _)| name == op) {
            assert_eq!(stmts, *n, "{op} statement-count regression");
        }
        println!("{op:<20}  {stmts:<10}  {rows:<6} ok");
    }
}
