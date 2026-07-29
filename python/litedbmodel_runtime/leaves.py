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
    the bound driver — the ONLY driver contact. Everything besides the statement rides in the OPTIONAL
    ``opts`` control record (absent ⇒ a plain read): ``opts["guard"]`` is the RELATION runaway cap of a
    guarded relation child fetch (absent/None ⇒ uncapped), asserted against the raw rows HERE
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
from typing import Any, Callable, Dict, List, Mapping, Sequence, Tuple, Union

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
# Port of ``src/scp/leaves.ts`` ``whereSplice``/``assembleDynamicWhere`` (the TS reference). A SKIP
# predicate's presence is per-CALL, so the FINAL statement can only be determined here — which is
# also why the placeholder render runs AFTER this. A statement with no optional predicate carries no
# plan and never reaches this code.

#: The SQL keywords that may follow a WHERE clause — the clause splices in BEFORE the first of them,
#: at exactly the position a bounded WHERE occupies.
_WHERE_TAIL_RE = re.compile(r"\s+(GROUP BY|ORDER BY|LIMIT|OFFSET|FOR UPDATE|RETURNING)\b", re.IGNORECASE)

#: The WHERE keyword itself, matched the SAME way a tail keyword is, so the five language ports share
#: one lexical rule. A statement that carries it already has a (bounded) WHERE, which a dynamic clause
#: CONTINUES instead of opening a second one.
_WHERE_RE = re.compile(r"\s+WHERE\b", re.IGNORECASE)


def _where_splice(base_sql: str) -> Tuple[int, str, int]:
    """Where a dynamic WHERE clause joins ``base_sql`` (port of leaves.ts ``whereSplice``) — the ONE scan
    :func:`_effective_statement` makes, and everything it needs to place both the text and the values:

    * ``at`` — the end of the statement's WHERE region: before the first tail keyword, or the end of the
      statement. The exact position a bounded WHERE occupies.
    * ``keyword`` — how the clause joins: ``' AND '`` when the statement already carries a WHERE (its
      BOUNDED predicates, lowered at emit — CLAUDE.md §2), ``' WHERE '`` when it carries none.
    * ``tail`` — how many base params bind AFTER the clause. Every ``?`` past ``at`` is a page-tail bound
      count (``LIMIT ?`` / ``OFFSET ?``) — the only placeholders the emitted SELECT carries after the
      WHERE — so the surviving fragments' params bind before exactly that many of the base params, which
      is the position their own ``?``s occupy in the final statement. It counts a SUBSTRING's
      placeholders and every placeholder binds one param, so it never exceeds ``len(params)`` for a
      statement that can be bound at all."""
    m = _WHERE_TAIL_RE.search(base_sql)
    at = len(base_sql) if m is None else m.start()
    keyword = " AND " if _WHERE_RE.search(base_sql[:at]) else " WHERE "
    return at, keyword, base_sql[at:].count("?")


#: The two `at` labels the fail-closed field read names — the payload itself and the control record.
_PAYLOAD = "the executeSQL payload"
_RECORD = "the 'opts' control record"


def _required(record: Mapping[str, Any], name: str, at: str) -> Any:
    """Read ONE DECLARED field out of a struct that IS present — the python leg's ONE fail-closed field
    read (the twin of the go ``portErr`` / rust ``port_mismatch`` discipline).

    ``None`` is a VALUE (the declared absence of a write mode / a plan / a cap / a model); a MISSING KEY
    is an ABI BREAK, and the two must not collapse: bc types a port by the literal wired into it and
    REJECTS a partial struct, so a generated module ALWAYS spells every field of every struct it wires.
    A key that is not there did not come from one, and defaulting it would silently downgrade a write to
    a read, drop a relation cap, or erase a SKIP predicate (#205)."""
    if name not in record:
        raise ValueError(
            f"scp leaf executeSQL: {at} is missing its '{name}' field — a generated module spells every "
            f"field of every struct it wires, so an ABSENT key is an ABI break (a null VALUE is how an "
            f"absent write mode / plan / cap is spelled)"
        )
    return record[name]


def _effective_statement(ports: Mapping[str, Any], plan: Any) -> Tuple[str, List[Any]]:
    """The ``(sql, params)`` a statement actually executes: the dynamic-WHERE plan assembled when one is
    present, the ports verbatim otherwise.

    ``plan`` is the control record's ``whereDynamic`` field (None ⇒ no dynamic WHERE — only a read that
    declares an OPTIONAL predicate carries one; CLAUDE.md §2). bc carries each fragment's SKIP decision
    as DATA: a skipped fragment is PRESENT with ``skipped`` true (never omitted), so assembly DROPS the
    ``skipped`` fragments. The survivors join with ``AND``, the clause CONTINUES the bounded WHERE the
    emitter already lowered (or opens one when there is none), and their params bind at the slot their
    ``?``s occupy: after the base params the clause follows, before the page tail's."""
    params: List[Any] = list(_required(ports, "params", _PAYLOAD))
    sql_port: str = _required(ports, "sql", _PAYLOAD)
    if plan is None:
        return sql_port, params
    frags = [f for f in plan["frags"] if not f["skipped"]]
    if not frags:
        return sql_port, params
    sql: str = sql_port
    at, keyword, tail = _where_splice(sql)
    where_params: List[Any] = [p for f in frags for p in f["params"]]
    bind = len(params) - tail
    clause = keyword + " AND ".join(f["sql"] for f in frags)
    return sql[:at] + clause + sql[at:], params[:bind] + where_params + params[bind:]


def _is_tuple_set(param: Sequence[Any]) -> bool:
    """A COMPOSITE relation key set: a bound array whose elements are the key TUPLES. Every other array
    param is a list of SCALAR cells, because no column class de-boxes to a nested list."""
    return len(param) > 0 and isinstance(param[0], list)


def _bind_params(params: Sequence[Any], dialect: str) -> List[Any]:
    """Bind a leaf's resolved param list for the driver per dialect (the SAME rule as TS
    ``leaves.encodeParams``, mirrored by the rust / go leaf transports).

    A COMPOSITE key set binds as ONE JSON array-of-tuples string on EVERY dialect (#159) — PostgreSQL
    expands it server-side with ``json_array_elements``, and binding it natively would hand the server
    an ``int[][]`` no cast can turn into json. Any other array is a list of scalar cells: postgres binds
    it natively (``= ANY($1)``), sqlite/mysql JSON-encode it as ONE scalar string
    (``json_each`` / ``JSON_TABLE``). A scalar param binds unchanged."""
    out: List[Any] = []
    for p in params:
        if not isinstance(p, list):
            out.append(p)
        elif dialect == "postgres" and not _is_tuple_set(p):
            out.append(p)
        else:
            out.append(json.dumps(p, separators=(",", ":"), ensure_ascii=False))
    return out


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
        # The OPTIONAL ``opts`` control record — how to run the statement plus the two optional control
        # structs. ABSENT ⇒ the empty record: a plain READ with no dynamic WHERE and no cap (the ONE
        # statement shape that omits the port, so its payload is ``sql`` + ``params`` and nothing else).
        opts = ports.get("opts")
        # The DYNAMIC (SKIP) WHERE is assembled FIRST: the final statement shape is only known here,
        # so the placeholder render must follow it (CLAUDE.md §2).
        # An OMITTED record is the ONE legitimate absence (a plain read); every FIELD of a record that
        # IS present is required — a missing key is an ABI break, not an absent value.
        plan = None if opts is None else _required(opts, "whereDynamic", _RECORD)
        effective_sql, effective_params = _effective_statement(ports, plan)
        if dialect == "postgres":
            # The DEFERRED `?::<T>[]` element type (#46) is resolved from the REAL bound key set —
            # the same render-layer step, and the same SSoT, the imperative relation path uses.
            for p in effective_params:
                if isinstance(p, list):
                    effective_sql = resolve_pg_array_cast(effective_sql, p)
        sql = render_placeholders(effective_sql, dialect)
        params = _bind_params(effective_params, dialect)
        try:
            # ``write`` is the statement's RUN MODE: None ⇒ a read; a mapping ⇒ a write carrying its
            # OWN ``returning`` (ONE field, three values — "returns rows but is not a write" is not a
            # state the ABI can hold, #206).
            write = None if opts is None else _required(opts, "write", _RECORD)
            if write is not None and not _required(write, "returning", "the 'write' mode"):
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
        guard = None if opts is None else _required(opts, "guard", _RECORD)
        if guard is not None:
            at = "the 'guard' cap"
            LimitExceededError.check(
                int(_required(guard, "limit", at)),
                len(rows),
                "relation",
                _required(guard, "model", at),
                _required(guard, "relation", at),
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
