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

    _table(driver, ddl, victim)
    payload = json.dumps([{"email": "a@x", "name": "mine", "tenant_id": 1}])
    assert _rows(driver, f"INSERT INTO {TBL} (email, name, tenant_id) SELECT JSON_UNQUOTE(jt.email), JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '$[*]' COLUMNS(email JSON PATH '$.email', name JSON PATH '$.name', tenant_id BIGINT PATH '$.tenant_id')) jt ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email,tenant_id*/", [payload]) == mine

    # ON u.id = … AND u.tenant_id = …: the victim shares the FIRST key column (id) only.
    _table(driver, "(tenant_id INT NOT NULL, id INT NOT NULL, name VARCHAR(64), PRIMARY KEY (tenant_id, id))",
           f"INSERT INTO {TBL} (tenant_id, id, name) VALUES (2, 7, 'victim')")
    payload = json.dumps([{"id": 7, "tenant_id": 1, "name": "hijack"}])
    assert _rows(driver, f"UPDATE {TBL} AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(id BIGINT PATH '$.id', tenant_id BIGINT PATH '$.tenant_id', name JSON PATH '$.name')) AS v ON u.id = v.id AND u.tenant_id = v.tenant_id SET u.name = JSON_UNQUOTE(v.name) RETURNING tenant_id, id, name", [payload]) == []
