"""Load the ONE cross-lang ORM-bench seed SSoT — benchmark/crosslang/.setup/<dialect>.json, emitted
from orm-domain.ts by emit-setup.ts — for BOTH python bench cells (orm_bench + orm_bench_sdk). No
python cell hand-writes a schema or seed: each applies ``schema`` once at open and ``delete``+``insert``
(the canonical 110-user fixture, literal SQL) per op. This is the single python-side reader of the JSON.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional


def load(dialect: str) -> Dict[str, Any]:
    """Return the dialect's setup doc. Besides the fixture (``schema``/``delete``/``insert``, literal
    SQL) it carries what every cell must agree on: ``ops`` (the statements the GENERATED module issues,
    captured at the runtime seam), ``inputs`` (the values each op binds, from the axis SSoT),
    ``recover`` (the MySQL RETURNING recovery, derived from the captured write by the library's own
    ``buildMysqlReselect``) and ``batchColumns`` (each batch statement's own column list). The path is
    anchored to this file (repo-root-relative), so it resolves regardless of the cwd."""
    here = os.path.dirname(os.path.abspath(__file__))  # <repo>/python
    root = os.path.dirname(here)  # <repo>
    path = os.path.join(root, "benchmark", "crosslang", ".setup", f"{dialect}.json")
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    return doc


def _resolve_it(value: Any, it: int) -> Any:
    """Substitute ``{it}`` — the ONE token the artifact carries — in every string of an input value."""
    if isinstance(value, str):
        return value.replace("{it}", str(it))
    if isinstance(value, list):
        return [_resolve_it(v, it) for v in value]
    if isinstance(value, dict):
        return {k: _resolve_it(v, it) for k, v in value.items()}
    return value


def op_input(doc: Dict[str, Any], op: str, it: int) -> Dict[str, Any]:
    """The values ``op`` binds at iteration ``it``, keyed by the parameter names the authored
    ``@behavior`` declares. Declared in benchmark/crosslang/contract.ts and read here so neither python
    cell spells one out — two cells binding different values do different work even on identical SQL."""
    declared = doc.get("inputs", {}).get(op)
    if declared is None:
        raise KeyError(f".setup/{doc['dialect']}.json declares no inputs for op {op!r}")
    return {name: _resolve_it(value, it) for name, value in declared.items()}


def recovery(doc: Dict[str, Any], op: str, index: int) -> Optional[Dict[str, Any]]:
    """Statement ``index``'s MySQL RETURNING recovery, or None where the database executes the declared
    RETURNING itself (every PostgreSQL and SQLite statement, and most MySQL ones)."""
    entries = doc.get("recover", {}).get(op) or []
    return entries[index] if index < len(entries) else None


def batch_columns(doc: Dict[str, Any], op: str) -> List[str]:
    """The columns ``op``'s batch statement reads, in its own order — a HARD failure when absent, since
    binding a batch write without the statement's column order is exactly the guess this removes."""
    cols = doc.get("batchColumns", {}).get(op)
    if cols is None:
        raise KeyError(f".setup/{doc['dialect']}.json declares no batchColumns for op {op!r}")
    return cols
