#!/usr/bin/env node
/**
 * The Go suite's RUN GATE (#219) — the running counterpart of `check-reachable-test-gates.mjs`.
 *
 * That script is static: it proves a `LITEDBMODEL_*` gate is declared and that some workflow loads
 * the declaration. It cannot prove the gate actually OPENED. `go test` reports a skipped test as a
 * success, so a live-DB leg that skips itself — the environment variable unset, the docker stack
 * down, a `t.Skip` added later — is indistinguishable from one that ran and passed. Sixteen go live
 * tests skipping is a green suite that executed none of them, which is how the #215 regression
 * (a named-DB transaction opening on the WRONG database) reached a commit: the checklist ran
 * `go test ./...` with the gate closed.
 *
 * So this RUNS the suite and counts what came back:
 *
 *     npm run go:test
 *
 * It owns the `go test` process rather than reading a pipe, because a pipe loses go's exit code
 * unless the caller remembers `set -o pipefail` — and a gate whose redness depends on the shell it
 * was invoked from is the same class of hole it exists to close.
 *
 * It is red when any of the following holds, and prints its green line only when none does:
 *
 *   - `go test` could not be started at all.
 *   - a package that FAILED TO BUILD. `go test -json` reports these as `build-output`/`build-fail`
 *     events keyed by `ImportPath` (NOT `Package`) and writes nothing to stderr, so a checker that
 *     only reads test-level events prints a full, healthy-looking count for the packages that did
 *     compile and calls it green. That is exactly what this script did when it was first added.
 *   - a package-level `fail`. A package fails with no failing test of its own when it does not
 *     build, when it panics, or when its `TestMain` errors; the test counts never show it.
 *   - a failed test, or more skipped tests than the budget below — each one NAMED.
 *   - no test reporting a verdict at all: the suite never ran.
 *   - `go test` exiting non-zero for a reason none of the above explains, or putting anything on
 *     stdout that is not a `-json` event. Unmodelled ⇒ red, never green.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * How many go tests may skip. ZERO: every live-DB leg is gated on `LITEDBMODEL_TX_ISOLATION`, which
 * `livedb-gates.env` declares and CI opens before the go step — so with the stack up nothing has a
 * reason to skip. Raising this is a decision about coverage, not a formality: name the tests and why.
 */
const SKIP_BUDGET = 0;

const go = spawn('go', ['test', './...', '-json'], {
  cwd: join(ROOT, 'go'),
  stdio: ['ignore', 'pipe', 'inherit'],
});
let spawnError = null;
go.on('error', (err) => {
  spawnError = err;
});
const exited = new Promise((resolve) => go.on('close', resolve));

/** Verdict actions. `start`/`run` carry none; everything else on an event is output. */
const VERDICT = new Set(['pass', 'fail', 'skip', 'build-fail']);
/** `kind\0label` → { kind, label, action, output[] } — one entry per build unit, package and test. */
const seen = new Map();
/** Lines that are not events. `go test -json` puts ONLY events on stdout; anything else is a hole. */
const foreign = [];

for await (const line of createInterface({ input: go.stdout })) {
  if (!line) continue;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    foreign.push(line);
    continue;
  }
  if (typeof e !== 'object' || e === null || !e.Action) {
    foreign.push(line);
    continue;
  }
  // A build event names an ImportPath and no Package; a test event names both; a package event
  // names only the Package. All three matter — dropping the first two is how a build failure read
  // as a clean green run.
  const [kind, label] = e.ImportPath
    ? ['build', e.ImportPath]
    : e.Test
      ? ['test', `${e.Package} ${e.Test}`]
      : ['package', e.Package];
  const k = `${kind}\0${label}`;
  if (!seen.has(k)) seen.set(k, { kind, label, action: null, output: [] });
  const s = seen.get(k);
  if (VERDICT.has(e.Action)) s.action = e.Action;
  else if (e.Output !== undefined) s.output.push(e.Output);
}

const goExit = await exited;
if (spawnError) {
  console.error(`\n❌ could not run \`go test\`: ${spawnError.message}`);
  process.exit(1);
}

const of = (kind, action) => [...seen.values()].filter((s) => s.kind === kind && s.action === action);
const [passed, failed, skipped] = [of('test', 'pass'), of('test', 'fail'), of('test', 'skip')];
const [unbuilt, failedPkgs] = [of('build', 'build-fail'), of('package', 'fail')];
const named = (rows) => rows.map((r) => `      ${r.label}`).join('\n');

// Replayed in the order `go test` prints them: build errors, then the failing tests, then the
// per-package FAIL summaries.
for (const r of [...unbuilt, ...failed, ...failedPkgs]) process.stdout.write(r.output.join(''));
console.log(`go test: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);

const problems = [];
if (unbuilt.length > 0) {
  problems.push(
    `${unbuilt.length} go package(s) FAILED TO BUILD — a package that does not compile runs NO tests, so the counts above are only of the packages that did:\n` +
      named(unbuilt),
  );
}
if (failedPkgs.length > 0) {
  problems.push(
    `${failedPkgs.length} go package(s) FAILED:\n` +
      named(failedPkgs) +
      `\n\n      (a package can fail with no failing test of its own — a build failure, a panic, a\n` +
      `      TestMain error — which is why this is counted apart from the tests.)`,
  );
}
if (failed.length > 0) problems.push(`${failed.length} go test(s) FAILED:\n` + named(failed));
if (skipped.length > SKIP_BUDGET) {
  problems.push(
    `${skipped.length} go test(s) SKIPPED, budget ${SKIP_BUDGET}. A skipped test is not a passing test:\n` +
      named(skipped) +
      `\n\n      Open the live-DB gates and bring the stack up, then re-run:\n` +
      `      npm run docker:livedb:up && set -a && . ./livedb-gates.env && set +a`,
  );
}
if (passed.length + failed.length + skipped.length === 0) {
  problems.push('the stream reported no tests at all — the suite never ran.');
}
if (foreign.length > 0) {
  problems.push(
    `\`go test -json\` put ${foreign.length} line(s) on stdout that are not events. This checker cannot account for them, so it will not call the run green:\n` +
      foreign.map((l) => `      ${l}`).join('\n'),
  );
}
if (goExit !== 0 && problems.length === 0) {
  problems.push(
    `\`go test\` exited ${goExit} while every event in its stream reported success — something failed that this check does not model. Do not read that as green.`,
  );
}

if (problems.length > 0) {
  console.error('\n' + problems.map((p) => `❌ ${p}`).join('\n\n'));
  process.exit(1);
}
console.log(
  `✅ every go package built and every go test ran (${passed.length} passed, ${skipped.length} skipped, budget ${SKIP_BUDGET})`,
);
