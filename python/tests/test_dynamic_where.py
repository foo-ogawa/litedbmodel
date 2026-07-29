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

from litedbmodel_runtime import (
    ConnectionRegistry,
    LimitExceededError,
    RoutingConfig,
    WriterStickyClock,
    reader_writer_pair,
)
from litedbmodel_runtime.connection_routing import ConnectionPool
from litedbmodel_runtime.driver import SqliteDriver
from litedbmodel_runtime.exec_context import ExecutionContext, MiddlewareChain
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


# #205 — a field ABSENT from a PRESENT struct, or present with the WRONG TYPE, is an ABI BREAK, never an
# absent VALUE. bc types a port by the literal wired into it and REJECTS a partial struct, so a generated
# module always spells every field of every struct it wires, with the type the port declares (``None`` is
# how absence is spelled). Neither shape came from one, and defaulting or coercing it would silently
# downgrade a write to a read, drop a relation cap, or erase a SKIP predicate. The five languages must
# agree; this is the python leg.
def _plan(frag):
    """Ports whose control record carries a `whereDynamic` plan of ONE fragment (the #209 cases)."""
    return {
        "sql": "SELECT id, v FROM t ORDER BY id",
        "params": [],
        "opts": {"write": None, "whereDynamic": {"frags": [frag]}, "guard": None},
    }


def _opts(**kw):
    """Ports whose control record has ONE field replaced (every other field spelled as its null)."""
    return {
        "sql": "SELECT id, v FROM t ORDER BY id",
        "params": [],
        "opts": {"write": None, "whereDynamic": None, "guard": None, **kw},
    }


def test_a_missing_or_mistyped_field_of_a_present_struct_is_loud(execute_sql):
    sql = "SELECT id, v FROM t ORDER BY id"
    cap = {"limit": 2, "model": "t", "relation": "things"}

    # Each case breaks exactly ONE declared field of a struct that is present — by DROPPING it first…
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
        # A field of the WRONG TYPE is the same ABI break, in every one of those positions: bc emits the
        # literal the port's type says, so nothing else can arrive from a generated module, and coercing
        # it is how a ``returning`` that is not a bool ran an INSERT on the READ seam and a ``skipped``
        # that is not a bool applied a predicate the call SKIPPED — the #209 failure modes, reached by
        # another route.
        ({"sql": 42, "params": []}, "payload's 'sql' must be string"),
        ({"sql": sql, "params": "x"}, "payload's 'params' must be list"),
        ({"sql": sql, "params": [], "opts": "nope"}, "payload's 'opts' must be record|null"),
        (_opts(write="nope"), "control record's 'write' must be record|null"),
        (_opts(write={"returning": "nope"}), "'write' mode's 'returning' must be bool"),
        (_opts(write={"returning": 0}), "'write' mode's 'returning' must be bool"),
        (_opts(whereDynamic="nope"), "control record's 'whereDynamic' must be record|null"),
        (_opts(whereDynamic={"frags": "nope"}), "'whereDynamic' plan's 'frags' must be list"),
        (_opts(guard="nope"), "control record's 'guard' must be record|null"),
        (_opts(guard={"limit": "nope", "model": "t", "relation": "things"}), "'guard' cap's 'limit' must be int"),
        (_opts(guard={"limit": 2.5, "model": "t", "relation": "things"}), "'guard' cap's 'limit' must be int"),
        (_opts(guard={"limit": 2, "model": 42, "relation": "things"}), "'guard' cap's 'model' must be string|null"),
        (_opts(guard={"limit": 2, "model": "t", "relation": 42}), "'guard' cap's 'relation' must be string"),
        (_plan("nope"), "fragment must be record"),
        (_plan({"skipped": "no", "sql": "v = ?", "params": ["zzz"]}), "fragment's 'skipped' must be bool"),
        (_plan({"skipped": False, "sql": 42, "params": []}), "fragment's 'sql' must be string"),
        (_plan({"skipped": False, "sql": "v = ?", "params": "z"}), "fragment's 'params' must be list"),
    ]
    for ports, want in cases:
        with pytest.raises(ValueError) as ei:
            execute_sql(ports, CTX)
        assert want in str(ei.value), f"{ports}: {ei.value} does not name the broken field ({want})"

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


# #207 — the leaf hands the central seam ONE StatementIntent, derived from the statement's RUN MODE, and
# ``ExecutionContext.connection_for`` resolves the CONNECTION from it (``resolve_pool``: write ⇒ the
# writer pool). The branch that selects the SEAM is a DIFFERENT question: a RETURNING write runs on the
# ROW seam (``seam_execute``) and is still a write. Deriving the intent from the branch — which is what
# this transport did — sent ``INSERT … RETURNING`` to the READ REPLICA.
#
# The conformance/livedb setups run reader === writer (every intent returns the same pool), which is why
# no cross-language leg saw this; the gate therefore SPLITS the pair and records which pool served each
# statement. The python leg of the five.


class _RecordingPool(ConnectionPool):
    """A pool that records its label on every acquire and hands out ONE shared raw connection, so a test
    can assert WHICH pool (reader vs writer) ``resolve_pool`` selected for a leaf's statement while the
    SQL really runs. The go/rust/TS/php legs use the same recording-pool instrument."""

    def __init__(self, label, conn, log):
        self._label = label
        self._conn = conn
        self._log = log

    def acquire(self):
        self._log.append(self._label)
        return self._conn

    def release(self, conn, destroy=False):
        pass


def test_the_run_mode_not_the_seam_branch_picks_the_pool():
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")
    log: list = []
    routing = RoutingConfig(
        ConnectionRegistry.from_default(
            reader_writer_pair(_RecordingPool("reader", conn, log), _RecordingPool("writer", conn, log))
        ).build(),
        WriterStickyClock(use_writer_after_transaction=False),
    )
    execute_sql = make_handlers(ExecutionContext(None, MiddlewareChain(), routing=routing), "sqlite")["executeSQL"]

    # A plain READ — the bounded payload that omits the control record entirely → the READER.
    execute_sql({"sql": "SELECT id FROM users", "params": []}, CTX)
    assert log == ["reader"]

    # A RETURNING write → the WRITER, even though it runs on the ROW seam. This is the #207 case: with
    # the intent taken from the branch it landed on the reader above.
    returning = execute_sql(
        {
            "sql": "INSERT INTO users (name) VALUES (?) RETURNING id",
            "params": ["A"],
            "opts": {"write": {"returning": True}, "whereDynamic": None, "guard": None},
        },
        CTX,
    )
    assert log == ["reader", "writer"]
    # …and the two decisions are INDEPENDENT, not accidentally aligned: it really did take the ROW seam.
    assert returning == {"ok": [{"id": 1}]}

    # A NON-returning write → the WRITER too (the half that was already right stays right).
    summary = execute_sql(
        {
            "sql": "INSERT INTO users (name) VALUES (?)",
            "params": ["B"],
            "opts": {"write": {"returning": False}, "whereDynamic": None, "guard": None},
        },
        CTX,
    )
    assert log == ["reader", "writer", "writer"]
    assert summary == {"ok": [{"changes": 1, "lastInsertRowid": 2}]}
