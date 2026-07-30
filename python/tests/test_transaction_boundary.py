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


def _do_op(id_, worker, seq):
    """One guarded INSERT through the PRODUCTION guarded write seam (:func:`run_guarded`) on the ambient
    pinned tx ctx — the same path a user-facing write inside ``transaction()`` rides. Outside a boundary
    the ambient pin is absent, so the guard fires (:class:`WriteOutsideTransactionError`)."""
    return run_guarded(current_context(), _INSERT_SQL, [id_, worker, seq], "WRITE", ISO_TBL)


def _read_rows(driver):
    rows = driver.prepare(f"SELECT id, worker FROM {ISO_TBL} WHERE worker <> 999").all([])
    return sorted((int(r["id"]), int(r["worker"])) for r in rows)


# ── (1) MULTI-OP ATOMICITY — commit path ───────────────────────────────────────


def test_multi_op_boundary_one_begin_one_commit():
    sink = _fresh_sink()
    driver = _make_driver(sink)
    ctx = context_for_driver(driver)

    result = transaction(ctx, lambda: [_do_op(100, 1, 0), _do_op(101, 1, 1)], TransactionOptions(), "sqlite")

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
        transaction(ctx, lambda: [_do_op(200, 2, 0), _do_op(201, 2, 1)], TransactionOptions(retry_on_error=False), "sqlite")

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
    context_for_driver(driver)
    # A bare guarded write OUTSIDE any transaction() → WriteOutsideTransactionError (the ambient pin is
    # absent, so current_context() is None and the guard fires before any SQL), nothing written.
    with pytest.raises(WriteOutsideTransactionError):
        _do_op(300, 3, 0)
    assert _read_rows(driver) == []


def test_guard_read_only_inside_boundary_rejects_write():
    sink = _fresh_sink()
    driver = _make_driver(sink)
    ctx = context_for_driver(driver)
    # Read-only-scoped write inside a boundary → WriteInReadOnlyContextError (read-only checked first).

    def body():
        ambient = current_context()  # the pinned tx ctx
        ro = ambient.with_read_only()
        # Pin the read-only ctx as the ambient so the guard (which reads the ambient markers) sees it.
        return run_with_pinned_context(ro, lambda: _do_op(301, 3, 0))

    with pytest.raises(WriteInReadOnlyContextError):
        transaction(ctx, body, TransactionOptions(retry_on_error=False), "sqlite")


def test_guard_inside_boundary_allows_write():
    sink = _fresh_sink()
    driver = _make_driver(sink)
    ctx = context_for_driver(driver)
    r = transaction(ctx, lambda: _do_op(302, 3, 0), TransactionOptions(), "sqlite")
    assert r.changes == 1
    assert _read_rows(driver) == [(302, 3)]


# ── (3) NESTED transaction = one begin/commit ──────────────────────────────────


def test_nested_transaction_one_begin_commit():
    sink = _fresh_sink()
    driver = _make_driver(sink)
    ctx = context_for_driver(driver)

    def outer():
        _do_op(500, 5, 0)
        # A NESTED transaction() JOINs the outer — no new begin_tx/commit.
        return transaction(ctx, lambda: _do_op(501, 5, 1), TransactionOptions(), "sqlite")

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
        _do_op(600, 6, 0)
        return transaction(ctx, lambda: _do_op(601, 6, 1), TransactionOptions(), "sqlite")

    with pytest.raises(Exception):
        transaction(ctx, outer, TransactionOptions(retry_on_error=False), "sqlite")
    assert sink["commits"] == 0
    assert sink["rolls"] == 1
    assert _read_rows(driver) == [], "an inner error rolls back the WHOLE tx (id=600 absent)"


# ── (4) rollback_only (dry-run) ────────────────────────────────────────────────


def test_rollback_only_returns_value_but_commits_nothing():
    sink = _fresh_sink()
    driver = _make_driver(sink)
    ctx = context_for_driver(driver)
    r = transaction(ctx, lambda: _do_op(700, 7, 0), TransactionOptions(rollback_only=True), "sqlite")
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
