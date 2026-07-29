#!/usr/bin/env node
/**
 * The Go suite's RUN GATE (#219) — the running counterpart of `check-reachable-test-gates.mjs`.
 *
 * That script is static: it proves a `LITEDBMODEL_*` gate is declared and that a workflow runs a
 * command that loads the declaration. It cannot prove the gate was OPEN where the suite actually
 * ran. `go test` reports a skipped test as a success, so a live-DB leg that skips itself — the
 * environment variable unset, the docker stack down, a `t.Skip` added later — is indistinguishable
 * from one that ran and passed. Sixteen go live tests skipping is a green suite that executed none
 * of them, which is how the #215 regression (a named-DB transaction opening on the WRONG database)
 * reached a commit: the checklist ran `go test ./...` with the gate closed.
 *
 * So this asserts the gates are open in its OWN environment, then RUNS the suite and checks what
 * came back against what the tree DECLARES:
 *
 *     npm run go:test
 *
 * It owns the `go test` process rather than reading a pipe, because a pipe loses go's exit code
 * unless the caller remembers `set -o pipefail` — and a gate whose redness depends on the shell it
 * was invoked from is the same class of hole it exists to close.
 *
 * `-count=1` is not a detail. Go's test cache REPLAYS a previous run's output with the test binary
 * never started, and its key is the source and the environment — not whether the database these
 * tests need is still up. Measured on a package whose only test dials a service: service up →
 * `ok 0.506s`; service killed → `ok (cached)`, exit 0; with `-count=1` → `connection refused`, exit
 * 1. Without it this script printed `every go test ran (122 passed)` in 0.737s having started
 * nothing — so bringing the docker stack down and re-running the checklist produced a green go leg,
 * which is #219 itself one level up.
 *
 * Counting is not enough either, because a suite that SHRANK reports no skips. Measured: excluding
 * one live file with a build tag gave `112 passed, 0 skipped` ✅ exit 0, and an ambient
 * `GOFLAGS=-run=TestTxIsolation` gave `2 passed` ✅ exit 0 — the file dropped was the one holding
 * `TestPhaseCRoutingTxPinPrecedenceLive`, the test that caught #215. So the run is checked against
 * the source tree: every top-level `func Test*` under `go/` must report a verdict. That is
 * self-maintaining (a new test needs no edit here, it is simply required from the moment it exists)
 * and it catches a build tag, a `-run` filter and a package left out of the build.
 *
 * What a source scan structurally CANNOT catch is a test that has been DELETED — it is missing from
 * the scan too. That is what `LIVE_TESTS` below is for, and only the live-DB legs are listed: a
 * whole-suite inventory would have to be edited every time anyone adds a test, and a count floor is
 * defeated by deleting one test and adding another. Its sibling gate does not cover this either —
 * all four live go files read the SAME `LITEDBMODEL_TX_ISOLATION`, so deleting one leaves
 * `check-reachable-test-gates.mjs`'s dead-declaration clause green.
 *
 * All of that checks the OUTCOME. It did not check the PRECONDITION the outcome is read against —
 * that the gates were open — and so the outcome could be produced without it. Measured: replacing
 * each of the sixteen live legs' `t.Skip(...)` with a bare `return` gave `122 passed, 0 failed,
 * 0 skipped` and the full green line, with the gates CLOSED and no database touched. A skip is one
 * spelling of "this leg did not run" and the budget knows only that one. So the gates are now
 * asserted against `livedb-gates.env` BEFORE `go test` is started, which is independent of how a
 * leg spells its bail-out. The residual hole is stated where it is checked, below.
 *
 * It is red when any of the following holds, and prints its green line only when none does:
 *
 *   - a gate `livedb-gates.env` declares is not open in this process — checked before anything runs.
 *   - `go test` could not be started at all, or was killed by a signal.
 *   - a package that FAILED TO BUILD. `go test -json` reports these as `build-output`/`build-fail`
 *     events keyed by `ImportPath` (NOT `Package`) and writes nothing to stderr, so a checker that
 *     only reads test-level events prints a full, healthy-looking count for the packages that did
 *     compile and calls it green. That is exactly what this script did when it was first added.
 *   - a package-level `fail`. A package fails with no failing test of its own when it does not
 *     build, when it panics, or when its `TestMain` errors; the test counts never show it.
 *   - a failed test, or more skipped tests than the budget below — each one NAMED.
 *   - a test the tree declares that reported NO verdict — it did not run.
 *   - a verdict for a top-level test the tree does not declare. The scan is then wrong, and a rule
 *     built on a wrong scan passes vacuously; that must be loud, not silent.
 *   - `LIVE_TESTS` disagreeing with the tree in EITHER direction: a listed leg gone (deleted or
 *     renamed), or a new live leg not listed (so it would go unprotected).
 *   - no test reporting a verdict at all: the suite never ran.
 *   - `go test` exiting non-zero for a reason none of the above explains, or putting anything on
 *     stdout that is not a `-json` event. Unmodelled ⇒ red, never green.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATES_ENV, readGateDeclarations } from './livedb-gates.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GO_DIR = join(ROOT, 'go');

/**
 * How many go tests may skip. ZERO: every live-DB leg is gated on `LITEDBMODEL_TX_ISOLATION`, which
 * `livedb-gates.env` declares and CI opens before the go step — so with the gates asserted open
 * below and the stack up, nothing has a reason to skip. Raising this is a decision about coverage,
 * not a formality: name the tests and why.
 */
const SKIP_BUDGET = 0;

/**
 * The live-DB legs, by name — the tests that only mean anything with a real PG/MySQL behind them,
 * and the ones whose disappearance is invisible: `go test` cannot miss a test that is not there.
 *
 * Derived, not guessed: these are exactly the top-level tests declared in a `go/**\/*_test.go` that
 * reads a `LITEDBMODEL_*` gate, and exactly the sixteen that skipped when the gates were closed
 * (106 passed / 16 skipped → 122 / 0 with them open). The check below is bidirectional against that
 * same derivation, so adding a live leg without listing it here is red too.
 *
 * Removing a name is a decision about coverage, not a formality: say which test and why.
 */
const LIVE_TESTS = [
  'TestPhaseCConfigCharsetResetOnReleaseLiveMySQL',
  'TestPhaseCConfigMaxPoolSoleCapLivePG',
  'TestPhaseCConfigQueryTimeoutLiveMySQL',
  'TestPhaseCConfigQueryTimeoutLivePG',
  'TestPhaseCConfigSearchPathResetOnReleaseLivePG',
  'TestPhaseCRoutingMultiDBLive',
  'TestPhaseCRoutingReaderWriterSplitLive',
  'TestPhaseCRoutingTxPinPrecedenceLive',
  'TestPhaseCRoutingWithWriterLive',
  'TestPhaseCRoutingWriterStickyLive',
  'TestPhaseDLiveTxControlVisiblePG',
  'TestPhaseDLiveTxControlVisibleRollbackPG',
  'TestTxBoundaryMysql',
  'TestTxBoundaryPostgres',
  'TestTxIsolationMysql',
  'TestTxIsolationPostgres',
];

/** Every `*_test.go` under `go/`. Build constraints are deliberately NOT honoured: a test the build
 *  excludes is a test that did not run, which is the thing being detected. */
function goTestFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e === 'vendor' || e === 'testdata' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...goTestFiles(p));
    else if (e.endsWith('_test.go')) out.push(p);
  }
  return out;
}

const MODULE = /^module\s+(\S+)/m.exec(readFileSync(join(GO_DIR, 'go.mod'), 'utf8'))[1];
/** `<import path> <TestName>` — the same label `go test -json` events carry → the declaring file. */
const declared = new Map();
/** Live legs as the TREE has them now, for the bidirectional check against `LIVE_TESTS`. */
const liveInTree = new Set();
for (const file of goTestFiles(GO_DIR)) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(GO_DIR, file);
  const pkg = dirname(rel) === '.' ? MODULE : `${MODULE}/${dirname(rel)}`;
  const isLive = /LITEDBMODEL_[A-Z0-9_]+/.test(src);
  for (const [, name] of src.matchAll(/^func (Test[A-Za-z0-9_]*)\s*\(/gm)) {
    if (name === 'TestMain') continue; // the package entry point, not a test — it reports no verdict
    declared.set(`${pkg} ${name}`, relative(ROOT, file));
    if (isLive) liveInTree.add(name);
  }
}

/**
 * The precondition every other check here is read against: the gates are OPEN. Asserted BEFORE the
 * suite is started, because a run with them shut has nothing to say and should not happen.
 *
 * `SKIP_BUDGET = 0` is only meaningful when they are open — with them closed the honest result IS
 * sixteen skips. Checking the outcome alone let the outcome be manufactured: with each live leg's
 * `t.Skip(...)` replaced by a bare `return`, this printed `122 passed, 0 failed, 0 skipped` and a
 * full green line with the gates closed and no database touched. The budget only knows one spelling
 * of "did not run"; the environment the legs read is the same for all of them, so it is checked
 * directly instead.
 *
 * ALL of `livedb-gates.env` is required, not just the gate go happens to read: the file is the SSoT
 * for "the live legs are open", CI opens it in one step for every language, and an environment
 * holding only some of it is not the one CI runs. VALUES are compared, not just presence —
 * `LITEDBMODEL_SKIP_LIVE` has INVERTED polarity and is pinned to `0`, so merely being "set" is
 * satisfied by the value that CLOSES it.
 *
 * What this does NOT prove, and it falls GREEN: with the gates open, a live leg whose body has been
 * emptied still passes. This establishes that the legs were enabled and that every declared test
 * reported a verdict from an uncached run — not that a given test dialled the database.
 */
const gateDeclarations = readGateDeclarations();
const shut = [...gateDeclarations].filter(([name, value]) => process.env[name] !== value);
if (shut.length > 0) {
  console.error(
    `\n❌ ${shut.length} of the ${gateDeclarations.size} live-DB gates \`${GATES_ENV}\` declares are not open in this ` +
      `process, so the go suite would run with its live-DB legs disabled — and a leg that does not run reports nothing ` +
      `this check could catch:\n` +
      shut
        .map(([n, v]) => `      ${n}: declared ${JSON.stringify(v)}, this environment has ${process.env[n] === undefined ? '(unset)' : JSON.stringify(process.env[n])}`)
        .join('\n') +
      `\n\n      npm run docker:livedb:up && set -a && . ./${GATES_ENV} && set +a\n` +
      `      (CI opens them in conformance.yml, step "Open the live-DB test gates".)`,
  );
  process.exit(1);
}

const go = spawn('go', ['test', './...', '-json', '-count=1'], {
  cwd: GO_DIR,
  stdio: ['ignore', 'pipe', 'inherit'],
});
let spawnError = null;
go.on('error', (err) => {
  spawnError = err;
});
const exited = new Promise((resolve) => go.on('close', (code, signal) => resolve({ code, signal })));

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
  // `Test` is kept apart from `label` because a subtest is spelled `Parent/Sub` while the import
  // path in `label` is full of slashes too — only the tree's top-level `func Test*` can be matched.
  if (!seen.has(k)) seen.set(k, { kind, label, test: e.Test ?? null, action: null, output: [] });
  const s = seen.get(k);
  if (VERDICT.has(e.Action)) s.action = e.Action;
  else if (e.Output !== undefined) s.output.push(e.Output);
}

const { code: goExit, signal: goSignal } = await exited;
if (spawnError) {
  console.error(`\n❌ could not run \`go test\`: ${spawnError.message}`);
  process.exit(1);
}

const of = (kind, action) => [...seen.values()].filter((s) => s.kind === kind && s.action === action);
const [passed, failed, skipped] = [of('test', 'pass'), of('test', 'fail'), of('test', 'skip')];
const [unbuilt, failedPkgs] = [of('build', 'build-fail'), of('package', 'fail')];
const named = (rows) => rows.map((r) => `      ${r.label}`).join('\n');
const list = (names) => names.map((n) => `      ${n}`).join('\n');

// What the run covered, against what the tree declares. Verdicts are taken at top level only —
// subtests are reported as `Parent/Sub` and the tree declares no `func` for them.
const reported = new Set(
  [...seen.values()].filter((s) => s.kind === 'test' && s.action && !s.test.includes('/')).map((s) => s.label),
);
const neverRan = [...declared.keys()].filter((l) => !reported.has(l)).sort();
const unscanned = [...reported].filter((l) => !declared.has(l)).sort();
const liveGone = LIVE_TESTS.filter((n) => !liveInTree.has(n));
const liveUnlisted = [...liveInTree].filter((n) => !LIVE_TESTS.includes(n)).sort();

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
      `\n\n      The gates were open, so this is not a closed gate — bring the stack up and re-run:\n` +
      `      npm run docker:livedb:up`,
  );
}
if (neverRan.length > 0) {
  problems.push(
    `${neverRan.length} go test(s) the tree DECLARES reported no verdict — they did not run, and a suite that shrank reports no skips:\n` +
      neverRan.map((l) => `      ${l}   (${declared.get(l)})`).join('\n') +
      `\n\n      A build tag on the file, a \`-run\` filter (check GOFLAGS), or a package \`./...\`\n` +
      `      no longer reaches all look exactly like this.`,
  );
}
if (unscanned.length > 0) {
  problems.push(
    `${unscanned.length} top-level go test(s) reported a verdict that this script's scan of go/**/*_test.go never found. The scan is wrong — and the check above is only as strong as the scan, so a broken scan passes it vacuously:\n` +
      list(unscanned),
  );
}
if (liveGone.length > 0) {
  problems.push(
    `${liveGone.length} test(s) listed in LIVE_TESTS are no longer live legs in the tree — deleted, renamed, or no longer in a file that reads a LITEDBMODEL_* gate:\n` +
      list(liveGone) +
      `\n\n      Nothing else notices this. A source scan cannot miss a test that is not there, and\n` +
      `      all four live files read the SAME LITEDBMODEL_TX_ISOLATION, so the declaration in\n` +
      `      ${GATES_ENV} stays alive and check-reachable-test-gates.mjs stays green.`,
  );
}
if (liveUnlisted.length > 0) {
  problems.push(
    `${liveUnlisted.length} live-DB test(s) exist under go/ but are not in LIVE_TESTS, so deleting them would be silent. List them:\n` +
      list(liveUnlisted),
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
if (goSignal) {
  problems.push(
    `\`go test\` was KILLED by ${goSignal}. Its stream stops where the process died, so everything after that point was never reported — a partial stream is not a green run.`,
  );
} else if (goExit !== 0 && problems.length === 0) {
  problems.push(
    `\`go test\` exited ${goExit} while every event in its stream reported success — something failed that this check does not model. Do not read that as green.`,
  );
}

if (problems.length > 0) {
  console.error('\n' + problems.map((p) => `❌ ${p}`).join('\n\n'));
  process.exit(1);
}
console.log(
  `✅ the ${gateDeclarations.size} live-DB gates ${GATES_ENV} declares were OPEN in this process before the suite started; ` +
    `every go package built; each of the ${declared.size} tests the tree declares reported a verdict from an UNCACHED ` +
    `(-count=1) run, and every verdict was a pass (${passed.length} incl. subtests, ${skipped.length} skipped, ` +
    `budget ${SKIP_BUDGET}); all ${LIVE_TESTS.length} live-DB legs listed in LIVE_TESTS are still present in the tree`,
);
