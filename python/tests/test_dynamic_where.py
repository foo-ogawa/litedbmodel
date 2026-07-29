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

from litedbmodel_runtime import LimitExceededError
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
            "opts": {"write": None, "whereDynamic": {"frags": frags}, "guard": None},
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


# #205 — a field ABSENT from a PRESENT struct is an ABI BREAK, never an absent VALUE. bc types a port by
# the literal wired into it and REJECTS a partial struct, so a generated module always spells every field
# of every struct it wires (``None`` is how absence is spelled). A key that is not there did not come
# from one, and defaulting it would silently downgrade a write to a read, drop a relation cap, or erase a
# SKIP predicate. The five languages must agree; this is the python leg.
def _plan(frag):
    """Ports whose control record carries a `whereDynamic` plan of ONE fragment (the #209 cases)."""
    return {
        "sql": "SELECT id, v FROM t ORDER BY id",
        "params": [],
        "opts": {"write": None, "whereDynamic": {"frags": [frag]}, "guard": None},
    }


def test_a_missing_field_of_a_present_struct_is_loud(execute_sql):
    sql = "SELECT id, v FROM t ORDER BY id"
    cap = {"limit": 2, "model": "t", "relation": "things"}

    # Each case drops exactly ONE declared field of a struct that is present.
    cases = [
        ({"params": []}, "'sql' field"),
        ({"sql": sql}, "'params' field"),
        ({"sql": sql, "params": [], "opts": {"whereDynamic": None, "guard": None}}, "'write' field"),
        ({"sql": sql, "params": [], "opts": {"write": None, "guard": None}}, "'whereDynamic' field"),
        ({"sql": sql, "params": [], "opts": {"write": None, "whereDynamic": None}}, "'guard' field"),
        ({"sql": sql, "params": [], "opts": {"write": {}, "whereDynamic": None, "guard": None}}, "'returning' field"),
        (
            {"sql": sql, "params": [], "opts": {"write": None, "whereDynamic": None, "guard": {"limit": 2, "relation": "things"}}},
            "'model' field",
        ),
        # …and the PLAN and its FRAGMENTS, one level further down (#209).
        ({"sql": sql, "params": [], "opts": {"write": None, "whereDynamic": {}, "guard": None}}, "'frags' field"),
        (_plan({"sql": "v = ?", "params": ["zzz"]}), "'skipped' field"),
        (_plan({"skipped": False, "params": ["zzz"]}), "'sql' field"),
        (_plan({"skipped": False, "sql": "v = ?"}), "'params' field"),
        # A SKIPPED fragment is unboxed too — it is spelled in full like any other.
        (_plan({"skipped": True, "params": ["zzz"]}), "'sql' field"),
    ]
    for ports, want in cases:
        with pytest.raises(ValueError) as ei:
            execute_sql(ports, CTX)
        assert want in str(ei.value), f"{ports}: {ei.value} does not name the missing field ({want})"

    # The LEGAL absences stay silent: an omitted record is a plain read, and a null FIELD is how an
    # absent write mode / plan / cap is spelled.
    assert len(execute_sql({"sql": sql, "params": []}, CTX)["ok"]) == 3
    all_null = {"write": None, "whereDynamic": None, "guard": None}
    assert len(execute_sql({"sql": sql, "params": [], "opts": all_null}, CTX)["ok"]) == 3
    # …and a cap that IS spelled still trips (the fail-closed reads did not disarm it).
    with pytest.raises(LimitExceededError):
        execute_sql({"sql": sql, "params": [], "opts": {**all_null, "guard": cap}}, CTX)
    # A WELL-FORMED plan still assembles: the surviving fragment applies, the skipped one does not.
    assert [r["id"] for r in execute_sql(_plan({"skipped": False, "sql": "v = ?", "params": ["c"]}), CTX)["ok"]] == [3]
    assert len(execute_sql(_plan({"skipped": True, "sql": "v = ?", "params": [None]}), CTX)["ok"]) == 3
