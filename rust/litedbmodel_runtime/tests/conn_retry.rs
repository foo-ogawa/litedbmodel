//! LIVE-DB: a transaction retry after a connection error runs only on a connection that passed a
//! `SELECT 1` probe. Every connection of the pool is killed by a separate admin connection
//! (pg_terminate_backend / KILL, by the ids of that pool's own connections) while a loopback proxy keeps
//! the client sockets open, as a load balancer or a failover does: the pool still holds them and learns
//! they are dead only by using them. `transaction()` then commits once.
//!
//! Gated behind the `livedb` feature AND `LITEDBMODEL_TX_BOUNDARY=1` (the tx_boundary suite's gate).

#![cfg(feature = "livedb")]

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use litedbmodel_runtime::{
    for_driver, seam_execute, seam_run, transaction, ConfigDialect, ConnectionConfig, Driver,
    MysqlDriver, PostgresDriver, StatementIntent, TransactionOptions, TxDialect, Value,
};

mod common;

use common::{env, first_i64, MYSQL_DB};

const GATE: &str = "LITEDBMODEL_TX_BOUNDARY";

/// = the default `retry_limit`: every connection the pool holds is dead after the kill.
const POOL_SIZE: u32 = 3;

/// Forwards TCP to `upstream`. `stale()` turns every connection open at that moment into a dead one the
/// client cannot see: nothing more is forwarded to the client, and the client's next write closes its
/// socket. Connections opened later are forwarded normally.
struct StaleProxy {
    port: u16,
    pairs: Pairs,
}

/// Every proxied connection: its dead flag, the client side and the upstream side.
type Pairs = Arc<Mutex<Vec<(Arc<AtomicBool>, TcpStream, TcpStream)>>>;

impl StaleProxy {
    fn start(upstream: String) -> StaleProxy {
        let listener = TcpListener::bind("127.0.0.1:0").expect("proxy listen");
        let port = listener.local_addr().unwrap().port();
        let pairs: Pairs = Arc::new(Mutex::new(Vec::new()));
        let registry = pairs.clone();
        thread::spawn(move || {
            for client in listener.incoming() {
                let Ok(client) = client else { return };
                let Ok(up) = TcpStream::connect(&upstream) else {
                    continue;
                };
                let dead = Arc::new(AtomicBool::new(false));
                registry.lock().unwrap().push((
                    dead.clone(),
                    client.try_clone().unwrap(),
                    up.try_clone().unwrap(),
                ));
                // client → upstream; a write on a dead pair closes the client.
                let (mut c, mut u, d) = (
                    client.try_clone().unwrap(),
                    up.try_clone().unwrap(),
                    dead.clone(),
                );
                thread::spawn(move || {
                    let mut buf = [0u8; 32 * 1024];
                    loop {
                        match c.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                if d.load(Ordering::SeqCst) || u.write_all(&buf[..n]).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    let _ = c.shutdown(Shutdown::Both);
                    let _ = u.shutdown(Shutdown::Both);
                });
                // upstream → client, until the pair is dead (the client is not told).
                let (mut c, mut u) = (client, up);
                thread::spawn(move || {
                    let mut buf = [0u8; 32 * 1024];
                    loop {
                        let r = u.read(&mut buf);
                        if dead.load(Ordering::SeqCst) {
                            return;
                        }
                        match r {
                            Ok(0) | Err(_) => {
                                let _ = c.shutdown(Shutdown::Both);
                                return;
                            }
                            Ok(n) => {
                                if c.write_all(&buf[..n]).is_err() {
                                    return;
                                }
                            }
                        }
                    }
                });
            }
        });
        StaleProxy { port, pairs }
    }

    fn stale(&self) {
        for (dead, _, _) in self.pairs.lock().unwrap().iter() {
            dead.store(true, Ordering::SeqCst);
        }
    }
}

impl Drop for StaleProxy {
    fn drop(&mut self) {
        for (_, c, u) in self.pairs.lock().unwrap().iter() {
            let _ = c.shutdown(Shutdown::Both);
            let _ = u.shutdown(Shutdown::Both);
        }
    }
}

fn config(
    dialect: ConfigDialect,
    host: &str,
    port: u16,
    database: String,
    user: String,
    password: String,
) -> ConnectionConfig {
    ConnectionConfig {
        driver: Some(dialect),
        host: Some(host.to_string()),
        port: Some(port),
        database: Some(database),
        user: Some(user),
        password: Some(password),
        max_pool: Some(POOL_SIZE),
        ..Default::default()
    }
}

/// Check out POOL_SIZE connections at once, read each one's server-side id, and return them all.
fn pool_ids(driver: &dyn Driver, id_sql: &str) -> Vec<i64> {
    let mut txs: Vec<_> = (0..POOL_SIZE)
        .map(|_| driver.acquire_tx().expect("checkout"))
        .collect();
    let ids = txs
        .iter_mut()
        .map(|tx| first_i64(&tx.execute(id_sql, &[]).expect("connection id")))
        .collect();
    for tx in txs {
        tx.release(false).expect("release");
    }
    ids
}

#[allow(clippy::too_many_arguments)]
fn tx_retry_after_killed_pool(
    driver: &dyn Driver,
    admin: &dyn Driver,
    proxy: &StaleProxy,
    dialect: TxDialect,
    tbl: &str,
    id_sql: &str,
    kill_sql: &dyn Fn(i64) -> String,
    insert_sql: &str,
) {
    let admin_ctx = for_driver(admin);
    let ids = pool_ids(driver, id_sql);
    proxy.stale();
    for id in ids {
        seam_execute(&admin_ctx, &kill_sql(id), &[], &StatementIntent::write()).expect("kill");
    }
    let options = TransactionOptions {
        retry_duration_ms: 1,
        ..TransactionOptions::default()
    };
    transaction(&for_driver(driver), dialect, &options, |tx| {
        seam_run(
            tx,
            insert_sql,
            &[Value::Str("after-kill".into())],
            &StatementIntent::write(),
        )
    })
    .expect("transaction() after the pool's connections were killed");
    let n = first_i64(
        &seam_execute(
            &admin_ctx,
            &format!("SELECT COUNT(*) AS c FROM {tbl}"),
            &[],
            &StatementIntent::read(),
        )
        .expect("count"),
    );
    assert_eq!(n, 1, "committed rows");
}

#[test]
fn tx_retry_after_killed_pool_pg() {
    common::require_live_db(GATE);
    let (host, port) = (
        env("TEST_DB_HOST", "localhost"),
        env("TEST_DB_PORT", "5433"),
    );
    let cfg = |h: &str, p: u16| {
        config(
            ConfigDialect::Postgres,
            h,
            p,
            env("TEST_DB_NAME", "testdb"),
            env("TEST_DB_USER", "testuser"),
            env("TEST_DB_PASSWORD", "testpass"),
        )
        .resolve()
    };
    let admin =
        PostgresDriver::connect_with_config(&cfg(&host, port.parse().unwrap())).expect("pg admin");
    let tbl = "conn_retry_rust";
    admin
        .exec_ddl(&[
            format!("DROP TABLE IF EXISTS {tbl}"),
            format!("CREATE TABLE {tbl} (id serial PRIMARY KEY, label text NOT NULL)"),
        ])
        .expect("pg reset");
    let proxy = StaleProxy::start(format!("{host}:{port}"));
    let driver =
        PostgresDriver::connect_with_config(&cfg("127.0.0.1", proxy.port)).expect("pg connect");
    tx_retry_after_killed_pool(
        &driver,
        &admin,
        &proxy,
        TxDialect::Postgres,
        tbl,
        "SELECT pg_backend_pid()::bigint AS id",
        &|id| format!("SELECT pg_terminate_backend({id})"),
        &format!("INSERT INTO {tbl} (label) VALUES ($1)"),
    );
    admin
        .exec_ddl(&[format!("DROP TABLE IF EXISTS {tbl}")])
        .expect("pg drop");
}

#[test]
fn tx_retry_after_killed_pool_mysql() {
    common::require_live_db(GATE);
    let (host, port) = (
        env("TEST_MYSQL_HOST", "127.0.0.1"),
        env("TEST_MYSQL_PORT", "3307"),
    );
    let cfg = |h: &str, p: u16| {
        config(
            ConfigDialect::Mysql,
            h,
            p,
            MYSQL_DB.to_string(),
            env("TEST_MYSQL_USER", "testuser"),
            env("TEST_MYSQL_PASSWORD", "testpass"),
        )
        .resolve()
    };
    let admin =
        MysqlDriver::connect_with_config(&cfg(&host, port.parse().unwrap())).expect("mysql admin");
    let tbl = "conn_retry_rust";
    admin
        .exec_ddl(&[
            format!("DROP TABLE IF EXISTS {tbl}"),
            format!("CREATE TABLE {tbl} (id int AUTO_INCREMENT PRIMARY KEY, label varchar(32) NOT NULL)"),
        ])
        .expect("mysql reset");
    let proxy = StaleProxy::start(format!("{host}:{port}"));
    let driver =
        MysqlDriver::connect_with_config(&cfg("127.0.0.1", proxy.port)).expect("mysql connect");
    tx_retry_after_killed_pool(
        &driver,
        &admin,
        &proxy,
        TxDialect::Mysql,
        tbl,
        "SELECT CONNECTION_ID() AS id",
        &|id| format!("KILL {id}"),
        &format!("INSERT INTO {tbl} (label) VALUES (?)"),
    );
    admin
        .exec_ddl(&[format!("DROP TABLE IF EXISTS {tbl}")])
        .expect("mysql drop");
}
