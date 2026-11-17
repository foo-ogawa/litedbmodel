"""Shared test helpers (pytest's aggregation point — the alternative is copying them per file).

Currently one: running a relation THE ONLY WAY PRODUCTION REACHES ONE. The codegen path calls exactly
three leaves (``src/scp/leaf-transport.ts:184,187,190``), so a relation is:

    executeSQL (parent read) → pluck (dedupe the parent keys) → executeSQL (BATCHED child fetch, the
    statement a cross-DB relation names its own database on) → group (nest children onto parents)

There is no fourth entry point for a generated module to call. Driving a relation through anything else
tests a path production does not take.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Union

import pytest

from litedbmodel_runtime.driver import Driver
from litedbmodel_runtime.exec_context import ExecutionContext
from litedbmodel_runtime.leaves import execute_sql, group_children, pluck_keys, with_leaf_transport


def run_relation_through_leaves(
    driver_or_ctx: Union[Driver, ExecutionContext],
    dialect: str,
    parent_sql: str,
    child_sql: str,
    pk: str,
    fk: str,
    into: str,
    child_db: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Run one relation through the three leaves, returning the grouped parents.

    The three calls run inside ONE :func:`with_leaf_transport` scope over ``driver_or_ctx`` + ``dialect``,
    exactly as a generated module's entry runs inside the scope its caller opens. ``child_db`` is the child
    fetch's ``db`` control field — ``None`` is the DEFAULT connection, which is exactly how a same-DB
    relation is lowered.
    """

    def relation() -> List[Dict[str, Any]]:
        parents = execute_sql({"sql": parent_sql, "params": []})
        keys: Sequence[Any] = pluck_keys({"rows": parents, "col": [pk]})
        # ONE param: the deduped key set. The leaf owns its dialect encoding (JSON array on sqlite/MySQL,
        # native array on PG) — the shaping the batched child SELECT is compiled against.
        children = execute_sql(
            {
                "sql": child_sql,
                "params": [list(keys)],
                "opts": {"db": child_db, "write": None, "whereDynamic": None, "guard": None},
            }
        )
        return group_children(
            {"parents": parents, "children": children, "pk": [pk], "fk": [fk], "into": into, "single": False}
        )

    return with_leaf_transport(driver_or_ctx, dialect, relation)


@pytest.fixture()
def relation_through_leaves():
    """The callable above, as a fixture (no cross-test-module imports)."""
    return run_relation_through_leaves
