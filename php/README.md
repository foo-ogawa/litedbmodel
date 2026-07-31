# litedbmodel/runtime (PHP)

The PHP leg of the litedbmodel v2 SCP multi-language runtime. It is the shared runtime a
`bc generate`d native module binds to: the leaf transport (`Leaves::makeHandlers` →
`executeSQL`/`pluck`/`group`) wired to the central execute/run seam, connection routing, and the
render-layer placeholder resolution — semantics-identical to the TS reference (`src/scp`).

**Status: implemented (WS7d, #33).** There is no litedbmodel-owned bundle/read-graph/tx-plan
execution (the self-built `SqlBundle`/`ReadGraph` surface was removed in #227): a BC-generated PHP
module drives the closed-set orchestration and calls the leaf handlers by boundary injection. The
runtime reproduces the frozen corpus byte-for-byte: same SQL across all three dialects, executed on
real PDO SQLite + the live PG/MySQL cross-language pass (the SQL-handler seam takes any PDO
connection).

## behavior-contracts dependency — VENDORED (not a registry dep)

The behavior-contracts **PHP port is NOT published to Packagist** (owner decision, mirrored from
graphddb — `foo-ogawa/behavior-contracts#7`). Like graphddb, this runtime therefore consumes it by
**vendoring** a mechanical copy into `php/src/BehaviorContracts/` behind a sync script + a CI drift
gate (`scripts/vendor-behavior-contracts-php.mjs`, mirroring graphddb's). This is NOT a local `../`
path dependency — it is a committed, drift-checked vendored copy, so the `check-no-local-deps`
gate is satisfied and the published artifact is self-contained.

Re-vendor from the behavior-contracts SSoT and check for drift:

```bash
npm run vendor:bc-php          # (re)vendor from ../behavior-contracts/php/src
npm run vendor:bc-php:check    # CI: fail on drift (never hand-edit src/BehaviorContracts/)
```

The composer.json therefore declares **no** behavior-contracts requirement; the vendored classes
autoload under the package's own PSR-4 root (`LiteDbModel\Runtime\` → `src/`, which covers
`LiteDbModel\Runtime\BehaviorContracts\` → `src/BehaviorContracts/`).

## Layout

```
php/
  composer.json                       # package litedbmodel/runtime (no bc dep — bc is vendored)
  src/Leaves.php                      # the op-agnostic leaf transport (executeSQL/pluck/group) — the execution surface
  src/ExecutionContext.php            # the ExecutionContext + central execute/run/runGuarded seam + transaction()
  src/Runtime.php                     # the in-source version mirror (scripts/sync-versions.mjs SSoT)
  src/StaticBundle.php                # the render-layer placeholder resolution (?→$N, PG array-cast)
  src/Dialect.php                     # dialect strategy (finalizePlaceholders / orderByNulls)
  src/SqlFailure.php                  # PDO error → SCP failure mapping (port of src/scp/errors.ts)
  src/BehaviorContracts/              # vendored bc PHP port (drift-gated), NOT hand-edited
  conformance/vectors_runner.php      # conformance runner entry (loads conformance/vectors/*.json)
  tests/                              # phpunit runtime tests
```

## Running

```bash
# Conformance vectors (real PDO SQLite; reproduces expected SQL + results):
php php/conformance/vectors_runner.php

# phpunit unit + integration tests:
cd php && composer install && ./vendor/bin/phpunit
```
