"""Guardrail test (WS7b, #31): bc runtime-core is CONSUMED, not reimplemented.

The hard rule: litedbmodel's Python leg delegates the CLOSED Expression-IR evaluation AND the
plan/map/wire/output orchestration to behavior-contracts — the bc-GENERATED native module evaluates
the IR and calls the leaf transport (:func:`litedbmodel_runtime.leaves.make_handlers`) by boundary
injection (``bind(handlers)``). Since the self-built ``SqlBundle``/``ReadGraph`` execution was deleted
(#227) there is no litedbmodel-owned bundle/read-graph runner, so the package defines NO generic
expression evaluator and calls bc ``run_behavior`` NOWHERE on the exec path. This pins that invariant
+ the exactly-pinned PyPI dep (the runtime + the generated §8 bundle must stay in lockstep).
"""

from __future__ import annotations

import re

import ast
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent / "litedbmodel_runtime"
PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def _package_sources() -> "dict[str, str]":
    """Every module of the runtime package, name → source."""
    return {p.name: p.read_text(encoding="utf-8") for p in sorted(PKG.glob("*.py"))}


def _bc_imports(src: str) -> "set[str]":
    names: set[str] = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("behavior_contracts"):
            names.update(a.name for a in node.names)
    return names


def test_no_module_calls_run_behavior_on_exec_path():
    # The self-built read-graph/tx execution that once drove bc `run_behavior` is deleted (#227): the
    # bc-GENERATED native module drives execution and calls the leaf transport by injection. No
    # litedbmodel module calls or imports `run_behavior` (a docstring may name it — the call form is
    # `run_behavior(`, which never appears in prose).
    for name, src in _package_sources().items():
        assert "run_behavior(" not in src, f"{name} must not call bc run_behavior on the exec path (#227)"
        assert "run_behavior" not in _bc_imports(src), f"{name} must not import bc run_behavior"


def test_no_local_generic_evaluator_reimplemented():
    # The runtime must not define its own expression evaluator / behavior runner (that would
    # reimplement bc-core instead of consuming it).
    for name, src in _package_sources().items():
        for banned in ("def evaluate_expression", "def evaluate(", "def _eval_expr", "def run_behavior"):
            assert banned not in src, f"{name} reimplements bc-core: found '{banned}'"


def test_pyproject_declares_bc_as_pypi_dep_no_local_path():
    text = PYPROJECT.read_text(encoding="utf-8")
    # bc is consumed as an EXACTLY-PINNED PyPI dependency (`behavior-contracts==<semver>`), never a
    # range and never a local path — the runtime + the generated §8 bundle must stay in lockstep
    # (WS7a #30). Assert the pinned FORM, version-agnostically, so this survives version bumps.
    assert re.search(r'"behavior-contracts==\d+\.\d+\.\d+"', text), (
        "pyproject must pin behavior-contracts to an exact PyPI version (behavior-contracts==X.Y.Z)"
    )
    # No local path dep (the no-local-deps gate forbids `../` / file:// / path = ...).
    assert "../" not in text
    assert "file://" not in text
    assert "behavior_contracts @" not in text


def test_bc_is_importable_and_provides_core():
    import behavior_contracts as bc

    assert callable(bc.run_behavior)
    assert callable(bc.evaluate_expression)
