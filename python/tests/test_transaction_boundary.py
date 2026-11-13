"""Phase B-core (#84/#86, python) — UNIT tests for the public transaction() boundary (in-proc SQLite).

No live DB — an in-proc stdlib ``sqlite3`` driver (wrapped in a recording shim that counts begin_tx /
commit / rollback) proves the boundary mechanics that DON'T need PG/MySQL. Every write is issued
through the PRODUCTION guarded write seam (:func:`run_guarded` on the ambient pinned tx ctx) — the same
seam a user-facing write inside ``transaction()`` rides:

  (1) MULTI-OP ATOMICITY — transaction(lambda: [opA_insert(); opB_insert()]) → both commit; the
      recording driver asserts EXACTLY ONE begin_tx / ONE commit / ONE tx handle for the whole boundary
      (the ambient JOIN — opB opens no second BEGIN). opB PK-collides → opA's row ALSO rolls back (ONE
      begin_tx + ONE rollback, zero commit), verified by reading real rows.
  (2) GUARD — a write OUTSIDE transaction() → WriteOutsideTransactionError; a read-only write inside →
      WriteInReadOnlyContextError; inside a boundary → ok.
  (3) NESTED — one begin_tx/commit; an inner error rolls back the whole tx.
  (4) rollback_only — the body runs + returns its value, but NOTHING commits (dry-run).

The live-PG/MySQL isolation + real-contention-retry proof lives in test_tx_boundary_livedb.py.
"""

from __future__ import annotations

import sqlite3
import threading

import pytest

from litedbmodel_runtime import (
    IsolationLevel,
    TransactionOptions,
    WriteInReadOnlyContextError,
    WriteOutsideTransactionError,
    context_for_driver,
    current_context,
    run_guarded,
    run_with_pinned_context,
    transaction,
)
from litedbmodel_runtime.driver import SqliteDriver, _SqliteTxConnection
from litedbmodel_runtime.leaves import make_handlers


ISO_TBL = "scp_tx_boundary_py"
_INSERT_SQL = f"INSERT INTO {ISO_TBL} (id, worker, seq) VALUES (?, ?, ?)"


# ── A recording SQLite driver: counts begin_tx / commit / rollback / distinct handles ──


class _RecTx(_SqliteTxConnection):
    """New contract (Phase D / #95): tx-control flows through :meth:`run` (issued by the combinator via
    the seam), so COMMIT/ROLLBACK are counted HERE when their SQL passes through — not in removed
    ``commit``/``rollback`` methods. BEGIN is likewise a ``run`` call (counted in the driver's begin_tx
    sink for the ambient-JOIN count, and issued via the seam)."""

    def __init__(self, conn, sink):
        super().__init__(conn)
        self._sink = sink

    def run(self, sql, params):
        head = sql.strip().split(" ", 1)[0].upper()
        if head == "COMMIT":
            self._sink["commits"] += 1
        elif head == "ROLLBACK":
            self._sink["rolls"] += 1
        return super().run(sql, params)


class _RecSqliteDriver(SqliteDriver):
    """A SqliteDriver that records tx lifecycle into a shared sink dict (begin_tx / commit / rollback /
    the set of distinct tx handles). Single-conn SQLite, so the whole boundary shares ONE conn — the
    counts prove the ambient JOIN (N ops = ONE begin_tx)."""

    def __init__(self, conn, sink):
        super().__init__(conn)
        self._sink = sink

    def begin_tx(self):
        # New contract: acquire + OWN the conn only; BEGIN is issued by the combinator THROUGH the seam
        # (via _RecTx.run). The begin_tx COUNT still proves the ambient JOIN (N ops = ONE begin_tx).
        self._sink["begin_tx"] += 1
        tx = _RecTx(self.conn, self._sink)
        self._sink["distinct"].add(id(tx))
        return tx


def _fresh_sink():
    return {"begin_tx": 0, "commits": 0, "rolls": 0, "distinct": set()}


def _make_driver(sink):
    conn = sqlite3.connect(":memory:")
    conn.execute(f"CREATE TABLE {ISO_TBL} (id INTEGER PRIMARY KEY, worker INTEGER NOT NULL, seq INTEGER NOT NULL)")
    conn.commit()
    return _RecSqliteDriver(conn, sink)


def _do_op(ctx, id_, worker, seq):
    """One guarded INSERT through the PRODUCTION guarded write seam (:func:`run_guarded`) on the ambient
    pinned tx ctx — the same path a user-facing write inside ``transaction()`` rides. Outside a boundary
    the ambient pin is absent, so the guard fires (:class:`WriteOutsideTransactionError`)."""
    return run_guarded(current_context(ctx), _INSERT_SQL, [id_, worker, seq], "WRITE", ISO_TBL)


def _read_rows(driver):
    rows = driver.prepare(f"SELECT id, worker FROM {ISO_TBL} WHERE worker <> 999").all([])
    return sorted((int(r["id"]), int(r["worker"])) for r in rows)


# ── (1) MULTI-OP ATOMICITY — commit path ───────────────────────────────────────


def test_multi_op_boundary_one_begin_one_commit():
    sink = _fresh_sink()
    driver = _make_driver(sink)
    ctx = context_for_driver(driver)

    result = transaction(ctx, lambda: [_do_op(ctx, 100, 1, 0), _do_op(ctx, 101, 1, 1)], TransactionOptions(), "sqlite")

    assert [r.changes for r in result] == [1, 1]
    # N ops in one boundary ⇒ ONE begin_tx + ONE commit on ONE tx handle (the ambient JOIN).
    assert sink["begin_tx"] == 1, f"expected 1 begin_tx, got {sink['begin_tx']}"
    assert sink["commits"] == 1, f"expected 1 commit, got {sink['commits']}"
    assert sink["rolls"] == 0
    assert len(sink["distinct"]) == 1, f"expected 1 distinct tx handle, got {len(sink['distinct'])}"
    assert _read_rows(driver) == [(100, 1), (101, 1)]


# ── (1) MULTI-OP ATOMICITY — rollback path (B fails ⇒ A also rolls back) ────────


def test_multi_op_boundary_opB_fail_rolls_back_opA():
    sink = _fresh_sink()
    driver = _make_driver(sink)
    driver.conn.execute(f"INSERT INTO {ISO_TBL} (id, worker, seq) VALUES (201, 999, 9)")  # pre-seed collision
    driver.conn.commit()
    ctx = context_for_driver(driver)

    with pytest.raises(Exception):
        transaction(ctx, lambda: [_do_op(ctx, 200, 2, 0), _do_op(ctx, 201, 2, 1)], TransactionOptions(retry_on_error=False), "sqlite")

    assert sink["begin_tx"] == 1
    assert sink["commits"] == 0
    assert sink["rolls"] == 1, f"opB failure ⇒ ONE rollback, got {sink['rolls']}"
    # opA (id=200) must ALSO have rolled back — the whole boundary is atomic. Both ops JOINed the ONE
    # ambient tx via run_guarded on the pinned ctx, so opB's PK collision rolls the whole boundary back.
    assert _read_rows(driver) == [], "opA must roll back when opB fails (cross-op atomicity)"


# ── (2) write=tx GUARD ──────────────────────────────────────────────────────────


def test_guard_outside_boundary_rejects_write():
    sink = _fresh_sink()
    driver = _make_driver(sink)
    ctx = context_for_driver(driver)
    # A bare guarded write OUTSIDE any transaction() → WriteOutsideTransactionError (the ambient pin is
    # absent, so current_context(ctx) is None and the guard fires before any SQL), nothing written.
    with pytest.raises(WriteOutsideTransactionError):
        _do_op(ctx, 300, 3, 0)
    assert _read_rows(driver) == []


def test_guard_read_only_inside_boundary_rejects_write():
    sink = _fresh_sink()
    driver = _make_driver(sink)
    ctx = context_for_driver(driver)
    # Read-only-scoped write inside a boundary → WriteInReadOnlyContextError (read-only checked first).

    def body():
        ambient = current_context(ctx)  # the pinned tx ctx
        ro = ambient.with_read_only()
        # Pin the read-only ctx as the ambient so the guard (which reads the ambient markers) sees it.
        return run_with_pinned_context(ro, lambda: _do_op(ctx, 301, 3, 0))

    with pytest.raises(WriteInReadOnlyContextError):
        transaction(ctx, body, TransactionOptions(retry_on_error=False), "sqlite")


def test_guard_inside_boundary_allows_write():
    sink = _fresh_sink()
    driver = _make_driver(sink)
    ctx = context_for_driver(driver)
    r = transaction(ctx, lambda: _do_op(ctx, 302, 3, 0), TransactionOptions(), "sqlite")
    assert r.changes == 1
    assert _read_rows(driver) == [(302, 3)]


# ── (3) NESTED transaction = one begin/commit ──────────────────────────────────


def test_nested_transaction_one_begin_commit():
    sink = _fresh_sink()
    driver = _make_driver(sink)
    ctx = context_for_driver(driver)

    def outer():
        _do_op(ctx, 500, 5, 0)
        # A NESTED transaction() JOINs the outer — no new begin_tx/commit.
        return transaction(ctx, lambda: _do_op(ctx, 501, 5, 1), TransactionOptions(), "sqlite")

    transaction(ctx, outer, TransactionOptions(), "sqlite")
    assert sink["begin_tx"] == 1
    assert sink["commits"] == 1
    assert sink["rolls"] == 0
    assert _read_rows(driver) == [(500, 5), (501, 5)]


def test_nested_inner_error_rolls_back_whole_tx():
    sink = _fresh_sink()
    driver = _make_driver(sink)
    driver.conn.execute(f"INSERT INTO {ISO_TBL} (id, worker, seq) VALUES (601, 999, 9)")  # collision for inner
    driver.conn.commit()
    ctx = context_for_driver(driver)

    def outer():
        _do_op(ctx, 600, 6, 0)
        return transaction(ctx, lambda: _do_op(ctx, 601, 6, 1), TransactionOptions(), "sqlite")

    with pytest.raises(Exception):
        transaction(ctx, outer, TransactionOptions(retry_on_error=False), "sqlite")
    assert sink["commits"] == 0
    assert sink["rolls"] == 1
    assert _read_rows(driver) == [], "an inner error rolls back the WHOLE tx (id=600 absent)"


# ── (3b) a transaction is joined only by contexts of its own owner (#371) ──────

_OWNER_TBL = "scp_tx_owner_py"
_OWNER_READ = {"sql": f"SELECT id, owner FROM {_OWNER_TBL} ORDER BY id", "params": []}


def _owner_write(id_, owner):
    return {
        "sql": f"INSERT INTO {_OWNER_TBL} (id, owner) VALUES (?, ?)",
        "params": [id_, owner],
        "opts": {"db": None, "whereDynamic": None, "write": {"returning": False}, "guard": None},
    }


def _owner_driver(owner):
    driver = SqliteDriver.in_memory([f"CREATE TABLE {_OWNER_TBL} (id INTEGER PRIMARY KEY, owner TEXT NOT NULL)"])
    driver.conn.execute(f"INSERT INTO {_OWNER_TBL} (id, owner) VALUES (1, ?)", [owner])
    return driver


def _owner_rows(driver):
    return [tuple(r) for r in driver.conn.execute(f"SELECT id, owner FROM {_OWNER_TBL} ORDER BY id").fetchall()]


def test_a_leaf_bound_to_another_context_reads_its_own_database_inside_a_transaction():
    drv_a, drv_b = _owner_driver("A"), _owner_driver("B")
    ctx_a, ctx_b = context_for_driver(drv_a), context_for_driver(drv_b)
    exec_b = make_handlers(ctx_b, "sqlite")["executeSQL"]
    # Another ctx over A's driver has A's owner: it joins A's transaction and sees its uncommitted row.
    exec_a = make_handlers(context_for_driver(drv_a), "sqlite")["executeSQL"]

    def body():
        exec_a(_owner_write(2, "A-uncommitted"), {})
        return exec_b(_OWNER_READ, {}), exec_a(_OWNER_READ, {})

    seen_b, seen_a = transaction(ctx_a, body, TransactionOptions(), "sqlite")

    assert seen_b == {"ok": [{"id": 1, "owner": "B"}]}, "a B-bound leaf inside A's transaction must read B"
    assert seen_a == {"ok": [{"id": 1, "owner": "A"}, {"id": 2, "owner": "A-uncommitted"}]}


def test_a_nested_transaction_on_another_context_writes_and_commits_on_its_own_database():
    drv_a, drv_b = _owner_driver("A"), _owner_driver("B")
    ctx_a, ctx_b = context_for_driver(drv_a), context_for_driver(drv_b)
    exec_b = make_handlers(ctx_b, "sqlite")["executeSQL"]

    class _OuterFails(Exception):
        pass

    def body():
        transaction(ctx_b, lambda: exec_b(_owner_write(2, "via-B"), {}), TransactionOptions(), "sqlite")
        raise _OuterFails()

    with pytest.raises(Exception) as raised:
        transaction(ctx_a, body, TransactionOptions(retry_on_error=False), "sqlite")
    assert isinstance(raised.value.__cause__, _OuterFails), "A must fail on its own body error"

    # B's transaction is its own: its write landed in B and committed even though A rolled back.
    assert _owner_rows(drv_b) == [(1, "B"), (2, "via-B")]
    assert _owner_rows(drv_a) == [(1, "A")]


# ── (4) rollback_only (dry-run) ────────────────────────────────────────────────


def test_rollback_only_returns_value_but_commits_nothing():
    sink = _fresh_sink()
    driver = _make_driver(sink)
    ctx = context_for_driver(driver)
    r = transaction(ctx, lambda: _do_op(ctx, 700, 7, 0), TransactionOptions(rollback_only=True), "sqlite")
    assert r.changes == 1  # the body's own view: its statement ran (before the boundary rolled back)
    # …but the boundary ROLLED BACK, so nothing persisted.
    assert sink["begin_tx"] == 1
    assert sink["commits"] == 0
    assert sink["rolls"] == 1
    assert _read_rows(driver) == [], "rollback_only must commit nothing"


# ── SQLite isolation is a hard error at the boundary ───────────────────────────


def test_sqlite_isolation_request_is_a_hard_error():
    sink = _fresh_sink()
    driver = _make_driver(sink)
    ctx = context_for_driver(driver)
    with pytest.raises(ValueError):
        transaction(ctx, lambda: None, TransactionOptions(isolation=IsolationLevel.SERIALIZABLE), "sqlite")
    # The hard-error fires BEFORE any connection is acquired.
    assert sink["begin_tx"] == 0


# ── #330 transaction-safety defects (2.x Python) ───────────────────────────────


class _CommitFailsTx(_SqliteTxConnection):
    """A tx handle whose COMMIT raises the next error in ``errors`` (then commits normally)."""

    def __init__(self, conn, errors):
        super().__init__(conn)
        self._errors = errors

    def run(self, sql, params):
        if sql.strip().split(" ", 1)[0].upper() == "COMMIT" and self._errors:
            super().run("ROLLBACK", params)  # a real connection error leaves no open tx to retry into
            raise self._errors.pop(0)
        return super().run(sql, params)


class _CommitFailsDriver(SqliteDriver):
    def __init__(self, conn, errors):
        super().__init__(conn)
        self._errors = errors

    def begin_tx(self):
        return _CommitFailsTx(self.conn, self._errors)


class _FakeSerializationError(Exception):
    sqlstate = "40001"


def _run_with_commit_errors(errors):
    conn = sqlite3.connect(":memory:")
    conn.execute(f"CREATE TABLE {ISO_TBL} (id INTEGER PRIMARY KEY, worker INTEGER NOT NULL, seq INTEGER NOT NULL)")
    conn.commit()
    ctx = context_for_driver(_CommitFailsDriver(conn, errors))
    runs = []

    def body():
        runs.append(1)
        return _do_op(ctx, 800 + len(runs), 8, 0)

    opts = TransactionOptions(retry_limit=3, retry_duration=0)
    try:
        transaction(ctx, body, opts, "sqlite")
        return len(runs), None
    except Exception as e:
        return len(runs), e


def test_commit_connection_error_does_not_rerun_the_body():
    # The COMMIT may have reached the server before the connection dropped: re-running the body could
    # write twice. The error surfaces after ONE run of the body.
    runs, error = _run_with_commit_errors([RuntimeError("server closed the connection unexpectedly")] * 3)
    assert runs == 1, f"the body must not re-run after a COMMIT connection error, ran {runs}x"
    assert error is not None and "server closed the connection" in str(error)


def test_commit_serialization_failure_is_still_retried():
    runs, error = _run_with_commit_errors([_FakeSerializationError("could not serialize access")])
    assert error is None
    assert runs == 2


def _recording_pool():
    closed = []

    class _Conn:
        def close(self):
            closed.append(self)

    from litedbmodel_runtime.driver import _ConnectionPool

    return _ConnectionPool(_Conn, 2), closed


def test_errored_connection_outside_a_tx_is_discarded_not_returned_to_the_pool():
    from litedbmodel_runtime.driver import _PooledDriver

    pool, closed = _recording_pool()
    driver = _PooledDriver(pool, lambda s: s, False)

    def failing(conn):
        raise RuntimeError("server closed the connection unexpectedly")

    with pytest.raises(RuntimeError):
        driver._with_conn(failing)
    assert len(closed) == 1, "the errored connection must be closed"
    assert pool._free == [], "the errored connection must not go back to the pool"
    assert pool._opened == 0, "its slot must be freed"
    # A clean statement still returns its connection to the pool.
    driver._with_conn(lambda conn: None)
    assert len(pool._free) == 1


def test_sql_error_outside_a_tx_returns_the_connection_to_the_pool_for_reuse():
    from litedbmodel_runtime.driver import _PooledDriver

    pool, closed = _recording_pool()
    driver = _PooledDriver(pool, lambda s: s, False)
    seen = []

    class _ConstraintViolation(Exception):
        sqlstate = "23505"

    def violating(conn):
        seen.append(conn)
        raise _ConstraintViolation('duplicate key value violates unique constraint "t_pkey"')

    # The pool's connections are autocommit, so the session is still usable after a SQL error.
    with pytest.raises(_ConstraintViolation):
        driver._with_conn(violating)
    assert closed == [], "a SQL error must not close the connection"
    assert [c for c, _ in pool._free] == seen, "the connection must go back to the pool"
    assert pool._opened == 1
    driver._with_conn(lambda conn: seen.append(conn))
    assert seen[1] is seen[0], "the next statement must reuse the same connection"
    assert pool._opened == 1


def test_interrupted_statement_outside_a_tx_discards_the_connection():
    from litedbmodel_runtime.driver import _PooledDriver

    pool, closed = _recording_pool()
    driver = _PooledDriver(pool, lambda s: s, False)

    def interrupted(conn):
        raise KeyboardInterrupt()  # not an Exception: it can land mid-statement

    with pytest.raises(KeyboardInterrupt):
        driver._with_conn(interrupted)
    assert len(closed) == 1 and pool._free == [] and pool._opened == 0


# ── A statement from a ctx that outlived the body is refused (sqlite and pg paths) ──────────────────


class _WindowTx(_SqliteTxConnection):
    """A sqlite tx handle that runs ``window()`` just before the COMMIT statement reaches the DB."""

    def __init__(self, conn, window, gate):
        super().__init__(conn)
        self._window = window
        self._gate = gate

    def run(self, sql, params):
        if sql.strip().upper().startswith("COMMIT"):
            self._window()
        self._gate(sql, params)
        return super().run(sql, params)


class _WindowSqliteDriver(SqliteDriver):
    def __init__(self, conn, window, gate):
        super().__init__(conn)
        self._window = window
        self._gate = gate

    def begin_tx(self):
        return _WindowTx(self.conn, self._window, self._gate)


class _FakeCursor:
    rowcount = 1
    lastrowid = None

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        if sql.strip().upper().startswith("COMMIT"):
            self._conn.window()
        self._conn.gate(sql, params)
        self._conn.sent.append((sql, tuple(params)))

    def close(self):
        pass


class _FakePgConn:
    """A DB-API connection (the pg/mysql pooled path) that records every statement it is sent."""

    def __init__(self, sent, window, gate):
        self.sent = sent
        self.window = window
        self.gate = gate

    def cursor(self):
        return _FakeCursor(self)

    def close(self):
        pass


def _no_gate(sql, params):
    pass


def _sqlite_leak_ctx(window, gate=_no_gate):
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.execute(f"CREATE TABLE {ISO_TBL} (id INTEGER PRIMARY KEY, worker INTEGER NOT NULL, seq INTEGER NOT NULL)")
    conn.commit()

    def sent_ids():
        return [int(r[0]) for r in conn.execute(f"SELECT id FROM {ISO_TBL}")]

    return context_for_driver(_WindowSqliteDriver(conn, window, gate)), "sqlite", sent_ids


def _pg_leak_ctx(window, gate=_no_gate):
    from litedbmodel_runtime.driver import _ConnectionPool, _PooledDriver

    sent = []
    pool = _ConnectionPool(lambda: _FakePgConn(sent, window, gate), 2)
    driver = _PooledDriver(pool, lambda s: s, False)

    def sent_ids():
        return [params[0] for sql, params in sent if sql.startswith("INSERT")]

    return context_for_driver(driver), "postgres", sent_ids


@pytest.mark.parametrize("make_ctx", [_sqlite_leak_ctx, _pg_leak_ctx], ids=["sqlite", "pg"])
def test_statement_from_a_leaked_ctx_is_refused_between_the_body_and_the_commit(make_ctx):
    from litedbmodel_runtime import WRITE_INTENT, run
    from litedbmodel_runtime.errors import TransactionClosedError

    leaked = []
    outcomes = []

    def attempt():
        try:
            run(leaked[0], _INSERT_SQL, [999, 9, 9], WRITE_INTENT)
            outcomes.append(None)
        except Exception as e:
            outcomes.append(e)

    ctx, dialect, sent_ids = make_ctx(attempt)

    def body():
        leaked.append(current_context(ctx))  # the ctx escapes the body (e.g. onto a thread left running)
        return _do_op(ctx, 1, 1, 0)

    transaction(ctx, body, TransactionOptions(), dialect)

    # Between the body's return and the COMMIT (the window), and again after the connection was released.
    attempt()
    expected = (
        "Query issued after the transaction function settled. "
        "Await every query started inside DBModel.transaction() before returning."
    )
    assert len(outcomes) == 2
    for outcome in outcomes:
        assert isinstance(outcome, TransactionClosedError), f"got {outcome!r}"
        assert str(outcome) == expected
    assert 999 not in sent_ids(), "the refused statement must never reach the DB"
    assert 1 in sent_ids()


# ── A statement still running when the body settles fails the transaction (sqlite and pg paths) ──────


def _gated_ctx(make_ctx):
    """A ctx whose statement for row id 777 blocks inside the DB until ``release`` is set; ``statements``
    records the verb of every statement the DB is sent."""
    started = threading.Event()
    release = threading.Event()
    statements = []

    def gate(sql, params):
        statements.append(sql.strip().split(" ", 1)[0].upper())
        if params and params[0] == 777:
            started.set()
            assert release.wait(10)

    ctx, dialect, sent_ids = make_ctx(lambda: None, gate)
    return ctx, dialect, sent_ids, started, release, statements


@pytest.mark.parametrize("make_ctx", [_sqlite_leak_ctx, _pg_leak_ctx], ids=["sqlite", "pg"])
def test_statement_still_running_when_the_body_returns_rolls_back_and_raises(make_ctx):
    from litedbmodel_runtime import WRITE_INTENT, run
    from litedbmodel_runtime.errors import TransactionClosedError

    ctx, dialect, sent_ids, started, release, statements = _gated_ctx(make_ctx)
    worker_errors = []
    body_calls = []

    def body():
        body_calls.append(1)
        _do_op(ctx, 1, 1, 0)
        leaked = current_context(ctx)

        def worker():
            try:
                run(leaked, _INSERT_SQL, [777, 7, 7], WRITE_INTENT)
            except Exception as e:  # pragma: no cover - the statement is awaited by the settle, it must not fail
                worker_errors.append(e)

        threading.Thread(target=worker).start()
        assert started.wait(10)  # the statement is now running in the DB; the body returns without awaiting it
        threading.Timer(0.2, release.set).start()
        return "done"

    with pytest.raises(TransactionClosedError) as raised:
        transaction(ctx, body, TransactionOptions(retry_limit=3, retry_duration=0), dialect)
    assert len(body_calls) == 1, "an unfinished statement must not be retried"

    assert str(raised.value) == (
        "A query started inside the transaction had not finished when the transaction function settled. "
        "Await every query started inside DBModel.transaction() before returning."
    )
    assert worker_errors == []
    assert "COMMIT" not in statements and "ROLLBACK" in statements
    if dialect == "sqlite":
        assert sent_ids() == [], "neither the awaited nor the unfinished write may remain"


@pytest.mark.parametrize("make_ctx", [_sqlite_leak_ctx, _pg_leak_ctx], ids=["sqlite", "pg"])
def test_statement_still_running_when_the_body_raises_a_retryable_error_is_not_retried(make_ctx):
    from litedbmodel_runtime import WRITE_INTENT, run
    from litedbmodel_runtime.errors import TransactionClosedError

    ctx, dialect, sent_ids, started, release, statements = _gated_ctx(make_ctx)
    body_error = _FakeSerializationError("could not serialize access")
    body_calls = []

    def body():
        body_calls.append(1)
        leaked = current_context(ctx)
        threading.Thread(target=lambda: run(leaked, _INSERT_SQL, [777, 7, 7], WRITE_INTENT)).start()
        assert started.wait(10)  # the statement is running in the DB when the body fails
        threading.Timer(0.2, release.set).start()
        raise body_error

    with pytest.raises(TransactionClosedError) as raised:
        transaction(ctx, body, TransactionOptions(retry_limit=3, retry_duration=0), dialect)

    assert raised.value.__cause__ is body_error
    assert len(body_calls) == 1, "the body must not be re-run: its statement was still unfinished"
    assert "COMMIT" not in statements and "ROLLBACK" in statements
    if dialect == "sqlite":
        assert sent_ids() == []


@pytest.mark.parametrize("make_ctx", [_sqlite_leak_ctx, _pg_leak_ctx], ids=["sqlite", "pg"])
def test_every_statement_awaited_inside_the_body_still_commits(make_ctx):
    from litedbmodel_runtime import WRITE_INTENT, run

    ctx, dialect, sent_ids, started, release, statements = _gated_ctx(make_ctx)

    def body():
        _do_op(ctx, 1, 1, 0)
        leaked = current_context(ctx)
        worker = threading.Thread(target=lambda: run(leaked, _INSERT_SQL, [777, 7, 7], WRITE_INTENT))
        worker.start()
        assert started.wait(10)
        release.set()
        worker.join()
        return "done"

    assert transaction(ctx, body, TransactionOptions(), dialect) == "done"
    assert "COMMIT" in statements and "ROLLBACK" not in statements
    assert sorted(sent_ids()) == [1, 777]
