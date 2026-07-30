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
from typing import Any, Callable, Dict, List, Protocol, Sequence, Tuple


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
        §3). The central seam's ``with_transaction`` pins the returned handle so every statement in the
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

# Bound EVERY acquire so an UNREACHABLE / non-responding DB fails in FINITE time instead of hanging
# (#225). `acquire` has two sub-waits, both bounded to this budget: the factory's TCP connect
# (`connect_timeout`, set in the pg/mysql factories) and the wait for a released connection when the
# pool is at capacity (`_free.get(timeout=…)`). 30s matches the established codebase default — the v1
# pg/mysql drivers' `config.timeout || 30` (src/drivers/postgres.ts, src/drivers/mysql.ts) — and the
# other runtimes' pool-library connect/acquire timeouts (rust sqlx ~30s / deadpool wait, go database/sql
# Ping, TS pg `connectionTimeoutMillis`). Only Python hand-rolls its pool, so it must supply the bound
# those libraries give the other four legs for free.
DEFAULT_ACQUIRE_TIMEOUT_SECONDS = 30.0


class _ConnectionPool:
    """A minimal thread-safe, bounded pool of DB-API connections (dependency-free).

    A bounded ``queue`` of live connections created lazily up to ``max_size``. ``acquire`` blocks
    for a free connection (or opens a new one below the ceiling); ``release`` returns it. This keeps
    the parallel-read seam dependency-free (no psycopg_pool / DBUtils needed) while giving each
    concurrent sibling its own connection.
    """

    __slots__ = ("_factory", "_max", "_free", "_opened", "_lock", "_closed", "_acquire_timeout")

    def __init__(self, factory, max_size: int, acquire_timeout: float = DEFAULT_ACQUIRE_TIMEOUT_SECONDS) -> None:
        import queue as _queue
        import threading as _threading

        self._factory = factory
        self._max = max_size
        self._free: "Any" = _queue.LifoQueue()
        self._opened = 0
        self._lock = _threading.Lock()
        # The bound on the at-capacity wait for a released connection (see acquire). Finite so an
        # exhausted pool that will never be replenished (e.g. every open failed) raises instead of
        # blocking forever (#225).
        self._acquire_timeout = acquire_timeout
        # Fail-fast after close(): a post-close acquire must RAISE, not block forever on `_free.get()`
        # (the pool is drained and nothing will be released). Additive — the Phase A/B paths never
        # acquire after close, so behavior there is unchanged; Phase C's close_all_pools relies on it so
        # a query on a closed pool fails loudly (mirror the TS pool.end() → query rejects).
        self._closed = False

    def acquire(self) -> Any:
        import queue as _queue

        if self._closed:
            raise RuntimeError("scp connection pool: acquire after close (the pool has been closed)")
        # Fast path: reuse a free connection.
        try:
            return self._free.get_nowait()
        except _queue.Empty:
            pass
        # Reserve a slot if below the ceiling, then open OUTSIDE the lock (a slow/blocked connect must
        # not serialize every other acquire/release on this pool).
        reserved = False
        with self._lock:
            if self._closed:
                raise RuntimeError("scp connection pool: acquire after close (the pool has been closed)")
            if self._opened < self._max:
                self._opened += 1
                reserved = True
        if reserved:
            try:
                return self._factory()
            except BaseException:
                # The open FAILED — RELEASE the reserved slot (mirror `discard`'s decrement). Without
                # this a failed connect permanently consumes capacity; once `_opened` hits the ceiling
                # every later acquire falls through to the wait below with no connection ever coming, so
                # an unreachable DB turns each fast connect-refused into an unbounded hang (#225).
                with self._lock:
                    self._opened -= 1
                raise
        # Pool at capacity: wait for a released connection, but BOUND the wait. An unbounded get() hangs
        # forever when nothing will ever be released; on timeout raise a clear error instead (#225 — the
        # parity target: the other runtimes' pool libraries bound this acquire wait).
        try:
            return self._free.get(timeout=self._acquire_timeout)
        except _queue.Empty:
            raise TimeoutError(
                f"scp connection pool: acquire timed out after {self._acquire_timeout}s "
                f"(pool at capacity {self._max}, no connection released)"
            ) from None

    def release(self, conn: Any) -> None:
        self._free.put(conn)

    def discard(self, conn: Any) -> None:
        """Permanently drop a POISONED connection (a tx whose COMMIT/ROLLBACK itself raised): close it
        and DECREMENT the opened count so a fresh connection can be opened in its place. Without the
        decrement the pool's ``_opened < _max`` ceiling would count the dead connection forever and
        capacity would shrink by one per discard — eventual exhaustion under repeated commit failures
        (the deeper half of the #78 leak: releasing wasn't enough; the destroy path must re-open a slot).
        """
        try:
            conn.close()
        except Exception:
            pass
        with self._lock:
            if self._opened > 0:
                self._opened -= 1

    def close(self) -> None:
        import queue as _queue

        self._closed = True  # fail-fast: a subsequent acquire raises instead of blocking on a drained pool
        while True:
            try:
                conn = self._free.get_nowait()
            except _queue.Empty:
                break
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
# The JOIN key column of an updateMany (`ON <alias>.<col> = JSON_UNQUOTE(…)`).
_BATCH_JOIN_KEY_RE = re.compile(r"\sON\s+[A-Za-z0-9_]*\.?([A-Za-z0-9_]+)\s*=", re.IGNORECASE)
# The strip-before-execute PK hint the mysql bundle appends to a write…RETURNING (tx.ts mysqlPkHint):
#   ` /*scp:pk=col1,col2;ai=<autoIncCol|>[;conflict=cols]*/`
# STRIP and PARSE are separate patterns, as in the four sibling ports: the strip form must swallow the
# whole comment (`conflict=` included), while `ai=` must stop at the `;` so the conflict list cannot
# leak into the AUTO_INCREMENT column name.
_PK_HINT_RE = re.compile(r"\s*/\*scp:pk=[^*]*\*/", re.IGNORECASE)
_PK_HINT_PARSE_RE = re.compile(r"/\*scp:pk=([^;*]*);ai=([^;*]*)", re.IGNORECASE)
_CONFLICT_HINT_RE = re.compile(r";conflict=([^*]*)\*/", re.IGNORECASE)


def _dollar_to_pyformat(sql: str) -> str:
    """Postgres `$N` → DB-API `%s` (positional). Render already numbers left-to-right 1..N, so a
    plain replace preserves order. Literal `%` is doubled so psycopg/pymysql don't treat it as a
    format directive (the rendered SQL never contains a literal `%`, but this keeps the seam safe).
    """
    return _DOLLAR_RE.sub("%s", sql.replace("%", "%%"))


def _qmark_to_pyformat(sql: str) -> str:
    """MySQL render keeps `?`; PyMySQL binds `%s`. Replace each `?` with `%s` (literal `%` doubled)."""
    return sql.replace("%", "%%").replace("?", "%s")


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


def _build_mysql_reselect(sql: str):
    """Derive the MySQL RETURNING recovery for ``sql``, or ``None`` when it declares no RETURNING.

    MySQL parses no RETURNING. A write that declares one is run STRIPPED and its written rows are
    recovered by a SELECT on the SAME connection, keyed on whatever identifies them:

      * create / createMany → the AUTO_INCREMENT range ``[LAST_INSERT_ID, +affected)``, or the
        client-supplied PK values pulled from the INSERT params by column position;
      * upsert / upsertMany → the CONFLICT key (MySQL does not report which row ON DUPLICATE KEY
        UPDATE touched, so the AUTO_INCREMENT range is wrong once a row was updated);
      * updateMany → the batch JOIN key, re-bound from the SAME JSON payload;
      * update → the write's OWN WHERE predicate (after the write — the rows carry their new values);
      * delete → the write's OWN WHERE predicate, selected BEFORE the write (afterwards there is
        nothing left to describe; that pre-image IS the set of rows the DELETE removes).

    Returns ``(write_sql, select_sql, binds, before)`` where each bind is ``("lastId"|"highId"|
    "json"|"param", index)``. Mirrors src/scp/makesql/mysql-returning.ts, rust ``build_mysql_reselect``,
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

    def json_select(key: str) -> str:
        return (
            f"SELECT {cols} FROM {table} WHERE {key} IN "
            f"(SELECT JSON_UNQUOTE(jt.{key}) FROM JSON_TABLE(?, '$[*]' COLUMNS({key} JSON PATH '$.{key}')) jt)"
            f"{order_by}"
        )

    # upsert / upsertMany — by the CONFLICT key.
    if wl.startswith("insert") and "on duplicate key update" in wl:
        if not conflict:
            raise ValueError(f"scp write(mysql): an upsert…RETURNING needs its conflict key in the pk hint ({write_sql!r})")
        key = conflict[0]
        if is_batch:
            return write_sql, json_select(key), [("json", 0)], False
        if key not in insert_cols:
            raise ValueError(f"scp write(mysql): conflict key {key!r} is not among the INSERT columns of {write_sql!r}")
        return write_sql, f"SELECT {cols} FROM {table} WHERE {key} = ?{order_by}", [("param", insert_cols.index(key))], False

    # create / createMany — by the AUTO_INCREMENT range, or by the client-supplied PK values.
    if wl.startswith("insert"):
        if auto_inc and pk_cols == [auto_inc]:
            return write_sql, f"SELECT {cols} FROM {table} WHERE {auto_inc} >= ? AND {auto_inc} < ?{order_by}", [("lastId", 0), ("highId", 0)], False
        if not pk_cols:
            raise ValueError(
                f"scp write(mysql): an INSERT…RETURNING carries no pk hint, so its written rows cannot be "
                f"identified ({write_sql!r}). The producer must pass the model's declared primary key."
            )
        if is_batch:
            # createMany with a CLIENT-supplied key: the statement binds ONE JSON payload, not one
            # param per key, so the keys are read back out of that SAME payload (as upsertMany does).
            if len(pk_cols) != 1:
                raise ValueError(
                    f"scp write(mysql): a batch INSERT…RETURNING on the COMPOSITE key "
                    f"({', '.join(pk_cols)}) cannot be recovered from its JSON payload ({write_sql!r})"
                )
            return write_sql, json_select(pk_cols[0]), [("json", 0)], False
        conds, binds = [], []
        for pk in pk_cols:
            if pk not in insert_cols:
                raise ValueError(f"scp write(mysql): PK column {pk!r} is not among the INSERT columns of {write_sql!r}")
            conds.append(f"{pk} = ?")
            binds.append(("param", insert_cols.index(pk)))
        return write_sql, f"SELECT {cols} FROM {table} WHERE {' AND '.join(conds)}{order_by}", binds, False

    # updateMany — by the batch JOIN key, re-selected from the SAME JSON payload the write bound.
    if wl.startswith("update") and is_batch:
        km = _BATCH_JOIN_KEY_RE.search(write_sql)
        if km is None:
            raise ValueError(f"scp write(mysql): cannot parse the batch JOIN key of {write_sql!r}")
        return write_sql, json_select(km.group(1)), [("json", 0)], False

    # update / delete — by the write's OWN WHERE predicate. Index off `wl` (the STRIPPED write's
    # lowercase), not the original sql: `write_sql` is hint-removed and trimmed, so only `wl`'s
    # offsets line up with the slices below.
    where_pos = wl.rfind(" where ")
    if where_pos < 0:
        raise ValueError(f"scp write(mysql): a write…RETURNING needs a WHERE to recover its rows ({write_sql!r})")
    where_sql = write_sql[where_pos + len(" where "):].strip()
    leading = write_sql[:where_pos].count("?")
    binds = [("param", leading + i) for i in range(where_sql.count("?"))]
    return write_sql, f"SELECT {cols} FROM {table} WHERE {where_sql}{order_by}", binds, wl.startswith("delete")


def _bind_reselect(binds, params, last_id, affected):
    """Bind the recovering SELECT's ``?``s against the write's params + the write's own result."""
    out = []
    for kind, index in binds:
        if kind == "lastId":
            out.append(last_id)
        elif kind == "highId":
            out.append(last_id + max(1, affected))
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
    """Coerce a driver cell to a canonical bc scalar (int/float/bool/str/None).

    psycopg maps a PG ``uuid`` column to a Python ``uuid.UUID`` and other rich types (Decimal,
    date/datetime) to their own classes. The conformance row encoding — and the cross-language
    reference — are JSON scalars, so a non-native cell is stringified to its canonical text form,
    exactly as SQLite/MySQL return a uuid-as-text or the Rust PG driver falls back to ``String``.
    Native scalars pass through unchanged (bool before int, since ``bool`` is an ``int`` subclass).
    """
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    from decimal import Decimal

    if isinstance(v, Decimal):
        f = float(v)
        return int(f) if f.is_integer() else f
    if isinstance(v, (bytes, bytearray)):
        return bytes(v).decode("utf-8", "replace")
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
    describe. This is the ONE python reselect path, mirroring the four sibling runtimes.
    """
    if emulate_returning:
        rs = _build_mysql_reselect(sql)
        if rs is not None:
            write_sql, select_sql, binds, before = rs
            if before:
                rows = _conn_select(conn, xform(select_sql), _bind_reselect(binds, list(params), 0, 0))
                cur = conn.cursor()
                cur.execute(xform(write_sql), tuple(params))
                cur.close()
                return rows
            cur = conn.cursor()
            cur.execute(xform(write_sql), tuple(params))
            last_id = cur.lastrowid or 0
            affected = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else 1
            cur.close()
            return _conn_select(conn, xform(select_sql), _bind_reselect(binds, list(params), last_id, affected))
    return _conn_select(conn, xform(sql), list(params))


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
            return op(conn)
        finally:
            self._pool.release(conn)

    def exec_ddl(self, statements: Sequence[str]) -> None:
        conn = self._pool.acquire()
        try:
            cur = conn.cursor()
            for stmt in statements:
                cur.execute(stmt)
            cur.close()
        finally:
            self._pool.release(conn)

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
