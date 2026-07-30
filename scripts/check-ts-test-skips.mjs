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
 *   - the FILES come from the TREE, by globbing {@link INCLUDE} — this gate's OWN statement of what the
 *     suite is, required to EQUAL `vitest.config.ts`'s `include` but never read from it. Deliberately
 *     the filesystem and NOT anything vitest reports — not
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
 * NOT done here, and it falls GREEN: PHASE 2 — re-running the live legs against a database that is not
 * there, the way the go, python, php and rust gates do. Measured on this tree, `vitest run
 * test/integration` against `127.0.0.1:1`: 66 failed, 291 skipped and **112 PASSED**. A flat "no live
 * test may pass without a server" rule is therefore not writable yet, because those 112 are three
 * different things:
 *
 *     Sqlite / SkipPattern / ReadmeConformance / MiddlewareHooks   legitimately OFFLINE — in-memory
 *       (31 + 9 + 23 + 15)                                        SQLite or pure wiring assertions,
 *                                                                 wrongly listed in LIVE_FILES below
 *     MultiDB 5 of 12, Postgres 1 of 41                           offline assertions inside a live
 *                                                                 file (class structure, an error path)
 *     Mysql.test.ts, ALL 28                                       VACUOUS: `isMysqlAvailable()` fails
 *                                                                 and every test then does
 *                                                                 `if (!mysqlAvailable) return;`
 *
 * The third is a real defect of the same class as #219 — a leg that reports PASS having executed
 * nothing, which no skip budget can see because it does not skip. Fixing it changes what those tests
 * MEAN (they must fail when MySQL is absent, as go's `require_live_db` panics), so it is the owner's
 * call, and phase 2 for TypeScript waits on it: until then this gate cannot tell that leg from one that
 * queried a database.
 */
import { readFileSync, globSync, mkdtempSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertGatesOpen, runOwned, mustHaveStarted, exitProblem, report } from './run-gate.mjs';
import { GATES_ENV } from './livedb-gates.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/**
 * What the suite IS, stated here and glob-matched against the filesystem.
 *
 * Deliberately this gate's OWN statement, not a value shared with `vitest.config.ts`. Sharing it looked
 * like removing a duplicate and was a net loss of detection: with one constant, narrowing it in one
 * place narrowed the run AND the check together. Measured — narrowing the shared constant to
 * `test/{unit,integration}/**` left `test/scp` (17 files) and `test/parity` (2) out of the run with the
 * gate reporting "13 of the 13 test files the tree holds" and only the LIVE_FILES clause complaining,
 * while the same narrowing applied to vitest.config.ts alone was `❌ 38 test file(s) the tree holds
 * reported NO test`. Two statements that must AGREE is the mechanism; one statement is a single point
 * of failure.
 *
 * Agreement in the other direction is asserted below: a config `include` WIDER than this would run
 * files this gate never asks about.
 */
const INCLUDE = 'test/**/*.test.ts';

/**
 * `vitest.config.ts`'s own `include`, read as text — the only thing here that reads that file, and only
 * to require it to be EXACTLY {@link INCLUDE}. Not an enumeration: if the pattern cannot be found the
 * gate is red, and if it differs the gate is red, so the two statements cannot drift in either
 * direction.
 */
const CONFIG_INCLUDE = /^\s*include:\s*\[([^\]]*)\]/m;

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

const configText = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
const configInclude = CONFIG_INCLUDE.exec(configText)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
if (configInclude !== INCLUDE) {
  console.error(
    `\n❌ vitest.config.ts's \`include\` is ${configInclude === undefined ? 'not where this gate looks for it' : JSON.stringify(configInclude)}, and this gate requires exactly ${JSON.stringify(INCLUDE)}.\n` +
      `      The two are stated separately on purpose — this gate globs its own pattern against the\n` +
      `      filesystem, so a narrowed config is caught by files reporting no test. They must still\n` +
      `      AGREE: a config that runs MORE than this pattern runs files nothing here asks about.`,
  );
  process.exit(1);
}

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
    `   NOT done, and it falls GREEN: phase 2. Measured against 127.0.0.1:1, 112 tests under\n` +
    `   test/integration PASS with no server — most legitimately (in-memory SQLite, wiring assertions),\n` +
    `   but all 28 in Mysql.test.ts VACUOUSLY: the availability probe fails and every test returns early.\n` +
    `   Until that leg fails instead, no phase-2 rule here can tell it from one that queried a database.`,
);
