//! #247 — the transaction CONTRACT the boundary carries, asked of the SERVER, on the live POOLED
//! seams (PG:5433 + MySQL:3307).
//!
//! `tests/tx_boundary.rs` (#240) proves the boundary is ONE transaction on ONE connection it OWNS.
//! That says nothing about what the transaction is worth: an isolation level that never reaches the
//! server, a lock cycle the runtime re-raises instead of retrying, a write that runs with no boundary
//! at all, and an inner boundary that opens a second physical transaction are all invisible to it,
//! and to the unit suite too — `src/tx_options.rs` asserts the SET statement's TEXT
//! (`begin_statements_per_dialect`) and classifies error STRINGS (`retryable_classification`), and
//! `src/exec_context.rs` drives the retry loop from a mock driver that fails on command
//! (`retry_reruns_whole_tx_on_retryable_error`). None of them has a server. Four claims, each asked
//! of a real one:
//!
//!   (1) ISOLATION   the level rides the boundary to the server: under REPEATABLE READ a re-read
//!                   inside the boundary holds its snapshot against a concurrent COMMIT, and under
//!                   READ COMMITTED the same re-read sees it. Same code, opposite results — so a
//!                   level that were dropped on the way could not produce both.
//!   (2) RETRY       two boundaries deadlock on the SERVER (opposite lock order, rendezvous-forced),
//!                   the loser's error is classified retryable and the WHOLE boundary re-runs, and
//!                   both commit. A data conflict (PK collision) is NOT retried — one attempt.
//!   (3) GUARD       a write outside any boundary is refused (`write_outside_transaction`) and
//!                   nothing reaches the table; a write in a read-only scope INSIDE a boundary is
//!                   refused first (`write_in_read_only_context`); a write inside commits.
//!   (4) NESTING     an inner `transaction()` JOINS the outer — one BEGIN, one COMMIT for the pair —
//!                   and an inner failure rolls back the OUTER's work too.
//!
//! RED (measured, negative control — one per claim, each reverted):
//!
//!   (1) `isolation_prelude` (`src/tx_options.rs`) returning EMPTY prelude vectors, so the level is
//!       rendered and dropped. The two engines trip OPPOSITE assertions, which is the claim itself:
//!         PG     left: 200  right: 100  "REPEATABLE READ: the re-read HOLDS its snapshot" — PG
//!                                       defaults to READ COMMITTED, so the re-read saw the commit.
//!         MySQL  left: 100  right: 300  "READ COMMITTED: the re-read SEES the concurrent commit" —
//!                                       InnoDB defaults to REPEATABLE READ, so it did not.
//!   (2) `is_retryable_tx_error` returning false: the loser's failure surfaces instead of retrying —
//!         PG     "postgres tx execute [...]: db error (SQLSTATE 40P01)"
//!         MySQL  "1213 (40001): Deadlock found when trying to get lock; try restarting transaction"
//!       The server codes in the RED are the proof the contention is real and not simulated.
//!   (3) `check_write_allowed` returning `Ok(())`: "a write outside a boundary must be refused:
//!       RunInfo { changes: 1, ... }" — `changes: 1` is the unguarded write LANDING, which is why the
//!       row-count assertion beside each refusal is load-bearing rather than decorative.
//!   (4) the nested-JOIN early return of `transaction_decided_on` (`src/exec_context.rs`) disabled:
//!       left: (2, 2, 0)  right: (1, 1, 0) — ["BEGIN", INSERT, "BEGIN", INSERT, "COMMIT", "COMMIT"],
//!       the inner boundary opening a SECOND physical transaction.
//!
//! One claim each, so no claim is asserted twice:
//!
//!   `tests/tx_boundary.rs` (#240)        ONE transaction, ONE OWNED connection, N ops.
//!   `tests/tx_unwind_release.rs` (#239)  that connection is RELEASED on every path, panic included.
//!   `tests/connection_routing.rs`        WHICH pool a named-DB transaction pins.
//!   `tests/livedb_middleware.rs`         the runtime's BEGIN/COMMIT are middleware-VISIBLE — which
//!                                        is what lets the counting below read them at all.
//!   HERE                                 what the transaction is WORTH: its isolation level, its
//!                                        retry, its write guard, and its nesting.
//!
//! Gated behind the `livedb` feature AND `LITEDBMODEL_TX_ISOLATION=1` (declared in
//! `livedb-gates.env`) so the default `cargo test` (no DBs) never runs it. Bring up + run:
//!   docker compose -f docker-compose.test.yml -f docker-compose.livedb.yml up -d postgres mysql
//!   LITEDBMODEL_TX_ISOLATION=1 cargo test -p litedbmodel_runtime --features livedb \
//!     --test tx_isolation -- --nocapture

#![cfg(feature = "livedb")]

use std::cell::Cell;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use litedbmodel_runtime::{
    create_middleware, for_driver, run_guarded, seam_execute, seam_run, transaction,
    use_middleware, with_middleware_scope, Driver, ExecutionContext, IsolationLevel, MysqlDriver,
    PostgresDriver, StatementIntent, TransactionOptions, TxDialect,
};

mod common;

use common::{first_i64, mysql_url, observer, pg_conn_string};

/// The gate this suite runs behind (declared in `livedb-gates.env`).
const GATE: &str = "LITEDBMODEL_TX_ISOLATION";

// rust-namespaced so the other ports sharing docker PG:5433 / MySQL:3307 never collide with it.
const PG_SCHEMA: &str = "tx_isolation_rust";
const TBL: &str = "tx_isolation_rust";

fn pg_tbl() -> String {
    format!("{PG_SCHEMA}.{TBL}")
}

/// How a worker reaches ITS OWN pooled driver. The contention below runs two boundaries at once, and
/// each gets a driver of its own so what they contend over is the SERVER's row locks and nothing
/// else — a shared driver would put its pool (and, for PG, its current-thread tokio runtime) between
/// the two and make the cycle an artefact of this test's plumbing.
type Connect = fn() -> Box<dyn Driver>;

fn pg_driver() -> Box<dyn Driver> {
    Box::new(PostgresDriver::connect(&pg_conn_string()).expect("pg connect"))
}

fn mysql_driver() -> Box<dyn Driver> {
    Box::new(MysqlDriver::connect(&mysql_url()).expect("mysql connect"))
}

// ── reading and writing AROUND the boundary ────────────────────────────────────

/// One scalar, asked OUTSIDE any transaction: `Driver::prepare` bypasses the seam, so this takes a
/// connection of its own and is invisible to the observer — which is what makes it usable both as
/// the concurrent COMMIT the isolation claim needs and as the verdict on what the table holds.
fn scalar_outside(driver: &dyn Driver, sql: &str) -> i64 {
    first_i64(
        &driver
            .prepare(sql)
            .all(&[])
            .expect("read outside any boundary"),
    )
}

/// A statement issued outside any transaction (setup, and the concurrent committed change).
fn run_outside(driver: &dyn Driver, sql: &str) {
    driver
        .prepare(sql)
        .run(&[])
        .expect("statement outside any boundary");
}

/// One scalar read THROUGH the seam — on the boundary's own pinned connection when `ctx` is a
/// tx-scoped one.
fn scalar_in(ctx: &ExecutionContext, sql: &str) -> i64 {
    first_i64(
        &seam_execute(ctx, sql, &[], &StatementIntent::read()).expect("read through the seam"),
    )
}

/// BEGIN / COMMIT / ROLLBACK counts in a recorded seam log. The tx runtime issues its tx-control
/// statements through the seam (`tests/livedb_middleware.rs` is the claim that it does), so this is
/// the runtime's own observation point rather than a Driver decorator laid over a pooled driver.
fn tx_control(log: &[String]) -> (usize, usize, usize) {
    let n = |head: &str| log.iter().filter(|s| s.trim() == head).count();
    (n("BEGIN"), n("COMMIT"), n("ROLLBACK"))
}

/// Run `body` with a recording middleware installed, and return what the seam saw. The registry is
/// thread-local, so each contending worker below installs its own.
fn recording<R>(body: impl FnOnce(&dyn Fn() -> Vec<String>) -> R) -> (R, Vec<String>) {
    let log = Arc::new(Mutex::new(Vec::<String>::new()));
    let recorded = log.clone();
    let snapshot = log.clone();
    let out = with_middleware_scope(|| {
        let mw = create_middleware::<(), _, fn() -> ()>(Some(observer(recorded)), None);
        use_middleware(&mw);
        body(&|| snapshot.lock().unwrap().clone())
    });
    let seen = log.lock().unwrap().clone();
    (out, seen)
}

/// Empty the table (every section starts from a table it seeded itself).
fn clear(driver: &dyn Driver, tbl: &str) {
    run_outside(driver, &format!("DELETE FROM {tbl}"));
}

// ── (1) ISOLATION — the level rides the boundary to the server ─────────────────

/// The SAME two reads, around the SAME concurrent COMMIT, at two levels: REPEATABLE READ must hold
/// the snapshot it opened with, READ COMMITTED must not. A level that never reached the server
/// cannot answer differently at the two, whatever `begin_statements` renders.
fn the_level_reaches_the_server(driver: &dyn Driver, dialect: TxDialect, tbl: &str) {
    let read = format!("SELECT val FROM {tbl} WHERE id = 1");

    let observe = |level: IsolationLevel, updated_to: i64| -> (i64, i64) {
        clear(driver, tbl);
        run_outside(
            driver,
            &format!("INSERT INTO {tbl} (id, val) VALUES (1, 100)"),
        );
        let ctx = for_driver(driver);
        // Captured, then asserted AFTER the boundary, so a failure is reported by this test rather
        // than by a panic unwinding through an open transaction.
        let seen = Cell::new((0i64, 0i64));
        transaction(
            &ctx,
            dialect,
            &TransactionOptions {
                isolation: Some(level),
                ..TransactionOptions::default()
            },
            |tx| {
                let first = scalar_in(tx, &read);
                // A committed change from OUTSIDE, on a connection of its own, BETWEEN the two reads.
                run_outside(
                    driver,
                    &format!("UPDATE {tbl} SET val = {updated_to} WHERE id = 1"),
                );
                let second = scalar_in(tx, &read);
                seen.set((first, second));
                Ok(())
            },
        )
        .expect("the boundary commits");
        seen.get()
    };

    let (first, second) = observe(IsolationLevel::RepeatableRead, 200);
    assert_eq!(first, 100, "REPEATABLE READ: the first read is the seed");
    assert_eq!(
        second, 100,
        "REPEATABLE READ: the re-read HOLDS its snapshot against the concurrent commit (#247)"
    );

    let (first, second) = observe(IsolationLevel::ReadCommitted, 300);
    assert_eq!(first, 100, "READ COMMITTED: the first read is the seed");
    assert_eq!(
        second, 300,
        "READ COMMITTED: the re-read SEES the concurrent commit (#247)"
    );
}

// ── (2) RETRY — a real lock cycle, and a conflict that must not be retried ─────

/// A two-party rendezvous each worker passes EXACTLY ONCE, on its FIRST attempt. It is what makes
/// the lock cycle certain instead of raced: neither worker asks for its second row until both hold
/// their first. A RETRIED attempt walks straight through — the party it would wait for has already
/// left, and waiting again would hang the suite.
struct Rendezvous {
    arrived: Mutex<usize>,
    cv: Condvar,
}

impl Rendezvous {
    fn new() -> Self {
        Rendezvous {
            arrived: Mutex::new(0),
            cv: Condvar::new(),
        }
    }

    /// Block until both parties have arrived — bounded, so a worker that failed before arriving
    /// leaves the other with a failed assertion rather than a hung test.
    fn arrive(&self) {
        let mut n = self.arrived.lock().unwrap();
        *n += 1;
        if *n >= 2 {
            self.cv.notify_all();
            return;
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        while *n < 2 {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            n = self.cv.wait_timeout(n, left).unwrap().0;
        }
    }
}

/// Two boundaries take the same two rows in OPPOSITE order, each holding its first until the other
/// does: the server has a cycle and breaks it (PG `40P01 deadlock_detected`, MySQL `1213
/// ER_LOCK_DEADLOCK`). The loser's failure must be CLASSIFIED retryable and the WHOLE boundary
/// re-run, so both workers end up committing — and the retry is read off the seam, where a re-run
/// shows as another BEGIN.
fn a_real_lock_cycle_is_retried(
    connect: Connect,
    driver: &dyn Driver,
    dialect: TxDialect,
    tbl: &str,
) {
    clear(driver, tbl);
    run_outside(
        driver,
        &format!("INSERT INTO {tbl} (id, val) VALUES (1, 0), (2, 0)"),
    );

    let rendezvous = Rendezvous::new();
    let options = TransactionOptions {
        // The default 200ms base doubles per attempt; this suite needs the retry to fire, not to wait.
        retry_duration_ms: 5,
        ..TransactionOptions::default()
    };

    let worker = |first: i64, second: i64| {
        // ITS OWN driver: what the two workers contend over is the server's row locks.
        let own = connect();
        let ctx = for_driver(&*own);
        let (result, seen) = recording(|_| {
            let passed = Cell::new(false);
            transaction(&ctx, dialect, &options, |tx| {
                seam_run(
                    tx,
                    &format!("UPDATE {tbl} SET val = val + 1 WHERE id = {first}"),
                    &[],
                    &StatementIntent::write(),
                )?;
                if !passed.replace(true) {
                    rendezvous.arrive();
                }
                seam_run(
                    tx,
                    &format!("UPDATE {tbl} SET val = val + 1 WHERE id = {second}"),
                    &[],
                    &StatementIntent::write(),
                )?;
                Ok(())
            })
        });
        (result, seen)
    };

    let ((a, log_a), (b, log_b)) = std::thread::scope(|s| {
        let ha = s.spawn(|| worker(1, 2));
        let hb = s.spawn(|| worker(2, 1));
        (ha.join().unwrap(), hb.join().unwrap())
    });

    assert!(
        a.is_ok() && b.is_ok(),
        "the loser of the lock cycle must RETRY and both boundaries commit (#247): {:?} / {:?}",
        a.as_ref().err().map(|e| &e.message),
        b.as_ref().err().map(|e| &e.message),
    );
    let begins = tx_control(&log_a).0 + tx_control(&log_b).0;
    assert!(
        begins > 2,
        "the retry must have FIRED — two workers, more than two BEGIN (#247): got {begins} \
         ({log_a:?} / {log_b:?})"
    );
    assert_eq!(
        scalar_outside(driver, &format!("SELECT COUNT(*) AS c FROM {tbl} WHERE val = 2")),
        2,
        "each worker incremented BOTH rows exactly once — a retried attempt left nothing behind (#247)"
    );

    // A data CONFLICT is a different verdict: re-running it would fail identically, so it must not be
    // retried even with retry armed. Exactly ONE BEGIN — one attempt.
    clear(driver, tbl);
    run_outside(
        driver,
        &format!("INSERT INTO {tbl} (id, val) VALUES (9, 0)"),
    );
    let ctx = for_driver(driver);
    let (conflict, log) = recording(|_| {
        transaction(&ctx, dialect, &options, |tx| {
            seam_run(
                tx,
                &format!("INSERT INTO {tbl} (id, val) VALUES (9, 1)"),
                &[],
                &StatementIntent::write(),
            )
            .map(|_| ())
        })
    });
    assert!(
        conflict.is_err(),
        "a PK collision must fail the boundary (#247)"
    );
    assert_eq!(
        tx_control(&log).0,
        1,
        "a NON-retryable error is not retried — exactly one BEGIN (#247): {log:?}"
    );
}

// ── (3) GUARD — a write is only allowed inside the boundary ────────────────────

/// The write=tx guard on the live seam: refused outside a boundary, refused first in a read-only
/// scope inside one, allowed inside. The refusals are checked at the TABLE too — a guard that
/// reported the error after the statement reached the server would still leak the row.
fn a_write_needs_the_boundary(driver: &dyn Driver, dialect: TxDialect, tbl: &str) {
    clear(driver, tbl);
    let ctx = for_driver(driver);
    let insert = |id: i64| format!("INSERT INTO {tbl} (id, val) VALUES ({id}, 1)");
    let count = |id: i64| format!("SELECT COUNT(*) AS c FROM {tbl} WHERE id = {id}");

    let outside = run_guarded(&ctx, &insert(1), &[], "create", Some(TBL))
        .expect_err("a write outside a boundary must be refused");
    assert_eq!(
        outside.kind, "write_outside_transaction",
        "a bare write is refused as write_outside_transaction (#247)"
    );
    assert_eq!(
        scalar_outside(driver, &count(1)),
        0,
        "the refused bare write reached no server (#247)"
    );

    let read_only = transaction(&ctx, dialect, &TransactionOptions::default(), |tx| {
        Ok(
            run_guarded(&tx.with_read_only(), &insert(2), &[], "create", Some(TBL))
                .expect_err("a write in a read-only scope must be refused"),
        )
    })
    .expect("the boundary itself commits");
    assert_eq!(
        read_only.kind, "write_in_read_only_context",
        "a read-only scope is the MORE specific refusal, and is checked first (#247)"
    );
    assert_eq!(
        scalar_outside(driver, &count(2)),
        0,
        "the refused read-only write reached no server (#247)"
    );

    transaction(&ctx, dialect, &TransactionOptions::default(), |tx| {
        run_guarded(tx, &insert(3), &[], "create", Some(TBL)).map(|_| ())
    })
    .expect("a write INSIDE the boundary is allowed");
    assert_eq!(
        scalar_outside(driver, &count(3)),
        1,
        "the guarded write inside the boundary committed (#247)"
    );
}

// ── (4) NESTING — an inner boundary joins the outer one ────────────────────────

/// A `transaction()` opened INSIDE one joins it: the pair is ONE physical transaction, and an inner
/// failure is the whole transaction's failure — the OUTER's already-executed write goes back too.
fn a_nested_boundary_joins_the_outer(driver: &dyn Driver, dialect: TxDialect, tbl: &str) {
    clear(driver, tbl);
    let ctx = for_driver(driver);
    let insert = |id: i64| format!("INSERT INTO {tbl} (id, val) VALUES ({id}, 1)");
    let count = |id: i64| format!("SELECT COUNT(*) AS c FROM {tbl} WHERE id = {id}");
    let write = |tx: &ExecutionContext, id: i64| {
        seam_run(tx, &insert(id), &[], &StatementIntent::write()).map(|_| ())
    };

    let (_, log) = recording(|_| {
        transaction(&ctx, dialect, &TransactionOptions::default(), |outer| {
            write(outer, 10)?;
            transaction(outer, dialect, &TransactionOptions::default(), |inner| {
                write(inner, 11)
            })
        })
        .expect("the joined pair commits");
    });
    assert_eq!(
        tx_control(&log),
        (1, 1, 0),
        "the inner boundary JOINED — ONE BEGIN, ONE COMMIT, no ROLLBACK for the pair (#247): {log:?}"
    );
    assert_eq!(
        scalar_outside(driver, &count(10)) + scalar_outside(driver, &count(11)),
        2,
        "both the outer and the inner write committed together (#247)"
    );

    // An inner failure is the WHOLE transaction's failure: id=21 is taken, so the inner write
    // collides, and the outer's id=20 must not survive it.
    clear(driver, tbl);
    run_outside(
        driver,
        &format!("INSERT INTO {tbl} (id, val) VALUES (21, 9)"),
    );
    let (failed, log) = recording(|_| {
        transaction(&ctx, dialect, &TransactionOptions::default(), |outer| {
            write(outer, 20)?;
            transaction(outer, dialect, &TransactionOptions::default(), |inner| {
                write(inner, 21)
            })
        })
    });
    assert!(
        failed.is_err(),
        "the inner failure surfaces as the boundary's failure (#247)"
    );
    let (begins, commits, rollbacks) = tx_control(&log);
    assert_eq!(
        (begins, commits, rollbacks),
        (1, 0, 1),
        "ONE BEGIN, no COMMIT, ONE ROLLBACK — the inner failure ended the OUTER transaction (#247): {log:?}"
    );
    assert_eq!(
        scalar_outside(driver, &count(20)),
        0,
        "the OUTER's write was rolled back by the INNER's failure (#247)"
    );
}

// ── entry points ───────────────────────────────────────────────────────────────

#[test]
fn isolation_retry_guard_and_nesting_pg() {
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

    let driver = PostgresDriver::connect(&pg_conn_string()).expect("pg connect");
    let tbl = pg_tbl();
    the_level_reaches_the_server(&driver, TxDialect::Postgres, &tbl);
    a_real_lock_cycle_is_retried(pg_driver, &driver, TxDialect::Postgres, &tbl);
    a_write_needs_the_boundary(&driver, TxDialect::Postgres, &tbl);
    a_nested_boundary_joins_the_outer(&driver, TxDialect::Postgres, &tbl);
}

#[test]
fn isolation_retry_guard_and_nesting_mysql() {
    common::require_live_db(GATE);

    let setup = MysqlDriver::connect(&mysql_url()).expect("mysql connect");
    setup
        .exec_ddl(&[
            format!("DROP TABLE IF EXISTS {TBL}"),
            format!("CREATE TABLE {TBL} (id INT PRIMARY KEY, val INT NOT NULL)"),
        ])
        .expect("mysql reset");

    let driver = MysqlDriver::connect(&mysql_url()).expect("mysql connect");
    the_level_reaches_the_server(&driver, TxDialect::Mysql, TBL);
    a_real_lock_cycle_is_retried(mysql_driver, &driver, TxDialect::Mysql, TBL);
    a_write_needs_the_boundary(&driver, TxDialect::Mysql, TBL);
    a_nested_boundary_joins_the_outer(&driver, TxDialect::Mysql, TBL);
}
