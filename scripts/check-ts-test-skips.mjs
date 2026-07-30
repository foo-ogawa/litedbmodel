#!/usr/bin/env node
/**
 * The TypeScript suite's RUN GATE (#220) — the running counterpart of `check-reachable-test-gates.mjs`,
 * built on the same skeleton as the go one (`run-gate.mjs`).
 *
 *     npm run ts:test
 *
 * Nothing looked at vitest's skipped count. Every one of the nineteen files under `test/integration`
 * is wrapped in `describe.skipIf(skipIntegrationTests)` — `SKIP_INTEGRATION_TESTS === '1'`
 * (`test/helpers/setup.ts:13`) — an INVERTED switch, like php's `LITEDBMODEL_SKIP_LIVE`, that
 * `livedb-gates.env` does not declare because it is not a `LITEDBMODEL_*` name. Measured on this tree
 * with one `it.skip` and one `it.todo` added to a unit file:
 *
 *     numTotalTests 83   pending 1   todo 1   success TRUE
 *
 * `success` is true with tests skipped, so an inherited `SKIP_INTEGRATION_TESTS=1` would take the
 * whole live-PG/MySQL half of the TS suite out of the run and report green. The budget below is what
 * closes that: the gate does not need to know the variable's name, only that nothing skipped.
 *
 * The run is then checked against what the TREE holds:
 *
 *   - the OUTCOMES come from `--reporter=json`, vitest's own machine-readable report: one entry per
 *     test FILE, each with its assertion results and their statuses.
 *   - the FILES come from the TREE, by globbing the pattern `vitest.config.ts` and this share
 *     (`scripts/test-include.mjs`). Deliberately the filesystem and NOT anything vitest reports — not
 *     `vitest list`, not its module graph — because a narrowed `include` narrows what vitest would say
 *     exactly as much as it narrows the run, and the run cannot report a file it was never told about:
 *
 *         a path argument            `vitest run test/unit` — leaving test/scp, test/parity and
 *                                    test/integration (1138 tests) out of CI with the job green
 *                                    (#168). That command was `test:ci` in package.json, still called
 *                                    by four workflows including a pull_request one, until #220
 *                                    deleted the alias and the steps; clause D of
 *                                    check-reachable-test-gates.mjs is what keeps it deleted
 *         a narrowed `include`       the same, one level down in the config
 *         `--testNamePattern`        every file still reported, but with no tests in it — which is why
 *                                    a file must report at least ONE test, not merely appear
 *         a file that fails to LOAD  measured: an import error puts the file in the report with zero
 *                                    assertion results, `numTotalTests 0`, `success false`
 *
 * A count FLOOR would be no use here (delete one test, add another) and a whole-suite inventory of
 * test names would need editing on every commit. Per FILE is the granularity that is both stable and
 * enforceable — plus {@link LIVE_FILES}, an inventory of just the live-DB files, because a source
 * scan cannot miss a file that has been DELETED.
 *
 * It is red when any of the following holds, and prints its green line only when none does:
 *
 *   - a gate `livedb-gates.env` declares is not open in this process — checked before anything runs.
 *     The TS suite reads none of them by name (it has its own inverted switch), but they are the SSoT
 *     for "the live stack is up", CI opens them in one step for every language, and `npm test` here
 *     runs the integration suite against the same real PG + MySQL;
 *   - vitest could not be started, or was killed by a signal;
 *   - vitest wrote no report at all;
 *   - a failing test, each NAMED;
 *   - a skipped or todo test — budget {@link SKIP_BUDGET};
 *   - a test file in the tree that reported NO test: it did not run;
 *   - a file in the report that is not in the tree — the glob is then wrong, and a rule built on a
 *     wrong glob passes vacuously;
 *   - `LIVE_FILES` disagreeing with the tree in EITHER direction;
 *   - no test at all: the suite never ran;
 *   - vitest exiting non-zero for a reason none of the above explains. Unmodelled ⇒ red.
 *
 * Not proven, and it falls GREEN: that a live leg TOUCHED a database. An outcome cannot tell a leg
 * that queried PG from one whose body is empty — both pass. The go and python gates re-run their live legs against an
 * unreachable database to close that; TypeScript has no equivalent yet.
 */
import { readFileSync, globSync, mkdtempSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertGatesOpen, runOwned, mustHaveStarted, exitProblem, report } from './run-gate.mjs';
import { GATES_ENV } from './livedb-gates.mjs';
import { TEST_INCLUDE } from './test-include.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/**
 * The suite's file pattern, from the module `vitest.config.ts` reads it from too — so the two cannot
 * drift — applied HERE to the filesystem rather than to anything vitest says. That is what makes it
 * independent: a narrowed `include`, a path argument or a `--testNamePattern` narrows vitest's answer
 * as much as it narrows the run, and leaves this glob unchanged, which is red.
 */
const INCLUDE = TEST_INCLUDE;

/**
 * How many vitest tests may skip. ZERO: the only conditional in the suite is
 * `describe.skipIf(skipIntegrationTests)` on the live-DB files, and CI runs them with the stack up.
 * `it.todo` counts against this too — a todo is a test that does not run. Raising this is a decision
 * about coverage, not a formality: name the tests and why.
 */
const SKIP_BUDGET = 0;

/**
 * The live-DB test FILES — the ones that only mean anything with a real PG/MySQL behind them, and the
 * ones whose disappearance is invisible: a glob cannot miss a file that is not there.
 *
 * Derived, not guessed: exactly the files under `test/integration`, every one of which gates itself on
 * `SKIP_INTEGRATION_TESTS` and connects to `TEST_DB_*`/`TEST_MYSQL_*`. Bidirectional, so adding a
 * live-DB file without listing it here is red too.
 *
 * Removing a name is a decision about coverage, not a formality: say which file and why.
 */
const LIVE_FILES = [
  'test/integration/ConnectionRouting.test.ts',
  'test/integration/EmitterEndToEnd.test.ts',
  'test/integration/LazyRelation.test.ts',
  'test/integration/MiddlewareHooks.test.ts',
  'test/integration/MultiDB.test.ts',
  'test/integration/Mysql.test.ts',
  'test/integration/PhaseF2ReadContract.test.ts',
  'test/integration/PkeyResult.test.ts',
  'test/integration/Postgres.test.ts',
  'test/integration/ReadmeConformance.test.ts',
  'test/integration/RelationNestedGraph.test.ts',
  'test/integration/ScpDialect.test.ts',
  'test/integration/ScpMiddleware.test.ts',
  'test/integration/SkipPattern.test.ts',
  'test/integration/Sqlite.test.ts',
  'test/integration/TxBoundary.test.ts',
  'test/integration/TxCompleteness.test.ts',
  'test/integration/TxIsolation.test.ts',
  'test/integration/UuidPk.test.ts',
];

/** Every test file the tree holds, as a repository-relative POSIX path. */
const inTree = new Set(globSync(INCLUDE, { cwd: ROOT }).map((p) => p.split(sep).join('/')).sort());

assertGatesOpen('TypeScript');

const out = join(mkdtempSync(join(tmpdir(), 'litedbmodel-vitest-')), 'vitest.json');
const label = 'vitest run';
// The `default` reporter rides along so a CI log has the progress of a suite that takes minutes;
// `--outputFile.json` is how vitest routes a file for ONE of several reporters.
const run = mustHaveStarted(
  await runOwned(join(ROOT, 'node_modules', '.bin', 'vitest'), ['run', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`], {
    cwd: ROOT,
    stdout: 'inherit',
  }),
  label,
);

const problems = [];
if (!existsSync(out)) {
  problems.push(`vitest wrote no json report — the run never got as far as collecting. (exit ${run.exit})`);
  report(problems, '');
}

const json = JSON.parse(readFileSync(out, 'utf8'));
/** file (repository-relative) → its assertion results. */
const reported = new Map(
  json.testResults.map((f) => [relative(ROOT, f.name).split(sep).join('/'), f.assertionResults ?? []]),
);
const results = [...reported].flatMap(([file, rs]) => rs.map((r) => ({ file, ...r })));
const withStatus = (...statuses) => results.filter((r) => statuses.includes(r.status));
const [failed, skipped] = [withStatus('failed'), withStatus('skipped', 'pending', 'todo')];
const named = (rows) => rows.map((r) => `      ${r.file} › ${r.fullName || r.title}`).join('\n');
const list = (names) => names.map((n) => `      ${n}`).join('\n');

const silent = [...inTree].filter((f) => (reported.get(f) ?? []).length === 0);
const unglobbed = [...reported.keys()].filter((f) => !inTree.has(f)).sort();
const liveGone = LIVE_FILES.filter((f) => !inTree.has(f));
const liveUnlisted = [...inTree].filter((f) => f.startsWith('test/integration/') && !LIVE_FILES.includes(f));

console.log(
  `vitest: ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped/todo ` +
    `(${reported.size} of the ${inTree.size} test files the tree holds reported)`,
);

if (failed.length > 0) problems.push(`${failed.length} vitest test(s) FAILED:\n` + named(failed));
if (skipped.length > SKIP_BUDGET) {
  problems.push(
    `${skipped.length} vitest test(s) SKIPPED or TODO, budget ${SKIP_BUDGET}. A skipped test is not a passing test, and vitest reports \`success: true\` beside them:\n` +
      named(skipped) +
      `\n\n      SKIP_INTEGRATION_TESTS=1 in the environment takes the whole live-DB half of this suite\n` +
      `      out of the run and looks exactly like this (test/helpers/setup.ts:13). Bring the stack up\n` +
      `      and unset it:  npm run docker:livedb:up`,
  );
}
if (silent.length > 0) {
  problems.push(
    `${silent.length} test file(s) the tree holds reported NO test — they did not run, and a suite that shrank reports no skips:\n` +
      list(silent) +
      `\n\n      A path argument (\`vitest run test/unit\`), a narrowed \`include\` in vitest.config.ts, a\n` +
      `      \`--testNamePattern\` and a file that fails to LOAD all look exactly like this.`,
  );
}
if (unglobbed.length > 0) {
  problems.push(
    `${unglobbed.length} file(s) in vitest's report are not matched by \`${INCLUDE}\`. The glob is wrong — and the check above is only as strong as the glob, so a broken glob passes it vacuously:\n` +
      list(unglobbed),
  );
}
if (liveGone.length > 0) {
  problems.push(
    `${liveGone.length} file(s) listed in LIVE_FILES are no longer in the tree — deleted or renamed:\n` +
      list(liveGone) +
      `\n\n      Nothing else notices this: a glob cannot miss a file that is not there, and the other\n` +
      `      eighteen still gate on the same SKIP_INTEGRATION_TESTS.`,
  );
}
if (liveUnlisted.length > 0) {
  problems.push(
    `${liveUnlisted.length} live-DB test file(s) exist under test/integration but are not in LIVE_FILES, so deleting them would be silent. List them:\n` +
      list(liveUnlisted),
  );
}
if (results.length === 0) problems.push('vitest reported no tests at all — the suite never ran.');
exitProblem(run, label, problems);

report(
  problems,
  `✅ the live-DB gates ${GATES_ENV} declares were OPEN in this process before vitest started; every one of the\n` +
    `   ${inTree.size} test files \`${INCLUDE}\` matches reported at least one test in vitest's own --reporter=json report,\n` +
    `   and all ${results.length} of them passed (${skipped.length} skipped or todo, budget ${SKIP_BUDGET}) — so no inherited\n` +
    `   SKIP_INTEGRATION_TESTS=1 took the live-DB half out of the run, which vitest itself would have called\n` +
    `   \`success: true\`. All ${LIVE_FILES.length} live-DB files listed in LIVE_FILES are still present in the tree.\n` +
    `   Not proven, and it falls GREEN: that a live leg TOUCHED a database. An emptied body passes an\n` +
    `   outcome check the same way a real query does — the go and python gates re-run theirs against an unreachable\n` +
    `   server to close that, and TypeScript has no equivalent yet.`,
);
