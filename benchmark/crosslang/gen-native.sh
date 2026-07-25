#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# ORM-bench NATIVE codegen driver — the REPRODUCIBLE bc-CLI pipeline.
#
#   ./gen-native.sh generate [dialect]   # bc generate       → the per-leg native modules
#   ./gen-native.sh check    [dialect]   # tsc + bc check    → drift gate (exit 1 on drift)
#
# `dialect` is sqlite (default) | postgres | mysql and selects the authored class. The committed
# modules are the sqlite ones — that is the dialect the bench cells consume — so `check` with no
# argument is the drift gate for what is in the tree. Regenerating for another dialect overwrites the
# same paths on purpose: each language cell holds ONE generated module. Per-dialect modules side by
# side would need per-dialect packages in the cells; that lands with the leaf-transport ABI migration.
#
# There is NO litedbmodel code in the generation OR verification path. `native-model.ts` only DECLARES
# the ops on bc's TS authoring surface; bc's own `bc generate --from` type-extracts and lowers that
# source (it is read, never executed), and the drift gate is `tsc --noEmit` over that source plus bc's
# own `bc check --from` — all over the SAME authored source + the SAME flags (defined once, below). No
# IR is dumped, staged, or re-read: the authored TS is the single source of truth.
#
# The SAME source feeds EVERY leg (language-agnostic). Each leg has its own emitter (`--lang`), --out
# module, --shared-types-out wire module + import specifiers, and leaf-transport symbol map; the flag
# sets are otherwise identical in shape, so `generate` and `check` share them per-leg.
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail
MODE="${1:-generate}"
DIALECT="${2:-sqlite}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="$HERE/native-model.ts"
BC="$ROOT/node_modules/.bin/bc"
TSC="$ROOT/node_modules/.bin/tsc"

# The authored class per dialect — the ONE varying parameter across the three generations.
case "$DIALECT" in
  sqlite)   BEHAVIOR=BenchSqlite ;;
  postgres) BEHAVIOR=BenchPostgres ;;
  mysql)    BEHAVIOR=BenchMysql ;;
  *) echo "usage: gen-native.sh [generate|check] [sqlite|postgres|mysql]" >&2; exit 2 ;;
esac
FROM=(--from "$SRC" --behavior "$BEHAVIOR")

# The rust SSoT flag set — `generate` and `check` MUST use identical flags (bc `check` re-generates and
# byte-diffs BOTH the covered module --out AND the shared wire-type module --shared-types-out). The
# shared wire types (WireValue/WireRow/WireList + runtime-free BehaviorError) are BC-generated into
# `litedbmodel_runtime/src/wire.rs` — no hand-placement. The op-agnostic leaves map to the runtime
# transport symbols execute_sql / pluck_keys / group_children.
OUT="$ROOT/rust/orm_bench/src/gen/behaviors_generated.rs"
WIRE="$ROOT/rust/litedbmodel_runtime/src/wire.rs"
FLAGS=(--lang rust-typed-native --out "$OUT" --shared-types-out "$WIRE"
  --runtime-import litedbmodel_runtime --shared-types-import litedbmodel_runtime
  --leaf-transport executeSQL=execute_sql pluck=pluck_keys group=group_children)

# The go SSoT flag set — the go-typed-native twin of the rust leg over the SAME source. The covered
# module lands in the bench cell package (`go/lm_bench/lm_orm_native/gen`); the BC-OWNED shared wire
# types are BC-generated (--shared-types-out) into the wire package `go/litedbmodel_runtime/wire/wire.go`
# — no hand-placement. The go covered module is a SEPARATE package from the leaf-transport runtime, so
# the transport symbols are package-qualified: --leaf-transport-import carries the runtime package path
# and --leaf-transport maps executeSQL/pluck/group → the exported ExecuteSQL / PluckKeys / GroupChildren.
GO_RT="github.com/foo-ogawa/litedbmodel/go/litedbmodel_runtime"
GO_WIRE_PKG="$GO_RT/wire"
GO_OUT="$ROOT/go/lm_bench/lm_orm_native/gen/behaviors_generated.go"
GO_WIRE="$ROOT/go/litedbmodel_runtime/wire/wire.go"
GO_FLAGS=(--lang go-typed-native --out "$GO_OUT" --shared-types-out "$GO_WIRE"
  --runtime-import "$GO_RT" --shared-types-import "$GO_WIRE_PKG"
  --leaf-transport executeSQL=ExecuteSQL pluck=PluckKeys group=GroupChildren
  --leaf-transport-import "$GO_RT")

# The python SSoT flag set — the LITERAL (ir-exec) twin over the SAME source (epic #123: ts/go/rust =
# native de-box; py/php = literal). The python emitter embeds the portable IR as a dict literal and
# hands it to the shared runtime core (`behavior_contracts.run_behavior`) via `bind(handlers)` — it
# generates NO per-op exec logic and NO typed wire, so the typed-native flags do NOT apply
# (`--shared-types-out`/`--leaf-transport` are rejected by the python emitter). The op-agnostic leaf
# transport (executeSQL/pluck/group) is injected at RUNTIME by the bench cell via
# `litedbmodel_runtime.make_handlers`, not baked at generate time.
PY_OUT="$ROOT/python/orm_bench/behaviors_generated.py"
PY_FLAGS=(--lang python --out "$PY_OUT")

# The php SSoT flag set — the LITERAL (ir-exec) twin over the SAME source, mirror of the python leg.
# The php emitter embeds the portable IR as a native stdClass/array literal and hands it to the shared
# runtime core (`Behavior::runBehavior`) via `bind($handlers)`. Unlike python (which consumes
# behavior-contracts from PyPI), the php bc runtime-core is VENDORED under
# `LiteDbModel\Runtime\BehaviorContracts` (bc php is unpublished — vendor:bc-php), so `--runtime-import`
# points the generated module's require-time gates (SpecVersions/Fingerprint) + `runBehavior` call at
# that vendored namespace. The op-agnostic leaf transport is injected at RUNTIME by the bench cell via
# `Leaves::makeHandlers`, not baked at generate time.
PHP_OUT="$ROOT/php/orm_bench/behaviors_generated.php"
PHP_FLAGS=(--lang php --out "$PHP_OUT" --runtime-import 'LiteDbModel\Runtime\BehaviorContracts')

# Generate (or drift-check) EACH native leg via bc's own CLI, over the SAME authored source.
case "$MODE" in
  generate)
    "$BC" generate "${FROM[@]}" "${FLAGS[@]}";     echo "bc generate ($DIALECT) → $OUT"
    "$BC" generate "${FROM[@]}" "${GO_FLAGS[@]}";  echo "bc generate ($DIALECT) → $GO_OUT"
    "$BC" generate "${FROM[@]}" "${PY_FLAGS[@]}";  echo "bc generate ($DIALECT) → $PY_OUT"
    "$BC" generate "${FROM[@]}" "${PHP_FLAGS[@]}"; echo "bc generate ($DIALECT) → $PHP_OUT" ;;
  check)
    # The authored source must be ORDINARY TypeScript — that is bc's authoring requirement, and it is
    # what keeps the de-box points honest: bc reads the ANNOTATION, so a binding whose declared row type
    # does not typecheck against the leaf's `WireValue[]` is a declaration bc would lower differently
    # than it reads. `tsc` over the SAME `$SRC` the generators consume is therefore part of the drift
    # gate, ahead of the output byte-diff — a source that does not typecheck never reaches the emitters.
    "$TSC" --noEmit --strict --target es2022 --module esnext --moduleResolution bundler "$SRC"
    "$BC" check "${FROM[@]}" "${FLAGS[@]}"
    "$BC" check "${FROM[@]}" "${GO_FLAGS[@]}"
    "$BC" check "${FROM[@]}" "${PY_FLAGS[@]}"
    "$BC" check "${FROM[@]}" "${PHP_FLAGS[@]}" ;;
  *) echo "usage: gen-native.sh [generate|check] [sqlite|postgres|mysql]" >&2; exit 2 ;;
esac
