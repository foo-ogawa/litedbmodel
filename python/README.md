# litedbmodel-runtime (Python)

The Python leg of the litedbmodel v2 SCP multi-language runtime. A `bc generate --lang python-native`
module is plain Python with no behavior-contracts runtime; it calls the three leaf transports this
package provides — `execute_sql` / `pluck_keys` / `group_children` in `litedbmodel_runtime.leaves` —
wired to the central execute/run seam, connection routing, transactions, and the render-layer
placeholder resolution. Semantics-identical to the TS reference (`src/scp`).

## Calling a generated module

The module is generated with the transports baked in:

```bash
bc generate --from <model>.ts --lang python-native \
  --leaf-transport executeSQL=execute_sql pluck=pluck_keys group=group_children \
  --leaf-transport-import litedbmodel_runtime.leaves
```

Its entries are module-level functions (snake_case names, authored parameter names). The execution
context the statements run on is bound around the call with `with_leaf_transport()`:

```python
from litedbmodel_runtime import with_leaf_transport
import behaviors_postgres as repo

rows = with_leaf_transport(conn_or_ctx, "postgres", lambda: repo.find_by_email(email="a@b.c"))
```

`conn_or_ctx` is a DB-API connection or an `ExecutionContext` (a routed context resolves its connection
per statement). The binding is a `ContextVar`, so it follows the call into the worker threads of a
parallel stage. A statement failure surfaces as the module's `BehaviorError` (`OP_FAILED`) with the
`SqlFailure` / `LimitExceededError` as its cause.

The package has no behavior-contracts dependency.

## Layout

```
python/
  pyproject.toml                       # PyPI package (litedbmodel-runtime), version-synced from package.json
  litedbmodel_runtime/
    leaves.py                          # the op-agnostic leaf transport + with_leaf_transport()
    exec_context.py                    # the ExecutionContext + central execute/run seam + transactions
    connection_routing.py              # reader/writer + named-connection routing
    driver.py / dialect.py / grouping.py / errors.py / middleware.py / tx_options.py
  conformance/
    behaviors_<dialect>.py             # generated python-native modules for the live-DB corpus
    livedb_runner.py                   # the live-DB corpus runner
  orm_bench/                           # the ORM-bench cell (generated modules + harness)
  tests/                               # pytest runtime tests
```

## Running

```bash
python3 -m pip install './python[test]' && python3 -m pytest python/tests
```
