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
    single_pool_pair,
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
            "opts": {"db": None, "write": None, "whereDynamic": {"frags": frags}, "guard": None},
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
        "opts": {"db": None, "write": None, "whereDynamic": {"frags": [frag]}, "guard": None},
    }


def _opts(**kw):
    """Ports whose control record has ONE field replaced (every other field spelled as its null)."""
    return {
        "sql": "SELECT id, v FROM t ORDER BY id",
        "params": [],
        "opts": {"db": None, "write": None, "whereDynamic": None, "guard": None, **kw},
    }


def test_a_missing_or_mistyped_field_of_a_present_struct_is_loud(execute_sql):
    sql = "SELECT id, v FROM t ORDER BY id"
    cap = {"limit": 2, "model": "t", "relation": "things"}

    # Each case breaks exactly ONE declared field of a struct that is present — by DROPPING it first…
    cases = [
        ({"params": []}, "'sql' field"),
        ({"sql": sql}, "'params' field"),
        ({"sql": sql, "params": [], "opts": {"guard": None, "whereDynamic": None, "write": None}}, "'db' field"),
        ({"sql": sql, "params": [], "opts": {"db": None, "whereDynamic": None, "guard": None}}, "'write' field"),
        ({"sql": sql, "params": [], "opts": {"db": None, "write": None, "guard": None}}, "'whereDynamic' field"),
        ({"sql": sql, "params": [], "opts": {"db": None, "write": None, "whereDynamic": None}}, "'guard' field"),
        ({"sql": sql, "params": [], "opts": {"db": None, "write": {}, "whereDynamic": None, "guard": None}}, "'returning' field"),
        (
            {"sql": sql, "params": [], "opts": {"db": None, "write": None, "whereDynamic": None, "guard": {"limit": 2, "relation": "things"}}},
            "'model' field",
        ),
        # …and the PLAN and its FRAGMENTS, one level further down (#209).
        ({"sql": sql, "params": [], "opts": {"db": None, "write": None, "whereDynamic": {}, "guard": None}}, "'frags' field"),
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
    all_null = {"db": None, "write": None, "whereDynamic": None, "guard": None}
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
            "opts": {"db": None, "write": {"returning": True}, "whereDynamic": None, "guard": None},
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
            "opts": {"db": None, "write": {"returning": False}, "whereDynamic": None, "guard": None},
        },
        CTX,
    )
    assert log == ["reader", "writer", "writer"]
    assert summary == {"ok": [{"changes": 1, "lastInsertRowid": 2}]}


# #213 — ``pluck`` / ``group`` read their ports through the SAME fail-closed reader as the SQL transport.
# Their ports are FLAT, which is not a reason to trust them: the generator spells every one with the type
# the catalog declares, so anything else is an ABI break — and on ``group`` the break is SILENT and
# changes the SHAPE of the returned graph. A ``single`` that is not a bool flipped the relation's
# CARDINALITY, an ``into`` that is not a string nested the children under a stringified number, and an
# absent ``pk``/``col`` surfaced as a bare ``KeyError`` that named no port at all. The python leg.


def test_a_missing_or_mistyped_pluck_or_group_port_is_loud():
    handlers = make_handlers(SqliteDriver(sqlite3.connect(":memory:")), "sqlite")
    rows = [{"id": 1}, {"id": 2}]
    kids = [{"post_id": 1, "t": "a"}, {"post_id": 1, "t": "b"}]
    pluck_ports = lambda **kw: {"rows": rows, "col": ["id"], **kw}  # noqa: E731
    group_ports = lambda **kw: {  # noqa: E731
        "parents": rows, "children": kids, "pk": ["id"], "fk": ["post_id"], "into": "kids",
        "single": False, **kw,
    }
    drop = lambda ports, name: {k: v for k, v in ports.items() if k != name}  # noqa: E731

    for name in ("rows", "col"):
        with pytest.raises(ValueError, match=rf"the pluck payload is missing its '{name}' field"):
            handlers["pluck"](drop(pluck_ports(), name), CTX)
    for name in ("parents", "children", "pk", "fk", "into", "single"):
        with pytest.raises(ValueError, match=rf"the group payload is missing its '{name}' field"):
            handlers["group"](drop(group_ports(), name), CTX)

    # The MISTYPED ports — the silent failures the issue measured.
    mistyped = [
        ("pluck", pluck_ports(rows="x"), "the pluck payload's 'rows' must be list"),
        ("pluck", pluck_ports(col=[1]), "the pluck payload's 'col' must be string[]"),
        ("group", group_ports(single="yes"), "the group payload's 'single' must be bool"),
        ("group", group_ports(into=42), "the group payload's 'into' must be string"),
        ("group", group_ports(pk=[1]), "the group payload's 'pk' must be string[]"),
        ("group", group_ports(fk="post_id"), "the group payload's 'fk' must be string[]"),
        ("group", group_ports(parents="x"), "the group payload's 'parents' must be list"),
        ("group", group_ports(children="x"), "the group payload's 'children' must be list"),
        # A KEYED map is a ``record`` on this plane, never a list. php's ``is_array`` used to say
        # otherwise, so the case is pinned in all three of the legs that can spell it.
        ("pluck", pluck_ports(rows={"a": 1}), "the pluck payload's 'rows' must be list"),
        ("pluck", pluck_ports(col={"a": "id"}), "the pluck payload's 'col' must be string[]"),
    ]
    for leaf, ports, want in mistyped:
        with pytest.raises(ValueError) as ei:
            handlers[leaf](ports, CTX)
        assert want in str(ei.value), f"{ports}: {ei.value} does not name the broken port ({want})"

    # The LEGAL shapes stay silent, and the CARDINALITY the ports declare is the one that comes out: a
    # hasMany nests the LIST, ``single`` nests the ONE child. (The mistyped ``single`` above used to land
    # on the other branch without a word.)
    assert handlers["pluck"](pluck_ports(), CTX) == {"ok": [1, 2]}
    assert handlers["group"](group_ports(), CTX) == {"ok": [{"id": 1, "kids": kids}, {"id": 2, "kids": []}]}
    assert handlers["group"](group_ports(single=True), CTX) == {
        "ok": [{"id": 1, "kids": kids[0]}, {"id": 2, "kids": None}]
    }


# #215 — a covered-plane transaction is the runtime's ONE transaction: it acquires from the WRITER pool,
# PINS that connection for the whole body, issues its tx-control THROUGH the seam (so a registered
# middleware sees BEGIN/COMMIT) and arms writer-sticky on COMMIT. Python gets all four from
# ``with_transaction`` because the CTX answers WHICH connection a transaction opens on
# (``ExecutionContext.begin_tx`` → ``routed_begin_tx``); go and rust each ran a private BEGIN/COMMIT
# beside the central one and lost some of them. The single-pool conformance/livedb setups cannot tell
# (reader IS writer there), so the gate SPLITS the pair — the python leg of the five.


def test_a_covered_transaction_opens_on_the_writer_and_is_seam_visible():
    from litedbmodel_runtime import with_middleware_scope, create_middleware, use
    from litedbmodel_runtime.exec_context import with_transaction
    from litedbmodel_runtime.middleware import active_sql_middlewares

    conn = sqlite3.connect(":memory:")
    # Autocommit: the runtime tx boundary issues BEGIN/COMMIT explicitly through the seam (the SAME
    # reason SqliteDriver.in_memory sets it).
    conn.isolation_level = None
    conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")
    pools: list = []
    clock = [1_000_000]
    routing = RoutingConfig(
        ConnectionRegistry.from_default(
            reader_writer_pair(_RecordingPool("reader", conn, pools), _RecordingPool("writer", conn, pools))
        ).build(),
        WriterStickyClock(use_writer_after_transaction=True, writer_sticky_duration=5000, now=lambda: clock[0]),
    )
    ctx = ExecutionContext(None, MiddlewareChain(active_sql_middlewares), routing=routing)
    execute_sql = make_handlers(ctx, "sqlite")["executeSQL"]
    seen: list = []

    def read():
        return execute_sql({"sql": "SELECT id FROM users", "params": []}, CTX)

    def observe(_state, next_, sql, params):
        seen.append(sql)
        return next_(sql, params)

    def body():
        use(create_middleware(execute=observe))
        # Before any transaction: a plain read ⇒ the READER (the sticky clock is unarmed).
        read()

        def in_tx(_tx_ctx):
            # A READ inside the tx: its intent says READER, but the tx PIN wins — and it acquires NO
            # further connection, because the pinned one is not drawn from a pool per statement.
            read()
            return execute_sql(
                {
                    "sql": "INSERT INTO users (name) VALUES (?)",
                    "params": ["A"],
                    "opts": {"db": None, "write": {"returning": False}, "whereDynamic": None, "guard": None},
                },
                CTX,
            )

        with_transaction(ctx, in_tx)
        # The COMMIT armed writer-sticky: the SAME plain read now routes to the WRITER (read-your-writes).
        clock[0] += 100
        read()

    with_middleware_scope(body)

    assert pools == ["reader", "writer", "writer"]
    assert seen == [
        "SELECT id FROM users",
        "BEGIN",
        "SELECT id FROM users",
        "INSERT INTO users (name) VALUES (?)",
        "COMMIT",
        "SELECT id FROM users",
    ]


# ── #217 named-DB: the statement's own connection reaches the router, or is LOUD ──────────────────
#
# The ``db`` field of the control record is the ONLY thing that decides WHICH registered connection
# serves the statement. A single-DB fixture cannot tell a honored connection name from a dropped one —
# which is exactly why the defect survived the single-DB conformance and livedb suites — so this gate
# registers TWO connections over TWO SEPARATE in-memory sqlite databases whose tables are DISJOINT:
# ``named_users`` exists ONLY in "B". A statement that lands on the wrong connection therefore does not
# return the wrong rows, it cannot see a table at all.
#
# The python leg of "the same behaviour in all five languages": the twin of the TS ``leaves.test.ts``
# #217 tests, the go ``TestExecuteSQL_NamedDBRoutesTheStatement``, the rust
# ``named_db_routes_the_statement`` and the php ``NamedDbRoutingTest``.


def _named_db_context():
    """The TWO-database routed ctx both named-DB consumers resolve against: DB "A" (the default
    connection) holds an UNRELATED table, DB "B" holds ``named_users``. Returns the ctx plus the log of
    WHICH connection each acquire drew from."""
    a = sqlite3.connect(":memory:")
    # `only_in_a` is also the PARENT page of the cross-DB relation gate below: its rows live on A, their
    # children only on B, so the two halves of one relation genuinely straddle two databases.
    a.execute("CREATE TABLE only_in_a (id INTEGER PRIMARY KEY)")
    a.executemany("INSERT INTO only_in_a VALUES (?)", [(1,), (2,)])
    b = sqlite3.connect(":memory:")
    b.execute("CREATE TABLE named_users (id INTEGER PRIMARY KEY, name TEXT)")
    b.executemany("INSERT INTO named_users VALUES (?, ?)", [(1, "Ada"), (2, "Bob")])
    log: list = []
    routing = RoutingConfig(
        ConnectionRegistry.from_default(single_pool_pair(_RecordingPool("A", a, log)))
        .add("B", single_pool_pair(_RecordingPool("B", b, log)))
        .build(),
        WriterStickyClock(use_writer_after_transaction=False),
    )
    return ExecutionContext(None, MiddlewareChain(), routing=routing), log


def _named_db_handler():
    ctx, log = _named_db_context()
    handler = make_handlers(ctx, "sqlite")["executeSQL"]

    def read(db):
        return handler(
            {
                "sql": "SELECT id, name FROM named_users ORDER BY id",
                "params": [],
                "opts": {"db": db, "write": None, "whereDynamic": None, "guard": None},
            },
            CTX,
        )

    return read, log


def test_named_db_routes_the_statement():
    read, log = _named_db_handler()
    # NAMED ⇒ B served it. The rows are unforgeable: `named_users` exists in NO other registered db.
    assert read("B")["ok"] == [{"id": 1, "name": "Ada"}, {"id": 2, "name": "Bob"}]
    assert log == ["B"]
    # NEGATIVE CONTROL — the name DROPPED (``None``, which is exactly the pre-#217 lowering) sends the
    # SAME statement to the DEFAULT connection, where the table does not exist. Measured, not reasoned:
    # this is the failure a cross-DB relation produced before the emitter lowered the name.
    with pytest.raises(Exception) as ei:
        read(None)
    assert "named_users" in str(ei.value)
    assert log == ["B", "A"]
    # An UNREGISTERED name is LOUD, never a silent fall back to the default.
    with pytest.raises(ValueError, match="no connection registered under name 'ghost'"):
        read("ghost")


def test_named_db_routes_the_relation_batch(relation_through_leaves):
    """A CROSS-DB RELATION through the production path: the parent page reads from the DEFAULT connection
    and the batched child fetch names the TARGET model's database, so one relation's two statements land
    on DIFFERENT servers. The emitter bakes that name into the child fetch's ``db`` control field; here
    the leaf carries it to ``connection_for`` and the ONE ``ConnectionRegistry`` resolves it. The tables
    are DISJOINT, so a mis-routed half sees no table at all."""
    ctx, log = _named_db_context()
    handlers = make_handlers(ctx, "sqlite")
    parent_sql = "SELECT id FROM only_in_a ORDER BY id"
    child_sql = "SELECT id, name FROM named_users WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id"

    # NAMED ⇒ B served the child fetch; the nested row proves it (`named_users` is on NO other connection).
    grouped = relation_through_leaves(handlers, parent_sql, child_sql, "id", "id", "kids", "B")
    assert [k["name"] for k in grouped[0]["kids"]] == ["Ada"]
    assert log == ["A", "B"]  # parent read on the default connection, child fetch on the named one
    # NEGATIVE CONTROL — the SAME relation with the child fetch's name DROPPED (``None``, exactly the
    # pre-#217 lowering) sends it to the DEFAULT connection, where `named_users` does not exist.
    with pytest.raises(Exception) as ei:
        relation_through_leaves(handlers, parent_sql, child_sql, "id", "id", "kids", None)
    assert "named_users" in str(ei.value)
    # An UNREGISTERED name is LOUD, never a silent fall back to the parent's database.
    with pytest.raises(ValueError, match="no connection registered under name 'ghost'"):
        relation_through_leaves(handlers, parent_sql, child_sql, "id", "id", "kids", "ghost")


def test_named_db_on_a_non_routed_context_is_loud():
    # A named statement on a single-driver ctx has no registry to resolve the name against, so it must be
    # LOUD. Running it on the primary driver anyway is the silent wrong-database execution named-DB
    # lowering exists to prevent — and a single-DB deployment is exactly where it would go unnoticed.
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)")
    handler = make_handlers(SqliteDriver(conn), "sqlite")["executeSQL"]
    ports = lambda db: {  # noqa: E731 — one expression, read twice
        "sql": "SELECT id FROM t",
        "params": [],
        "opts": {"db": db, "write": None, "whereDynamic": None, "guard": None},
    }
    with pytest.raises(ValueError, match="a statement names connection 'analytics'"):
        handler(ports("analytics"), CTX)
    # The DEFAULT connection is the single-driver case itself and still runs.
    assert handler(ports(None), CTX)["ok"] == []
