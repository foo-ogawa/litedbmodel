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
 * Then PHASE 2, at the bottom of this file: the live files are run AGAIN against a database that is NOT
 * THERE, and a test that PASSES anyway never dialled one. 423 tests across the 17 live files, none
 * passing except the 38 in OFFLINE_TESTS.
 *
 * #230 stopped this from LYING for `Mysql.test.ts`: it reported all 28 as PASSED with no MySQL —
 * `isMysqlAvailable()` failed and every test then did `if (!mysqlAvailable) return;`, a PASS for a test
 * that executed nothing, indistinguishable in the output from a real run and invisible to a skip budget
 * because it does not skip. Its `beforeAll` now THROWS (fail-closed, as rust's `require_live_db` panics),
 * so those 28 report SKIPPED and no longer PASS without a server. They still do not RUN their bodies
 * against the dead server, though, so — like every hook-guarded file — phase 2 learns nothing about an
 * emptied body there (below); it reads a body only where the test's OWN body dials, e.g. Postgres.
 *
 * Not proven, and it falls GREEN: that a leg asserted anything USEFUL about what it read. A body reduced
 * to a bare connect dials, so it satisfies both phases. Nor does phase 2 learn anything about a file
 * whose HOOKS fail without a server (`PkeyResult`, and every file that skips itself): its tests never
 * run, so none of them can pass — measured, an early `return` planted in one of them changed nothing,
 * while the same `return` in `Postgres.test.ts`, whose tests do run, was caught by name.
 */
import { readFileSync, globSync, mkdtempSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertGatesOpen, runOwned, mustHaveStarted, exitProblem, report, UNREACHABLE } from './run-gate.mjs';
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
  'test/integration/TxBoundary.test.ts',
  'test/integration/TxCompleteness.test.ts',
  'test/integration/TxIsolation.test.ts',
  'test/integration/UuidPk.test.ts',
];

/**
 * Files under test/integration that need NO server, so phase 2 says nothing about them. Measured
 * against 127.0.0.1:1: every test in each PASSES, none fails and none skips — in-memory SQLite
 * (`Sqlite.test.ts`) and middleware-wiring assertions over it (`MiddlewareHooks.test.ts`).
 *
 * Together with LIVE_FILES this partitions the directory, and BOTH directions are checked against the
 * tree below: a new file in test/integration must be classified, and a listed one that is gone is red.
 */
const OFFLINE_FILES = ['test/integration/MiddlewareHooks.test.ts', 'test/integration/Sqlite.test.ts'];

/**
 * The individual tests INSIDE a live file that legitimately pass with no server, and must — the same
 * device php's and python's gates use for their offline corpus checks.
 *
 * Four live files are mixed: `ReadmeConformance` and `SkipPattern` run their SQLite dialect leg
 * in-process while their PG/MySQL legs skip, `MultiDB` asserts class structure that needs no
 * connection, and `Postgres` has one error-path test that throws before dialling. Naming them is what
 * lets the rule for everything else be absolute: a live test that PASSES without a server never
 * dialled one.
 *
 * BIDIRECTIONAL: an entry that does NOT pass against the unreachable server is misclassified (it needs
 * a database, so it must not be excused), and an entry whose test is gone is stale.
 */
const OFFLINE_TESTS = [
  "test/integration/MultiDB.test.ts › createDBBase() Global DBModel isolation should not affect global DBModel writer state",
  "test/integration/MultiDB.test.ts › createDBBase() Independent withWriter() Contexts should have independent inWriterContext() state",
  "test/integration/MultiDB.test.ts › createDBBase() Independent withWriter() Contexts should have nested withWriter work independently",
  "test/integration/MultiDB.test.ts › createDBBase() createDBBase() returns proper class structure should have independent instances",
  "test/integration/MultiDB.test.ts › createDBBase() createDBBase() returns proper class structure should return a class that extends DBModel",
  "test/integration/Postgres.test.ts › DBModel advanced operations Error handling should throw error when reloading without primary key",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §CRUD — createMany returning + updateMany (keyColumns) returning + delete returning",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Column Decorators — @column.date() reads a DATE as a YYYY-MM-DD string; @column.datetime() reads a TIMESTAMP",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Column Decorators — the BARE @column() read contract holds live (string→string, number→number, boolean→boolean, Date column)",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Date Utility Functions — formatLocalDate / formatUTCDate return YYYY-MM-DD",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Middleware — execute middleware sees EVERY SQL statement through the decorator API",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Middleware — method-level find hook with per-request state (getCurrentContext)",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Model Options — order / filter / select defaults are applied by find()",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §OR Conditions and ORDER BY — User.or(...) + { order }",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Query Limits — findHardLimit throws LimitExceededError with limit/actualCount",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Query Limits — per-relation hardLimit override throws; hardLimit:null disables",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Query-Based Models — static QUERY becomes a CTE; find() applies extra conditions",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Quick Start / §CRUD — create/update/delete/find/findOne + returning PkeyResult + findById",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Relations — composite-key belongsTo resolves",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Relations — hasMany / belongsTo / hasOne lazy loading through the decorator API",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Relations — per-parent limit (top-N per group) via the limit option",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §SKIP — update excludes column, createMany applies DEFAULT, updateMany retains existing",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Subquery Conditions — inSubquery / composite / notIn / correlated parentRef / exists / notExists (+documented SQL)",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Transactions — basic / with-return-value / rollbackOnly / retry option",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Transactions — the tx body runs on ONE transactional connection (writes are atomic; a mid-tx failure rolls BOTH back)",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Transparent N+1 Prevention — user.posts inside a loop batch-loads (2 queries, not N+1)",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Type-Safe Conditions — tuple / sql`` operators (>, BETWEEN, LIKE, IN (?), IS NULL) run live",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §Upsert — onConflictIgnore, onConflictUpdate, and composite unique key",
  "test/integration/ReadmeConformance.test.ts › README conformance — sqlite README §findById — single, multiple, and composite PK",
  "test/integration/SkipPattern.test.ts › Array (JSON) Pattern - SQLite should create and retrieve array data stored as JSON",
  "test/integration/SkipPattern.test.ts › Array (JSON) Pattern - SQLite should createMany with array data",
  "test/integration/SkipPattern.test.ts › Array (JSON) Pattern - SQLite should handle empty arrays",
  "test/integration/SkipPattern.test.ts › Array (JSON) Pattern - SQLite should handle null arrays",
  "test/integration/SkipPattern.test.ts › SKIP Pattern - SQLite Single create with SKIP should exclude SKIPped columns in single create (uses DB DEFAULT)",
  "test/integration/SkipPattern.test.ts › SKIP Pattern - SQLite createMany with SKIP (grouped INSERT) should handle different SKIP patterns",
  "test/integration/SkipPattern.test.ts › SKIP Pattern - SQLite updateMany with SKIP should handle multiple columns SKIPped in different rows",
  "test/integration/SkipPattern.test.ts › SKIP Pattern - SQLite updateMany with SKIP should handle null values distinct from SKIP",
  "test/integration/SkipPattern.test.ts › SKIP Pattern - SQLite updateMany with SKIP should retain existing value when column is SKIPped using batch",
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
/**
 * A file under test/integration in NEITHER LIVE_FILES nor OFFLINE_FILES. ONE predicate, because it is
 * one condition: such a file is both unprotected against silent deletion AND unclassified for phase 2,
 * and stating it twice let two messages drift apart while asking the identical question.
 */
const unclassified = [...inTree].filter(
  (f) => f.startsWith('test/integration/') && !LIVE_FILES.includes(f) && !OFFLINE_FILES.includes(f),
);

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
if (unclassified.length > 0) {
  problems.push(
    `${unclassified.length} file(s) under test/integration are in neither LIVE_FILES nor OFFLINE_FILES, so deleting one would be silent AND phase 2 does not know whether it may pass without a server:\n` +
      list(unclassified),
  );
}
const offlineGone = OFFLINE_FILES.filter((f) => !inTree.has(f));
if (offlineGone.length > 0) {
  problems.push(`${offlineGone.length} file(s) listed in OFFLINE_FILES are no longer in the tree — deleted or renamed:\n` + list(offlineGone));
}
if (results.length === 0) problems.push('vitest reported no tests at all — the suite never ran.');
exitProblem(run, label, problems);

// ── PHASE 2: the live legs really DIAL a database ───────────────────────────────────────────────────
//
// Everything above reads the OUTCOME of a run against a live server, and an outcome cannot distinguish a
// leg that queried the database from a leg whose body is empty: both pass. So the live files are run
// again against a database that is NOT THERE, and a test that PASSES anyway never touched a server —
// unless it is named in OFFLINE_TESTS, which then must pass.
//
// #230 removed the FALSE-PASS this used to see: `Mysql.test.ts` reported all 28 as PASSED with no MySQL
// because each test opened with `if (!mysqlAvailable) return;`. Its `beforeAll` now throws, so those
// tests report SKIPPED and no longer pass without a server. But a throwing beforeAll makes them SKIP,
// not run — so phase 2 still cannot tell an emptied body from a real one in Mysql (or any hook-guarded
// file); it catches that only where the test's OWN body dials, e.g. Postgres. See the green line's SCOPE.
if (problems.length === 0) {
  const out2 = join(mkdtempSync(join(tmpdir(), 'litedbmodel-vitest-p2-')), 'vitest.json');
  const p2 = mustHaveStarted(
    await runOwned(
      join(ROOT, 'node_modules', '.bin', 'vitest'),
      ['run', 'test/integration', '--reporter=default', '--reporter=json', `--outputFile.json=${out2}`],
      { cwd: ROOT, stdout: 'inherit', env: UNREACHABLE },
    ),
    `${label} test/integration (unreachable database)`,
  );
  if (!existsSync(out2)) {
    problems.push(`the unreachable-database re-run wrote no json report, so nothing was learned from it. (exit ${p2.exit})`);
  } else {
    const j2 = JSON.parse(readFileSync(out2, 'utf8'));
    /** `<file> › <fullName>` → status, for the live files only. */
    const verdicts = new Map();
    for (const f of j2.testResults) {
      const file = relative(ROOT, f.name).split(sep).join('/');
      if (!LIVE_FILES.includes(file)) continue;
      for (const r of f.assertionResults ?? []) verdicts.set(`${file} › ${r.fullName || r.title}`, r.status);
    }
    const passedWithoutServer = [...verdicts].filter(([k, v]) => v === 'passed' && !OFFLINE_TESTS.includes(k)).map(([k]) => k);
    const misclassified = OFFLINE_TESTS.filter((k) => verdicts.has(k) && verdicts.get(k) !== 'passed');
    const staleOffline = OFFLINE_TESTS.filter((k) => !verdicts.has(k));
    if (passedWithoutServer.length > 0) {
      problems.push(
        `${passedWithoutServer.length} test(s) in a live-DB file PASSED with no database behind them (${UNREACHABLE.TEST_DB_HOST}:${UNREACHABLE.TEST_DB_PORT} refuses every connection). A test that passes without a server never dialled one, so its green above says nothing about a live database:\n` +
          list(passedWithoutServer) +
          `\n\n      An emptied body, a removed assertion block, and a bail-out that RETURNS instead of\n` +
          `      failing (#230) all look exactly like this. If the test needs no server, name it in\n` +
          `      OFFLINE_TESTS.`,
      );
    }
    if (misclassified.length > 0) {
      problems.push(
        `${misclassified.length} test(s) named in OFFLINE_TESTS did NOT pass against an unreachable database, so they are not offline tests after all:\n` +
          list(misclassified) +
          `\n\n      An entry there excuses a test from "must not pass without a server". One that needs a\n` +
          `      server must be removed from the list, not excused by it.`,
      );
    }
    if (staleOffline.length > 0) {
      problems.push(
        `${staleOffline.length} entry/entries in OFFLINE_TESTS name a test the unreachable-database run never reported — renamed, moved or deleted:\n` + list(staleOffline),
      );
    }
    console.log(
      `phase 2: ${verdicts.size} test(s) across the ${LIVE_FILES.length} live-DB files re-run against ${UNREACHABLE.TEST_DB_HOST}:${UNREACHABLE.TEST_DB_PORT}; ` +
        `none passed except the ${OFFLINE_TESTS.length} named in OFFLINE_TESTS`,
    );
  }
}

report(
  problems,
  `✅ the live-DB gates ${GATES_ENV} declares were OPEN in this process before vitest started; every one of the\n` +
    `   ${inTree.size} test files \`${INCLUDE}\` matches reported at least one test in vitest's own --reporter=json report,\n` +
    `   and all ${results.length} of them passed (${skipped.length} skipped or todo, budget ${SKIP_BUDGET}) — so no inherited\n` +
    `   SKIP_INTEGRATION_TESTS=1 took the live-DB half out of the run, which vitest itself would have called\n` +
    `   \`success: true\`. All ${LIVE_FILES.length} live-DB files listed in LIVE_FILES are still present in the tree.\n` +
    `   The ${LIVE_FILES.length} live-DB files were then run AGAIN against an UNREACHABLE database (${UNREACHABLE.TEST_DB_HOST}:${UNREACHABLE.TEST_DB_PORT}) and NO test\n` +
    `   passed there except the ${OFFLINE_TESTS.length} named in OFFLINE_TESTS, which were required to — so no live test passes\n` +
    `   with no server behind it (an emptied body or a bail-out that RETURNS would, #230).\n` +
    `   SCOPE, and it falls GREEN: phase 2 tells an emptied body from a real one ONLY for a test whose OWN\n` +
    `   body dials — measured, ~47 of the live tests (Postgres + MultiDB), where an emptied body FLIPS to\n` +
    `   passed against the dead server and is named. A file that dials in a HOOK (beforeAll/beforeEach) is\n` +
    `   fail-closed — correct — but its tests then report SKIPPED or hook-FAILED whatever their bodies say,\n` +
    `   so phase 2 cannot probe an emptied body there. Moving a file's connect out of its hooks is the only\n` +
    `   thing that would widen this, and is a test-architecture change, not a gate one.\n` +
    `   Also not proven: that a leg ASSERTED anything useful about what it read.`,
);
