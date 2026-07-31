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

# ── arm64 TOOLCHAIN, PINNED AND GUARDED. This is an Apple-Silicon host, but the default PATH points at
# the x86 Homebrew (/usr/local) — so `node`, `go`, `php`, `cargo` all resolve to x86_64 binaries that run
# under Rosetta, and one language (python, a universal binary) runs arm64. That mixes architectures AND
# measures emulation, not the machine. Every number this harness prints must be arm64-native, so the
# toolchain is resolved to arm64 here and a mismatch is a HARD failure, never a silent Rosetta run.
#
# Override any entry with BENCH_NODE / BENCH_GO / BENCH_PHP / BENCH_PYTHON; otherwise: node from the
# newest arm64 nvm install, go/php from /opt/homebrew (arm64 Homebrew), python3 from PATH (Xcode's is a
# universal binary that already runs arm64). Rust builds with --target aarch64-apple-darwin below.
RUST_TARGET="aarch64-apple-darwin"
pick_arm64_node() {
  [ -n "${BENCH_NODE:-}" ] && { echo "$BENCH_NODE"; return; }
  local n
  for n in $(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -rV); do
    [ -x "$n" ] && file "$n" | grep -q arm64 && { echo "$n"; return; }
  done
}
BENCH_NODE="$(pick_arm64_node)"
[ -n "$BENCH_NODE" ] && export PATH="$(dirname "$BENCH_NODE"):$PATH"
[ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/bin:$PATH"
NODE="${BENCH_NODE:-node}"; GO="${BENCH_GO:-go}"; PHP="${BENCH_PHP:-php}"; PY="${BENCH_PYTHON:-python3}"

# node/go/php resolve to THIN arm64 binaries, which run arm64 whatever the parent shell is. python3 here
# is a UNIVERSAL binary, and macOS does not propagate an `arch -arm64` preference to a grandchild — so a
# python spawned two shells deep from this x86 login shell runs x86. Launch it as a DIRECT child of
# `arch -arm64` (that IS honoured), but only when the plain invocation is not already arm64.
PY_LAUNCH="$PY"
if [ "$($PY -c 'import platform;print(platform.machine())' 2>/dev/null)" != "arm64" ] \
   && [ "$(arch -arm64 $PY -c 'import platform;print(platform.machine())' 2>/dev/null)" = "arm64" ]; then
  PY_LAUNCH="arch -arm64 $PY"
fi

guard_arch() { # name actual  → fail unless arm64
  case "$2" in
    arm64|aarch64) : ;;
    *) echo "✗ $1 is '$2', not arm64 — refusing to publish Rosetta/x86 numbers on an arm64 host."; echo "  Fix the arm64 toolchain (see the block in run-cells.sh) or set BENCH_$1."; exit 1 ;;
  esac
}
guard_arch NODE "$("$NODE" -p process.arch 2>/dev/null)"
guard_arch GO   "$("$GO" env GOARCH 2>/dev/null)"
guard_arch PHP  "$("$PHP" -r 'echo php_uname("m");' 2>/dev/null)"
guard_arch PYTHON "$($PY_LAUNCH -c 'import platform;print(platform.machine())' 2>/dev/null)"
echo "arch: node/go/php/python all arm64; rust → $RUST_TARGET"

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

# Complete the artifact for this dialect, so every cell runs the SAME work rather than its own idea of it
# (#172). Two steps, in this order, and both before the fixture check so the check sees the merged file:
#
#   1. CAPTURE the per-op SQL from the GENERATED module at the runtime seam. It has to be a capture and
#      not a copy — PostgreSQL's relation predicates carry a cast token the runtime resolves from the key
#      param's element type, so the final text is only knowable by running it.
#   2. DERIVE what the statements imply but do not say: the MySQL RETURNING recovery (which the runtime
#      issues BELOW the seam, so it cannot be captured) and each batch write's own column order. Both
#      come from the library's own code, never from a cell's guess.
(cd "$ROOT/go" && "$GO" run -tags "bench_$DIALECT" ./lm_bench/lm_orm_native/ sql >/dev/null) || {
  echo "✗ op-SQL capture failed on $DIALECT — the SDK cells have no statements to run"; exit 1
}
npx tsx "$HERE/derive-ops.ts" "$DIALECT" || {
  echo "✗ op-SQL derivation failed on $DIALECT — the SDK cells cannot bind the captured statements"; exit 1
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

# ── VERIFY: every cell issues the SAME work, checked BEFORE anything is timed. ───────────────────────
# Each cell's proof pass prints one `proof,<surface>,<dialect>,<op>,<statements>,<rows>` line per op — the
# ONE machine-readable format all ten share. This collects them and fails the run if any (op) is not
# single-valued across the native and sdk cells.
#
# It is a phase of its own, ahead of the measurement, because the point is to refuse to PRODUCE numbers
# that are not comparable rather than to publish them and note a disagreement underneath. `aggregate.mjs`
# already compares rows/op after the fact, and #172 is the case that slipped through it: two cells issuing
# different SQL for `compositeRelations` moved the same 11,100 rows by coincidence. Statements are checked
# here as well as rows, and the run stops on the spot.
#
# `typescript.runtime` is not in this comparison and prints `runtime`: the imperative path wraps every
# single-row write in its own transaction (its own `Cell.expectedStatements`) and cannot express `upsert`
# at all, so it is a different amount of work by design — the report divides native by SDK, not by it.
PROOF="$(mktemp)"
trap 'rm -rf "$LOCK"; rm -f "$PROOF"' EXIT INT TERM
verify_fail=0
prove() { # <name> <working-dir> <command…>
  local name="$1" dir="$2"; shift 2
  local out
  if ! out="$( (cd "$dir" && "$@") 2>&1 )"; then
    echo "   ✗ $name did not complete its proof pass on $DIALECT"
    echo "$out" | tail -20
    verify_fail=$((verify_fail + 1))
    return
  fi
  local n
  n="$(printf '%s\n' "$out" | grep -c '^proof,' || true)"
  if [ "$n" -eq 0 ]; then
    echo "   ✗ $name printed no proof lines — it cannot be checked against the other cells"
    verify_fail=$((verify_fail + 1))
    return
  fi
  printf '%s\n' "$out" | grep '^proof,' | sed "s|^|$name,|" >> "$PROOF"
  echo "   ✓ $name ($n ops)"
}

echo "── verify: every cell issues the same statements and moves the same rows ($DIALECT)"
npx tsc -p "$HERE/ts-cell/tsconfig.json" || exit 1
TS_MAIN="$ROOT/benchmark/crosslang-build/ts-cell/main.js"
[ "$DIALECT" = "sqlite" ] || prove typescript.native "$ROOT" "$NODE" "$TS_MAIN" safety codegen "$DIALECT"
prove typescript.sdk "$ROOT" "$NODE" "$TS_MAIN" safety sdk "$DIALECT"
prove go.native "$ROOT/go" "$GO" run -tags "bench_$DIALECT" ./lm_bench/lm_orm_native/
prove go.sdk    "$ROOT/go" "$GO" run ./lm_bench/lm_orm/ "$DIALECT"
RUST_FEATURES=""
[ "$DIALECT" = "sqlite" ] || RUST_FEATURES="--features livedb,target_$DIALECT"
prove rust.native "$ROOT/rust" cargo run --quiet --release --target "$RUST_TARGET" --manifest-path orm_bench/Cargo.toml $RUST_FEATURES -- safety
RUST_SDK_FEATURES=""
[ "$DIALECT" = "sqlite" ] || RUST_SDK_FEATURES="--features livedb"
prove rust.sdk "$ROOT/rust" cargo run --quiet --release --target "$RUST_TARGET" --manifest-path orm_bench_sdk/Cargo.toml $RUST_SDK_FEATURES -- safety "$DIALECT"
prove python.native "$ROOT/python" $PY_LAUNCH -m orm_bench.main safety "$DIALECT"
prove python.sdk    "$ROOT/python" $PY_LAUNCH -m orm_bench_sdk.main safety "$DIALECT"
prove php.native "$ROOT/php" "$PHP" orm_bench/main.php safety "$DIALECT"
prove php.sdk    "$ROOT/php" "$PHP" orm_bench_sdk/main.php safety "$DIALECT"

[ "$verify_fail" -gt 0 ] && { echo "✗ $verify_fail cell(s) could not be verified on $DIALECT — refusing to measure."; exit 1; }
node -e '
  const fs = require("fs");
  // cell,surface,dialect,op,statements,rows — one line per op per cell, from each cell own proof pass.
  const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => l.split(","));
  const by = new Map();
  for (const line of rows) {
    // `<cell>,proof,<surface>,<dialect>,<op>,<statements>,<rows>` — the cell name is prefixed by `prove`.
    const [cell, , surface, dialect, op, stmts, rowCount] = line;
    if (surface !== "native" && surface !== "sdk") continue;
    const key = `${dialect}|${op}`;
    if (!by.has(key)) by.set(key, new Map());
    const seen = by.get(key);
    const value = `${stmts} statements / ${rowCount} rows`;
    if (!seen.has(value)) seen.set(value, []);
    seen.get(value).push(cell);
  }
  const bad = [...by].filter(([, seen]) => seen.size > 1);
  const cells = new Set(rows.map((l) => l[0]));
  if (bad.length === 0) {
    console.log(`   ✓ ${by.size} op(s) × ${cells.size} cell(s): every native and sdk cell issues the same statements and moves the same rows.`);
    process.exit(0);
  }
  console.error("\n✗ cells disagree on the work an op does — they are not comparable, so nothing is measured:\n");
  for (const [key, seen] of bad) {
    console.error(`  ${key.replace("|", "  ")}`);
    for (const [value, list] of seen) console.error(`      ${value}  ←  ${list.join(", ")}`);
  }
  console.error("\nEvery statement, value and RETURNING recovery comes from .setup/<dialect>.json. A cell that");
  console.error("disagrees is reading something else, or binding it differently.");
  process.exit(1);
' "$PROOF" || exit 1
echo

fail=0
# run <lang>.<surface> <working-dir> <command…> — keeps only the CSV body, and reports a dead cell loudly.
run() {
  local name="$1" dir="$2"; shift 2
  local csv="$OUT/${name}.${DIALECT}.csv"
  echo "── $name ($DIALECT, reps=$REPS warmup=$WARMUP scale=$SCALE)"
  if (cd "$dir" && "$@") | grep -E '^(cell,|(native|sdk|runtime),)' > "$csv"; then
    echo "   → $csv ($(($(wc -l < "$csv") - 1)) samples)"
  else
    echo "   ✗ FAILED — $name did not run on $DIALECT; no numbers for it in the report"
    rm -f "$csv"
    fail=$((fail + 1))
  fi
}

# TypeScript — three modes (codegen is labelled `native`, the twin of the other languages' native cells).
if [ "$DIALECT" = "sqlite" ]; then
  # A LOUD skip, per this script's own contract. litedbmodel routes SQLite through the runtime in-proc path,
  # so `pool-executor.ts` exports no `sqliteConnectionPool` and `dbmodel-runtime.ts` throws for it — there
  # is no TS codegen leg to measure on this dialect, and `typescript.runtime` is what a TS consumer on SQLite
  # actually runs. This was skipped with no message at all, which reads as a missing measurement instead
  # of an absent path. Note the asymmetry it leaves: go/rust/python/php all HAVE a native leg on SQLite,
  # so TypeScript is the only language with no native÷sdk ratio on the dialect where client-side cost is
  # the largest fraction.
  echo "── typescript.native (sqlite): SKIP — no TS codegen leg for SQLite (runtime in-proc path; see"
  echo "   src/scp/dbmodel-runtime.ts:145). typescript.runtime covers this dialect."
else
  run typescript.native "$ROOT" "$NODE" "$TS_MAIN" codegen "$DIALECT" "$REPS" "$WARMUP"
fi
run typescript.runtime "$ROOT" "$NODE" "$TS_MAIN" runtime "$DIALECT" "$REPS" "$WARMUP"
run typescript.sdk "$ROOT" "$NODE" "$TS_MAIN" sdk "$DIALECT" "$REPS" "$WARMUP"

# Go — the dialect is a BUILD tag on the native cell (the generated module is baked per dialect).
run go.native "$ROOT/go" "$GO" run -tags "bench_$DIALECT" ./lm_bench/lm_orm_native/ bench "$REPS" "$WARMUP"
run go.sdk    "$ROOT/go" "$GO" run ./lm_bench/lm_orm/ "$DIALECT" bench "$REPS" "$WARMUP"

# Rust — the dialect is a cargo FEATURE on the native cell, an argv on the SDK cell (both settled above).
run rust.native "$ROOT/rust" cargo run --quiet --release --target "$RUST_TARGET" --manifest-path orm_bench/Cargo.toml $RUST_FEATURES -- "$REPS" "$WARMUP"
run rust.sdk "$ROOT/rust" cargo run --quiet --release --target "$RUST_TARGET" --manifest-path orm_bench_sdk/Cargo.toml $RUST_SDK_FEATURES -- "$DIALECT" "$REPS" "$WARMUP"

run python.native "$ROOT/python" $PY_LAUNCH -m orm_bench.main "$DIALECT" "$REPS" "$WARMUP"
run python.sdk    "$ROOT/python" $PY_LAUNCH -m orm_bench_sdk.main "$DIALECT" "$REPS" "$WARMUP"

run php.native "$ROOT/php" "$PHP" orm_bench/main.php "$DIALECT" "$REPS" "$WARMUP"
run php.sdk    "$ROOT/php" "$PHP" orm_bench_sdk/main.php "$DIALECT" "$REPS" "$WARMUP"

echo
if [ "$fail" -gt 0 ]; then
  echo "✗ $fail cell(s) failed on $DIALECT — the report will show them as SKIP."
  exit 1
fi
echo "✓ every cell ran on $DIALECT → $OUT"
