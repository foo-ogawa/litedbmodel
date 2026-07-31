//! #239 — the transaction's owned connection is released on EVERY path, INCLUDING an UNWINDING body,
//! on the live POOLED seams (PG:5433 + MySQL:3307).
//!
//! `with_transaction_decided_isolated` (`src/exec_context.rs`) used to release only from its `Ok`/`Err`
//! arms, so a `body` that PANICKED unwound past all of them: no ROLLBACK, no `release`, just the raw
//! `TxSlot` dropped. The pooled connection went back to the pool **still inside an open transaction**
//! (rust was the only one of the five ports without the release in its finally: python `finally`, php
//! `finally` + leak-guard, TS "released EXACTLY once per attempt", go `defer`).
//!
//! Both legs ask the SERVER, which is the only witness a pool cannot talk out of it, and each probes
//! over its OWN driver so the leaked connection stays where the defect leaves it — in the pool, idle:
//!
//!   PG     `SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction'` == 0
//!   MySQL  `SELECT COUNT(*) FROM information_schema.innodb_trx` == 0
//!
//! RED without the fix (measured, #239): PG recycles the dirty connection ⇒ the count is 1. MySQL is
//! worse than a leak — dropping a sqlx `PoolConnection` outside the tokio runtime its own `Drop`
//! requires (`livedb.rs:1630-1635`) panics WHILE unwinding, and the process aborts.
//!
//! Gated behind the `livedb` feature AND `LITEDBMODEL_TX_UNWIND=1` (declared in `livedb-gates.env`) so
//! the default `cargo test` (no DBs) never runs it. Bring up + run:
//!   docker compose -f docker-compose.test.yml -f docker-compose.livedb.yml up -d postgres mysql
//!   LITEDBMODEL_TX_UNWIND=1 cargo test -p litedbmodel_runtime --features livedb \
//!     --test tx_unwind_release -- --nocapture

#![cfg(feature = "livedb")]

use std::panic::AssertUnwindSafe;

use litedbmodel_runtime::{
    for_driver, seam_execute, seam_run, with_transaction, ExecutionContext, MysqlDriver,
    PostgresDriver, SqlFailure, StatementIntent,
};

mod common;

use common::{
    first_i64, mysql_probe_url, mysql_url, open_tx_count, pg_conn_string, MYSQL_OPEN_TX, PG_OPEN_TX,
};

/// The gate this suite runs behind (declared in `livedb-gates.env`).
const GATE: &str = "LITEDBMODEL_TX_UNWIND";

// rust-namespaced so the other ports sharing docker PG:5433 / MySQL:3307 never collide with it.
const PG_SCHEMA: &str = "tx_unwind_rust";
const TBL: &str = "tx_unwind_rust";

fn pg_tbl() -> String {
    format!("{PG_SCHEMA}.{TBL}")
}

/// Run `body` inside a live transaction and PANIC mid-transaction (after a real DATA statement, so the
/// transaction exists as far as the server is concerned). Returns once the panic has been caught.
fn panic_inside_transaction(ctx: &ExecutionContext, insert: &str) {
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let _: Result<(), SqlFailure> = with_transaction(ctx, |tx_ctx| {
            seam_run(tx_ctx, insert, &[], &StatementIntent::write())?;
            panic!("#239: the tx body panics mid-transaction");
        });
    }));
    assert!(
        outcome.is_err(),
        "the tx body must have panicked — this test proves nothing otherwise"
    );
}

#[test]
fn tx_body_panic_leaves_no_open_transaction_pg() {
    common::require_live_db(GATE);

    let setup = PostgresDriver::connect(&pg_conn_string()).expect("pg connect");
    setup
        .exec_ddl(&[
            format!("CREATE SCHEMA IF NOT EXISTS {PG_SCHEMA}"),
            format!("DROP TABLE IF EXISTS {}", pg_tbl()),
            format!(
                "CREATE TABLE {} (id INTEGER PRIMARY KEY, val TEXT NOT NULL)",
                pg_tbl()
            ),
        ])
        .expect("pg reset");

    // The tx runs on ITS pool; the probe asks over a SEPARATE one, so a connection the defect returns
    // to the pool dirty stays idle there instead of being checked out (and made `active`) by the probe.
    let driver = PostgresDriver::connect(&pg_conn_string()).expect("pg connect");
    let ctx = for_driver(&driver);
    let probe_driver = PostgresDriver::connect(&pg_conn_string()).expect("pg connect");
    let probe = for_driver(&probe_driver);

    assert_eq!(
        first_i64(&seam_execute(&probe, PG_OPEN_TX, &[], &StatementIntent::read()).expect("probe")),
        0,
        "precondition: no connection may already be idle in transaction"
    );

    panic_inside_transaction(
        &ctx,
        &format!("INSERT INTO {} (id, val) VALUES (1, 'panic')", pg_tbl()),
    );

    assert_eq!(
        open_tx_count(&probe, PG_OPEN_TX),
        0,
        "a panicking tx body must not leave a connection idle in transaction (#239)"
    );
}

#[test]
fn tx_body_panic_leaves_no_open_transaction_mysql() {
    common::require_live_db(GATE);

    let setup = MysqlDriver::connect(&mysql_url()).expect("mysql connect");
    setup
        .exec_ddl(&[
            format!("DROP TABLE IF EXISTS {TBL}"),
            format!("CREATE TABLE {TBL} (id INT PRIMARY KEY, val TEXT NOT NULL)"),
        ])
        .expect("mysql reset");

    let driver = MysqlDriver::connect(&mysql_url()).expect("mysql connect");
    let ctx = for_driver(&driver);
    let probe_driver = MysqlDriver::connect(&mysql_probe_url()).expect("mysql connect");
    let probe = for_driver(&probe_driver);

    assert_eq!(
        first_i64(
            &seam_execute(&probe, MYSQL_OPEN_TX, &[], &StatementIntent::read()).expect("probe")
        ),
        0,
        "precondition: no transaction may already be open on the server"
    );

    panic_inside_transaction(
        &ctx,
        &format!("INSERT INTO {TBL} (id, val) VALUES (1, 'panic')"),
    );

    assert_eq!(
        open_tx_count(&probe, MYSQL_OPEN_TX),
        0,
        "a panicking tx body must not leave an open transaction on a pooled connection (#239)"
    );
}
