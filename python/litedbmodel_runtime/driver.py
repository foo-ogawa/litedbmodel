"""litedbmodel v2 SCP — SQL driver seam (WS7b).

The minimal synchronous SQL-driver surface the runtime needs, mirroring the TS `SqliteDb`
seam (`prepare(sql).all(...) / .run(...)`). The conformance bar executes against an in-process
stdlib ``sqlite3`` connection (:class:`SqliteDriver`) — the sanctioned in-proc substitute for a
docker integration DB (#31 AC; live PG/MySQL is deferred to a coordinated cross-language docker
pass). A psycopg / mysql-connector driver plugs into this SAME abstract seam later: implement
:class:`Driver.prepare` returning a :class:`PreparedStatement` (`all` / `run`) over the
paramstyle the bundle's dialect emits (`$N` for Postgres, `?`/`%s` for MySQL) — no runtime change.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Protocol, Sequence, Tuple

from .tx_options import is_connection_error


# ── Row materialization: per-column-set dict builder (read-path hot loop, #63 §② perf) ──────────
#
# The read path turns each fetched driver tuple into the plain-dict row the runtime returns. The
# naive `dict(zip(cols, row))` rebuilds a `zip` iterator per row and dispatches through `dict()`'s
# generic iterable path 100× on a `Find all (limit 100)` — measured as the litedbmodel-over-raw
# overhead the cross-language bench flags (SQLite §②). The columns of a given prepared statement are
# FIXED, so we compile the tuple→dict mapping ONCE per distinct column-name set and cache it: the
# per-row work becomes a straight-line dict literal keyed by fixed indices (no per-row zip, no
# per-cell type dispatch). Output is byte-identical to `dict(zip(cols, row))` — same keys in column
# order, duplicate column names dedupe keeping the last value (dict-literal + dict(zip) agree), and
# `repr()`-quoted keys make any column name (spaces / quotes) safe. The read TYPE CONTRACT is
# UNCHANGED: this only assembles the dict; it applies NO coercion of its own.

_ROW_BUILDER_CACHE: "Dict[Tuple[str, ...], Callable[[Sequence[Any]], Dict[str, Any]]]" = {}


def _make_row_builder(cols: "Tuple[str, ...]") -> "Callable[[Sequence[Any]], Dict[str, Any]]":
    """Compile a straight-line ``row -> {col: row[i], …}`` builder for a fixed column tuple.

    The dict-literal is emitted with ``repr``-quoted keys (any column name is safe) and fixed
    positional indices, so the per-row cost is a single native dict construction — no ``zip``, no
    per-cell dispatch. Semantically identical to ``dict(zip(cols, row))``: same insertion order,
    duplicate names collapse to the last occurrence.
    """
    if not cols:
        return lambda _r: {}
    body = ", ".join(f"{c!r}: r[{i}]" for i, c in enumerate(cols))
    ns: Dict[str, Any] = {}
    exec(f"def _row_builder(r):\n    return {{{body}}}\n", ns)  # noqa: S102 — trusted DB column names, compiled once/col-set
    return ns["_row_builder"]


def _row_builder_for(description: Any) -> "Callable[[Sequence[Any]], Dict[str, Any]]":
    """Return the cached (or freshly compiled) dict builder for a cursor ``description``."""
    cols: Tuple[str, ...] = tuple(d[0] for d in description) if description is not None else ()
    builder = _ROW_BUILDER_CACHE.get(cols)
    if builder is None:
        builder = _ROW_BUILDER_CACHE[cols] = _make_row_builder(cols)
    return builder


class RunInfo:
    """The summary of a non-returning write: affected-row count + last insert rowid."""

    __slots__ = ("changes", "last_insert_rowid")

    def __init__(self, changes: int, last_insert_rowid: int) -> None:
        self.changes = changes
        self.last_insert_rowid = last_insert_rowid


class PreparedStatement(Protocol):
    """A prepared statement: `all` returns the row list (SELECT/RETURNING); `run` a write summary."""

    def all(self, params: Sequence[Any]) -> List[Dict[str, Any]]: ...

    def run(self, params: Sequence[Any]) -> RunInfo: ...


class TxConnection(Protocol):
    """An OWNED transaction connection (Phase A / #78) — the Python analogue of v1 ``PoolTransaction``
    / go's ``*sql.Tx``. Acquired by :meth:`Driver.begin_tx`, it holds ONE connection for the
    transaction's whole duration: EVERY statement in the tx — the body (``all`` / ``run``) AND the
    tx-control (BEGIN / COMMIT / ROLLBACK / the isolation SET) — runs on it via ``run`` / ``all``. The
    tx-control is issued THROUGH the exec-context seam by ``with_transaction_decided`` (Phase D / #95,
    middleware-visible), NOT by this handle. The caller then :meth:`release` s the connection EXACTLY
    ONCE (back to the pool, or destroyed if poisoned).

    **Release ownership**: this handle is the connection OWNER, not the tx-control issuer. The seam
    combinator (``with_transaction_decided``) is the SOLE owner of :meth:`release`, calling it in a
    ``finally`` so the owned connection is returned/destroyed on EVERY path (success, BEGIN error, body
    error, AND a commit/rollback that itself raises — the leak the self-release model missed).
    :meth:`release` is idempotent (a second call is a no-op).

    Concurrent transactions each hold a DISTINCT handle over a DISTINCT pooled connection, so their
    writes never cross-talk — the isolation the removed driver-global ``_writer`` slot violated.
    """

    def all(self, sql: str, params: Sequence[Any]) -> List[Dict[str, Any]]: ...

    def run(self, sql: str, params: Sequence[Any]) -> RunInfo: ...

    def release(self, destroy: bool) -> None:
        """Release the owned connection EXACTLY ONCE (idempotent): back to the pool, or dropped when
        ``destroy`` (a poisoned connection — a BEGIN/COMMIT/ROLLBACK that itself raised). Called by the
        seam combinator in a ``finally``; the tx-control SQL itself is issued through the seam."""
        ...


class Driver(Protocol):
    """The synchronous SQL-driver seam (mirrors the TS `SqliteDb`)."""

    def prepare(self, sql: str) -> PreparedStatement: ...

    def begin_tx(self) -> TxConnection:
        """Acquire + OWN a :class:`TxConnection` for a transaction (per-execution connection ownership,
        §3). The central seam's ``with_transaction`` pins the returned handle so every statement of the tx's own database in the
        tx body runs on it, and issues the isolation SET + BEGIN/COMMIT/ROLLBACK THROUGH the seam on this
        connection (Phase D / #95, middleware-visible) — this method only acquires the owned connection.
        Empty prelude ⇒ a bare ``BEGIN`` (the Phase A behavior, byte-identical statements + connection)."""
        ...


class _SqlitePrepared:
    """A prepared statement over a stdlib ``sqlite3`` connection."""

    __slots__ = ("_conn", "_sql")

    def __init__(self, conn: "sqlite3.Connection", sql: str) -> None:
        self._conn = conn
        self._sql = sql

    def all(self, params: Sequence[Any]) -> List[Dict[str, Any]]:
        cur = self._conn.execute(self._sql, tuple(params))
        # Straight-line, per-column-set compiled dict builder (cached) instead of a per-row
        # `dict(zip(cols, row))` — byte-identical rows, far less per-row overhead on multi-row reads
        # (#63 §② SQLite `Find all` hot loop). No coercion: SQLite already returns native scalars.
        build = _row_builder_for(cur.description)
        rows = [build(r) for r in cur.fetchall()]
        cur.close()
        return rows

    def run(self, params: Sequence[Any]) -> RunInfo:
        cur = self._conn.execute(self._sql, tuple(params))
        changes = cur.rowcount if cur.rowcount is not None else 0
        last = cur.lastrowid if cur.lastrowid is not None else 0
        cur.close()
        return RunInfo(changes, last)


class SqliteDriver:
    """An in-process stdlib ``sqlite3`` driver implementing the :class:`Driver` seam.

    This is the runnable conformance seam: it binds `?` placeholders positionally, so a
    Postgres-tagged bundle's `$N` text is NOT what runs here — the exec/tx vectors run only the
    SQLite-tagged bundles (the §10 promise: same IR + input → same RESULT regardless of dialect
    text). PG/MySQL SQL-text conformance is proven on the render axis; live PG/MySQL execution is
    the coordinated docker pass.
    """

    __slots__ = ("conn",)

    def __init__(self, conn: "sqlite3.Connection") -> None:
        self.conn = conn

    @classmethod
    def in_memory(cls, schema: Sequence[str]) -> "SqliteDriver":
        conn = sqlite3.connect(":memory:")
        # Autocommit (isolation_level=None): the runtime tx boundary issues BEGIN/COMMIT/ROLLBACK
        # EXPLICITLY through the seam (exec_context.with_transaction_decided), so the connection must
        # NOT also run stdlib sqlite3's legacy implicit-BEGIN (which would raise "cannot start a
        # transaction within a transaction" on the explicit BEGIN after any prior uncommitted DML). This
        # is the SQLite twin of the PG/MySQL pool factories' `autocommit=True` — the literal BEGIN…COMMIT
        # then brackets a REAL transaction, and a non-tx statement autocommits (single-conn, byte-identical
        # read-back).
        conn.isolation_level = None
        conn.execute("PRAGMA foreign_keys = ON")
        for stmt in schema:
            conn.execute(stmt)
        conn.commit()
        return cls(conn)

    def prepare(self, sql: str) -> _SqlitePrepared:
        return _SqlitePrepared(self.conn, sql)

    def begin_tx(self) -> "_SqliteTxConnection":
        """Own the OWNED tx connection (§3). SQLite is single-connection, so the tx owns THE conn: every
        tx statement runs on it. tx-control (BEGIN / COMMIT / ROLLBACK) is issued THROUGH the seam by the
        combinator on THIS connection (Phase D / #95, middleware-visible) — the SAME single-conn
        BEGIN…COMMIT bracket the pre-seam path ran, byte-identical (same literal statements, same conn).

        SQLite has NO per-transaction isolation level; the Phase B contract loud-rejects an isolation
        request for SQLite BEFORE it reaches here (:func:`isolation_prelude`), so the combinator issues a
        bare BEGIN with no prelude on this path."""
        return _SqliteTxConnection(self.conn)

    def close(self) -> None:
        self.conn.close()


class _SqliteTxConnection:
    """The OWNED tx handle over a stdlib ``sqlite3`` connection (single-conn; the tx owns THE conn).
    Both tx-body statements AND tx-control (BEGIN/COMMIT/ROLLBACK) run on THIS conn via :meth:`run`,
    routed THROUGH the seam by the combinator (Phase D / #95) — so a middleware observes them. This
    handle owns the conn (there is no pool to return to); it no longer issues tx-control itself."""

    __slots__ = ("_conn",)

    def __init__(self, conn: "sqlite3.Connection") -> None:
        self._conn = conn

    def all(self, sql: str, params: Sequence[Any]) -> List[Dict[str, Any]]:
        return _SqlitePrepared(self._conn, sql).all(params)

    def run(self, sql: str, params: Sequence[Any]) -> RunInfo:
        # Serves tx-body writes AND tx-control (BEGIN/COMMIT/ROLLBACK) — the SAME literal statements the
        # pre-seam path ran on THIS conn, byte-identical.
        return _SqlitePrepared(self._conn, sql).run(params)

    def release(self, destroy: bool) -> None:
        # SQLite is single-connection (the driver owns THE conn); there is no pool to return to and
        # the shared conn is never dropped mid-life. A no-op — the combinator's finally still calls it
        # uniformly so the release contract is honored across drivers.
        pass


# ── Live PostgreSQL / MySQL drivers (WS7g #36; async/pooled #40) ────────────────
#
# The SAME synchronous `Driver` seam, now backed by a CONNECTION POOL over REAL psycopg (Postgres)
# / PyMySQL (MySQL) connections — proving the deferred live-DB execution axis (spec §10) AND turning
# the read plan's `concurrency` into REAL parallel DB I/O (#40). The Python bc `run_plan` dispatches
# the INDEPENDENT sibling relations of a plan stage on a `ThreadPoolExecutor` when
# `concurrency > 1` (bc#23); a single DB-API connection is NOT safe for concurrent use, so each
# `prepare().all()` CHECKS OUT ITS OWN pooled connection — distinct threads run on distinct
# connections in parallel. The runtime is UNCHANGED: it renders the dialect-tagged bundle
# (Postgres → `$N`, MySQL → `?`), binds params positionally, and calls `prepare(sql).all(...)` /
# `.run(...)`. Each live driver adapts the rendered placeholder text to its DB's native paramstyle
# (both DB-API drivers here use `%s`), and MySQL emulates the missing `RETURNING` at this seam
# (strip → execute → re-select the inserted PK) — the WS6 TS ScpDialect behavior-by-convention.
#
# WRITE-TX OWNS ITS CONNECTION (Phase A / #78): `begin_tx()` acquires ONE pooled connection, issues
# BEGIN on it, and returns an OWNED `_PooledTxConnection`; every tx-body statement runs on THAT
# connection (tx-DAG order, gate-first short-circuit), and the seam combinator ends the tx
# (COMMIT/ROLLBACK) then releases the connection EXACTLY ONCE in a finally — back to the pool, or
# destroyed if poisoned. There is NO driver-global writer slot, so concurrent transactions each own a
# DISTINCT connection ⇒ isolated. Reads (no active tx) each check out + return a pooled connection.
# The connections run with autocommit ON so the literal BEGIN…COMMIT bracket a REAL transaction.

# The read plan's default concurrency (spec) — the pool is sized to match so `concurrency` sibling
# relations can each hold a live connection without starving.
DEFAULT_POOL_SIZE = 16

# Bound EVERY acquire so an UNREACHABLE / non-responding DB fails in FINITE time instead of hanging.
# `acquire` has two sub-waits, each bounded to this budget: the factory's connect (`connect_timeout`,
# set in the pg/mysql factories) and the wait for a released connection when the pool is at capacity.
# 30s is the codebase default (the v1 pg/mysql drivers' `config.timeout || 30`) and the
# `connectTimeoutMillis` default of the connection config. Only Python hand-rolls its pool, so it supplies
# the bound the other runtimes take from their pool libraries.
DEFAULT_ACQUIRE_TIMEOUT_SECONDS = 30.0

# How long a released connection may sit unused in the pool before the pool closes it — the
# `idleTimeoutMillis` default of the connection config (and of the v1 pg/mysql drivers).
DEFAULT_IDLE_TIMEOUT_SECONDS = 10.0


class _ConnectionPool:
    """A minimal thread-safe, bounded pool of DB-API connections (dependency-free).

    Connections are opened lazily up to ``max_size``. ``acquire`` hands out the most recently released
    free connection, opens a new one below the ceiling, or waits — at most ``acquire_timeout`` seconds,
    without limit when it is ``None`` — for a release or a freed slot. ``release`` returns a connection; one left unused for
    ``idle_timeout`` seconds is closed by a timer (a daemon ``threading.Timer`` armed while free
    connections exist), so a quiet application does not hold server sessions open. This keeps the
    parallel-read seam dependency-free while giving each concurrent sibling its own connection.
    """

    __slots__ = ("_factory", "_max", "_free", "_opened", "_cond", "_closed", "_acquire_timeout", "_idle_timeout", "_reaper")

    def __init__(
        self,
        factory,
        max_size: int,
        acquire_timeout: Optional[float] = DEFAULT_ACQUIRE_TIMEOUT_SECONDS,
        idle_timeout: float = DEFAULT_IDLE_TIMEOUT_SECONDS,
    ) -> None:
        import threading as _threading

        self._factory = factory
        self._max = max_size
        # Free connections with the monotonic time each was released, oldest first: ``acquire`` takes
        # from the end (most recently used), the idle timer closes from the front.
        self._free: List[Tuple[Any, float]] = []
        self._opened = 0
        self._cond = _threading.Condition()
        self._acquire_timeout = acquire_timeout
        self._idle_timeout = idle_timeout
        self._reaper: Any = None
        # Fail-fast after close(): a post-close acquire RAISES instead of waiting on a drained pool
        # (close_all_pools relies on it so a query on a closed pool fails loudly).
        self._closed = False

    def acquire(self) -> Any:
        import time as _time

        deadline = None if self._acquire_timeout is None else _time.monotonic() + self._acquire_timeout
        with self._cond:
            while True:
                if self._closed:
                    raise RuntimeError("scp connection pool: acquire after close (the pool has been closed)")
                if self._free:
                    return self._free.pop()[0]
                if self._opened < self._max:
                    # Reserve the slot, then open OUTSIDE the lock (a slow connect must not serialize
                    # every other acquire/release on this pool).
                    self._opened += 1
                    break
                # At capacity: wait for a release (or a discarded/closed slot), bounded by the deadline
                # when there is one.
                remaining = None if deadline is None else deadline - _time.monotonic()
                if remaining is not None and remaining <= 0:
                    raise TimeoutError(
                        f"scp connection pool: acquire timed out after {self._acquire_timeout}s "
                        f"(pool at capacity {self._max}, no connection released)"
                    )
                self._cond.wait(remaining)
        try:
            return self._factory()
        except BaseException:
            # The open FAILED — give the reserved slot back. Without this a failed connect permanently
            # consumes capacity, and once every slot is consumed each later acquire waits for a
            # connection that never comes.
            self._free_slots(1)
            raise

    def release(self, conn: Any) -> None:
        import time as _time

        with self._cond:
            if not self._closed:
                self._free.append((conn, _time.monotonic()))
                self._cond.notify()
                self._arm_reaper()
                return
        _close_quietly(conn)  # released after close(): nothing will hand it out again

    def discard(self, conn: Any) -> None:
        """Permanently drop a POISONED connection (a tx whose COMMIT/ROLLBACK itself raised): close it
        and free its slot so a fresh connection can be opened in its place — otherwise capacity would
        shrink by one per discard until the pool is exhausted."""
        _close_quietly(conn)
        self._free_slots(1)

    def close(self) -> None:
        with self._cond:
            self._closed = True
            free, self._free = self._free, []
            if self._reaper is not None:
                self._reaper.cancel()
                self._reaper = None
            self._cond.notify_all()  # waiters raise "acquire after close" instead of timing out
        for conn, _ in free:
            _close_quietly(conn)

    def _free_slots(self, n: int) -> None:
        with self._cond:
            self._opened = max(0, self._opened - n)
            self._cond.notify(n)  # a waiter may now open a connection in a freed slot

    def _arm_reaper(self) -> None:
        """(Under the lock.) Arm the idle timer for the oldest free connection, unless it is armed."""
        import threading as _threading
        import time as _time

        if self._reaper is not None or not self._free or self._closed:
            return
        delay = max(0.0, self._free[0][1] + self._idle_timeout - _time.monotonic())
        self._reaper = _threading.Timer(delay, self._reap)
        self._reaper.daemon = True
        self._reaper.start()

    def _reap(self) -> None:
        """Close every free connection that has been unused for ``idle_timeout``, then re-arm."""
        import time as _time

        with self._cond:
            self._reaper = None
            cutoff = _time.monotonic() - self._idle_timeout
            expired = [c for c, at in self._free if at <= cutoff]
            self._free = [(c, at) for c, at in self._free if at > cutoff]
            self._opened = max(0, self._opened - len(expired))
            self._cond.notify(len(expired))
            self._arm_reaper()
        for conn in expired:
            _close_quietly(conn)


def _close_quietly(conn: Any) -> None:
    try:
        conn.close()
    except Exception:
        pass


# `$1`, `$2`, … (Postgres render output).
_DOLLAR_RE = re.compile(r"\$\d+")
# The write's target table — the identifier after INSERT INTO / UPDATE / DELETE FROM.
_WRITE_TABLE_RE = re.compile(r"\b(?:INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z0-9_.\"`]+)", re.IGNORECASE)
# The INSERT column list `INSERT [IGNORE] INTO <t> (c1, c2, …)` — for extracting client-PK values.
_INSERT_COLS_RE = re.compile(r"\bINSERT\s+(?:IGNORE\s+)?INTO\s+[A-Za-z0-9_.\"`]+\s*\(([^)]*)\)", re.IGNORECASE)
# An updateMany's JOIN predicate (`ON u.k1 = <v.k1> AND u.k2 = <v.k2> SET …`), and one `AND`-joined
# conjunct of it (group 1 = its target-side key column).
_BATCH_JOIN_ON_RE = re.compile(r"\sON\s+(.*?)\s+SET\s", re.IGNORECASE | re.DOTALL)
_BATCH_JOIN_CONJ_RE = re.compile(r"^[A-Za-z0-9_]*\.?([A-Za-z0-9_]+)\s*=")
_AND_SPLIT_RE = re.compile(r"\s+AND\s+", re.IGNORECASE)
# The strip-before-execute PK hint the mysql bundle appends to a write…RETURNING (tx.ts mysqlPkHint):
#   ` /*scp:pk=col1,col2;ai=<autoIncCol|>[;conflict=cols[;action=ignore]]*/`
# STRIP and PARSE are separate patterns, as in the four sibling ports: the strip form must swallow the
# whole comment (`conflict=` included), while each field must stop at the next `;` so one field cannot
# leak into another.
_PK_HINT_RE = re.compile(r"\s*/\*scp:pk=[^*]*\*/", re.IGNORECASE)
_PK_HINT_PARSE_RE = re.compile(r"/\*scp:pk=([^;*]*);ai=([^;*]*)", re.IGNORECASE)
_CONFLICT_HINT_RE = re.compile(r";conflict=([^;*]*)", re.IGNORECASE)
_IGNORE_HINT_RE = re.compile(r";action=ignore[;*]", re.IGNORECASE)
# The OK/EOF packet's "a transaction is open" status bit (pymysql.constants.SERVER_STATUS.SERVER_STATUS_IN_TRANS).
_SERVER_STATUS_IN_TRANS = 1


class _MysqlReselect(NamedTuple):
    """A write→re-select plan (mysql-returning.ts ``MysqlReselect``): the stripped write, the
    recovering SELECT and its binds (each ``("lastId"|"highId"|"json"|"param", index)``), how many
    rows the write wrote (:func:`_written_row_count`; ``None`` ⇒ not countable), and whether the
    SELECT runs BEFORE the write (a DELETE's pre-image)."""

    write_sql: str
    select_sql: str
    binds: List[Tuple[str, int]]
    written: Optional[str]
    before: bool
    # A consistent read run BEFORE the write in the same transaction ("" ⇒ none): a bulk INSERT's
    # AUTO_INCREMENT ids are not consecutive, and anchoring the read view first hides the rows other
    # sessions insert meanwhile from the recovering SELECT (mysql-returning.ts ``anchorSql``).
    anchor_sql: str = ""
    # An UPDATE's lock-and-key step, run BEFORE the write ("" ⇒ none): ``SELECT <pk> … WHERE <where> …
    # FOR UPDATE`` names — and locks — exactly the rows the UPDATE is about to write (bound by
    # ``lock_binds``). Its rows are recovered by THOSE keys: ``select_sql`` is then the head
    # ``SELECT <cols> FROM <table> WHERE (<pk>) IN `` that :func:`_keyed_select_sql` completes.
    lock_sql: str = ""
    lock_binds: List[Tuple[str, int]] = []
    # The key columns ``lock_sql`` reads, in order (the declared PK).
    key_cols: List[str] = []
    # An insert-or-ignore on a CLIENT-supplied key (mysql-returning.ts ``insertIfAbsent``): ``lock_sql``
    # reads — and LOCKS — the row its own PK names BEFORE the write. A row there ⇒ it inserts nothing, so
    # it returns ``[]``; none ⇒ the next-key lock keeps every other session from inserting that PK, so the
    # row ``select_sql`` finds by it afterwards is the one it inserted. No affected count is read: under
    # CLIENT_FOUND_ROWS a no-op conflict and an insert both report 1.
    insert_if_absent: bool = False


def _dollar_to_pyformat(sql: str) -> str:
    """Postgres `$N` → DB-API `%s` (positional). Render already numbers left-to-right 1..N, so a
    plain replace preserves order. Literal `%` is doubled so psycopg/pymysql don't treat it as a
    format directive (the rendered SQL never contains a literal `%`, but this keeps the seam safe).
    """
    return _DOLLAR_RE.sub("%s", sql.replace("%", "%%"))


def rewrite_unquoted_placeholders(sql: str, render: Callable[[int], str]) -> str:
    """Rewrite every ``?`` that is NOT inside a single-quoted SQL string literal, in order, to
    ``render(n)`` (``n`` = 1-based placeholder ordinal). A ``?`` inside a literal is TEXT, not a
    placeholder, and is left exactly as it is.

    The ONE quote-aware ``?`` walk on this plane: both the dialect placeholder render
    (:func:`litedbmodel_runtime.leaves.render_placeholders` — PG ``$N``) and the DB-API
    paramstyle conversion (:func:`_qmark_to_pyformat` — PyMySQL ``%s``) go through it, so the two
    cannot disagree about which ``?`` is a placeholder. They did: a naive ``str.replace`` rewrote a
    quoted ``?`` as a placeholder and bound a value into a string literal, while the render skipped
    it (the same class of split #202 names).
    """
    out: List[str] = []
    index = 0
    in_string = False
    for ch in sql:
        if in_string:
            out.append(ch)
            if ch == "'":
                in_string = False
        elif ch == "'":
            out.append(ch)
            in_string = True
        elif ch == "?":
            index += 1
            out.append(render(index))
        else:
            out.append(ch)
    return "".join(out)


def _qmark_to_pyformat(sql: str) -> str:
    """MySQL render keeps `?`; PyMySQL binds `%s`. Rewrite each PLACEHOLDER `?` to `%s` (literal `%`
    doubled). A `?` inside a string literal is TEXT — PyMySQL substitutes positionally over the whole
    text, so rewriting one would bind a value INSIDE the literal and shift every later value."""
    return rewrite_unquoted_placeholders(sql.replace("%", "%%"), lambda _n: "%s")


def _parse_pk_hint(hint_region: str):
    """Parse the ` /*scp:pk=col1,col2;ai=<col|>[;conflict=cols]*/` PK hint.

    Returns ``(pk_columns, auto_inc_or_empty)``. Absent hint → ``([], "")`` (legacy path).
    """
    hm = _PK_HINT_PARSE_RE.search(hint_region)
    if hm is None:
        return [], ""
    return [c.strip() for c in hm.group(1).split(",") if c.strip()], hm.group(2).strip()


def _parse_conflict_hint(hint_region: str):
    """The hint's ``;conflict=<cols>`` field (the upsert conflict target). Empty ⇒ not an upsert."""
    hm = _CONFLICT_HINT_RE.search(hint_region)
    if hm is None:
        return []
    return [c.strip() for c in hm.group(1).split(",") if c.strip()]


def _update_batch_keys(write_sql: str):
    """EVERY JOIN key column of an updateMany — the target-side column of each ``AND``-joined conjunct
    of ``ON u.k1 = <v.k1> AND u.k2 = <v.k2> SET …`` (json-batch.ts ``mysqlUpdateManyJson``). A composite
    key keyed on its first column alone names rows the write never touched. ``None`` ⇒ unparsable."""
    m = _BATCH_JOIN_ON_RE.search(write_sql)
    if m is None:
        return None
    keys = []
    for conj in _AND_SPLIT_RE.split(m.group(1)):
        km = _BATCH_JOIN_CONJ_RE.search(conj.strip())
        if km is None:
            return None
        keys.append(km.group(1))
    return keys


def _build_mysql_reselect(sql: str):
    """Derive the MySQL RETURNING recovery for ``sql``, or ``None`` when it declares no RETURNING.

    MySQL parses no RETURNING. A write that declares one is run STRIPPED and its written rows are
    recovered by a SELECT on the SAME connection, keyed on whatever identifies them:

      * create → the AUTO_INCREMENT range ``[LAST_INSERT_ID, +affected)``, or the client-supplied
        PK values pulled from the INSERT params by column position;
      * createMany → the AUTO_INCREMENT ids from LAST_INSERT_ID up that this transaction can see (a
        bulk INSERT's ids need not be consecutive), or the PK tuples read back out of the payload;
      * upsert / upsertMany → EVERY column of the CONFLICT key (MySQL does not report which row ON
        DUPLICATE KEY UPDATE touched, so the AUTO_INCREMENT range is wrong once a row was updated;
        one column of a composite key names other rows too);
      * insert-or-ignore (``;action=ignore``) → as create, and ONLY the rows it inserted (a conflict
        writes nothing, so it returns nothing);
      * updateMany → EVERY batch JOIN key column, re-bound from the SAME JSON payload;
      * update → the PK of every row its WHERE names, read and LOCKED (FOR UPDATE) before the write;
        the written rows re-selected by those keys after it (never by the WHERE re-evaluated);
      * delete → the write's OWN WHERE predicate, read and LOCKED (FOR UPDATE) BEFORE the write (afterwards
        there is nothing left to describe); the DELETE must remove exactly those rows (affected).

    Returns a :class:`_MysqlReselect`. Mirrors src/scp/makesql/mysql-returning.ts, rust ``build_mysql_reselect``,
    go ``buildMysqlReselect`` and php ``buildMysqlReselect`` — one derivation, five runtimes.

    Fail-closed: a RETURNING write whose key cannot be identified raises rather than silently
    returning no rows.
    """
    lower = sql.lower()
    ret_pos = lower.rfind(" returning ")
    if ret_pos < 0:
        return None
    hint_region = sql[ret_pos:]
    cols = _PK_HINT_RE.sub("", sql[ret_pos + len(" returning "):]).strip()
    pk_cols, auto_inc = _parse_pk_hint(hint_region)
    conflict = _parse_conflict_hint(hint_region)
    write_sql = _PK_HINT_RE.sub("", sql[:ret_pos]).strip()
    wl = write_sql.lower()

    tm = _WRITE_TABLE_RE.search(write_sql)
    if tm is None:
        raise ValueError(f"scp write(mysql): cannot parse the target table of {write_sql!r}")
    table = tm.group(1)
    order_by = f" ORDER BY {', '.join(pk_cols)}" if pk_cols else ""
    is_batch = "json_table(" in wl
    cm = _INSERT_COLS_RE.search(write_sql)
    insert_cols = [c.strip() for c in cm.group(1).split(",")] if cm is not None else []

    def json_select(keys, what: str, written):
        # Recover a BATCH write's rows by reading its key TUPLES back out of the SAME JSON payload it
        # bound — every key column, never the first alone (a composite key's first column names other
        # rows too). The payload's fields ARE the INSERT columns, so a key column outside them would
        # read NULL back and recover nothing: that fails closed.
        if wl.startswith("insert"):
            for k in keys:
                if k not in insert_cols:
                    raise ValueError(f"scp write(mysql): {what} column {k!r} is not among the INSERT columns of {write_sql!r}")
        unq = ", ".join(f"JSON_UNQUOTE(jt.{k})" for k in keys)
        paths = ", ".join(f"{k} JSON PATH '$.{k}'" for k in keys)
        return _MysqlReselect(write_sql, (
            f"SELECT {cols} FROM {table} WHERE ({', '.join(keys)}) IN "
            f"(SELECT {unq} FROM JSON_TABLE(?, '$[*]' COLUMNS({paths})) jt){order_by}"
        ), [("json", 0)], written, False)

    def keyed_by_insert_params(keys, what: str, written):
        # Recover a SINGLE-row INSERT's row by EVERY key column, each bound from its INSERT column position.
        conds, binds = [], []
        for k in keys:
            if k not in insert_cols:
                raise ValueError(f"scp write(mysql): {what} column {k!r} is not among the INSERT columns of {write_sql!r}")
            conds.append(f"{k} = ?")
            binds.append(("param", insert_cols.index(k)))
        return _MysqlReselect(write_sql, f"SELECT {cols} FROM {table} WHERE {' AND '.join(conds)}{order_by}", binds, written, False)

    # An insert-or-ignore is spelled `ON DUPLICATE KEY UPDATE c = c` on a single row — it reads like an
    # upsert, but it writes NOTHING on a conflict, so it is recovered as the INSERT it may have been.
    noop_on_conflict = "on duplicate key update" in wl
    upsert = noop_on_conflict and _IGNORE_HINT_RE.search(hint_region) is None

    # upsert / upsertMany — by EVERY column of the CONFLICT key.
    if wl.startswith("insert") and upsert:
        if not conflict:
            raise ValueError(f"scp write(mysql): an upsert…RETURNING needs its conflict key in the pk hint ({write_sql!r})")
        return json_select(conflict, "conflict key", None) if is_batch else keyed_by_insert_params(conflict, "conflict key", None)

    # create / createMany / insert-or-ignore — by the AUTO_INCREMENT range, or by the client-supplied PK
    # values. Recovered only when it wrote a row, and only as many rows as it wrote (_written_row_count).
    if wl.startswith("insert"):
        if auto_inc and pk_cols == [auto_inc] and is_batch:
            # createMany (a bulk INSERT…SELECT): its ids start at LAST_INSERT_ID but need not be
            # consecutive, so the bare range would name other sessions' rows and miss our own. Every id
            # it allocated is ≥ LAST_INSERT_ID; the anchored read view hides other sessions' rows; the
            # count check fails the rest closed.
            return _MysqlReselect(
                write_sql, f"SELECT {cols} FROM {table} WHERE {auto_inc} >= ?{order_by}",
                [("lastId", 0)], "affected", False, f"SELECT 1 FROM {table} LIMIT 1",
            )
        if auto_inc and pk_cols == [auto_inc]:
            # A single-row / multi-VALUES INSERT reserves its ids up front, so they ARE consecutive.
            return _MysqlReselect(
                write_sql, f"SELECT {cols} FROM {table} WHERE {auto_inc} >= ? AND {auto_inc} < ?{order_by}",
                [("lastId", 0), ("highId", 0)], "insertId" if noop_on_conflict else "affected", False,
            )
        if not pk_cols:
            raise ValueError(
                f"scp write(mysql): an INSERT…RETURNING carries no pk hint, so its written rows cannot be "
                f"identified ({write_sql!r}). The producer must pass the model's declared primary key."
            )
        # createMany with a CLIENT-supplied key: the statement binds ONE JSON payload, not one param
        # per key, so the key tuples are read back out of that SAME payload (as upsertMany does). A batch
        # `INSERT IGNORE` reads back pre-existing rows too, so its count check fails it closed.
        if is_batch:
            return json_select(pk_cols, "PK", "affected")
        if noop_on_conflict:
            # insert-or-ignore on a client-supplied key: lock its PK first (insert_if_absent) — never its
            # affected count, which CLIENT_FOUND_ROWS makes the same for a conflict and an insert.
            keyed = keyed_by_insert_params(pk_cols, "PK", None)
            return keyed._replace(
                lock_sql=f"SELECT {', '.join(pk_cols)} FROM {table} WHERE {' AND '.join(f'{k} = ?' for k in pk_cols)} FOR UPDATE",
                lock_binds=keyed.binds, insert_if_absent=True,
            )
        return keyed_by_insert_params(pk_cols, "PK", "affected")

    # updateMany — by EVERY batch JOIN key column, re-selected from the SAME JSON payload the write bound.
    if wl.startswith("update") and is_batch:
        keys = _update_batch_keys(write_sql)
        if keys is None:
            raise ValueError(f"scp write(mysql): cannot parse the batch JOIN key of {write_sql!r}")
        return json_select(keys, "JOIN key", None)

    # update / delete — by the write's OWN WHERE predicate. Index off `wl` (the STRIPPED write's
    # lowercase), not the original sql: `write_sql` is hint-removed and trimmed, so only `wl`'s
    # offsets line up with the slices below.
    where_pos = wl.rfind(" where ")
    if where_pos < 0:
        raise ValueError(f"scp write(mysql): a write…RETURNING needs a WHERE to recover its rows ({write_sql!r})")
    where_sql = write_sql[where_pos + len(" where "):].strip()
    leading = write_sql[:where_pos].count("?")
    binds = [("param", leading + i) for i in range(where_sql.count("?"))]
    # The DELETE: its pre-image is a LOCKING read — it reads the latest committed rows (not an older
    # snapshot) and holds them, so no other session can remove them first — and the DELETE must remove
    # exactly those rows: its affected count is checked against the pre-image ("affected").
    if wl.startswith("delete"):
        return _MysqlReselect(write_sql, f"SELECT {cols} FROM {table} WHERE {where_sql}{order_by} FOR UPDATE", binds, "affected", True)
    # The UPDATE: lock the rows its WHERE names and read their keys BEFORE the write, then recover the
    # written rows (carrying their new values) by those keys — never by the WHERE re-evaluated after it.
    if not pk_cols:
        raise ValueError(
            f"scp write(mysql): an UPDATE…RETURNING carries no pk hint, so the rows it writes cannot be keyed "
            f"({write_sql!r}). The producer must pass the model's declared primary key."
        )
    return _MysqlReselect(
        write_sql, f"SELECT {cols} FROM {table} WHERE ({', '.join(pk_cols)}) IN ", [], None, False,
        lock_sql=f"SELECT {', '.join(pk_cols)} FROM {table} WHERE {where_sql}{order_by} FOR UPDATE",
        lock_binds=binds, key_cols=pk_cols,
    )


def _keyed_select_sql(rs: _MysqlReselect, rows: int) -> str:
    """An UPDATE's ``select_sql`` completed for ``rows`` locked keys (mysql-returning.ts
    ``keyedSelectSql``): one ``(?, …)`` tuple per row, ordered by the declared PK."""
    tuple_ = "(" + ", ".join("?" for _ in rs.key_cols) + ")"
    return f"{rs.select_sql}({', '.join(tuple_ for _ in range(rows))}) ORDER BY {', '.join(rs.key_cols)}"


def _written_row_count(written: Optional[str], last_id: int, affected: int) -> Optional[int]:
    """How many rows the write wrote, from its own result (mysql-returning.ts ``writtenRowCount``);
    ``None`` ⇒ not countable.

    ``affected`` — the affected count (a plain INSERT / INSERT IGNORE never updates a row, so
    CLIENT_FOUND_ROWS cannot change it); ``insertId`` — an insert-or-ignore on an AUTO_INCREMENT key
    inserted ⇔ its insert id is not 0.
    """
    if written is None:
        return None
    if written == "insertId":
        return 1 if last_id != 0 else 0
    return affected


def _check_recovered(rows, written: Optional[int], write_sql: str):
    """Fail closed when the recovered row count differs from the count the write wrote: the SELECT then
    named rows the write did not write (or missed ones it did)."""
    if written is not None and len(rows) != written:
        raise ValueError(
            f"scp write(mysql): the write wrote {written} row(s) but its RETURNING recovery found {len(rows)} — "
            f"refusing to return rows it cannot attribute to this write ({write_sql!r})"
        )
    return rows


def _bind_reselect(binds, params, last_id, affected):
    """Bind the recovering SELECT's ``?``s against the write's params + the write's own result."""
    out = []
    for kind, index in binds:
        if kind == "lastId":
            out.append(last_id)
        elif kind == "highId":
            # A write that wrote no row is never re-selected (_written_row_count 0 ⇒ []), so affected ≥ 1.
            out.append(last_id + affected)
        elif kind == "json":
            out.append(params[0] if params else None)
        else:
            out.append(params[index] if index < len(params) else None)
    return out


# ── Per-connection execution primitives (shared by the pooled read/write path + the owned tx) ──
#
# These run one statement on a GIVEN DB-API connection — the SAME row-exec, MySQL-RETURNING-emulation,
# and cell-scalar logic whether the connection is a freshly-acquired pooled one (non-tx read/write) or
# the tx's OWNED connection (Phase A / #78). Factoring them out of the old `_PooledPrepared`/
# `_PooledDriver._writer` pair is what lets the tx path own its connection without a driver-global slot.


def _scalar(v: Any) -> Any:
    """Coerce a driver cell to a canonical bc scalar (int/float/bool/str/None) WITHOUT losing its value.

    psycopg maps a PG ``uuid`` column to a Python ``uuid.UUID`` and other rich types (Decimal,
    date/datetime) to their own classes. The conformance row encoding — and the cross-language
    reference — are JSON scalars, so a non-native cell is stringified to its canonical text form,
    exactly as SQLite/MySQL return a uuid-as-text or the Rust PG driver falls back to ``String``.
    Native scalars pass through unchanged (bool before int, since ``bool`` is an ``int`` subclass).

    The mapping is INJECTIVE: two different DB values never become one runtime value, because a cell is
    a relation key (``pluck`` / ``group``) and a write key as often as it is a payload (#363).

      - ``Decimal`` (every NUMERIC/DECIMAL column and numeric aggregate): an integral finite value is
        the exact ``int``; any other is its exact decimal text — the DECIMAL/NUMERIC ``string`` outType
        (``src/scp/coltype.ts``). Never through ``float``: 9007199254740993 rounds to …992 there.
      - ``bytes``: decoded STRICTLY, so an invalid UTF-8 cell fails closed (``UnicodeDecodeError``)
        instead of collapsing onto another value through U+FFFD — as the Rust readers' ``String``
        decode fails on it.
    """
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    from decimal import Decimal

    if isinstance(v, Decimal):
        if v.is_finite() and v == v.to_integral_value():
            return int(v)
        return format(v, "f")
    if isinstance(v, (bytes, bytearray)):
        return bytes(v).decode("utf-8")
    return str(v)


def _fetch_all(cur) -> List[Dict[str, Any]]:
    cols = [d[0] for d in cur.description] if cur.description is not None else []
    return [{c: _scalar(x) for c, x in zip(cols, r)} for r in cur.fetchall()]


def _conn_all(conn: Any, sql: str, params: Sequence[Any], xform, emulate_returning: bool) -> List[Dict[str, Any]]:
    """Run a SELECT/RETURNING statement on ``conn`` (with MySQL RETURNING emulation when configured).

    MySQL parses no RETURNING, so a write that declares one runs STRIPPED and its written rows are
    recovered by the SELECT :func:`_build_mysql_reselect` derives — the id range, the conflict key,
    the batch JSON key or the write's own WHERE, keyed off the strip-before-execute PK hint. The
    recovery runs on THIS connection, so inside a transaction it sees the uncommitted rows; a
    DELETE's pre-image SELECT runs BEFORE the write, since afterwards there is nothing left to
    describe. The steps run ATOMICALLY (:func:`_atomically`). This is the ONE python reselect path,
    mirroring the four sibling runtimes.
    """
    if emulate_returning:
        rs = _build_mysql_reselect(sql)
        if rs is not None:
            return _atomically(conn, lambda: _conn_returning(conn, rs, params, xform))
    return _conn_select(conn, xform(sql), list(params))


def _atomically(conn: Any, steps):
    """Run the RETURNING emulation's steps as ONE unit: inside the connection's open transaction, or in
    their own BEGIN … COMMIT (ROLLBACK when a step — the fail-closed recovery included — fails, so its
    write does not survive). Whether a transaction is open is the SERVER's answer: PyMySQL keeps the
    status flags of the last OK/EOF packet in ``server_status``, whoever issued the BEGIN."""
    if conn.server_status & _SERVER_STATUS_IN_TRANS:
        return steps()
    cur = conn.cursor()
    cur.execute("BEGIN")
    try:
        result = steps()
    except BaseException:
        cur.execute("ROLLBACK")
        cur.close()
        raise
    cur.execute("COMMIT")
    cur.close()
    return result


def _conn_returning(conn: Any, rs: _MysqlReselect, params: Sequence[Any], xform) -> List[Dict[str, Any]]:
    """One RETURNING emulation's steps on ``conn`` (the caller makes them atomic)."""
    if rs.before:
        rows = _conn_select(conn, xform(rs.select_sql), _bind_reselect(rs.binds, list(params), 0, 0))
        cur = conn.cursor()
        cur.execute(xform(rs.write_sql), tuple(params))
        affected = cur.rowcount
        cur.close()
        # The DELETE must have removed exactly the locked pre-image.
        return _check_recovered(rows, _written_row_count(rs.written, 0, affected), rs.write_sql)
    if rs.lock_sql:
        keys = _conn_select(conn, xform(rs.lock_sql), _bind_reselect(rs.lock_binds, list(params), 0, 0))
        cur = conn.cursor()
        cur.execute(xform(rs.write_sql), tuple(params))
        cur.close()
        if rs.insert_if_absent:
            # insert-or-ignore on a client-supplied key: its PK was already there ⇒ it inserted nothing;
            # else the row that PK names now is the one it inserted (the lock kept every other session out).
            if keys:
                return []
            return _conn_select(conn, xform(rs.select_sql), _bind_reselect(rs.binds, list(params), 0, 0))
        # UPDATE…RETURNING: recover the written rows by the keys locked BEFORE the write (never by the
        # WHERE re-evaluated after it).
        if not keys:
            return []
        key_values = [k[c] for k in keys for c in rs.key_cols]
        rows = _conn_select(conn, xform(_keyed_select_sql(rs, len(keys))), key_values)
        return _check_recovered(rows, len(keys), rs.write_sql)
    if rs.anchor_sql:
        _conn_select(conn, rs.anchor_sql, [])
    cur = conn.cursor()
    cur.execute(xform(rs.write_sql), tuple(params))
    last_id = cur.lastrowid or 0
    affected = cur.rowcount
    cur.close()
    # A write that wrote no row (an insert-or-ignore that hit a conflict) returns nothing.
    written = _written_row_count(rs.written, last_id, affected)
    if written == 0:
        return []
    rows = _conn_select(conn, xform(rs.select_sql), _bind_reselect(rs.binds, list(params), last_id, affected))
    return _check_recovered(rows, written, rs.write_sql)


def _conn_select(conn: Any, sql: str, params: Sequence[Any]) -> List[Dict[str, Any]]:
    """Run one already-transformed row-returning statement on ``conn`` and materialize its rows."""
    cur = conn.cursor()
    cur.execute(sql, tuple(params))
    rows = _fetch_all(cur)
    cur.close()
    return rows


def _conn_run(conn: Any, sql: str, params: Sequence[Any], xform) -> RunInfo:
    """Run a non-returning write on ``conn`` and report the affected summary."""
    cur = conn.cursor()
    cur.execute(xform(sql), tuple(params))
    changes = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else 0
    last = cur.lastrowid if getattr(cur, "lastrowid", None) is not None else 0
    cur.close()
    return RunInfo(changes, last)


class _PooledPrepared:
    """A prepared statement over a POOLED live DB-API driver (psycopg / PyMySQL) — the NON-TX path.

    It checks out a connection from the pool, runs the statement, and returns the connection — so
    concurrent siblings run on DISTINCT connections. The write-tx path no longer rides here: a tx runs
    on its OWN connection via :class:`_PooledTxConnection` (per-execution ownership, §3), NOT through a
    driver-global pinned writer.
    """

    __slots__ = ("_driver", "_sql")

    def __init__(self, driver: "_PooledDriver", sql: str) -> None:
        self._driver = driver
        self._sql = sql

    def all(self, params: Sequence[Any]) -> List[Dict[str, Any]]:
        return self._driver._with_conn(
            lambda conn: _conn_all(conn, self._sql, params, self._driver._xform, self._driver._emulate_returning)
        )

    def run(self, params: Sequence[Any]) -> RunInfo:
        return self._driver._with_conn(lambda conn: _conn_run(conn, self._sql, params, self._driver._xform))


class _PooledTxConnection:
    """The OWNED tx handle over a POOLED live DB-API connection (§3) — the Python analogue of v1
    ``PoolTransaction``. It acquires ONE connection from the pool and HOLDS it for the transaction's
    whole duration: every tx-body statement AND every tx-control statement (BEGIN / COMMIT / ROLLBACK /
    the isolation SET) runs on THIS connection via :meth:`run` — routed THROUGH the exec-context seam by
    the combinator, so a registered middleware observes the runtime tx-control (Phase D / #95, full TS
    parity). This handle no longer issues tx-control SQL itself; it is the connection OWNER (acquire /
    release / discard), not the tx-control issuer.

    **Release ownership**: :meth:`release` (idempotent) is the SOLE releaser, called by the seam
    combinator in a ``finally`` so the pooled connection is returned on EVERY path — including a
    COMMIT/ROLLBACK that itself raises (the leak the old self-in-``commit`` release missed — #78).
    ``destroy`` drops a poisoned connection instead of returning it to the pool.

    Concurrent transactions each hold a DISTINCT ``_PooledTxConnection`` over a DISTINCT pooled
    connection, so their writes never cross-talk — the isolation the removed driver-global ``_writer``
    slot violated.
    """

    __slots__ = ("_pool", "_xform", "_emulate_returning", "_conn", "_released")

    def __init__(
        self,
        pool: "_ConnectionPool",
        xform,
        emulate_returning: bool,
    ) -> None:
        self._pool = pool
        self._xform = xform
        self._emulate_returning = emulate_returning
        # Acquire + OWN one connection. tx-control (isolation SET / BEGIN / COMMIT / ROLLBACK) is issued
        # by the combinator THROUGH the seam on THIS pinned connection (Phase D / #95) — NOT here — so a
        # prelude/BEGIN failure is handled by the combinator's discard-on-poison finally (destroy=True),
        # exactly like a body-statement failure. `pool.acquire()` either returns an owned conn or raises
        # before ownership (nothing to discard).
        self._conn = pool.acquire()
        self._released = False

    def all(self, sql: str, params: Sequence[Any]) -> List[Dict[str, Any]]:
        return _conn_all(self._conn, sql, params, self._xform, self._emulate_returning)

    def run(self, sql: str, params: Sequence[Any]) -> RunInfo:
        # Serves BOTH tx-body writes AND tx-control (BEGIN/COMMIT/ROLLBACK/SET). tx-control carries no
        # params, so `xform` is a no-op on it. A failure propagates so the combinator releases with
        # destroy=True (a raised COMMIT/BEGIN leaves the connection in an unknown state — it must not
        # re-enter the pool).
        return _conn_run(self._conn, sql, params, self._xform)

    def release(self, destroy: bool) -> None:
        if self._released:
            return  # idempotent — the combinator's finally is the single releaser, but guard anyway
        self._released = True
        if destroy:
            # A poisoned connection: DISCARD it (close + free a pool slot for a fresh one). Never
            # return it to the pool, and never leave the pool's opened-count stuck at the ceiling.
            self._pool.discard(self._conn)
        else:
            self._pool.release(self._conn)


class _PooledDriver:
    """Shared pooled live-driver base (Postgres / MySQL) — the parallel-read + per-execution-owned-tx
    seam (Phase A / #78). NO driver-global tx slot: a transaction owns its connection via
    :class:`_PooledTxConnection` (acquired by :meth:`begin_tx`), so concurrent transactions are
    isolated."""

    __slots__ = ("_pool", "_xform", "_emulate_returning")

    def __init__(self, pool: _ConnectionPool, xform, emulate_returning: bool) -> None:
        self._pool = pool
        self._xform = xform
        self._emulate_returning = emulate_returning

    def _with_conn(self, op):
        """Run ``op(conn)`` on a freshly checked-out pooled connection (the non-tx read/write path)."""
        conn = self._pool.acquire()
        try:
            result = op(conn)
        except BaseException as error:
            # The pool's connections are autocommit, so a SQL error (constraint violation, syntax error,
            # statement_timeout) leaves the session usable: return it. DISCARD only a connection error
            # (dropped mid-statement) or a non-Exception interruption (KeyboardInterrupt etc. can land
            # mid-statement), whose state is unknown. #330 defect 1.
            if is_connection_error(error) or not isinstance(error, Exception):
                self._pool.discard(conn)
            else:
                self._pool.release(conn)
            raise
        self._pool.release(conn)
        return result

    def exec_ddl(self, statements: Sequence[str]) -> None:
        def run_all(conn):
            cur = conn.cursor()
            for stmt in statements:
                cur.execute(stmt)
            cur.close()

        self._with_conn(run_all)

    def prepare(self, sql: str) -> _PooledPrepared:
        return _PooledPrepared(self, sql)

    def begin_tx(self) -> _PooledTxConnection:
        """Acquire + OWN one :class:`_PooledTxConnection` for a transaction (§3): ONE pooled connection,
        held for the tx's whole duration. Concurrent ``begin_tx`` calls (distinct threads) acquire
        DISTINCT connections ⇒ isolated — the concurrent-tx fix. tx-control (the isolation SET / BEGIN /
        COMMIT / ROLLBACK) is issued THROUGH the seam by the combinator on this pinned connection
        (Phase D / #95, middleware-visible), NOT here — so this method just acquires the owned conn."""
        return _PooledTxConnection(self._pool, self._xform, self._emulate_returning)

    def close(self) -> None:
        self._pool.close()


class PostgresDriver(_PooledDriver):
    """A live Postgres driver (psycopg 3, POOLED) implementing the :class:`Driver` seam.

    Renders a `postgres`-tagged bundle → `$N`; rewrites `$N`→`%s` for psycopg. A bounded pool of
    autocommit connections lets independent sibling relations run concurrently on distinct
    connections; the write-tx pins one connection for its BEGIN…COMMIT span.
    """

    @classmethod
    def connect(
        cls,
        *,
        host: str,
        port: int,
        user: str,
        password: str,
        dbname: str,
        pool_size: int = DEFAULT_POOL_SIZE,
    ) -> "PostgresDriver":
        import psycopg  # imported lazily so the SQLite conformance never needs the driver installed

        def factory():
            # connect_timeout bounds the TCP connect so an unreachable/non-responding host fails in
            # finite time (psycopg has NO default connect timeout — a blackhole host would block the
            # acquire forever, #225). Matches the v1 driver's 30s default and the other runtimes.
            return psycopg.connect(
                host=host, port=port, user=user, password=password, dbname=dbname, autocommit=True,
                connect_timeout=int(DEFAULT_ACQUIRE_TIMEOUT_SECONDS),
            )

        pool = _ConnectionPool(factory, pool_size)
        return cls(pool, _dollar_to_pyformat, emulate_returning=False)


class MysqlDriver(_PooledDriver):
    """A live MySQL driver (PyMySQL, POOLED) implementing the :class:`Driver` seam.

    Renders a `mysql`-tagged bundle → `?`; rewrites `?`→`%s` for PyMySQL. MySQL 8.0 has NO
    `RETURNING`, so an INSERT…RETURNING is emulated at this seam (strip → INSERT → re-select the
    AUTO_INCREMENT PK's columns) — the WS6 TS ScpDialect behavior-by-convention. A bounded pool of
    autocommit connections gives concurrent siblings distinct connections; the write-tx pins one.
    """

    @classmethod
    def connect(
        cls,
        *,
        host: str,
        port: int,
        user: str,
        password: str,
        dbname: str,
        pool_size: int = DEFAULT_POOL_SIZE,
    ) -> "MysqlDriver":
        import pymysql  # lazy import (conformance bar never needs it)

        def factory():
            # connect_timeout bounds the TCP connect so an unreachable host fails in finite time (#225).
            # PyMySQL defaults this to 10s; pin it to the shared budget so both live drivers agree.
            return pymysql.connect(
                host=host, port=port, user=user, password=password, database=dbname, autocommit=True,
                connect_timeout=int(DEFAULT_ACQUIRE_TIMEOUT_SECONDS),
            )

        pool = _ConnectionPool(factory, pool_size)
        return cls(pool, _qmark_to_pyformat, emulate_returning=True)
