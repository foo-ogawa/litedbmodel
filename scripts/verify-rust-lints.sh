#!/usr/bin/env bash
# The rust fmt + clippy set, EXACTLY as `.github/workflows/conformance.yml` runs it (#242: all 5 crates
# under rust/, including the 3 that declare their own `[workspace]` and so cannot be reached by
# `--workspace`/`-p` from rust/Cargo.toml).
#
# It is a script rather than a hand-typed sequence because hand-typing it went wrong: a loop that passed
# `--manifest-path Cargo.toml` for the workspace root reported FAIL for every run, since the virtual
# manifest has no targets of its own — a false red that looked like a formatting problem in the code.
# `npm run verify` calls this, so the sequence is written down once and run the same way every time.
#
# `npm run gates:check` separately asserts that CI's list covers every Cargo.toml under rust/, so this
# file cannot silently fall behind a new crate.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../rust" && pwd)" || exit 1

fail=0
run() {
  printf '   %-92s' "$*"
  if out="$("$@" 2>&1)"; then
    echo "ok"
  else
    echo "FAIL"
    printf '%s\n' "$out" | tail -20 | sed 's/^/       /'
    fail=$((fail + 1))
  fi
}

run cargo fmt --all -- --check
run cargo check --locked
run cargo clippy -p litedbmodel_runtime --features livedb --all-targets -- -D warnings
run cargo clippy -p livedb_runner --features livedb --all-targets -- -D warnings
run cargo fmt --manifest-path orm_bench_common/Cargo.toml --all -- --check
run cargo clippy --manifest-path orm_bench_common/Cargo.toml --all-targets -- -D warnings
run cargo fmt --manifest-path orm_bench/Cargo.toml --all -- --check
run cargo clippy --manifest-path orm_bench/Cargo.toml --features livedb --all-targets -- -D warnings
run cargo fmt --manifest-path orm_bench_sdk/Cargo.toml --all -- --check
run cargo clippy --manifest-path orm_bench_sdk/Cargo.toml --features livedb --all-targets -- -D warnings

[ "$fail" -eq 0 ] || { echo "✗ $fail rust lint command(s) failed."; exit 1; }
echo "✓ all 10 rust fmt/clippy commands clean (5 crates)"
