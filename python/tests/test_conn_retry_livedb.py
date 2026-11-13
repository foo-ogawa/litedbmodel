"""LIVE-DB: a transaction retry after a connection error runs only on a connection that passed a
``SELECT 1`` probe (:meth:`ExecutionContext.begin_tx`). Every connection of the pool is killed by a separate
admin connection (pg_terminate_backend / KILL, by the ids of that pool's own connections) while a loopback
proxy keeps the client sockets open, as a load balancer or a failover does: the pool still holds them and
learns they are dead only by using them. transaction() then commits once.

Gated behind LITEDBMODEL_TX_ISOLATION=1 (the shared live-DB gate). Requires the dockerized PG (:5433) +
MySQL (:3307).
"""

from __future__ import annotations

import os
import socket
import threading

import pytest

from litedbmodel_runtime import (
    MysqlDriver,
    PostgresDriver,
    TransactionOptions,
    context_for_driver,
    execute,
    run_guarded,
    transaction,
)

pytestmark = pytest.mark.skipif(
    os.environ.get("LITEDBMODEL_TX_ISOLATION") != "1", reason="set LITEDBMODEL_TX_ISOLATION=1 + docker up"
)

POOL_SIZE = 3  # = the default retry_limit: every connection the pool holds is dead after the kill


def _pg_cfg():
    return dict(
        host=os.environ.get("TEST_DB_HOST", "localhost"),
        port=int(os.environ.get("TEST_DB_PORT", "5433")),
        user=os.environ.get("TEST_DB_USER", "testuser"),
        password=os.environ.get("TEST_DB_PASSWORD", "testpass"),
        dbname=os.environ.get("TEST_DB_NAME", "testdb"),
    )


def _mysql_cfg():
    return dict(
        host=os.environ.get("TEST_MYSQL_HOST", "127.0.0.1"),
        port=int(os.environ.get("TEST_MYSQL_PORT", "3307")),
        user=os.environ.get("TEST_MYSQL_USER", "testuser"),
        password=os.environ.get("TEST_MYSQL_PASSWORD", "testpass"),
        dbname=os.environ.get("TEST_MYSQL_DB", "testdb"),
    )


class _StaleProxy:
    """Forwards TCP to ``upstream``. :meth:`stale` turns every connection open at that moment into a dead one
    the client cannot see: nothing more is forwarded to the client, and the client's next write closes its
    socket. Connections opened later are forwarded normally."""

    def __init__(self, host, port):
        self._upstream = (host, port)
        self._listener = socket.create_server(("127.0.0.1", 0))
        self.port = self._listener.getsockname()[1]
        self._lock = threading.Lock()
        self._pairs = []  # [client, upstream, dead]
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while True:
            try:
                client, _ = self._listener.accept()
            except OSError:
                return
            up = socket.create_connection(self._upstream)
            pair = [client, up, False]
            with self._lock:
                self._pairs.append(pair)
            threading.Thread(target=self._to_upstream, args=(pair,), daemon=True).start()
            threading.Thread(target=self._to_client, args=(pair,), daemon=True).start()

    def _to_upstream(self, pair):
        client, up, _ = pair
        try:
            while True:
                data = client.recv(32768)
                if not data or pair[2]:
                    break
                up.sendall(data)
        except OSError:
            pass
        for s in (client, up):
            try:
                s.close()
            except OSError:
                pass

    def _to_client(self, pair):
        client, up, _ = pair
        try:
            while True:
                data = up.recv(32768)
                if pair[2]:
                    return  # the client is not told
                if not data:
                    client.shutdown(socket.SHUT_RDWR)
                    return
                client.sendall(data)
        except OSError:
            pass

    def stale(self):
        with self._lock:
            for pair in self._pairs:
                pair[2] = True

    def close(self):
        self._listener.close()
        with self._lock:
            for client, up, _ in self._pairs:
                for s in (client, up):
                    try:
                        s.close()
                    except OSError:
                        pass


def _pool_ids(driver, id_sql):
    """Check out POOL_SIZE connections at once, read each one's server-side id, and return them all."""
    txs = [driver.begin_tx() for _ in range(POOL_SIZE)]
    try:
        return [list(tx.all(id_sql, [])[0].values())[0] for tx in txs]
    finally:
        for tx in txs:
            tx.release(False)


def _tx_retry_after_killed_pool(connect, cfg, dialect, id_sql, kill_sql, create_sql, insert_sql):
    tbl = f"conn_retry_py_{dialect}"
    admin_driver = connect(**cfg, pool_size=1)
    admin = admin_driver.begin_tx()
    proxy = _StaleProxy(cfg["host"], cfg["port"])
    driver = connect(**{**cfg, "host": "127.0.0.1", "port": proxy.port}, pool_size=POOL_SIZE)
    try:
        admin.run(f"DROP TABLE IF EXISTS {tbl}", [])
        admin.run(create_sql.format(tbl), [])
        ids = _pool_ids(driver, id_sql)
        proxy.stale()
        for conn_id in ids:
            admin.run(kill_sql.format(int(conn_id)), [])
        ctx = context_for_driver(driver)

        def body():
            run_guarded(ctx, insert_sql.format(tbl), ["after-kill"], "INSERT")

        transaction(ctx, body, TransactionOptions(retry_duration=1), dialect)
        assert admin.all(f"SELECT count(*) AS n FROM {tbl}", [])[0]["n"] == 1
    finally:
        admin.run(f"DROP TABLE IF EXISTS {tbl}", [])
        admin.release(False)
        admin_driver.close()
        driver.close()
        proxy.close()


def test_tx_retry_after_killed_pool_postgres():
    _tx_retry_after_killed_pool(
        PostgresDriver.connect, _pg_cfg(), "postgres",
        "SELECT pg_backend_pid() AS id", "SELECT pg_terminate_backend({})",
        "CREATE TABLE {} (id serial PRIMARY KEY, label text NOT NULL)", "INSERT INTO {} (label) VALUES ($1)",
    )


def test_tx_retry_after_killed_pool_mysql():
    _tx_retry_after_killed_pool(
        MysqlDriver.connect, _mysql_cfg(), "mysql",
        "SELECT CONNECTION_ID() AS id", "KILL {}",
        "CREATE TABLE {} (id int AUTO_INCREMENT PRIMARY KEY, label varchar(32) NOT NULL)",
        "INSERT INTO {} (label) VALUES (?)",
    )


def test_tx_retry_after_admin_shutdown_postgres():
    """A REAL pg_terminate_backend on the transaction's own connection, with no proxy: the server answers the
    statement in flight with ``FATAL 57P01 terminating connection due to administrator command`` and closes
    the connection — what a restart or a failover sends. That is a connection error
    (:func:`is_connection_error`), so the transaction is retried on another connection and commits once."""
    cfg = _pg_cfg()
    tbl = "conn_retry_py_admin_shutdown"
    admin_driver = PostgresDriver.connect(**cfg, pool_size=1)
    admin = admin_driver.begin_tx()
    driver = PostgresDriver.connect(**cfg, pool_size=2)
    try:
        admin.run(f"DROP TABLE IF EXISTS {tbl}", [])
        admin.run(f"CREATE TABLE {tbl} (id serial PRIMARY KEY, label text NOT NULL)", [])
        ctx = context_for_driver(driver)
        attempts = []

        def body():
            attempts.append(1)
            if len(attempts) == 1:
                pid = execute(ctx, "SELECT pg_backend_pid() AS id", [])[0]["id"]
                # Terminate this connection while a statement is in flight on it.
                threading.Timer(0.2, lambda: admin.all(f"SELECT pg_terminate_backend({int(pid)})", [])).start()
                execute(ctx, "SELECT pg_sleep(5)", [])
            run_guarded(ctx, f"INSERT INTO {tbl} (label) VALUES ($1)", ["after-admin-shutdown"], "INSERT")

        transaction(ctx, body, TransactionOptions(retry_duration=1), "postgres")
        assert len(attempts) == 2
        assert admin.all(f"SELECT count(*) AS n FROM {tbl}", [])[0]["n"] == 1
    finally:
        admin.run(f"DROP TABLE IF EXISTS {tbl}", [])
        admin.release(False)
        admin_driver.close()
        driver.close()
