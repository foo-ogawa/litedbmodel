"""litedbmodel v2 SCP — read-relation batch EXECUTION (Python port of ``src/scp/relation.ts``, #43).

Byte-for-byte port of the TS reference relation runtime: the STATIC pre-compiled batch op
(``bundle.relations[name]`` — pure JSON) is EXECUTED, never regenerated. A ``RelationOp`` carries
the batched child SELECT text with ONE ``?`` for the deduped-key array param; the runtime dedupes
the parent keys, resolves the deferred PG array cast from the REAL keys, renders ``?``→``$N``,
short-circuits an empty key set (NO query), runs the batch, groups the child rows by target key,
and distributes them onto the parents per cardinality (``hasMany`` → list, ``belongsTo``/``hasOne``
→ single or None). This is the SAME ``runRelationOp`` / ``distributeToParent`` / ``dedupeKeys`` the
TS typed-object path (``buildResultSet``) uses.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Mapping, Sequence, Union

from .driver import Driver
from .errors import LimitExceededError
from .exec_context import READ_INTENT, ExecutionContext, StatementIntent, as_context, execute as seam_execute
from .grouping import attach_to_parent, dedupe_key_tuples, group_by_key
from .static_bundle import PG_ARRAY_CAST_TOKEN, render_placeholders, resolve_pg_array_cast

__all__ = ["dedupe_keys", "run_relation_op", "distribute_to_parent"]


def _parent_key_cols(op: Mapping[str, Any]) -> List[str]:
    """The ordered PARENT key columns (single-key → 1-element; composite → the tuple)."""
    pk = op.get("parentKeys")
    return list(pk) if pk is not None else [op["parentKey"]]


def _target_key_cols(op: Mapping[str, Any]) -> List[str]:
    """The ordered CHILD key columns (single-key → 1-element; composite → the tuple)."""
    tk = op.get("targetKeys")
    return list(tk) if tk is not None else [op["targetKey"]]


def dedupe_keys(parents: Sequence[Mapping[str, Any]], key_cols: Sequence[str]) -> List[List[Any]]:
    """The deduped, non-null parent-key TUPLES (insertion order preserved). Thin delegator to the shared
    grouping core :func:`~litedbmodel_runtime.grouping.dedupe_key_tuples` (SSoT — no local copy)."""
    return dedupe_key_tuples(parents, key_cols)


def _bind_keys(op: Mapping[str, Any], tuples: Sequence[Sequence[Any]]) -> List[Any]:
    """Bind the deduped keys to the op's params per dialect + arity (mirrors TS ``bindKeys``).

    Composite: ONE JSON array-of-tuples string on EVERY dialect (#159) — PostgreSQL expands it
    server-side with json_array_elements, so the key set crosses as one param whatever its length
    and whatever its arity. Single-key: PG → ONE scalar array param; MySQL/SQLite → ONE JSON
    scalar-array string.
    """
    if op.get("parentKeys") is not None:
        payload = [list(t) for t in tuples]
        return [json.dumps(payload, separators=(",", ":"), ensure_ascii=False)]
    keys = [t[0] for t in tuples]
    if op["dialect"] == "postgres":
        return [keys]
    return [json.dumps(keys, separators=(",", ":"), ensure_ascii=False)]


def run_relation_op(
    op: Mapping[str, Any],
    parents: Sequence[Mapping[str, Any]],
    driver: Union[Driver, ExecutionContext],
) -> Dict[str, Any]:
    """Run ONE relation batch op for a set of parent rows (byte-for-byte port of TS ``runRelationOp``).

    Dedup the parent-key tuples, resolve the deferred PG array cast(s) from the REAL keys (one per
    key column for composite) BEFORE the ``?``→``$N`` render, render placeholders, then — on a
    NON-empty key set — execute (THROUGH THE CENTRAL SEAM, ``READ_INTENT``) binding the keys (single
    array / per-column arrays / JSON tuples) and group the child rows by their target-key identity.
    EMPTY key set → NO query. Returns ``{sql, keys, batch}`` (``keys`` = the deduped parent-key tuples).

    ``driver`` is EITHER a raw :class:`Driver` (wrapped via :func:`context_for_driver` — byte-identical)
    OR an :class:`ExecutionContext`.
    """
    ctx = as_context(driver)
    p_cols = _parent_key_cols(op)
    keys = dedupe_keys(parents, p_cols)
    batch: Dict[str, List[Dict[str, Any]]] = {}
    cast = op["sql"]
    if op["dialect"] == "postgres":
        for col in range(len(p_cols)):
            cast = resolve_pg_array_cast(cast, [t[col] for t in keys])
    sql = render_placeholders(cast, op["dialect"])
    if len(keys) == 0:
        return {"sql": sql, "keys": keys, "batch": batch}
    t_cols = _target_key_cols(op)
    # The batch's own DATABASE: the compiled op names it (``op['connection']`` — the TARGET model's)
    # and the ctx owns the registry that resolves the name. They meet HERE, on the
    # :class:`StatementIntent` — the only input ``connection_for`` routes on, and the SAME channel the
    # ``execute_sql`` leaf uses on the codegen surface. An untagged (same-DB) relation leaves ``db``
    # unset ⇒ the DEFAULT connection (``READ_INTENT`` itself).
    connection = op.get("connection")
    intent = READ_INTENT if connection is None else StatementIntent(write=False, db=connection)
    rows = seam_execute(ctx, sql, _bind_keys(op, keys), intent)
    # Hard-limit runaway guard (Phase E-2, epic #74; v1 ``_selectForRelation``; port of the TS
    # ``runRelationOp`` guard). POST-fetch, if the batch TOTAL exceeds the baked cap, raise with the
    # EXACT count (the batch is fetched in full, no N+1). ⚠️ field mapping: ``model`` = the relation
    # TARGET TABLE, ``relation`` = the relation NAME. Absent ``op['hardLimit']`` ⇒ disabled / an
    # intrinsic per-parent ``limit`` window ⇒ NO check. The native ports (#100-103) run the SAME check
    # off the same JSON field. Raised BEFORE grouping/hydration so an over-cap read never assembles an
    # unbounded result set. ONE guard point, shared by every caller of the batch.
    hard_limit = op.get("hardLimit")
    if hard_limit is not None:
        # The relation-context arm of the shared runaway check (SSoT) — the SAME `count > limit ⇒ raise`
        # primitive the find guard (`check_find_hard_limit`) calls, so the comparison lives in one place.
        LimitExceededError.check(hard_limit, len(rows), "relation", op.get("targetTable"), op.get("name"))
    # Group the fetched child rows by their target-key identity — the shared grouping core (SSoT), the
    # SAME `group_by_key` the op-independent `group` leaf uses (no duplicated grouping).
    batch = group_by_key(rows, t_cols)
    return {"sql": sql, "keys": keys, "batch": batch}


def distribute_to_parent(
    op: Mapping[str, Any],
    parent: Mapping[str, Any],
    batch: Mapping[str, List[Dict[str, Any]]],
) -> Union[List[Dict[str, Any]], Dict[str, Any], None]:
    """Distribute a resolved batch onto ONE parent per cardinality (port of TS ``distributeToParent``).

    ``hasMany`` → the child list (``[]`` when none); ``belongsTo``/``hasOne`` → the single child (or
    ``None``). Keyed by the parent's key-tuple identity. Thin delegator to the shared grouping core
    :func:`~litedbmodel_runtime.grouping.attach_to_parent` (SSoT — no local grouping copy).
    """
    return attach_to_parent(parent, _parent_key_cols(op), batch, op["kind"] != "hasMany")
