"""Frozen-corpus conformance test (WS7b #31; leaf/emitter cutover #144) — the §10 language axis.

The Python leg runs the module bc GENERATED for it from the SAME declaration the TS leg runs, bound
to a LIVE PostgreSQL / MySQL through the op-agnostic leaf transport. A leaf-executed module needs a
live in-process handle, so there is nothing to replay from a serialized bundle and no in-proc
substitute for this bar: the runner IS the test, and this file drives it.

Two levels, so a plain `pytest` (no docker) still guards everything that does not need a server:

  - the corpus CONTRACT — it is the supported version, it carries both live dialects, and every
    vector names an endpoint the generated modules actually expose. A drifted corpus, or a module
    regenerated from a different declaration, fails here with no database in the loop.
  - the live BAR — the full runner against real PG + MySQL, asserting the statements the leaf handed
    the driver, the FULL nested result (relation children and their field values) and the post-write
    DB state. Gated behind LITEDBMODEL_LIVEDB=1 (+ `npm run docker:livedb:up`), like the other live
    tests here:

        LITEDBMODEL_LIVEDB=1 python3 -m pytest tests/test_conformance_corpus.py
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent.parent
CORPUS = REPO / "conformance" / "vectors-livedb" / "livedb.json"
RUNNER = REPO / "python" / "conformance" / "livedb_runner.py"

LIVE_DIALECTS = ("postgres", "mysql")


def _load_runner():
    spec = importlib.util.spec_from_file_location("litedbmodel_livedb_runner", RUNNER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = _load_runner()
corpus = json.loads(CORPUS.read_text(encoding="utf-8"))


def test_corpus_is_the_supported_version():
    assert corpus["corpusVersion"] == runner.SUPPORTED_CORPUS_VERSION


def test_corpus_covers_both_live_dialects_with_the_same_cases():
    by_dialect = {d: {v["entry"] for v in corpus["vectors"] if v["dialect"] == d} for d in LIVE_DIALECTS}
    assert by_dialect["postgres"], "the corpus carries no postgres vectors"
    # The SAME declared endpoints on both servers — that is what makes the §10 comparison meaningful.
    assert by_dialect["postgres"] == by_dialect["mysql"]


def test_corpus_carries_a_seeded_schema():
    assert len(corpus["schema"]) > 0


@pytest.mark.parametrize("dialect", LIVE_DIALECTS)
def test_every_vector_names_an_endpoint_the_generated_module_exposes(dialect):
    """The generated module and the corpus come from ONE declaration, so every vector's `entry` must
    be a component of the module bc emitted. This catches a stale generated module (or a stale
    corpus) with no database in the loop."""
    names = set(_load_runner()._load_generated(dialect).COMPONENT_NAMES)
    for v in corpus["vectors"]:
        if v["dialect"] == dialect:
            assert v["entry"] in names, f"{v['name']}: '{v['entry']}' is not in the generated module"


@pytest.mark.skipif(os.environ.get("LITEDBMODEL_LIVEDB") != "1", reason="set LITEDBMODEL_LIVEDB=1 + docker up")
def test_live_db_conformance_all_vectors_pass():
    assert runner.main() == 0
