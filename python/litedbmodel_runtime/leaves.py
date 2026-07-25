"""litedbmodel v2 SCP — the op-INDEPENDENT leaf transport (#141), Python port of ``src/scp/leaves.ts``.

The three op-agnostic (NOT per-op) leaves the bc python emitter's ir-exec runner (``run_behavior``)
calls by catalog name via boundary injection (``bind(handlers)``). Each is a bc handler
(``handler(ports, ctx) -> {"ok": value} | {"error": str}``) — the SAME contract the rust/go
typed-native runners call positionally (``rust/litedbmodel_runtime/src/leaves.rs``
``execute_sql``/``pluck_keys``/``group_children``), reproduced for the python literal (ir-exec) path
(epic #123: ts/go/rust = native de-box; py/php = literal). Python's native value model is the plain
``dict`` record, so there is NO ``WireValue`` conversion — the wire IS the dict.

  - ``executeSQL`` — the SOLE SQL transport: render ``?``→dialect placeholders, bind params (an array
    param — a relation key set from ``pluck`` or a batch record set — rides per dialect: sqlite/mysql
    JSON-encode it for ``json_each``/``JSON_TABLE``, postgres binds the array as-is), and run it through
    the runtime's central execute/run seam (:func:`exec_context.execute` / :func:`exec_context.run`) on
    the bound driver — the ONLY driver contact. The OPTIONAL ``guard`` port is the RELATION runaway cap
    of a guarded relation child fetch: the raw rows are asserted against it HERE
    (:meth:`errors.LimitExceededError.check`) because past ``group`` the graph is already nested. A
    non-returning write returns a one-row ``[{changes, lastInsertRowid}]`` summary so the leaf output
    shape is uniform (a list of rows).
  - ``pluck`` — rows + the ordered key-column TUPLE → the deduped, non-null batch key set (single-key →
    a flat scalar array; composite → an array-of-tuples). Delegates the dedupe to the shared grouping
    core (:func:`grouping.dedupe_key_tuples`) — the SAME SSoT the runtime relation path uses.
  - ``group`` — parents + flat children → each parent with its children nested under ``into`` per
    cardinality. Delegates to the shared grouping core (:func:`grouping.group_by_key` /
    :func:`grouping.attach_to_parent`) — the SAME SSoT, no duplicated grouping.

The leaf is injected driver-bound (a closure over the :class:`ExecutionContext` + dialect) rather than
resolving a thread-local ambient driver: the bc python boundary is ``bind(handlers)``, so the transport
is handed in directly (the rust/go typed-native path resolves an ambient driver because the generated
code calls the leaf with no driver arg — the python ir-exec path injects it).
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union

from .driver import Driver
from .errors import LimitExceededError, SqlFailure
from .exec_context import (
    READ_INTENT,
    WRITE_INTENT,
    ExecutionContext,
    as_context,
    current_context,
)
from .exec_context import execute as seam_execute
from .exec_context import run as seam_run
from .grouping import attach_to_parent, dedupe_key_tuples, group_by_key
from .static_bundle import render_placeholders, resolve_pg_array_cast

__all__ = ["make_handlers"]

# The bc handler outcome contract (behavior.py): a handler returns ``{"ok": value}`` on success or
# ``{"error": message}`` on a fail-closed transport failure (``run_behavior`` propagates it).
Outcome = Mapping[str, Any]
Handler = Callable[[Mapping[str, Any], Mapping[str, Any]], Outcome]


# ── the DYNAMIC (SKIP) WHERE: assembled by the transport, at execution time ────────────────────
#
# Port of ``src/scp/leaves.ts`` ``spliceWhere``/``assembleDynamicWhere`` (the TS reference). A SKIP
# predicate's presence is per-CALL, so the FINAL statement can only be determined here — which is
# also why the placeholder render runs AFTER this. A statement with no optional predicate carries no
# plan and never reaches this code.

#: The SQL keywords that may follow a WHERE clause — the clause splices in BEFORE the first of them,
#: at exactly the position a bounded WHERE occupies.
_WHERE_TAIL_RE = re.compile(r"\s+(GROUP BY|ORDER BY|LIMIT|OFFSET|FOR UPDATE|RETURNING)\b", re.IGNORECASE)


def _splice_where(base_sql: str, where_sql: str) -> str:
    """Splice a ``` WHERE …``` clause (leading space included, or ``''``) before the first tail keyword."""
    if where_sql == "":
        return base_sql
    tail = _WHERE_TAIL_RE.search(base_sql)
    if tail is None:
        return base_sql + where_sql
    return base_sql[: tail.start()] + where_sql + base_sql[tail.start() :]


def _effective_statement(ports: Mapping[str, Any]) -> Tuple[str, List[Any]]:
    """The ``(sql, params)`` a statement actually executes: the dynamic plan assembled when one is
    present, the ports verbatim otherwise.

    bc has ALREADY evaluated each fragment's params and its SKIP guard against the input, so a dropped
    fragment arrives as ``None``. The survivors join with ``WHERE``/``AND`` and their params bind
    BEFORE the base params (the WHERE ``?``s precede the tail's)."""
    plan: Optional[Mapping[str, Any]] = ports.get("whereDynamic")
    params: List[Any] = list(ports["params"])
    if plan is None:
        return ports["sql"], params
    where_sql = ""
    where_params: List[Any] = []
    for frag in (f for f in (plan.get("frags") or []) if f is not None):
        where_sql += (" WHERE " if where_sql == "" else " AND ") + frag["sql"]
        where_params.extend(frag["params"])
    return _splice_where(ports["sql"], where_sql), where_params + params


def _bind_params(params: Sequence[Any], dialect: str) -> List[Any]:
    """Bind a leaf's resolved param list for the driver per dialect (mirror of the rust driver's
    ``WireValue`` → param encoding + ``relation.py`` ``_bind_keys``). An array param (a relation key set
    from ``pluck`` or a batch record set) is server-side-expanded: sqlite/mysql JSON-encode it as ONE
    scalar string (``json_each``/``JSON_TABLE``); postgres binds the array as-is (native ``= ANY($1)`` /
    ``unnest``). A scalar param binds unchanged."""
    if dialect == "postgres":
        return list(params)
    return [json.dumps(p, separators=(",", ":"), ensure_ascii=False) if isinstance(p, list) else p for p in params]


def make_handlers(driver_or_ctx: Union[Driver, ExecutionContext], dialect: str) -> Dict[str, Handler]:
    """The op-agnostic leaf transport handlers (``executeSQL``/``pluck``/``group``), bound to a driver
    (or an :class:`ExecutionContext`) + its ``dialect``, ready to inject into a bc-generated python
    module's ``bind(handlers)``. Every SQL access funnels through the central execute/run seam over the
    bound driver — the SAME seam the runtime read/relation path uses (middleware-visible, N+1-free)."""
    ctx = as_context(driver_or_ctx)

    def execute_sql(ports: Mapping[str, Any], _ctx: Mapping[str, Any]) -> Outcome:
        # Resolve the AMBIENT tx-scoped ctx when this leaf runs inside a `with_transaction` /
        # `transaction` scope (`run_with_pinned_context` pins it), so every statement resolves the
        # tx-OWNED connection — the tx boundary is the runtime's (BEGIN/COMMIT/ROLLBACK), not baked into
        # the generated runner. Outside a tx, `current_context()` is None ⇒ the bound driver ctx (the
        # documented `current_context` contract — a raw-driver callee still resolves the pinned tx conn).
        active = current_context() or ctx
        # The DYNAMIC (SKIP) WHERE is assembled FIRST: the final statement shape is only known here,
        # so the placeholder render must follow it (CLAUDE.md §2).
        effective_sql, effective_params = _effective_statement(ports)
        if dialect == "postgres":
            # The DEFERRED `?::<T>[]` element type (#46) is resolved from the REAL bound key set —
            # the same render-layer step, and the same SSoT, the imperative relation path uses.
            for p in effective_params:
                if isinstance(p, list):
                    effective_sql = resolve_pg_array_cast(effective_sql, p)
        sql = render_placeholders(effective_sql, dialect)
        params = _bind_params(effective_params, dialect)
        try:
            if ports.get("write") and not ports.get("returning"):
                info = seam_run(active, sql, params, WRITE_INTENT)
                # The affected-write summary row (uniform ``items`` output shape — TS ``writeSummary``).
                return {"ok": [{"changes": info.changes, "lastInsertRowid": info.last_insert_rowid}]}
            rows = seam_execute(active, sql, params, READ_INTENT)
        except SqlFailure as e:
            return {"error": e.message}
        # The RELATION runaway guard, on the RAW child rows — the only point they are visible (past
        # ``group`` the graph is already nested) and the reason the cap rides on this transport at all.
        # The comparison + error assembly are the shared :meth:`LimitExceededError.check` SSoT, so this
        # path cannot drift from the runtime relation path (relation.py) or from the TS reference. It
        # RAISES rather than returning ``{"error": …}``: a runaway is a litedbmodel policy error with
        # typed fields, not a mapped transport failure (the TS leaf throws the same class).
        guard = ports.get("guard")
        if guard is not None:
            LimitExceededError.check(
                int(guard["limit"]), len(rows), "relation", guard.get("model"), guard["relation"]
            )
        return {"ok": rows}

    def pluck(ports: Mapping[str, Any], _ctx: Mapping[str, Any]) -> Outcome:
        col: Sequence[str] = ports["col"]
        tuples = dedupe_key_tuples(ports["rows"], col)
        # single-key → a flat scalar key array (json_each scalar ``value``); composite → an
        # array-of-tuples (json_each per-ordinal ``$[i]``) — the SAME shape ``relation.py`` binds.
        keys = [t[0] for t in tuples] if len(col) == 1 else [list(t) for t in tuples]
        return {"ok": keys}

    def group(ports: Mapping[str, Any], _ctx: Mapping[str, Any]) -> Outcome:
        into = ports["into"]
        single = ports["single"]
        pk: Sequence[str] = ports["pk"]
        by_key = group_by_key(ports["children"], ports["fk"])
        # {...par, [into]: nested}: shallow-copy each parent (the input is not mutated — TS spread).
        out = [{**par, into: attach_to_parent(par, pk, by_key, single)} for par in ports["parents"]]
        return {"ok": out}

    return {"executeSQL": execute_sql, "pluck": pluck, "group": group}
