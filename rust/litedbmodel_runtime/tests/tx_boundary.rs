//! #240 — ONE transaction is ONE physical transaction on ONE connection the boundary OWNS, on the
//! live POOLED seams (PG:5433 + MySQL:3307).
//!
//! N operations inside one `transaction()` produce exactly ONE BEGIN and ONE COMMIT, and the
//! connection they run on belongs to the boundary from `acquire_tx` until it ends. The witness for
//! the ownership half is the POOL ITSELF: while the boundary is open, a statement issued OUTSIDE it
//! on the SAME driver cannot be handed the transaction's connection, so the pool must open a SECOND
//! one — and that second connection is not in the transaction, so the uncommitted rows are invisible
//! to it. Then the SERVER is asked whether anything is still holding a transaction open.
//!
//! RED (measured, negative control): replacing the `acquire_tx()` of
//! `with_transaction_decided_isolated` (`src/exec_context.rs`) with a per-statement FORWARDING handle
//! — the #238 shape, a single-connection tx handle laid over a POOLED driver — checks the connection
//! back into the pool between statements. The two assertions catch that from opposite ends, and the
//! two pools trip DIFFERENT ones, so neither covers for the other:
//!
//!   PG     left: 1  right: 2  "the boundary still OWNS its connection, so the outside statement
//!                             needed a second" — deadpool handed the boundary's own connection
//!                             straight back to the outside read, so a second was never opened.
//!   MySQL  left: 1  right: 0  "a statement OUTSIDE the boundary must not see its uncommitted rows"
//!                             — sqlx did open a second connection, but the boundary's statements
//!                             had scattered across the pool, so one INSERT AUTOCOMMITTED on a
//!                             connection that was not in the transaction and the outside read saw it.
//!
//! One claim each, so no claim is asserted twice:
//!
//!   `tests/tx_unwind_release.rs` (#239)  the owned connection is RELEASED on every path out of the
//!                                       boundary, including a body that PANICS.
//!   `tests/connection_routing.rs`        WHICH pool a named-DB transaction pins (the routing pin,
//!                                       observed at the registry).
//!   `tests/livedb_middleware.rs`         that the runtime's own BEGIN/COMMIT are middleware-VISIBLE.
//!   HERE                                 that the boundary is ONE transaction (one BEGIN, one
//!                                       COMMIT, whatever N is) on ONE OWNED connection, and that it
//!                                       leaves the server with no transaction open.
//!
//! Gated behind the `livedb` feature AND `LITEDBMODEL_TX_BOUNDARY=1` (declared in `livedb-gates.env`)
//! so the default `cargo test` (no DBs) never runs it. Bring up + run:
//!   docker compose -f docker-compose.test.yml -f docker-compose.livedb.yml up -d postgres mysql
//!   LITEDBMODEL_TX_BOUNDARY=1 cargo test -p litedbmodel_runtime --features livedb \
//!     --test tx_boundary -- --nocapture

#![cfg(feature = "livedb")]

use std::cell::RefCell;
use std::sync::{Arc, Mutex};

use litedbmodel_runtime::{
    create_middleware, for_driver, seam_run, transaction, use_middleware, with_middleware_scope,
    Driver, ExecutionContext, MysqlDriver, PostgresDriver, StatementIntent, TransactionOptions,
    TxDialect,
};

mod common;

use common::{
    first_i64, mysql_probe_url, mysql_url, observer, open_tx_count, pg_conn_string, MYSQL_OPEN_TX,
    PG_OPEN_TX,
};

/// The gate this suite runs behind (declared in `livedb-gates.env`).
const GATE: &str = "LITEDBMODEL_TX_BOUNDARY";

// rust-namespaced so the other ports sharing docker PG:5433 / MySQL:3307 never collide with it.
const PG_SCHEMA: &str = "tx_boundary_rust";
const TBL: &str = "tx_boundary_rust";

fn pg_tbl() -> String {
    format!("{PG_SCHEMA}.{TBL}")
}

/// How many rows the table holds, asked OUTSIDE any transaction: `Driver::prepare` bypasses the seam,
/// so this needs a connection of its own from the pool and is invisible to the middleware observer.
/// That is the whole point — it is the statement the open boundary must not be able to lend its
/// connection to.
fn rows_outside(driver: &dyn Driver, tbl: &str) -> i64 {
    first_i64(
        &driver
            .prepare(&format!("SELECT COUNT(*) AS c FROM {tbl}"))
            .all(&[])
            .expect("read outside the transaction"),
    )
}

/// The ONE claim, against a live POOLED driver of either dialect. `total` reads that driver's pool
/// size (`PostgresDriver::total_connections` / `MysqlDriver::total_connections`), the count of
/// connections it has had to open.
fn one_transaction_owns_one_connection(
    driver: &dyn Driver,
    total: &dyn Fn() -> usize,
    dialect: TxDialect,
    tbl: &str,
    probe: &ExecutionContext,
    open_tx_sql: &str,
) {
    let ctx = for_driver(driver);

    // Warm the pool to EXACTLY ONE connection, so what the boundary does to it is unambiguous: from
    // here, a second connection can only be one the boundary's own refused to serve.
    assert_eq!(
        rows_outside(driver, tbl),
        0,
        "precondition: the table is empty"
    );
    assert_eq!(
        total(),
        1,
        "precondition: the pool has opened exactly one connection"
    );
    assert_eq!(
        open_tx_count(probe, open_tx_sql),
        0,
        "precondition: no connection is already holding a transaction open"
    );

    // What is observed FROM OUTSIDE mid-boundary is CAPTURED and asserted after it, so a failure is
    // reported by this test rather than by a panic unwinding through the transaction.
    let mid = RefCell::new((0usize, -1i64));
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let recorded = seen.clone();
    with_middleware_scope(|| {
        let mw = create_middleware::<(), _, fn() -> ()>(Some(observer(recorded)), None);
        use_middleware(&mw);
        transaction(&ctx, dialect, &TransactionOptions::default(), |tx| {
            seam_run(
                tx,
                &format!("INSERT INTO {tbl} (id, val) VALUES (1, 10)"),
                &[],
                &StatementIntent::write(),
            )?;
            seam_run(
                tx,
                &format!("INSERT INTO {tbl} (id, val) VALUES (2, 20)"),
                &[],
                &StatementIntent::write(),
            )?;
            // A statement issued OUTSIDE the boundary, on the SAME driver. The boundary owns its
            // connection for its whole span, so the pool cannot hand that one out: this has to open a
            // SECOND connection, which is not in the transaction and therefore sees neither row.
            let outside = rows_outside(driver, tbl);
            *mid.borrow_mut() = (total(), outside);
            Ok(())
        })
        .expect("the boundary commits");
    });

    let (opened, outside) = *mid.borrow();
    assert_eq!(
        opened, 2,
        "the boundary still OWNS its connection, so the outside statement needed a second (#240)"
    );
    assert_eq!(
        outside, 0,
        "a statement OUTSIDE the boundary must not see its uncommitted rows (#240)"
    );

    // ONE physical transaction for the two operations: BEGIN, the two bodies, COMMIT — nothing else,
    // and no second BEGIN/COMMIT/ROLLBACK. Read from the seam's own observation point (the middleware
    // hook the tx runtime issues BEGIN/COMMIT through), never from a Driver decorator: wrapping a
    // pooled driver in a tx handle of one's own is the #238 defect this suite exists to catch.
    let statements = seen.lock().unwrap().clone();
    let count = |head: &str| statements.iter().filter(|s| s.trim() == head).count();
    assert_eq!(
        count("BEGIN"),
        1,
        "two ops = exactly ONE BEGIN: {statements:?}"
    );
    assert_eq!(count("COMMIT"), 1, "exactly ONE COMMIT: {statements:?}");
    assert_eq!(count("ROLLBACK"), 0, "zero ROLLBACK: {statements:?}");
    assert_eq!(
        statements.len(),
        4,
        "BEGIN + the two body statements + COMMIT, and nothing else: {statements:?}"
    );

    assert_eq!(
        rows_outside(driver, tbl),
        2,
        "both rows committed together (#240)"
    );
    assert_eq!(
        open_tx_count(probe, open_tx_sql),
        0,
        "the finished boundary leaves no transaction open on the server (#240)"
    );
}

#[test]
fn one_transaction_owns_one_connection_pg() {
    common::require_live_db(GATE);

    let setup = PostgresDriver::connect(&pg_conn_string()).expect("pg connect");
    setup
        .exec_ddl(&[
            format!("CREATE SCHEMA IF NOT EXISTS {PG_SCHEMA}"),
            format!("DROP TABLE IF EXISTS {}", pg_tbl()),
            format!(
                "CREATE TABLE {} (id INTEGER PRIMARY KEY, val INTEGER NOT NULL)",
                pg_tbl()
            ),
        ])
        .expect("pg reset");

    // The boundary runs on ITS pool; the probe asks over a SEPARATE one, so a connection the boundary
    // is holding stays held instead of being checked out by the probe.
    let driver = PostgresDriver::connect(&pg_conn_string()).expect("pg connect");
    let probe_driver = PostgresDriver::connect(&pg_conn_string()).expect("pg connect");
    let probe = for_driver(&probe_driver);

    one_transaction_owns_one_connection(
        &driver,
        &|| driver.total_connections(),
        TxDialect::Postgres,
        &pg_tbl(),
        &probe,
        PG_OPEN_TX,
    );
}

#[test]
fn one_transaction_owns_one_connection_mysql() {
    common::require_live_db(GATE);

    let setup = MysqlDriver::connect(&mysql_url()).expect("mysql connect");
    setup
        .exec_ddl(&[
            format!("DROP TABLE IF EXISTS {TBL}"),
            format!("CREATE TABLE {TBL} (id INT PRIMARY KEY, val INT NOT NULL)"),
        ])
        .expect("mysql reset");

    let driver = MysqlDriver::connect(&mysql_url()).expect("mysql connect");
    let probe_driver = MysqlDriver::connect(&mysql_probe_url()).expect("mysql connect");
    let probe = for_driver(&probe_driver);

    one_transaction_owns_one_connection(
        &driver,
        &|| driver.total_connections(),
        TxDialect::Mysql,
        TBL,
        &probe,
        MYSQL_OPEN_TX,
    );
}
