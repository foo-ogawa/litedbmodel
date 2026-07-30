"""Shared test helpers (pytest's aggregation point — the alternative is copying them per file).

Currently one: running a relation THE ONLY WAY PRODUCTION REACHES ONE. The codegen path calls exactly
three leaves (``src/scp/leaf-transport.ts:184,187,190``), so a relation is:

    executeSQL (parent read) → pluck (dedupe the parent keys) → executeSQL (BATCHED child fetch, the
    statement a cross-DB relation names its own database on) → group (nest children onto parents)

There is no fourth entry point for a generated module to call. Driving a relation through anything else
tests a path production does not take.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Sequence

import pytest

CTX = {"nodeId": "n0", "component": "executeSQL"}


def _ok(outcome: Mapping[str, Any], what: str) -> Any:
    """Unwrap a leaf Outcome, surfacing a leaf-reported failure as an exception the test can assert on."""
    if "ok" not in outcome:
        raise AssertionError(f"{what} did not return an ok outcome: {outcome!r}")
    return outcome["ok"]


def run_relation_through_leaves(
    handlers: Mapping[str, Any],
    parent_sql: str,
    child_sql: str,
    pk: str,
    fk: str,
    into: str,
    child_db: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Run one relation through the three leaves, returning the grouped parents.

    ``child_db`` is the child fetch's ``db`` control field — ``None`` is the DEFAULT connection, which is
    exactly how a same-DB relation is lowered.
    """
    parents = _ok(
        handlers["executeSQL"]({"sql": parent_sql, "params": []}, CTX), "parent read"
    )
    keys: Sequence[Any] = _ok(
        handlers["pluck"]({"rows": parents, "col": [pk]}, CTX), "pluck"
    )
    # ONE param: the deduped key set. The leaf owns its dialect encoding (JSON array on sqlite/MySQL,
    # native array on PG) — the shaping the batched child SELECT is compiled against.
    children = _ok(
        handlers["executeSQL"](
            {
                "sql": child_sql,
                "params": [list(keys)],
                "opts": {"db": child_db, "write": None, "whereDynamic": None, "guard": None},
            },
            CTX,
        ),
        "child fetch",
    )
    return _ok(
        handlers["group"](
            {"parents": parents, "children": children, "pk": [pk], "fk": [fk], "into": into, "single": False},
            CTX,
        ),
        "group",
    )


@pytest.fixture()
def relation_through_leaves():
    """The callable above, as a fixture (no cross-test-module imports)."""
    return run_relation_through_leaves
