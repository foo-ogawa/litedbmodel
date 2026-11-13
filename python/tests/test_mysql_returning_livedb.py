"""MySQL has no RETURNING: the PyMySQL driver's emulation (driver.py ``_build_mysql_reselect`` +
``_conn_all``) must return EXACTLY the rows the write wrote — the set PG / SQLite native RETURNING
returns — and fail closed where it cannot know that set. Each statement below is the TS compiler's own
mysql output (compileWriteNode / the batch bundles), run through the shipped ``MysqlDriver``.

Gated behind LITEDBMODEL_TX_ISOLATION=1 + docker up (MySQL:3307), like the other live python suites.
"""

from __future__ import annotations

import json
import os

import pytest

from litedbmodel_runtime import MysqlDriver


def _enabled() -> bool:
    return os.environ.get("LITEDBMODEL_TX_ISOLATION") == "1"


pytestmark = pytest.mark.skipif(not _enabled(), reason="set LITEDBMODEL_TX_ISOLATION=1 + docker up")

TBL = f"scp_myret_py_{os.getpid()}"


@pytest.fixture
def driver():
    d = MysqlDriver.connect(
        host=os.environ.get("TEST_MYSQL_HOST", "127.0.0.1"),
        port=int(os.environ.get("TEST_MYSQL_PORT", "3307")),
        user=os.environ.get("TEST_MYSQL_USER", "testuser"),
        password=os.environ.get("TEST_MYSQL_PASSWORD", "testpass"),
        dbname=os.environ.get("TEST_MYSQL_DB", "testdb"),
    )
    yield d
    d.exec_ddl([f"DROP TABLE IF EXISTS {TBL}"])
    d.close()


def _table(d, ddl: str, *seed: str) -> None:
    d.exec_ddl([f"DROP TABLE IF EXISTS {TBL}", f"CREATE TABLE {TBL} {ddl}", *seed])


def _rows(d, sql: str, params):
    return d.prepare(sql).all(list(params))


# ── #358 — a composite key is matched on EVERY column, never the first alone ─────────────────────


def test_mysql_returning_composite_key(driver):
    ddl = "(id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(64) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64), UNIQUE KEY uq (email, tenant_id))"
    victim = f"INSERT INTO {TBL} (email, tenant_id, name) VALUES ('a@x', 2, 'victim')"
    mine = [{"email": "a@x", "tenant_id": 1, "name": "mine"}]

    _table(driver, ddl, victim)
    assert _rows(driver, f"INSERT INTO {TBL} (email, name, tenant_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email, tenant_id*/", ["a@x", "mine", 1]) == mine

    # A multi-row VALUES upsert: every row's key tuple, never the first row's alone.
    _table(driver, ddl, victim)
    assert _rows(driver, f"INSERT INTO {TBL} (email, name, tenant_id) VALUES (?, ?, ?), (?, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email, tenant_id*/", ["a@x", "mine", 1, "b@x", "mine", 1]) == mine + [{"email": "b@x", "tenant_id": 1, "name": "mine"}]

    _table(driver, ddl, victim)
    payload = json.dumps([{"email": "a@x", "name": "mine", "tenant_id": 1}])
    assert _rows(driver, f"INSERT INTO {TBL} (email, name, tenant_id) SELECT JSON_UNQUOTE(jt.email), JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(email JSON PATH '$.email', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email,tenant_id*/", [payload]) == mine

    # ON u.id = … AND u.tenant_id = …: the victim shares the FIRST key column (id) only.
    _table(driver, "(tenant_id INT NOT NULL, id INT NOT NULL, name VARCHAR(64), PRIMARY KEY (tenant_id, id))",
           f"INSERT INTO {TBL} (tenant_id, id, name) VALUES (2, 7, 'victim')")
    payload = json.dumps([{"id": 7, "tenant_id": 1, "name": "hijack"}])
    assert _rows(driver, f"UPDATE {TBL} AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(id BIGINT PATH '$.id', tenant_id BIGINT PATH '$.tenant_id', name JSON PATH '$.name')) AS v ON u.id = v.id AND u.tenant_id = v.tenant_id SET u.name = JSON_UNQUOTE(v.name) RETURNING tenant_id, id, name", [payload]) == []


# ── #359 — an insert-or-ignore returns only the row it inserted, never the conflicting row ───────


def test_mysql_returning_insert_ignore(driver):
    # AUTO_INCREMENT key: inserted ⇔ the insert id is not 0.
    _table(driver, "(id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(64) NOT NULL, name VARCHAR(64), UNIQUE KEY uq (email))",
           f"INSERT INTO {TBL} (email, name) VALUES ('a@x', 'victim')")
    ignore_auto_inc = f"INSERT INTO {TBL} (email, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE email = email RETURNING email, name /*scp:pk=id;ai=id;conflict=email;action=ignore*/"
    assert _rows(driver, ignore_auto_inc, ["a@x", "mine"]) == []
    assert _rows(driver, ignore_auto_inc, ["b@x", "mine"]) == [{"email": "b@x", "name": "mine"}]

    # Client-supplied key: decided by its PK lock, never by the affected count — so the same on a
    # connection with CLIENT_FOUND_ROWS (a no-op conflict and an insert both report 1) as without it.
    import pymysql
    from pymysql.constants import CLIENT
    from litedbmodel_runtime.driver import _conn_all, _qmark_to_pyformat

    client_ddl = "(code VARCHAR(16) PRIMARY KEY, owner VARCHAR(64))"
    victim = f"INSERT INTO {TBL} (code, owner) VALUES ('X1', 'victim')"
    ignore_client = f"INSERT INTO {TBL} (code, owner) VALUES (?, ?) ON DUPLICATE KEY UPDATE code = code RETURNING code, owner /*scp:pk=code;ai=;conflict=code;action=ignore*/"
    unique_ddl = "(id VARCHAR(36) PRIMARY KEY, email VARCHAR(64) NOT NULL, owner VARCHAR(64), UNIQUE KEY uq (email))"
    unique_victim = f"INSERT INTO {TBL} (id, email, owner) VALUES ('u-1', 'a@x', 'victim')"
    ignore_unique = f"INSERT INTO {TBL} (email, id, owner) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE email = email RETURNING id, email, owner /*scp:pk=id;ai=;conflict=email;action=ignore*/"
    found_rows = pymysql.connect(
        host=os.environ.get("TEST_MYSQL_HOST", "127.0.0.1"), port=int(os.environ.get("TEST_MYSQL_PORT", "3307")),
        user=os.environ.get("TEST_MYSQL_USER", "testuser"), password=os.environ.get("TEST_MYSQL_PASSWORD", "testpass"),
        database=os.environ.get("TEST_MYSQL_DB", "testdb"), autocommit=True, client_flag=CLIENT.FOUND_ROWS,
    )
    runs = {
        "default": lambda sql, params: _rows(driver, sql, params),
        "client_found_rows": lambda sql, params: _conn_all(found_rows, sql, params, _qmark_to_pyformat, True),
    }
    try:
        for name, run in runs.items():
            _table(driver, client_ddl, victim)
            assert run(ignore_client, ["X2", "mine"]) == [{"code": "X2", "owner": "mine"}], name
            assert run(ignore_client, ["X1", "mine"]) == [], name
            # A conflict on another unique key — the conflict key taken, or the PK taken — returns nothing.
            _table(driver, unique_ddl, unique_victim)
            assert run(ignore_unique, ["a@x", "u-2", "mine"]) == [], name
            assert run(ignore_unique, ["b@x", "u-1", "mine"]) == [], name
            assert run(ignore_unique, ["b@x", "u-3", "mine"]) == [{"id": "u-3", "email": "b@x", "owner": "mine"}], name
    finally:
        found_rows.close()

    # READ COMMITTED: another session inserts the same key while ours is in flight — its row is never
    # returned. A BEFORE INSERT trigger parks OUR insert (owner 'mine') on a row another session holds, so
    # the other session's insert of the same key lands exactly between a lock and the write.
    _insert_ignore_race(driver, client_ddl, ignore_client)

    # Batch (INSERT IGNORE) on a client-supplied key: the pre-existing row read back fails it closed.
    _table(driver, client_ddl, victim)
    batch = f"INSERT IGNORE INTO {TBL} (code, owner) SELECT JSON_UNQUOTE(jt.code), JSON_UNQUOTE(jt.owner) FROM JSON_TABLE(?, '$[*]' COLUMNS(code JSON PATH '$.code', owner JSON PATH '$.owner')) jt RETURNING code, owner /*scp:pk=code;ai=;conflict=code;action=ignore*/"
    with pytest.raises(ValueError, match=r"wrote 1 row\(s\) but its RETURNING recovery found 2"):
        _rows(driver, batch, [json.dumps([{"code": "X1", "owner": "mine"}, {"code": "X2", "owner": "mine"}])])
    assert _rows(driver, batch, [json.dumps([{"code": "X3", "owner": "mine"}])]) == [{"code": "X3", "owner": "mine"}]


def _raw_conn():
    import pymysql

    return pymysql.connect(
        host=os.environ.get("TEST_MYSQL_HOST", "127.0.0.1"), port=int(os.environ.get("TEST_MYSQL_PORT", "3307")),
        user=os.environ.get("TEST_MYSQL_USER", "testuser"), password=os.environ.get("TEST_MYSQL_PASSWORD", "testpass"),
        database=os.environ.get("TEST_MYSQL_DB", "testdb"), autocommit=True,
    )


def _insert_ignore_race(driver, ddl: str, ignore: str) -> None:
    """Run the insert-or-ignore ``ignore`` (code, owner) for key K1 under READ COMMITTED while another
    session inserts K1 — parked by a trigger until that other row is committed — and check that the other
    session's row is never returned as ours."""
    import threading

    from litedbmodel_runtime.driver import _conn_all, _qmark_to_pyformat

    gate = f"{TBL}_gate"
    _table(driver, ddl)
    driver.exec_ddl([
        f"DROP TABLE IF EXISTS {gate}", f"CREATE TABLE {gate} (id INT PRIMARY KEY)", f"INSERT INTO {gate} (id) VALUES (1)",
        f"CREATE TRIGGER {TBL}_park BEFORE INSERT ON {TBL} FOR EACH ROW BEGIN "
        f"IF NEW.owner = 'mine' THEN SELECT id INTO @scp_park FROM {gate} WHERE id = 1 FOR UPDATE; END IF; END",
    ])
    holder, ours = _raw_conn(), _raw_conn()
    try:
        hc = holder.cursor()
        hc.execute("BEGIN")
        hc.execute(f"SELECT id FROM {gate} WHERE id = 1 FOR UPDATE")
        ours.cursor().execute("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED")
        got: dict = {}

        def run() -> None:
            try:
                got["rows"] = _conn_all(ours, ignore, ["K1", "mine"], _qmark_to_pyformat, True)
            except Exception as e:  # surfaced by the assertion below
                got["err"] = e

        t = threading.Thread(target=run)
        t.start()
        _until_running(holder, "SELECT id INTO @scp_park ")  # ours: parked in its trigger, before its row
        driver.exec_ddl([f"INSERT INTO {TBL} (code, owner) VALUES ('K1', 'victim')"])  # committed
        hc.execute("COMMIT")
        t.join(30)
        assert got == {"rows": []}
    finally:
        holder.close()
        ours.close()
        driver.exec_ddl([f"DROP TABLE IF EXISTS {gate}"])


def _until_running(conn, prefix: str) -> None:
    """Poll the server until a thread runs a statement starting with ``prefix``, then let it block."""
    import time

    cur = conn.cursor()
    for _ in range(200):
        cur.execute("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE INFO LIKE %s", (prefix + "%",))
        if cur.fetchone()[0] > 0:
            time.sleep(0.3)
            cur.close()
            return
        time.sleep(0.02)
    raise AssertionError(f"no thread ever ran {prefix!r}…")


# ── #360 — a bulk INSERT…RETURNING returns its own rows, not the ids another session took between them ──


def test_mysql_returning_bulk_auto_inc(driver):
    import threading

    create_many = f"INSERT INTO {TBL} (tenant_id, uk) SELECT jt.tenant_id, JSON_UNQUOTE(jt.uk) FROM JSON_TABLE(?, '$[*]' COLUMNS(tenant_id BIGINT PATH '$.tenant_id', uk JSON PATH '$.uk')) jt RETURNING uk, tenant_id /*scp:pk=id;ai=id*/"
    mine = [{"uk": uk, "tenant_id": 1} for uk in ("k1", "k2", "k3", "k4")]
    payload = json.dumps([{"tenant_id": 1, "uk": uk} for uk in ("k1", "k2", "k3", "k4")])

    # A bounded two-connection schedule: the other session holds a gap lock the bulk insert must wait
    # on, inserts its own row (taking the next id) while the bulk insert is blocked mid-way, and commits.
    _table(driver, "(id INT AUTO_INCREMENT PRIMARY KEY, uk VARCHAR(32) NOT NULL, tenant_id INT NOT NULL, UNIQUE KEY uq (uk))",
           f"INSERT INTO {TBL} (uk, tenant_id) VALUES ('seed', 0)")
    other = _raw_conn()
    try:
        cur = other.cursor()
        cur.execute("BEGIN")
        cur.execute(f"SELECT id FROM {TBL} WHERE uk = 'k3' FOR UPDATE")
        result = {}

        def run():
            try:
                result["rows"] = _rows(driver, create_many, [payload])
            except Exception as e:  # surfaced below
                result["err"] = e

        t = threading.Thread(target=run)
        t.start()
        _until_running(other, f"INSERT INTO {TBL} ")
        cur.execute(f"INSERT INTO {TBL} (uk, tenant_id) VALUES ('zz', 2)")
        cur.execute("COMMIT")
        t.join(30)
        assert "err" not in result, result.get("err")
        assert result["rows"] == mine
    finally:
        other.close()
    # The foreign row did land between the bulk insert's ids — the bare id range named it.
    assert [r["uk"] for r in _rows(driver, f"SELECT uk FROM {TBL} ORDER BY id", [])] == ["seed", "k1", "zz", "k2", "k3", "k4"]

    # A non-concurrent createMany keeps returning exactly its rows.
    _table(driver, "(id INT AUTO_INCREMENT PRIMARY KEY, uk VARCHAR(32) NOT NULL, tenant_id INT NOT NULL)")
    assert _rows(driver, create_many, [payload]) == mine


# ── #361 — an UPDATE…RETURNING returns the rows it updated, keyed before the write ──────────────────


def test_mysql_returning_update_by_key(driver):
    _table(driver, "(id INT PRIMARY KEY, state VARCHAR(16) NOT NULL)",
           f"INSERT INTO {TBL} (id, state) VALUES (1, 'open'), (2, 'open'), (3, 'done')")
    # A state transition: the SET changes the WHERE column, so the WHERE no longer matches afterwards.
    got = _rows(driver, f"UPDATE {TBL} SET state = ? WHERE state = ? RETURNING id, state /*scp:pk=id;ai=*/", ["claimed", "open"])
    assert got == [{"id": 1, "state": "claimed"}, {"id": 2, "state": "claimed"}]


# ── #362 — a DELETE…RETURNING returns only the rows it deleted ────────────────────────────────────


def test_mysql_returning_delete_locked(driver):
    delete = f"DELETE FROM {TBL} WHERE id = ? RETURNING id, state /*scp:pk=id;ai=*/"
    _table(driver, "(id INT PRIMARY KEY, state VARCHAR(16) NOT NULL)", f"INSERT INTO {TBL} (id, state) VALUES (8, 'open'), (5, 'open')")
    # Another session deletes the row after OUR snapshot: a plain pre-image still sees it.
    tx = driver.begin_tx()
    try:
        tx.run("START TRANSACTION WITH CONSISTENT SNAPSHOT", [])
        other = _raw_conn()
        try:
            other.cursor().execute(f"DELETE FROM {TBL} WHERE id = 8")
        finally:
            other.close()
        assert tx.all(delete, [8]) == []
        tx.run("COMMIT", [])
    finally:
        tx.release(False)
    # A row it did delete is returned.
    assert _rows(driver, delete, [5]) == [{"id": 5, "state": "open"}]


# ── #379 — a batch RETURNING compares its keys the way the write did (BIGINT past 2^53) ──────────


def test_mysql_returning_bigint_key(driver):
    """Through the write's own JSON_TABLE declaration (``k BIGINT PATH``): re-read as the JSON_UNQUOTE
    string, a BIGINT key compares as DOUBLE, and past 2^53 every neighbouring key in the same double
    matches. Each key column is UNINDEXED, so the re-select scans (an index lookup would hide it)."""

    def seed(ddl: str, ours: bool) -> None:
        # Our two keys 2^60+1 / 2^60+14, among 38 other-tenant rows whose keys round to the same doubles.
        rows = [
            f"INSERT INTO {TBL} (k, tenant_id, name) VALUES (1152921504606846976 + {i}, {1 if i in (1, 14) else 2}, 'theirs')"
            for i in range(1, 41)
            if ours or i not in (1, 14)
        ]
        _table(driver, ddl, *rows)

    payload = '[{"k":1152921504606846977,"name":"mine","tenant_id":1},{"k":1152921504606846990,"name":"mine","tenant_id":1}]'
    failures = []

    def count(what: str, sql: str) -> None:
        try:
            got = _rows(driver, sql, [payload])
        except ValueError as e:
            failures.append(f"{what}: {e}")
            return
        if len(got) != 2:
            failures.append(f"{what}: RETURNING returned {len(got)} rows, want the 2 it wrote")

    seed("(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", True)
    count("updateMany", f"UPDATE {TBL} AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(k BIGINT PATH '$.k', name JSON PATH '$.name')) AS v ON u.k = v.k SET u.name = JSON_UNQUOTE(v.name) RETURNING k, tenant_id")
    # #384: the write reads each key by its OWN rule — the JSON value (no declared type), a declared
    # numeric type, or unquoted text — so the re-select must read it with the write's own expression.
    seed("(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", True)
    count("updateMany, no declared type", f"UPDATE {TBL} AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(k JSON PATH '$.k', name JSON PATH '$.name')) AS v ON u.k = v.k SET u.name = JSON_UNQUOTE(v.name) RETURNING k, tenant_id")
    seed("(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", True)
    count("updateMany, declared BIGINT", f"UPDATE {TBL} AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(k DECIMAL(65,30) PATH '$.k', name JSON PATH '$.name')) AS v ON u.k = v.k SET u.name = JSON_UNQUOTE(v.name) RETURNING k, tenant_id")

    seed("(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", False)
    count("upsertMany", f"INSERT INTO {TBL} (k, name, tenant_id) SELECT jt.k, JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(k BIGINT PATH '$.k', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt ON DUPLICATE KEY UPDATE k = VALUES(k), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING k, tenant_id /*scp:pk=id;ai=id;conflict=k*/")

    seed("(k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", False)
    count("createMany", f"INSERT INTO {TBL} (k, name, tenant_id) SELECT jt.k, JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(k BIGINT PATH '$.k', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt RETURNING k, tenant_id /*scp:pk=k;ai=*/")

    # A string (UUID) key the write reads as unquoted text.
    def uuid(i: int) -> str:
        return f"0b0d8a52-7a7e-4c43-9a8e-{i:012d}"

    def seed_text(ddl: str, ours: bool) -> None:
        rows = [
            f"INSERT INTO {TBL} (k, tenant_id, name) VALUES ('{uuid(i)}', {1 if i in (1, 14) else 2}, 'theirs')"
            for i in range(1, 41)
            if ours or i not in (1, 14)
        ]
        _table(driver, ddl, *rows)

    payload = json.dumps([{"k": uuid(1), "name": "mine", "tenant_id": 1}, {"k": uuid(14), "name": "mine", "tenant_id": 1}])
    text_ddl = "(id INT AUTO_INCREMENT PRIMARY KEY, k VARCHAR(36) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))"
    seed_text(text_ddl, True)
    count("updateMany, UUID key", f"UPDATE {TBL} AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(k JSON PATH '$.k', name JSON PATH '$.name')) AS v ON u.k = JSON_UNQUOTE(v.k) SET u.name = JSON_UNQUOTE(v.name) RETURNING k, tenant_id")
    seed_text(text_ddl, False)
    count("upsertMany, UUID key", f"INSERT INTO {TBL} (k, name, tenant_id) SELECT JSON_UNQUOTE(jt.k), JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(k JSON PATH '$.k', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt ON DUPLICATE KEY UPDATE k = VALUES(k), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING k, tenant_id /*scp:pk=id;ai=id;conflict=k*/")
    seed_text("(k VARCHAR(36) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))", False)
    count("createMany, UUID key", f"INSERT INTO {TBL} (k, name, tenant_id) SELECT JSON_UNQUOTE(jt.k), JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(k JSON PATH '$.k', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt RETURNING k, tenant_id /*scp:pk=k;ai=*/")

    assert failures == []
