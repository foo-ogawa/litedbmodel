"""NATIVE-codegen ORM-bench cell (python leg, epic #123) — self-measure the covered ORM ops through
the litedbmodel-GENERATED ir-exec module (``behaviors_generated.py``, verbatim ``bc generate --lang
python``) + ``litedbmodel_runtime``'s op-agnostic leaf transport, and print a flat CSV
(``cell,dialect,op,iter,us``) the TS collector aggregates.

This cell is a litedbmodel-CONSUMER: it binds the leaf transport (``make_handlers`` →
``executeSQL``/``pluck``/``group``) into the generated module's ``bind(handlers)`` (boundary injection
— the python literal/ir-exec path, epic #123: ts/go/rust = native de-box; py/php = literal) and calls
the resulting per-op callables. It holds NO hand-written exec seam and NO hand-written BEGIN/COMMIT:

  - reads/single-writes/batches run the bound op callable directly; the leaf funnels every DB access
    through the runtime central execute/run seam. Relations are N+1-free: ``parents → pluck →
    executeSQL(WHERE fk IN …) → group`` = 1 batched child query per level (nestedFindAll=2,
    nestedRelations=3, composite=3). Batch writes are ONE ``json_each``/``JSON_TABLE`` statement.
  - RETURNING-chained TRANSACTIONS run THROUGH the runtime tx boundary ``with_transaction`` (BEGIN →
    body → COMMIT on ok / ROLLBACK on error) — the consumer's tx-boundary responsibility. The
    generated ``.map`` runner emits its 2 body statements via the leaf; ``with_transaction`` pins the
    tx-owned connection (the leaf resolves it via ``current_context()``) and brackets BEGIN/COMMIT.

Usage: ``python -m orm_bench.main <dialect> [reps] [warmup]`` or
``python -m orm_bench.main safety <dialect>``.
"""

from __future__ import annotations

import os
import sys
import time
from contextlib import contextmanager
from typing import Any, Callable, Dict, List

# The shared seed-SSoT loader lives at the python/ root (one dir above this package) — anchor its import
# to this file so it resolves regardless of cwd.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import lm_bench_setup  # noqa: E402

from litedbmodel_runtime import (
    MysqlDriver,
    PostgresDriver,
    SqliteDriver,
    as_context,
    clear_middlewares,
    create_middleware,
    make_handlers,
    register_middleware,
    with_transaction,
)

# One generated module PER TARGET DB (#156): the SQL is baked per dialect, so a postgres run must load
# the postgres module — there is no dialect fallback.
from . import behaviors_mysql, behaviors_postgres, behaviors_sqlite

_GENERATED = {"sqlite": behaviors_sqlite, "postgres": behaviors_postgres, "mysql": behaviors_mysql}

# ── schema + seed from the ONE seed SSoT (benchmark/crosslang/.setup/sqlite.json, emitted from
#    orm-domain.ts) — the SAME fixture every other cell loads. This is FIXTURE setup, not covered code:
#    the harness measures the GENERATED op callables, it does not hand-write the seed. ──
# The seed SSoT is PER TARGET DB (#156): `benchmark/crosslang/.setup/<dialect>.json`, emitted from the
# one `orm-domain.ts`. `setup_for` is the only reader; nothing here hand-writes a schema or a seed.
def setup_for(dialect: str) -> Dict[str, List[str]]:
    return lm_bench_setup.load(dialect)


_SETUP = setup_for("sqlite")
SCHEMA: List[str] = _SETUP["schema"]  # the sqlite default (in-memory cell); a live target loads its own
SEED: List[str] = _SETUP["delete"] + _SETUP["insert"]  # empty + the canonical 110-user fixture, per op

# All 19 covered ops in generated declaration order (COMPONENT_NAMES).
OPS: List[str] = [
    "findAll", "filterPaginateSort", "findFirst", "findUnique",
    "nestedFindAll", "nestedFindFirst", "nestedFindUnique", "nestedRelations", "compositeRelations",
    "create", "update", "upsert", "createMany", "upsertMany", "updateMany",
    "nestedCreate", "nestedUpsert", "nestedUpdate", "delete",
]

# The RETURNING-chained transactions — run THROUGH the runtime tx boundary (with_transaction). The
# generated runner emits no BEGIN/COMMIT; the boundary is the consumer's (BEGIN + 2 body + COMMIT).
TX_OPS = frozenset({"nestedCreate", "nestedUpsert", "nestedUpdate", "delete"})

# ── safety expectations ──────────────────────────────────────────────────────────
# Batched relation: 1 parent + 1 batched child per level, INDEPENDENT of the row count (never 1 + N).
RELATION_QUERY_COUNTS: Dict[str, int] = {
    "nestedFindAll": 2, "nestedFindFirst": 2, "nestedFindUnique": 2, "nestedRelations": 3, "compositeRelations": 3,
}
# Batch write: ONE json_each/JSON_TABLE statement for N records (no per-row fan-out).
BATCH_QUERY_COUNTS: Dict[str, int] = {"createMany": 1, "upsertMany": 1, "updateMany": 1}
# RETURNING-chained tx: BEGIN + 2 body (the RETURNING write + the dependent write) + COMMIT = 4.
TX_STMT_COUNTS: Dict[str, int] = {"nestedCreate": 4, "nestedUpsert": 4, "nestedUpdate": 4, "delete": 4}


def _user_rows(it: int, stable: bool) -> List[Dict[str, Any]]:
    """The 10-row batch record set for createMany/upsertMany (ONE opaque `rows` array — the
    json_each/JSON_TABLE batch param). `stable` reuses fixed emails (upsertMany — conflict-updates);
    else the email varies by iteration so a plain INSERT stays insertable under UNIQUE(email)."""
    return [
        {"email": (f"many{i}@bench.com" if stable else f"many{it}_{i}@bench.com"), "name": f"Many {i}"}
        for i in range(10)
    ]


def op_input(op: str, it: int) -> Dict[str, Any]:
    """The per-op input scope (the emitter-declared `value` input ports). Mutating ops vary their UNIQUE
    column by iteration (matching the rust bench cell); a read with no input ports gets `{}`."""
    if op == "filterPaginateSort":
        return {"published": 1}
    if op in ("findFirst", "nestedFindFirst"):
        return {"name": "User%"}
    if op in ("findUnique", "nestedFindUnique"):
        return {"email": "user1@example.com"}
    if op == "create":
        return {"email": f"new{it}@bench.com", "name": "New"}
    if op == "update":
        return {"id": 1, "name": "Updated 1"}
    if op == "upsert":
        return {"email": "user1@example.com", "name": "Upserted One"}
    if op == "createMany":
        return {"rows": _user_rows(it, stable=False)}
    if op == "upsertMany":
        return {"rows": _user_rows(it, stable=True)}
    if op == "updateMany":
        return {"rows": [{"id": i, "name": f"Many {i}"} for i in range(1, 11)]}
    if op == "nestedCreate":
        return {"email": f"nc{it}@bench.com", "name": "NC", "title": "NC Post"}
    if op == "nestedUpsert":
        return {"email": "user1@example.com", "name": "NUp", "title": "NUp Post"}
    if op == "nestedUpdate":
        return {"id": 1, "name": "NU", "title": "NU Post"}
    if op == "delete":
        return {"email": f"del{it}@bench.com", "name": "Del"}
    return {}


def open_driver(dialect: str) -> Any:
    """The driver for ONE target DB, built with the runtime's own constructors (#156 — the cell writes no
    connection code of its own).

    sqlite = in-memory, built from the generated schema; postgres / mysql = the LIVE docker DB on the
    established ports (``TEST_DB_PORT`` 5433 / ``TEST_MYSQL_PORT`` 3307), whose schema is applied here
    from the SAME single-SSoT DDL. An unreachable target is a LOUD failure — never a silent fall back to
    sqlite, which is exactly the defect that let "postgres" runs execute sqlite SQL.
    """
    if dialect not in ("sqlite", "postgres", "mysql"):
        raise SystemExit(f"orm_bench: unknown target {dialect!r} (sqlite|postgres|mysql)")
    setup = setup_for(dialect)
    if dialect == "sqlite":
        return SqliteDriver.in_memory(setup["schema"])
    if dialect == "postgres":
        driver = PostgresDriver.connect(
            host=os.environ.get("TEST_DB_HOST", "localhost"),
            port=int(os.environ.get("TEST_DB_PORT", "5433")),
            user=os.environ.get("TEST_DB_USER", "testuser"),
            password=os.environ.get("TEST_DB_PASSWORD", "testpass"),
            dbname=os.environ.get("TEST_DB_NAME", "testdb"),
        )
    elif dialect == "mysql":
        driver = MysqlDriver.connect(
            host=os.environ.get("TEST_MYSQL_HOST", "127.0.0.1"),
            port=int(os.environ.get("TEST_MYSQL_PORT", "3307")),
            user=os.environ.get("TEST_MYSQL_USER", "testuser"),
            password=os.environ.get("TEST_MYSQL_PASSWORD", "testpass"),
            dbname=os.environ.get("TEST_MYSQL_DB", "testdb"),
        )
    driver.exec_ddl(list(setup["schema"]))
    return driver


def seed(driver: Any, dialect: str = "sqlite") -> None:
    """DELETE + INSERT the canonical nested fixture of THIS target (runs on the driver directly — not
    through the seam, so it is never counted by the safety middleware)."""
    setup = setup_for(dialect)
    for stmt in setup["delete"] + setup["insert"]:
        driver.prepare(stmt).run([])


def bound_ops(driver: Any, dialect: str) -> Dict[str, Callable[..., Any]]:
    """Bind the op-agnostic leaf transport into the generated module of THIS dialect."""
    module = _GENERATED.get(dialect)
    if module is None:
        raise SystemExit(f"orm_bench: no generated module for dialect {dialect!r} (sqlite|postgres|mysql)")
    return module.bind(make_handlers(driver, dialect))


def run_op(fns: Dict[str, Callable[..., Any]], driver: Any, op: str, it: int) -> Any:
    """Run ONE covered op through its generated callable. A RETURNING-chained tx op runs THROUGH the
    runtime tx boundary (with_transaction over the driver ctx) so BEGIN/COMMIT bracket the leaf's body
    statements on the tx-owned connection; every other op runs the bound callable directly."""
    inp = op_input(op, it)
    if op in TX_OPS:
        return with_transaction(as_context(driver), lambda _tx_ctx: fns[op](inp))
    return fns[op](inp)


def _measure(dialect: str, reps: int, warmup: int) -> None:
    driver = open_driver(dialect)
    fns = bound_ops(driver, dialect)
    print("cell,dialect,op,iter,us,rows")
    for op in OPS:
        # One UN-TIMED probe measures the rows this op moves (it re-seeds too) — the report's per-row
        # denominator (#170). The counting middleware is unregistered before the timed loop.
        rows = probe(driver, fns, dialect, op)["rows"]
        for it in range(warmup):
            run_op(fns, driver, op, it)
        for it in range(reps):
            g = it + warmup  # unique iteration id (UNIQUE-email ops stay insertable across warmup+timed)
            t = time.perf_counter_ns()
            run_op(fns, driver, op, g)
            us = (time.perf_counter_ns() - t) // 1000
            print(f"native,{dialect},{op},{it},{us},{rows}")


@contextmanager
def _counters() -> Any:
    """Register the ONE counting middleware — statements AND rows — at the runtime seam, for the duration
    of the block. Every read / batch write / tx-control statement funnels through execute/run →
    middleware.wrap; the read seam hands the row list back, so the same hook totals both. The seed runs
    on the driver directly (off-seam) and is never counted.

    Scoped rather than process-wide on purpose: an op's rows are measured by an UN-TIMED probe, so the
    published latencies never pay for the observation (#170).
    """
    tally = {"stmts": 0, "rows": 0}

    def counter(_state: Any, nxt: Callable[..., Any], sql: str, params: Any) -> Any:
        tally["stmts"] += 1
        out = nxt(sql, params)
        if isinstance(out, list):
            tally["rows"] += len(out)
        return out

    clear_middlewares()
    unregister = register_middleware(create_middleware(execute=counter))
    try:
        yield tally
    finally:
        unregister()
        clear_middlewares()


def probe(driver: Any, fns: Dict[str, Callable[..., Any]], dialect: str, op: str) -> Dict[str, int]:
    """Run ONE op once off the timed seam and report its ``{stmts, rows}`` — the safety assertion's input
    and the report's per-row denominator, measured in one place."""
    seed(driver, dialect)  # clean fixture; not counted (runs off-seam)
    with _counters() as tally:
        run_op(fns, driver, op, 0)
        return dict(tally)


def _safety(dialect: str) -> None:
    driver = open_driver(dialect)
    fns = bound_ops(driver, dialect)
    expected = {**RELATION_QUERY_COUNTS, **BATCH_QUERY_COUNTS, **TX_STMT_COUNTS}
    print("op                    statements  rows")
    for op in OPS:
        got = probe(driver, fns, dialect, op)
        want = expected.get(op)
        mark = "ok" if want is None or got["stmts"] == want else f"STATEMENT-COUNT MISMATCH (want {want})"
        print(f"{op:<20}  {got['stmts']:<10}  {got['rows']:<6} {mark}")
        assert want is None or got["stmts"] == want, f"{op} statement-count regression: got {got['stmts']}, expect {want}"


def main(argv: List[str]) -> None:
    if argv and argv[0] == "safety":
        _safety(argv[1] if len(argv) > 1 else "sqlite")
        return
    dialect = argv[0] if argv else "sqlite"
    reps = int(argv[1]) if len(argv) > 1 else 300
    warmup = int(argv[2]) if len(argv) > 2 else 30
    _measure(dialect, reps, warmup)


if __name__ == "__main__":
    main(sys.argv[1:])
