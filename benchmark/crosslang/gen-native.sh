#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# ORM-bench NATIVE codegen driver — the REPRODUCIBLE bc-CLI pipeline.
#
#   ./gen-native.sh generate [dialect...]   # bc generate    → the per-leg native modules
#   ./gen-native.sh check    [dialect...]   # tsc + bc check → drift gate (exit 1 on drift)
#
# `dialect` is sqlite | postgres | mysql; with none given ALL THREE are generated/checked (#156). Each
# dialect has its OWN authored class (`BenchSqlite` / `BenchPostgres` / `BenchMysql`), and bc names the
# generated namespace after the declaring class (bc#216) — so the three modules coexist without
# colliding: go gets `package benchsqlite|benchpostgres|benchmysql`, rust three modules, python/php
# three files each exposing its own class. The bench cell selects one at run time by target DB; there
# is no dialect fallback (a cell asked for postgres runs the postgres module or fails loudly).
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
shift || true
DIALECTS=("$@")
[ ${#DIALECTS[@]} -eq 0 ] && DIALECTS=(sqlite postgres mysql)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="$HERE/native-model.ts"
BC="$ROOT/node_modules/.bin/bc"
TSC="$ROOT/node_modules/.bin/tsc"

# The authored class per dialect — the ONE varying parameter across the three generations. bc names the
# generated namespace after it (bc#216), which is what lets the three modules coexist per language.
behavior_of() {
  case "$1" in
    sqlite)   echo BenchSqlite ;;
    postgres) echo BenchPostgres ;;
    mysql)    echo BenchMysql ;;
    *) echo "usage: gen-native.sh [generate|check] [sqlite|postgres|mysql]..." >&2; exit 2 ;;
  esac
}

# The BC-OWNED shared wire modules are dialect-INDEPENDENT (the wire vocabulary does not vary with the
# SQL), so they are emitted once, from the sqlite generation, and the other two dialects reuse them.
RUST_WIRE="$ROOT/rust/litedbmodel_runtime/src/wire.rs"
# Read from go/go.mod, not spelled again here. The module path is a value that MUST agree in three
# places — the manifest that defines it and the two generators that bake it into their output — and it
# was spelled out in all three. Go requires a `/vN` suffix from major 2 on, this repository shipped v2
# without one, and `go get` could not resolve a single v2 tag from 2.0.0 to 2.2.4 (#265). Deriving it
# means the next major bump edits one line.
GO_MODULE="$(awk '$1 == "module" { print $2; exit }' "$ROOT/go/go.mod")"
[ -n "$GO_MODULE" ] || { echo "✗ could not read the module path from go/go.mod"; exit 1; }
GO_RT="$GO_MODULE/litedbmodel_runtime"
GO_WIRE_PKG="$GO_RT/wire"
GO_WIRE="$ROOT/go/litedbmodel_runtime/wire/wire.go"

# One dialect's five legs. Every leg reads the SAME authored source and differs only in the emitter and
# the output path; the leaf-transport symbol map is the ONE op-agnostic transport per language, so it is
# dialect-invariant too. `$1` = dialect, `$2` = generate|check.
run_dialect() {
  local d="$1" mode="$2" behavior
  behavior="$(behavior_of "$d")"
  local from=(--from "$SRC" --behavior "$behavior")

  # rust — one module per dialect under `gen/`, the shared wire crate module emitted once (sqlite run).
  local rust_out="$ROOT/rust/orm_bench/src/gen/$d.rs"
  local rust_flags=(--lang rust-typed-native --out "$rust_out"
    --runtime-import litedbmodel_runtime --shared-types-import litedbmodel_runtime
    --leaf-transport executeSQL=execute_sql pluck=pluck_keys group=group_children)
  [ "$d" = sqlite ] && rust_flags+=(--shared-types-out "$RUST_WIRE")

  # go — one PACKAGE per dialect (bc#216 names it after the declaring class: benchsqlite/…), so the
  # three covered modules coexist; the shared wire package is emitted once (sqlite run).
  local go_pkg="bench$d"
  local go_out="$ROOT/go/lm_bench/lm_orm_native/gen/$go_pkg/behaviors.go"
  local go_flags=(--lang go-typed-native --out "$go_out"
    --runtime-import "$GO_RT" --shared-types-import "$GO_WIRE_PKG"
    --leaf-transport executeSQL=ExecuteSQL pluck=PluckKeys group=GroupChildren
    --leaf-transport-import "$GO_RT")
  [ "$d" = sqlite ] && go_flags+=(--shared-types-out "$GO_WIRE")

  # typescript — the NATIVE emitter's TS target. TS is type-erased, so the transport cannot be baked
  # into the call the way go/rust bake it; the module exposes `bindTyped(handlers)` and the cell hands
  # it litedbmodel's own `leafHandlers` (src/scp/leaves.ts). One file per dialect.
  local ts_out="$ROOT/benchmark/crosslang/ts-cell/behaviors_$d.ts"
  local ts_flags=(--lang typescript-native --out "$ts_out")

  # python / php — the LITERAL (ir-exec) twins, one file per dialect. Each exposes its own class
  # (bc#216), so the three import side by side.
  local py_out="$ROOT/python/orm_bench/behaviors_$d.py"
  local py_flags=(--lang python --out "$py_out")
  local php_out="$ROOT/php/orm_bench/behaviors_$d.php"
  local php_flags=(--lang php --out "$php_out" --runtime-import 'LiteDbModel\Runtime\BehaviorContracts')

  if [ "$mode" = generate ]; then
    mkdir -p "$(dirname "$rust_out")" "$(dirname "$go_out")" "$(dirname "$ts_out")"
    "$BC" generate "${from[@]}" "${rust_flags[@]}"; echo "bc generate ($d) → $rust_out"
    "$BC" generate "${from[@]}" "${go_flags[@]}";   echo "bc generate ($d) → $go_out"
    "$BC" generate "${from[@]}" "${py_flags[@]}";   echo "bc generate ($d) → $py_out"
    "$BC" generate "${from[@]}" "${php_flags[@]}";  echo "bc generate ($d) → $php_out"
    "$BC" generate "${from[@]}" "${ts_flags[@]}";   echo "bc generate ($d) → $ts_out"
  else
    "$BC" check "${from[@]}" "${rust_flags[@]}"
    "$BC" check "${from[@]}" "${go_flags[@]}"
    "$BC" check "${from[@]}" "${py_flags[@]}"
    "$BC" check "${from[@]}" "${php_flags[@]}"
    "$BC" check "${from[@]}" "${ts_flags[@]}"
  fi
}

# The authored source must be ORDINARY TypeScript — bc's authoring requirement, and what keeps the
# de-box points honest: bc reads the ANNOTATION, so a binding whose declared row type does not typecheck
# against the leaf's `WireValue[]` is a declaration bc would lower differently than it reads. `tsc` over
# the SAME `$SRC` the generators consume is part of the drift gate, ahead of the output byte-diff.
[ "$MODE" = check ] && "$TSC" --noEmit --strict --target es2022 --module esnext --moduleResolution bundler "$SRC"

case "$MODE" in
  generate|check) for d in "${DIALECTS[@]}"; do run_dialect "$d" "$MODE"; done ;;
  *) echo "usage: gen-native.sh [generate|check] [sqlite|postgres|mysql]" >&2; exit 2 ;;
esac
