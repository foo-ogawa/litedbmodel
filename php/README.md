# litedbmodel/runtime (PHP)

The PHP leg of the litedbmodel v2 SCP multi-language runtime. A `bc generate --lang php-native` module
is plain PHP with no behavior-contracts runtime; it calls the three leaf transports this package
provides — `Leaves::executeSQL` / `Leaves::pluckKeys` / `Leaves::groupChildren` — wired to the central
execute/run seam, connection routing, transactions, and the render-layer placeholder resolution.
Semantics-identical to the TS reference (`src/scp`).

The generated module reproduces the frozen corpus byte-for-byte: same SQL across all three dialects,
executed on real PDO SQLite and on the live PG/MySQL cross-language pass.

## Calling a generated module

The module is generated with the transports baked in:

```bash
bc generate --from <model>.ts --lang php-native \
  --leaf-transport executeSQL=executeSQL pluck=pluckKeys group=groupChildren \
  --leaf-transport-import 'LiteDbModel\Runtime\Leaves'
```

Its `require` returns an object whose public static methods are the authored entries. The execution
context the statements run on is bound around the call with `Leaves::withTransport()`:

```php
$repo = require 'behaviors_postgres.php';
$rows = Leaves::withTransport($pdoOrCtx, 'postgres', static fn () => $repo::findByEmail('a@b.c'));
```

`$pdoOrCtx` is a raw `\PDO` or an `ExecutionContext` (a routed context resolves its connection per
statement). A statement failure surfaces as `\BehaviorContractsNative\BehaviorError` (`OP_FAILED`)
with the `SqlFailure` / `LimitExceededError` as its previous exception.

The package has no behavior-contracts dependency.

## Layout

```
php/
  composer.json                       # package litedbmodel/runtime
  src/Leaves.php                      # the op-agnostic leaf transport (executeSQL/pluckKeys/groupChildren) + withTransport()
  src/ExecutionContext.php            # the ExecutionContext + central execute/run/runGuarded seam + transaction()
  src/Runtime.php                     # the in-source version mirror (scripts/sync-versions.mjs SSoT)
  src/StaticBundle.php                # the render-layer placeholder resolution (?→$N, PG array-cast)
  src/Dialect.php                     # dialect strategy (finalizePlaceholders / orderByNulls)
  src/SqlFailure.php                  # PDO error → SCP failure mapping (port of src/scp/errors.ts)
  conformance/behaviors_<dialect>.php # generated php-native modules for the live-DB corpus
  conformance/livedb_runner.php       # the live-DB corpus runner
  orm_bench/                          # the ORM-bench cell (generated modules + harness)
  tests/                              # phpunit runtime tests
```

## Running

```bash
cd php && composer install && ./vendor/bin/phpunit
```
