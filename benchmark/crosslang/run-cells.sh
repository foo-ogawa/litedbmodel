#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# Run the ORM-bench cells into results/ — the ONE reproducible command behind the report.
#
#   ./run-cells.sh <dialect> [reps] [warmup] [scale]
#
# `dialect` = sqlite | postgres | mysql. `scale` (default 1) only names the output directory: it must
# match the fixture already emitted by `emit-setup.ts <scale>`, which this script does NOT re-emit (the
# fixture is shared by every cell, so re-emitting mid-run would measure two fixtures in one report).
#
# Every cell writes `cell,dialect,op,iter,us,rows` to results/[scale-<scale>/]<lang>.<surface>.<dialect>.csv;
# `aggregate.mjs` renders them. A cell that cannot run on this dialect is a LOUD skip, never a silent one.
# ════════════════════════════════════════════════════════════════════════════
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DIALECT="${1:?usage: run-cells.sh <sqlite|postgres|mysql> [reps] [warmup] [scale]}"
REPS="${2:-60}"
WARMUP="${3:-10}"
SCALE="${4:-1}"

OUT="$HERE/results"
[ "$SCALE" != "1" ] && OUT="$OUT/scale-$SCALE"
mkdir -p "$OUT"

# ── EXCLUSIVE. One run of this harness at a time, machine-wide — not per dialect. Two reasons, and both
# produce numbers that look plausible and are wrong:
#   1. every cell DROP/CREATEs the same `benchmark_*` tables, so a second run pulls the fixture out from
#      under the first (`Table 'benchmark_tenant_users' doesn't exist` mid-seed is what that looks like);
#   2. even on separate servers, two runs contend for the CPU they are measuring.
# `mkdir` is the atomic test-and-set. A stale directory from a killed run is reclaimed by checking the pid.
LOCK="${TMPDIR:-/tmp}/litedbmodel-crosslang-bench.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  owner="$(cat "$LOCK/pid" 2>/dev/null || echo '?')"
  if [ "$owner" != '?' ] && kill -0 "$owner" 2>/dev/null; then
    echo "✗ another crosslang bench run is live (pid $owner). Concurrent runs corrupt each other's fixture"
    echo "  AND skew each other's timings — refusing to produce numbers. Wait for it, or kill it."
    exit 1
  fi
  echo "  (reclaiming a stale lock from pid $owner)" >&2
  rm -rf "$LOCK" && mkdir "$LOCK" || { echo "✗ cannot take $LOCK"; exit 1; }
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT INT TERM

# Capture the per-op SQL from the GENERATED module for this dialect into the artifact, so every SDK cell
# executes the statements its native twin executes (#172). Runs before the fixture check so the check sees
# the merged artifact.
(cd "$ROOT/go" && go run -tags "bench_$DIALECT" ./lm_bench/lm_orm_native/ sql >/dev/null) || {
  echo "✗ op-SQL capture failed on $DIALECT — the SDK cells have no statements to run"; exit 1
}

# The fixture must already be the one this run claims to measure.
node -e "
  let d;
  try { d = require('$HERE/.setup/$DIALECT.json'); }
  catch { console.error('✗ no fixture — run: npx tsx benchmark/crosslang/emit-setup.ts $SCALE'); process.exit(1); }
  if (String(d.scale) !== '$SCALE') {
    console.error(\`✗ .setup/$DIALECT.json is scale \${d.scale}, not $SCALE — run: npx tsx benchmark/crosslang/emit-setup.ts $SCALE\`);
    process.exit(1);
  }
  console.error(\`fixture: scale \${d.scale}, \${Object.values(d.counts).reduce((a,b)=>a+b,0)} rows\`);
" || exit 1

fail=0
# run <lang>.<surface> <working-dir> <command…> — keeps only the CSV body, and reports a dead cell loudly.
run() {
  local name="$1" dir="$2"; shift 2
  local csv="$OUT/${name}.${DIALECT}.csv"
  echo "── $name ($DIALECT, reps=$REPS warmup=$WARMUP scale=$SCALE)"
  if (cd "$dir" && "$@") | grep -E '^(cell,|(native|sdk|v1),)' > "$csv"; then
    echo "   → $csv ($(($(wc -l < "$csv") - 1)) samples)"
  else
    echo "   ✗ FAILED — $name did not run on $DIALECT; no numbers for it in the report"
    rm -f "$csv"
    fail=$((fail + 1))
  fi
}

# TypeScript — three modes (codegen is labelled `native`, the twin of the other languages' native cells).
npx tsc -p "$HERE/ts-cell/tsconfig.json" || exit 1
TS_MAIN="$ROOT/benchmark/crosslang-build/ts-cell/main.js"
if [ "$DIALECT" = "sqlite" ]; then
  # A LOUD skip, per this script's own contract. litedbmodel routes SQLite through the v1 in-proc path,
  # so `pool-executor.ts` exports no `sqliteConnectionPool` and `dbmodel-runtime.ts` throws for it — there
  # is no TS codegen leg to measure on this dialect, and `typescript.v1` is what a TS consumer on SQLite
  # actually runs. This was skipped with no message at all, which reads as a missing measurement instead
  # of an absent path. Note the asymmetry it leaves: go/rust/python/php all HAVE a native leg on SQLite,
  # so TypeScript is the only language with no native÷sdk ratio on the dialect where client-side cost is
  # the largest fraction.
  echo "── typescript.native (sqlite): SKIP — no TS codegen leg for SQLite (v1 in-proc path; see"
  echo "   src/scp/dbmodel-runtime.ts:145). typescript.v1 covers this dialect."
else
  run typescript.native "$ROOT" node "$TS_MAIN" codegen "$DIALECT" "$REPS" "$WARMUP"
fi
run typescript.v1  "$ROOT" node "$TS_MAIN" v1  "$DIALECT" "$REPS" "$WARMUP"
run typescript.sdk "$ROOT" node "$TS_MAIN" sdk "$DIALECT" "$REPS" "$WARMUP"

# Go — the dialect is a BUILD tag on the native cell (the generated module is baked per dialect).
run go.native "$ROOT/go" go run -tags "bench_$DIALECT" ./lm_bench/lm_orm_native/ bench "$REPS" "$WARMUP"
run go.sdk    "$ROOT/go" go run ./lm_bench/lm_orm/ "$DIALECT" bench "$REPS" "$WARMUP"

# Rust — the dialect is a cargo FEATURE on the native cell, an argv on the SDK cell.
RUST_FEATURES=""
[ "$DIALECT" = "sqlite" ] || RUST_FEATURES="--features livedb,target_$DIALECT"
run rust.native "$ROOT/rust" cargo run --quiet --release --manifest-path orm_bench/Cargo.toml $RUST_FEATURES -- "$REPS" "$WARMUP"
RUST_SDK_FEATURES=""
[ "$DIALECT" = "sqlite" ] || RUST_SDK_FEATURES="--features livedb"
run rust.sdk "$ROOT/rust" cargo run --quiet --release --manifest-path orm_bench_sdk/Cargo.toml $RUST_SDK_FEATURES -- "$DIALECT" "$REPS" "$WARMUP"

run python.native "$ROOT/python" python3 -m orm_bench.main "$DIALECT" "$REPS" "$WARMUP"
run python.sdk    "$ROOT/python" python3 -m orm_bench_sdk.main "$DIALECT" "$REPS" "$WARMUP"

run php.native "$ROOT/php" php orm_bench/main.php "$DIALECT" "$REPS" "$WARMUP"
run php.sdk    "$ROOT/php" php orm_bench_sdk/main.php "$DIALECT" "$REPS" "$WARMUP"

echo
if [ "$fail" -gt 0 ]; then
  echo "✗ $fail cell(s) failed on $DIALECT — the report will show them as SKIP."
  exit 1
fi
echo "✓ every cell ran on $DIALECT → $OUT"
