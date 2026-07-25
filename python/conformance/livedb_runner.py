#!/usr/bin/env python3
"""litedbmodel SCP LIVE-DB conformance — the Python leg (#36 WS7g; leaf/emitter cutover #144).

What runs here is the module bc GENERATED for this language from the SAME declaration the TS leg
runs (``conformance/harness.ts`` → ``emitBehaviorModule`` → ``bc generate --lang python``, one module
per live dialect, written by ``conformance/gen-livedb.ts``). Nothing is replayed from a serialized
bundle: a leaf-executed module needs a LIVE in-process handle, which is exactly why the recorder-era
bundle-replay model is gone.

The only hand-wiring is the two lines that make the generated module callable — bind the op-agnostic
leaf transport to a live connection and call the endpoint by name::

    ops = behaviors.bind(make_handlers(driver, dialect))
    ops[vector["entry"]](vector["input"])

Every vector is then compared against what the TS leg observed on the SAME server for the SAME
dialect (``conformance/vectors-livedb/livedb.json``, projected from the frozen exec suite): the
ORDERED statements the leaf handed the driver, the FULL nested result (relation children and their
field values included — a row count is not a check, #150), and the resulting DB state for a write.

REAL DBs, no mock, NO silent skip: if PG or MySQL is unreachable this ERRORS OUT LOUDLY (exit 3).
Connection config is env-driven (matching docker-compose.livedb.yml / the WS6 host defaults)::

    TEST_DB_HOST/PORT/USER/PASSWORD/NAME      (Postgres, default localhost:5433)
    TEST_MYSQL_HOST/PORT/USER/PASSWORD/DB     (MySQL,    default localhost:3307)

Emits the machine-readable JSON summary the orchestrator expects as its LAST stdout line::

    {"lang":"py-livedb","suites":{"livedb-pg":{..},"livedb-mysql":{..}},"total_pass",...}

Exit: 0 all pass, 1 any fail, 2 corpus-version mismatch, 3 DB unreachable.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Sequence, Tuple

_HERE = Path(__file__).resolve().parent
_PY_ROOT = _HERE.parent
_REPO = _PY_ROOT.parent
if str(_PY_ROOT) not in sys.path:
    sys.path.insert(0, str(_PY_ROOT))

from litedbmodel_runtime import MysqlDriver, PostgresDriver, make_handlers  # noqa: E402
from litedbmodel_runtime.driver import RunInfo  # noqa: E402

# The corpus schema version this leg supports (harness.CORPUS_VERSION — fail-closed on a mismatch).
SUPPORTED_CORPUS_VERSION = 5

# The live dialects, and the suite key each reports under.
_LEGS = (("postgres", "livedb-pg"), ("mysql", "livedb-mysql"))


def _corpus_path() -> Path:
    env = os.environ.get("LITEDBMODEL_LIVEDB_VECTORS")
    return Path(env) if env else _REPO / "conformance" / "vectors-livedb" / "livedb.json"


def _pg_cfg() -> Dict[str, Any]:
    return dict(
        host=os.environ.get("TEST_DB_HOST", "localhost"),
        port=int(os.environ.get("TEST_DB_PORT", "5433")),
        user=os.environ.get("TEST_DB_USER", "testuser"),
        password=os.environ.get("TEST_DB_PASSWORD", "testpass"),
        dbname=os.environ.get("TEST_DB_NAME", "testdb"),
    )


def _mysql_cfg() -> Dict[str, Any]:
    return dict(
        host=os.environ.get("TEST_MYSQL_HOST", "127.0.0.1"),
        port=int(os.environ.get("TEST_MYSQL_PORT", "3307")),
        user=os.environ.get("TEST_MYSQL_USER", "testuser"),
        password=os.environ.get("TEST_MYSQL_PASSWORD", "testpass"),
        dbname=os.environ.get("TEST_MYSQL_DB", "testdb"),
    )


# ── canonical comparison (the corpus is TS-encoded: bigint → {"$bigint": "N"}) ─────────────────


def _canon(x: Any) -> Any:
    """Canonicalize the two NUMERIC REPRESENTATIONS of one declared type, and nothing else.

    Both foldings are representation-only — a differing VALUE still compares unequal:

      - ``{"$bigint": "N"}`` is how the TS reference encodes an ``int`` cell for JSON; Python has no
        bigint type, so the tag can only ever appear on the EXPECTED side.
      - an INTEGRAL ``float`` is the integer it denotes. An int32 column's declared read type IS bc
        ``float`` (``src/scp/coltype.ts``: "an int32 column materializes to a JS number → bc float"),
        and each language renders that one declared type in its own numeric model — TS a JS number
        (JSON ``10``), Python a ``float`` (``10.0``). ``10.5`` still differs from ``10``.
    """
    if isinstance(x, dict):
        if len(x) == 1 and "$bigint" in x:
            return int(x["$bigint"])
        return {k: _canon(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_canon(v) for v in x]
    if isinstance(x, float) and x.is_integer():
        return int(x)
    return x


def _dumps(x: Any) -> str:
    return json.dumps(_canon(x), sort_keys=True, ensure_ascii=False, default=str)


def _eq(a: Any, b: Any) -> bool:
    return _dumps(a) == _dumps(b)


# ── the statement TAP: what the leaf transport actually handed the driver ─────────────────────


class _TapPrepared:
    """Records ``(sql, params)`` at the driver contact point, then delegates. The SAME point the TS
    harness taps, so the two logs are directly comparable: the dynamic (SKIP) WHERE is already
    assembled, ``?``→``$N`` already rendered and the array params already encoded."""

    __slots__ = ("_inner", "_log", "_sql")

    def __init__(self, inner: Any, log: List[Dict[str, Any]], sql: str) -> None:
        self._inner = inner
        self._log = log
        self._sql = sql

    def all(self, params: Sequence[Any]) -> List[Dict[str, Any]]:
        self._log.append({"sql": self._sql, "params": list(params)})
        return self._inner.all(params)

    def run(self, params: Sequence[Any]) -> RunInfo:
        self._log.append({"sql": self._sql, "params": list(params)})
        return self._inner.run(params)


class _TapDriver:
    """A :class:`Driver` that logs every prepared statement. Test instrumentation only — it adds no
    behavior; the underlying driver executes exactly as it would unwrapped."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.log: List[Dict[str, Any]] = []

    def prepare(self, sql: str) -> _TapPrepared:
        return _TapPrepared(self._inner.prepare(sql), self.log, sql)

    def begin_tx(self) -> Any:
        return self._inner.begin_tx()


# ── the generated modules ──────────────────────────────────────────────────────────────────────


def _load_generated(dialect: str) -> Any:
    """Load ``python/conformance/behaviors_<dialect>.py`` — the module `bc generate --lang python`
    produced from the harness declaration for this dialect."""
    path = _HERE / f"behaviors_{dialect}.py"
    if not path.exists():
        raise FileNotFoundError(f"{path} is missing — run `npm run conformance:gen:livedb`")
    spec = importlib.util.spec_from_file_location(f"litedbmodel_conformance_{dialect}", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── one leg ────────────────────────────────────────────────────────────────────────────────────


def _run_vector(ops: Dict[str, Callable[..., Any]], driver: Any, tap: _TapDriver, v: Dict[str, Any]) -> Tuple[bool, str]:
    del tap.log[:]
    result = ops[v["entry"]](dict(v["input"]))
    problems: List[str] = []
    if not _eq(tap.log, v["expectedStatements"]):
        problems.append(f"statements {_dumps(tap.log)} != {_dumps(v['expectedStatements'])}")
    if not _eq(result, v["expectedResult"]):
        problems.append(f"result {_dumps(result)} != {_dumps(v['expectedResult'])}")
    for s in v.get("expectedDbState") or []:
        got = driver.prepare(s["query"]).all([])
        if not _eq(got, s["rows"]):
            problems.append(f"db-state '{s['query']}': {_dumps(got)} != {_dumps(s['rows'])}")
    return len(problems) == 0, "; ".join(problems)


def _run_leg(dialect: str, driver: Any, corpus: Dict[str, Any]) -> Dict[str, int]:
    vectors = [v for v in corpus["vectors"] if v["dialect"] == dialect]
    tally = {"pass": 0, "fail": 0}
    sys.stderr.write(f"\nlivedb-{dialect} — {len(vectors)} vectors (real {dialect})\n")
    tap = _TapDriver(driver)
    ops = _load_generated(dialect).bind(make_handlers(tap, dialect))
    schema: List[str] = list(corpus["schema"])
    for v in vectors:
        try:
            # Every vector starts from the SAME seeded state the TS leg captured from.
            driver.exec_ddl(schema)
            ok, detail = _run_vector(ops, driver, tap, v)
        except Exception as e:  # a live-DB failure is a vector FAILURE, never a fake pass
            ok, detail = False, f"threw: {e}\n{traceback.format_exc()}"
        if ok:
            tally["pass"] += 1
            sys.stderr.write(f"  ok  {v['name']}\n")
        else:
            tally["fail"] += 1
            sys.stderr.write(f"  XX  {v['name']}\n      {detail}\n")
    return tally


def main() -> int:
    sys.stderr.write("litedbmodel SCP LIVE-DB conformance — Python runner (bc-generated modules, real PG + MySQL)\n")
    corpus = json.loads(_corpus_path().read_text(encoding="utf-8"))
    if corpus.get("corpusVersion") != SUPPORTED_CORPUS_VERSION:
        sys.stderr.write(f"FAIL-CLOSED: corpusVersion {corpus.get('corpusVersion')} != {SUPPORTED_CORPUS_VERSION}\n")
        print(json.dumps({"lang": "py-livedb", "suites": {}, "total_pass": 0, "total_fail": 0, "version_mismatch": True}))
        return 2

    drivers: Dict[str, Any] = {}
    try:
        drivers["postgres"] = PostgresDriver.connect(**_pg_cfg())
    except Exception as e:
        sys.stderr.write(f"FATAL: Postgres unreachable at {_pg_cfg()['host']}:{_pg_cfg()['port']} — {e}\n")
        return 3
    try:
        drivers["mysql"] = MysqlDriver.connect(**_mysql_cfg())
    except Exception as e:
        drivers["postgres"].close()
        sys.stderr.write(f"FATAL: MySQL unreachable at {_mysql_cfg()['host']}:{_mysql_cfg()['port']} — {e}\n")
        return 3

    try:
        suites = {suite: _run_leg(dialect, drivers[dialect], corpus) for dialect, suite in _LEGS}
    finally:
        for d in drivers.values():
            d.close()

    total_pass = sum(t["pass"] for t in suites.values())
    total_fail = sum(t["fail"] for t in suites.values())
    sys.stderr.write(f"\n{total_pass} passed, {total_fail} failed / {total_pass + total_fail} live-DB vectors\n")
    print(json.dumps({"lang": "py-livedb", "suites": suites, "total_pass": total_pass, "total_fail": total_fail, "version_mismatch": False}))
    return 1 if total_fail > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
