"""The DYNAMIC (SKIP) WHERE assembled by the ``executeSQL`` leaf (#192, python port).

The python leg of "the same behaviour in all five languages" — the twin of the rust
``dynamic_where_continues_a_bounded_where``, the go ``TestExecuteSQL_DynamicWhereContinuesBoundedWhere``,
the php ``DynamicWhereTest`` and the TS ``leaves.test.ts`` SKIP tests.

CLAUDE.md §2: the emitter lowers a read's BOUNDED predicates into the statement's own static WHERE and
carries ONLY the actually-optional ones as ``{skipped, sql, params}`` fragments, so the leaf has to
CONTINUE that WHERE with ``AND`` (a second ``WHERE`` is a syntax error) and bind the survivors' params
at the slot their ``?``s occupy — after the bounded values, before the page tail's counts.
"""

from __future__ import annotations

import sqlite3

import pytest

from litedbmodel_runtime.driver import SqliteDriver
from litedbmodel_runtime.leaves import make_handlers

CTX = {"nodeId": "n0", "component": "executeSQL"}

#: A MIXED read exactly as the emitter now lowers it: the bounded `id > ?` IS the statement's WHERE and
#: the page count binds after it.
BASE_SQL = "SELECT id FROM t WHERE id > ? ORDER BY id LIMIT ?"


@pytest.fixture()
def execute_sql():
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    conn.executemany("INSERT INTO t (id, v) VALUES (?, ?)", [(1, "a"), (2, "b"), (3, "c")])
    return make_handlers(SqliteDriver(conn), "sqlite")["executeSQL"]


def read(execute_sql, frags):
    return execute_sql(
        {
            "sql": BASE_SQL,
            "params": [1, 2],
            # Everything besides the statement rides in the ONE ``opts`` control record (#193).
            "opts": {"write": False, "returning": False, "whereDynamic": {"frags": frags}, "guard": None},
        },
        CTX,
    )["ok"]


def test_dynamic_where_continues_a_bounded_where(execute_sql):
    # `id > 1 AND v = 'c' ORDER BY id LIMIT 2` selects exactly row 3. Any other assembly fails loud or
    # empty: a second ` WHERE ` is a syntax error, and any other param order binds `id > 'c'` / `v = 1`.
    rows = read(execute_sql, [{"skipped": False, "sql": "v = ?", "params": ["c"]}])
    assert [r["id"] for r in rows] == [3]


def test_a_skipped_fragment_is_dropped_from_text_and_binding(execute_sql):
    # The skipped fragment's param is never bound (else the bind count would not match the `?`s).
    rows = read(
        execute_sql,
        [
            {"skipped": True, "sql": "v = ?", "params": [None]},
            {"skipped": False, "sql": "v <> ?", "params": ["b"]},
        ],
    )
    assert [r["id"] for r in rows] == [3]


def test_every_fragment_skipped_runs_the_statement_as_compiled(execute_sql):
    # No survivor ⇒ the emitted statement is untouched: its OWN bounded WHERE + page tail still apply.
    rows = read(execute_sql, [{"skipped": True, "sql": "v = ?", "params": [None]}])
    assert [r["id"] for r in rows] == [2, 3]
