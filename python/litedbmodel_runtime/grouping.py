"""litedbmodel v2 SCP — the SHARED relation-grouping CORE (#141), Python port.

The ONE implementation of relation key-identity + dedupe + parent grouping over plain dict
records, behaviour-identical to the TS SSoT ``src/scp/grouping.ts`` and the Rust port
``rust/litedbmodel_runtime/src/grouping.rs``. It is consumed by BOTH relation surfaces so there is
a single source of truth (no duplicated grouping logic):

  - the op-INDEPENDENT ``pluck`` / ``group`` leaves (``./leaves``) — the eager N+1-free graph
    (``parents → pluck → executeSQL(WHERE fk = ANY(?)) → group``);
  - already-fetched rows, grouped over the SAME algorithm,
    which groups already-fetched rows over the SAME core.

Nothing here touches SQL or a driver: it is pure in-memory grouping over already-fetched rows
(plain ``dict`` records — Python's native value model IS the wire, so no ``WireValue`` enum). Ordered
TUPLE keys are supported (composite keys), matching TS/Rust.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Sequence

__all__ = ["key_identity", "dedupe_key_tuples", "group_by_key", "attach_to_parent"]

def _key_cell(v: Any) -> Any:
    """One key column's value, in the form a dict key takes it. A whole float and the same integer are ONE
    key (a parent read as ``1`` and a child FK read as ``1.0`` must land in one bucket) — the rendering
    this replaces collapsed them the same way (``str(int(v))``).

    ``bool`` rides as its TEXT, and that is not cosmetic: ``bool`` is a subclass of ``int`` with
    ``hash(True) == hash(1)`` and ``True == 1``, so RETURNING THE BOOL puts ``True`` and ``1`` in the SAME
    dict bucket. Rendering it keeps them apart, exactly as the reference does (``String(true)`` is
    ``'true'``, ``String(1)`` is ``'1'``)."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v == v and v not in (float("inf"), float("-inf")) and v.is_integer():
        return int(v)
    if isinstance(v, str) and v and (v[0].isdigit() or v[0] == "-"):
        # `1` and `"1"` are ONE key. The rendering this replaces collapsed them (both `String(v)` to
        # `"1"`), and a driver may hand back a numeric column as text (mysql2 does for BIGINT), so the
        # collapse is load-bearing, not incidental. Only an EXACT round-trip collapses, so `"01"` and
        # `" 1"` stay distinct strings, exactly as `String(v)` kept them.
        try:
            n = int(v)
        except ValueError:
            return v
        return n if str(n) == v else v
    return v


def key_identity(values: Sequence[Any]) -> Any:
    """The key identity for dedupe/grouping — the key CELLS, not a rendering of them.

    A raw-driver consumer groups on the native value (a dict keyed by the id, a tuple key for a composite
    one). Rendering each cell to text and joining built a generator, N strings and a joined string PER ROW,
    per relation level; a tuple of the cells hashes directly and allocates one small tuple. A single-column
    key is the cell itself — no tuple at all.
    """
    if len(values) == 1:
        return _key_cell(values[0])
    return tuple(_key_cell(v) for v in values)


def dedupe_key_tuples(rows: Sequence[Mapping[str, Any]], key_cols: Sequence[str]) -> List[List[Any]]:
    """The deduped, non-null key TUPLES of ``rows`` over ``key_cols`` (insertion order preserved —
    deterministic). A tuple is DROPPED if ANY of its key columns is absent or ``None`` (no partial
    keys); deduped on the tuple identity. Port of TS ``dedupeKeyTuples``."""
    seen: set = set()
    out: List[List[Any]] = []
    for r in rows:
        tuple_ = [r.get(c) for c in key_cols]
        if any(v is None for v in tuple_):
            continue
        ident = key_identity(tuple_)
        if ident in seen:
            continue
        seen.add(ident)
        out.append(tuple_)
    return out


def group_by_key(
    children: Sequence[Mapping[str, Any]], fk_cols: Sequence[str]
) -> Dict[Any, List[Mapping[str, Any]]]:
    """Group ``children`` by their ``fk_cols`` tuple identity (a null/absent key drops the child). Child
    order within a bucket is the input order. Port of TS ``groupByKey``."""
    by_key: Dict[Any, List[Mapping[str, Any]]] = {}
    for c in children:
        tuple_ = [c.get(col) for col in fk_cols]
        if any(v is None for v in tuple_):
            continue
        by_key.setdefault(key_identity(tuple_), []).append(c)
    return by_key


def attach_to_parent(
    parent: Mapping[str, Any],
    pk_cols: Sequence[str],
    by_key: Mapping[Any, List[Mapping[str, Any]]],
    single: bool,
) -> Any:
    """Distribute grouped children onto ONE parent per cardinality (port of TS ``attachToParent``):
    ``single is False`` (hasMany) → the child list (``[]`` when none); ``single is True``
    (belongsTo/hasOne) → the single child (or ``None``). Keyed by the parent's ``pk_cols`` tuple
    identity; a null/absent parent key matches nothing (``[]``/``None``)."""
    tuple_ = [parent.get(c) for c in pk_cols]
    rows = None if any(v is None for v in tuple_) else by_key.get(key_identity(tuple_))
    if not single:
        return rows if rows is not None else []
    return rows[0] if rows else None
