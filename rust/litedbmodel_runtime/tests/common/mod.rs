//! Shared preconditions and probes for the live-DB integration tests (#168).
//!
//! Each integration test file is its own crate, so this is the one module the live suites can share
//! — the SSoT for "this suite needs a real database", for how each of them REACHES the dockerized
//! PG:5433 / MySQL:3307, for the SERVER-side witness of an open transaction, and for the seam
//! observer that records the statements a boundary issues.

// Every test crate compiles this whole module and uses the part its own suite needs, so an item is
// "unused" from the point of view of the others. Duplicating it per suite instead is what put the
// same open-transaction probe in two files.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use litedbmodel_runtime::{
    seam_execute, ExecutionContext, SeamResult, SqlFailure, SqlHookFn, SqlNext, StatementIntent,
    Value, WireValue,
};

/// Assert the live-DB gate named `var` is open, panicking with the way to open it if it is not.
///
/// Both suites used to `return` early here instead, and `cargo test` counts an early return as PASS
/// — so `publish-crates.yml` gated a crate release on ten tests that had never executed. The gate is
/// declared in `livedb-gates.env` and loaded by CI; a leg that cannot reach the database FAILS, the
/// same rule the cross-language conformance runner states: NO mock, NO silent skip.
pub fn require_live_db(var: &str) {
    if std::env::var(var).as_deref() != Ok("1") {
        panic!(
            "this suite requires a real database: set {var}=1 (see livedb-gates.env) and bring the \
             docker services up (`npm run docker:livedb:up`). Skipping would report PASS for a test \
             that never ran."
        );
    }
}

/// `k` from the environment, or `d` when it is unset or empty.
pub fn env(k: &str, d: &str) -> String {
    std::env::var(k)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| d.to_string())
}

/// The rust port's OWN MySQL database on the shared docker MySQL, so the other four ports running
/// the same stack never collide with it (`test/fixtures/livedb-grants.sql` creates the `scp_%`
/// family and grants `testuser` all of it).
pub const MYSQL_DB: &str = "scp_rust";

pub fn pg_conn_string() -> String {
    format!(
        "host={} port={} user={} password={} dbname={}",
        env("TEST_DB_HOST", "localhost"),
        env("TEST_DB_PORT", "5433"),
        env("TEST_DB_USER", "testuser"),
        env("TEST_DB_PASSWORD", "testpass"),
        env("TEST_DB_NAME", "testdb"),
    )
}

pub fn mysql_url() -> String {
    format!(
        "mysql://{}:{}@{}:{}/{}",
        env("TEST_MYSQL_USER", "testuser"),
        env("TEST_MYSQL_PASSWORD", "testpass"),
        env("TEST_MYSQL_HOST", "127.0.0.1"),
        env("TEST_MYSQL_PORT", "3307"),
        MYSQL_DB,
    )
}

/// The MySQL PROBE's own connection. `information_schema.innodb_trx` — the only server-side witness
/// of an open transaction — requires the `PROCESS` privilege, which `testuser` does not have
/// (`test/fixtures/livedb-grants.sql` grants it the `scp_%` databases only, and the runtime under
/// test needs nothing more). So the probe alone connects as root, exactly as the compose healthcheck
/// does (`docker-compose.test.yml:64,73`).
pub fn mysql_probe_url() -> String {
    format!(
        "mysql://{}:{}@{}:{}/{}",
        env("TEST_MYSQL_ROOT_USER", "root"),
        env("TEST_MYSQL_ROOT_PASSWORD", "rootpass"),
        env("TEST_MYSQL_HOST", "127.0.0.1"),
        env("TEST_MYSQL_PORT", "3307"),
        MYSQL_DB,
    )
}

/// How many connections hold an OPEN transaction, asked of the SERVER — the one witness a pool
/// cannot talk its caller out of. One per dialect, for [`open_tx_count`].
pub const PG_OPEN_TX: &str =
    "SELECT count(*) AS c FROM pg_stat_activity WHERE state='idle in transaction'";
pub const MYSQL_OPEN_TX: &str = "SELECT COUNT(*) AS c FROM information_schema.innodb_trx";

/// The first cell of the first row, as an i64 — a `COUNT(*)` probe's whole result.
pub fn first_i64(rows: &[WireValue]) -> i64 {
    match rows.first() {
        Some(WireValue::Row(r)) => match r.entries.first().map(|(_, v)| v) {
            Some(WireValue::Int(n)) => *n,
            Some(WireValue::Float(f)) => *f as i64,
            Some(WireValue::Str(s)) => s.parse().unwrap_or(-1),
            _ => -1,
        },
        _ => -1,
    }
}

/// How many connections hold an OPEN transaction, per the server, waiting up to ~5s for it to reach
/// zero. The wait is slack for the SERVER's own bookkeeping (a PG backend publishes `idle` just after
/// it answers the COMMIT/ROLLBACK), not for the runtime: a connection handed back to the pool with a
/// transaction still open holds it for as long as it sits there, so no amount of waiting turns that
/// red green.
pub fn open_tx_count(probe: &ExecutionContext, sql: &str) -> i64 {
    let mut last = -1;
    for _ in 0..100 {
        last = first_i64(&seam_execute(probe, sql, &[], &StatementIntent::read()).expect("probe"));
        if last == 0 {
            return 0;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    last
}

/// A SQL middleware hook that records every statement the SEAM issues, in order — the runtime's own
/// observation point, and the only one that sees the tx runtime's BEGIN/COMMIT (they are seam-issued
/// on the pinned connection). Statements a test sends through `Driver::prepare` directly bypass the
/// seam and are deliberately NOT recorded.
pub fn observer(
    log: Arc<Mutex<Vec<String>>>,
) -> SqlHookFn<impl Fn(&str, &[Value], &SqlNext) -> Result<SeamResult, SqlFailure> + Send + Sync> {
    SqlHookFn(move |sql: &str, params: &[Value], next: &SqlNext| {
        log.lock().unwrap().push(sql.to_string());
        next(sql, params)
    })
}
