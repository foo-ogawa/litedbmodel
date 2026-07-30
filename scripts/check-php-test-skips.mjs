#!/usr/bin/env node
/**
 * The PHP suite's RUN GATE (#220) — the running counterpart of `check-reachable-test-gates.mjs`,
 * built on the same skeleton as the go one (`run-gate.mjs`).
 *
 *     npm run php:test
 *
 * PHP's live-DB legs are gated the other way round from every other language: they run BY DEFAULT and
 * skip when `LITEDBMODEL_SKIP_LIVE=1`. `livedb-gates.env` pins it to `0` and says why — "so a CI run
 * can never be talked out of the live legs by an inherited environment" — and that promise held only
 * for a path that READ the file:
 *
 *     $ LITEDBMODEL_SKIP_LIVE=1 ./vendor/bin/phpunit
 *     OK, but some tests were skipped!   Tests: 152, Skipped: 45      exit 0
 *
 * Forty-five tests — every live-DB leg plus the live corpus — reported nothing, and phpunit said OK.
 * The gate is now the environment itself: {@link assertGatesOpen} compares the VALUE of every
 * declaration, so `LITEDBMODEL_SKIP_LIVE=1` is red BEFORE phpunit starts, and no `--filter`, inherited
 * variable or shell can reach past it. Merely being "set" would have been satisfied by the value that
 * closes it, which is why values and not presence.
 *
 * The run is then checked against what the TREE declares:
 *
 *   - the OUTCOMES come from `--log-junit`, phpunit's own machine-readable report. The progress dots
 *     are not enough: an `S` in the stream and a trailing "but some tests were skipped!" is the whole
 *     of what the console says, it never names the tests, and `Skipped: 45` sits next to `OK`.
 *   - the DECLARATIONS come from PHP itself. A `php -r` subprocess requires every `.php` under
 *     `php/tests` and asks `ReflectionClass` for the `test*` methods of every class each file
 *     declares. Not a regex of this repository's making: #222 (A) is what a hand-written source
 *     scanner is worth — fooled twice by comment and string syntax it did not model, 361 lines
 *     deleted in favour of asking the toolchain.
 *
 * Counting is not enough on its own, because a suite that SHRANK reports no skips. Each of these
 * removes coverage while leaving `OK`, and each is caught by the enumeration:
 *
 *     a file renamed off `*Test.php`            phpunit.xml's `<directory>tests</directory>` has an
 *                                               implicit `suffix="Test.php"`, so it is collected by
 *                                               nothing. The walk here reads EVERY `.php` under
 *                                               tests/ for exactly this reason
 *     `<directory>` narrowed in phpunit.xml     a whole subtree stops being a test suite
 *     a class that stops extending TestCase     phpunit collects nothing from it; reflection still
 *                                               sees its `test*` methods
 *
 * The walk is deliberately WIDER than phpunit's own collection rules — every `test*` public method of
 * every class, whether or not the class is a TestCase — so a test phpunit would not collect is RED
 * here rather than silently absent. It errs loud.
 *
 * NOT caught, and it falls GREEN: a method renamed OFF the `test` prefix. The walk selects methods by
 * that same prefix, so both sides go blind together — measured, `testRenderAllFragmentsPresent` →
 * `renderAllFragmentsPresent` took the run from `152 testcases from 134 declared tests` to `151 … from
 * 133` with no new problem reported. Enumerating `#[Test]`/`@test` as well (this suite uses neither)
 * would not change that: a method with neither the prefix nor the attribute is invisible to phpunit
 * and to reflection alike. python's gate has the identical hole for the same reason.
 *
 * What a source walk structurally CANNOT catch is a test that has been DELETED: it is missing from the
 * walk too. That is what {@link LIVE_TESTS} is for, and only the live-DB legs are listed — a
 * whole-suite inventory would need editing every time anyone adds a test, and a count floor is
 * defeated by deleting one test and adding another. `check-reachable-test-gates.mjs` does not cover
 * this either: all four live files read the SAME `LITEDBMODEL_SKIP_LIVE`, so deleting one leaves its
 * dead-declaration clause green.
 *
 * It is red when any of the following holds, and prints its green line only when none does:
 *
 *   - a gate `livedb-gates.env` declares is not open in this process — checked before anything runs;
 *   - phpunit could not be started, or was killed by a signal;
 *   - phpunit wrote no report at all: the run never got as far as collecting;
 *   - a failure or an ERROR (phpunit counts them apart, and `failOnWarning`/`failOnRisky` in
 *     phpunit.xml mean a warning or a risky test fails the run too, so a non-zero exit with no
 *     failure of its own is still red — see the unmodelled-exit clause);
 *   - more skips than {@link SKIP_BUDGET} — each one NAMED;
 *   - a test the tree declares that reported NO verdict: it did not run;
 *   - a verdict for a test the tree does not declare. The walk is then wrong, and a rule built on a
 *     wrong walk passes vacuously; that must be loud, not silent;
 *   - `LIVE_TESTS` disagreeing with the tree in EITHER direction;
 *   - no test reporting a verdict at all: the suite never ran;
 *   - phpunit exiting non-zero for a reason none of the above explains. Unmodelled ⇒ red.
 *
 * Then PHASE 2, at the bottom of this file: the suite is run AGAIN against a database that is NOT THERE,
 * and a leg that PASSES anyway never dialled one. 30 of the 33 in LIVE_TESTS fail on a refused
 * connection; the other three are `ConformanceCorpusTest`'s offline corpus checks, named in
 * OFFLINE_CHECKS because they live in a gated FILE but read only the frozen corpus.
 *
 * Not proven, and it falls GREEN: that a leg asserted anything USEFUL about what it read. A body
 * reduced to a bare connect dials, so it satisfies both phases.
 */
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertGatesOpen, runOwned, mustHaveStarted, exitProblem, junitTestcases, report, UNREACHABLE } from './run-gate.mjs';
import { GATES_ENV, readsAGate } from './livedb-gates.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PHP_DIR = join(ROOT, 'php');
/** `<testsuite><directory>` in php/phpunit.xml — the tree phpunit is told to walk. */
const TESTS_DIR = 'tests';

/**
 * How many php tests may skip. ZERO: with `LITEDBMODEL_SKIP_LIVE=0` asserted above and the stack up,
 * the only remaining `markTestSkipped` in the suite is `TxBoundaryLiveTest`'s "pcntl_fork
 * unavailable" — and that one is in `setUp`, so a PHP build without pcntl silently drops all fourteen
 * of that class's tests. `pcntl` is therefore REQUIRED of the environment rather than budgeted for
 * (`conformance.yml` lists it under setup-php `extensions:`; it is built in on the CLI PHP most
 * platforms ship). Raising this is a decision about coverage, not a formality: name the tests and why.
 */
const SKIP_BUDGET = 0;

/**
 * The public methods of a TestCase subclass that phpunit does NOT collect as tests, with what they are.
 * All four are `#[DataProvider]`/`dataProvider` sources, which must be public for phpunit to call them.
 *
 * BIDIRECTIONAL: an entry whose method is gone, is no longer declared by a TestCase subclass, or is now
 * collected AS a test is stale and red — otherwise it would go on excusing a method that stopped being
 * a provider.
 */
const PROVIDERS = [
  'LiteDbModel\\Runtime\\Tests\\MiddlewareLiveTest::liveDrivers',
  'LiteDbModel\\Runtime\\Tests\\RenderTest::orderByNullsCases',
  'LiteDbModel\\Runtime\\Tests\\TxAtomicityLiveTest::liveDrivers',
  'LiteDbModel\\Runtime\\Tests\\TxBoundaryLiveTest::dialects',
];

/**
 * The live-DB legs, by `<Class>::<method>` — the tests that only mean anything with a real PG/MySQL
 * behind them, and the ones whose disappearance is invisible: a source walk cannot miss a test that is
 * not there.
 *
 * Derived, not guessed: exactly the tests declared in a `php/tests/**` file that reads a
 * `LITEDBMODEL_*` gate. They cover the 45 testcases that skipped with `LITEDBMODEL_SKIP_LIVE=1` (the
 * count differs because data providers expand one method into several testcases, and because
 * `ConformanceCorpusTest`'s three offline corpus checks live in a gated FILE — the same file-level
 * derivation go uses).
 *
 * Removing a name is a decision about coverage, not a formality: say which test and why.
 */
const LIVE_TESTS = [
  'LiteDbModel\\Runtime\\Tests\\ConformanceCorpusTest::testCorpusCoversBothLiveDialectsWithTheSameCases',
  'LiteDbModel\\Runtime\\Tests\\ConformanceCorpusTest::testCorpusIsTheSupportedVersion',
  'LiteDbModel\\Runtime\\Tests\\ConformanceCorpusTest::testEveryVectorNamesAnEndpointTheGeneratedModuleExposes',
  'LiteDbModel\\Runtime\\Tests\\ConformanceCorpusTest::testLiveDbConformanceAllVectorsPass',
  'LiteDbModel\\Runtime\\Tests\\ConnectionRoutingLiveTest::testActiveTxPinWinsOverRouting',
  'LiteDbModel\\Runtime\\Tests\\ConnectionRoutingLiveTest::testCharsetAppliedAndResetOnMysql',
  'LiteDbModel\\Runtime\\Tests\\ConnectionRoutingLiveTest::testKeepAlivePersistent',
  'LiteDbModel\\Runtime\\Tests\\ConnectionRoutingLiveTest::testMultiDbNameRouting',
  'LiteDbModel\\Runtime\\Tests\\ConnectionRoutingLiveTest::testQueryTimeoutFiresOnMysqlHeavyQuery',
  'LiteDbModel\\Runtime\\Tests\\ConnectionRoutingLiveTest::testQueryTimeoutFiresOnPg',
  'LiteDbModel\\Runtime\\Tests\\ConnectionRoutingLiveTest::testReaderWriterSplit',
  'LiteDbModel\\Runtime\\Tests\\ConnectionRoutingLiveTest::testSearchPathAppliedAndResetOnPg',
  'LiteDbModel\\Runtime\\Tests\\ConnectionRoutingLiveTest::testSetConfigBuildsWorkingPoolAndCloseAllPools',
  'LiteDbModel\\Runtime\\Tests\\ConnectionRoutingLiveTest::testUnknownConnectionNameIsLoud',
  'LiteDbModel\\Runtime\\Tests\\ConnectionRoutingLiveTest::testWithWriterScope',
  'LiteDbModel\\Runtime\\Tests\\ConnectionRoutingLiveTest::testWriterStickyAfterCommit',
  'LiteDbModel\\Runtime\\Tests\\MiddlewareLiveTest::testLoggerRecordsLiveStatement',
  'LiteDbModel\\Runtime\\Tests\\MiddlewareLiveTest::testMiddlewareObservesRuntimeBeginAndCommitOfRealTransaction',
  'LiteDbModel\\Runtime\\Tests\\MiddlewareLiveTest::testMiddlewareObservesRuntimeBeginAndRollbackOnError',
  'LiteDbModel\\Runtime\\Tests\\MiddlewareLiveTest::testQueryMethodHookFiresAroundRawQuery',
  'LiteDbModel\\Runtime\\Tests\\MiddlewareLiveTest::testRawExecuteAndRawQueryThroughLiveSeam',
  'LiteDbModel\\Runtime\\Tests\\MiddlewareLiveTest::testRedProofUnregisteredDoesNotObserveTxControl',
  'LiteDbModel\\Runtime\\Tests\\MiddlewareLiveTest::testRedProofUnregisteredIsBytePassthrough',
  'LiteDbModel\\Runtime\\Tests\\TxAtomicityLiveTest::testFaithfulMutationMakesAtomicityRed',
  'LiteDbModel\\Runtime\\Tests\\TxAtomicityLiveTest::testMultiStatementAtomicityRollsBackFirstOnSecondFailure',
  'LiteDbModel\\Runtime\\Tests\\TxBoundaryLiveTest::testGuardLive',
  'LiteDbModel\\Runtime\\Tests\\TxBoundaryLiveTest::testIsolationBehaviorLive',
  'LiteDbModel\\Runtime\\Tests\\TxBoundaryLiveTest::testIsolationSqlEmittedLive',
  'LiteDbModel\\Runtime\\Tests\\TxBoundaryLiveTest::testMultiOpAtomicityCommitsTogether',
  'LiteDbModel\\Runtime\\Tests\\TxBoundaryLiveTest::testMultiOpAtomicityRollsBackTogetherAndRedGreenMutation',
  'LiteDbModel\\Runtime\\Tests\\TxBoundaryLiveTest::testMysqlRetryOnRealDeadlock',
  'LiteDbModel\\Runtime\\Tests\\TxBoundaryLiveTest::testNestedLive',
  'LiteDbModel\\Runtime\\Tests\\TxBoundaryLiveTest::testPgRetryOnRealSerializationFailure',
];

/**
 * Every `test*` method the tree declares, as `<Class>::<method>` plus the file that declares it,
 * asked of PHP's own reflection rather than of a regex.
 *
 * Each file is `require`d and the classes it ADDED are diffed out of `get_declared_classes()`, so a
 * file declaring several classes (this tree has test doubles — `RecordingPdo`, `ThrowingPdo`,
 * `MisRoutingContext` — beside the TestCase) contributes all of them. Abstract classes are skipped:
 * phpunit reports an abstract base's tests under each concrete subclass, never under the base.
 */
const REFLECT = `
require "vendor/autoload.php";
$out = [];
$files = [];
$walk = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($argv[1], FilesystemIterator::SKIP_DOTS));
foreach ($walk as $f) {
    if ($f->isFile() && substr($f->getFilename(), -4) === ".php") { $files[] = $f->getPathname(); }
}
sort($files);
foreach ($files as $file) {
    $before = get_declared_classes();
    require $file;
    foreach (array_diff(get_declared_classes(), $before) as $class) {
        $r = new ReflectionClass($class);
        if ($r->isAbstract()) { continue; }
        $isTestCase = $r->isSubclassOf("PHPUnit\\\\Framework\\\\TestCase");
        foreach ($r->getMethods(ReflectionMethod::IS_PUBLIC) as $m) {
            // DECLARED here, not inherited: TestCase's own public API is not this class's tests.
            if ($m->getDeclaringClass()->getName() !== $class) { continue; }
            $out[] = [
                $class . "::" . $m->getName(),
                $m->getDeclaringClass()->getFileName(),
                $isTestCase,
                strncmp($m->getName(), "test", 4) === 0,
            ];
        }
    }
}
echo json_encode($out);
`;

const enumeration = mustHaveStarted(
  await runOwned('php', ['-r', REFLECT, TESTS_DIR], { cwd: PHP_DIR }),
  'php -r <reflection walk>',
);
if (enumeration.exit !== 0) {
  console.error(
    `\n❌ the reflection walk of php/${TESTS_DIR} exited ${enumeration.exit} — nothing below can be checked against a tree it failed to read.`,
  );
  process.exit(1);
}
const reflected = JSON.parse(enumeration.stdout);
/** `<Class>::<method>` → the file declaring it, for the `test*`-prefixed methods phpunit collects. */
const declared = new Map(reflected.filter(([, , , prefixed]) => prefixed).map(([label, file]) => [label, file]));
/**
 * Every public method a TestCase SUBCLASS declares, prefixed or not — what closes the rename hole.
 *
 * A method renamed off the `test` prefix used to be invisible: the walk selected on that same prefix, so
 * both sides went blind together. Reflection was never blind, though — measured, this tree declares 134
 * `test*` methods and 37 non-prefixed public methods, of which 4 belong to TestCase subclasses and all
 * four are data providers. So the rule is "a public method of a TestCase subclass is COLLECTED by
 * phpunit or is named in {@link PROVIDERS}", and `testRenderAllFragmentsPresent` →
 * `renderAllFragmentsPresent` becomes red instead of silent.
 */
const collectible = reflected.filter(([, , isTestCase]) => isTestCase).map(([label]) => label);
/** Live legs as the TREE has them now, for the bidirectional check against `LIVE_TESTS`. */
const liveInTree = new Set(
  [...declared].filter(([, file]) => readsAGate(readFileSync(file, 'utf8'))).map(([label]) => label),
);

assertGatesOpen('php');

const junit = join(mkdtempSync(join(tmpdir(), 'litedbmodel-phpunit-')), 'junit.xml');
const label = './vendor/bin/phpunit';
const run = mustHaveStarted(
  await runOwned('./vendor/bin/phpunit', [`--log-junit=${junit}`], { cwd: PHP_DIR, stdout: 'inherit' }),
  label,
);

const problems = [];
if (!existsSync(junit)) {
  problems.push(
    `phpunit wrote no junit report — it never got as far as collecting, so the run reported nothing at all. (exit ${run.exit})`,
  );
  report(problems, '');
}

// `class` is the FQCN and `name` carries the data-set suffix a provider adds
// (`testFoo with data set "postgres"`), which is ONE method reported as several testcases. PHPUnit
// writes a bare `<skipped/>` with no message, so a skip's REASON is not available here — the tests
// are NAMED instead.
const cases = junitTestcases(readFileSync(junit, 'utf8')).map(({ attributes, outcome }) => ({
  label: `${attributes.class ?? ''}::${(attributes.name ?? '').replace(/ with data set .*$/, '')}`,
  outcome,
}));

const verdicts = new Set(cases.map((c) => c.label));
const counted = (outcome) => cases.filter((c) => c.outcome === outcome);
const [passed, failed, errored, skipped] = [counted('passed'), counted('failed'), counted('error'), counted('skipped')];
const named = (rows) => [...new Set(rows.map((c) => `      ${c.label}`))].join('\n');
const list = (names) => names.map((n) => `      ${n}`).join('\n');

const neverRan = [...declared.keys()].filter((l) => !verdicts.has(l)).sort();
const unscanned = [...verdicts].filter((l) => !declared.has(l)).sort();
const liveGone = LIVE_TESTS.filter((n) => !liveInTree.has(n));
const liveUnlisted = [...liveInTree].filter((n) => !LIVE_TESTS.includes(n)).sort();

console.log(
  `phpunit: ${passed.length} passed, ${failed.length} failed, ${errored.length} errored, ${skipped.length} skipped ` +
    `(${cases.length} testcases from ${declared.size} declared tests)`,
);

if (failed.length > 0) problems.push(`${failed.length} php testcase(s) FAILED:\n` + named(failed));
if (errored.length > 0) {
  problems.push(
    `${errored.length} php testcase(s) ERRORED:\n` +
      named(errored) +
      `\n\n      An error is not a failure: an exception outside an assertion, a \`setUp\` that raised, a\n` +
      `      file that would not load all land here.`,
  );
}
if (skipped.length > SKIP_BUDGET) {
  problems.push(
    `${skipped.length} php testcase(s) SKIPPED, budget ${SKIP_BUDGET}. A skipped test is not a passing test:\n` +
      named(skipped) +
      `\n\n      The gates were open (LITEDBMODEL_SKIP_LIVE=0 among them), so this is not the inverted\n` +
      `      gate — bring the stack up, and check that this PHP has pcntl (TxBoundaryLiveTest skips its\n` +
      `      whole class in setUp without it):\n` +
      `      npm run docker:livedb:up && php -m | grep pcntl`,
  );
}
if (neverRan.length > 0) {
  problems.push(
    `${neverRan.length} php test(s) the tree DECLARES reported no verdict — they did not run, and a suite that shrank reports no skips:\n` +
      list(neverRan) +
      `\n\n      A file renamed off \`*Test.php\`, a narrowed \`<directory>\` in phpunit.xml, a class that\n` +
      `      stopped extending TestCase, and a method renamed off the \`test\` prefix all look exactly\n` +
      `      like this.`,
  );
}
const uncollected = collectible.filter((l) => !verdicts.has(l) && !PROVIDERS.includes(l));
if (uncollected.length > 0) {
  problems.push(
    `${uncollected.length} public method(s) of a TestCase subclass were NOT COLLECTED by phpunit and are not named in PROVIDERS:\n` +
      list(uncollected) +
      `\n\n      A public method of a test class is a test phpunit runs, a data provider, or a mistake.\n` +
      `      This is what catches a method renamed OFF the \`test\` prefix — phpunit stops collecting it\n` +
      `      and a prefix-based walk stops seeing it, both at once, so nothing else says a word.`,
  );
}
const staleProviders = PROVIDERS.filter((l) => !collectible.includes(l) || verdicts.has(l));
if (staleProviders.length > 0) {
  problems.push(
    `${staleProviders.length} entry/entries in PROVIDERS no longer describe a data provider — the method is gone, is no longer declared by a TestCase subclass, or is now COLLECTED as a test:\n` +
      list(staleProviders),
  );
}
if (unscanned.length > 0) {
  problems.push(
    `${unscanned.length} php test(s) reported a verdict that the reflection walk of php/${TESTS_DIR} never found. The walk is wrong — and the check above is only as strong as the walk, so a broken walk passes it vacuously:\n` +
      list(unscanned),
  );
}
if (liveGone.length > 0) {
  problems.push(
    `${liveGone.length} test(s) listed in LIVE_TESTS are no longer live legs in the tree — deleted, renamed, or no longer in a file that reads a LITEDBMODEL_* gate:\n` +
      list(liveGone) +
      `\n\n      Nothing else notices this. A source walk cannot miss a test that is not there, and the\n` +
      `      four live files read the SAME LITEDBMODEL_SKIP_LIVE, so the declaration in ${GATES_ENV}\n` +
      `      stays alive and check-reachable-test-gates.mjs stays green.`,
  );
}
if (liveUnlisted.length > 0) {
  problems.push(
    `${liveUnlisted.length} live-DB test(s) exist under php/${TESTS_DIR} but are not in LIVE_TESTS, so deleting them would be silent. List them:\n` +
      list(liveUnlisted),
  );
}
if (cases.length === 0) problems.push('phpunit reported no testcases at all — the suite never ran.');
exitProblem(run, label, problems);

// ── PHASE 2: the live legs really DIAL a database ───────────────────────────────────────────────────
//
// Everything above reads the OUTCOME of a run against a live server, and an outcome cannot distinguish a
// leg that queried the database from a leg whose body is empty: both pass. So the suite is run again
// against a database that is NOT THERE, with the gates still open, and a leg that PASSES anyway never
// touched a server.
//
// Measured: 30 of the 33 in LIVE_TESTS fail on a refused connection. The other three are the corpus
// checks below — they are in LIVE_TESTS because they live in a gated FILE (the same file-level
// derivation go uses), but they read the frozen corpus and the generated module and touch no database at
// all. They are named here rather than dropped from LIVE_TESTS, so that deleting one is still loud.
const OFFLINE_CHECKS = [
  'LiteDbModel\\Runtime\\Tests\\ConformanceCorpusTest::testCorpusCoversBothLiveDialectsWithTheSameCases',
  'LiteDbModel\\Runtime\\Tests\\ConformanceCorpusTest::testCorpusIsTheSupportedVersion',
  'LiteDbModel\\Runtime\\Tests\\ConformanceCorpusTest::testEveryVectorNamesAnEndpointTheGeneratedModuleExposes',
];
if (problems.length === 0) {
  const out = join(mkdtempSync(join(tmpdir(), 'litedbmodel-phpunit-p2-')), 'junit.xml');
  const p2 = mustHaveStarted(
    await runOwned('./vendor/bin/phpunit', [`--log-junit=${out}`], { cwd: PHP_DIR, stdout: 'inherit', env: UNREACHABLE }),
    `${label} (unreachable database)`,
  );
  const verdicts = new Map();
  if (existsSync(out)) {
    for (const { attributes, outcome } of junitTestcases(readFileSync(out, 'utf8'))) {
      const l = `${attributes.class ?? ''}::${(attributes.name ?? '').replace(/ with data set .*$/, '')}`;
      // A method expanded by a data provider reports several times; ONE passing testcase is enough to
      // say the method can pass with no server behind it.
      if (outcome === 'passed' || !verdicts.has(l)) verdicts.set(l, outcome);
    }
  }
  const dialling = LIVE_TESTS.filter((l) => !OFFLINE_CHECKS.includes(l));
  const passedWithoutServer = dialling.filter((l) => verdicts.get(l) === 'passed');
  const noVerdict = LIVE_TESTS.filter((l) => !verdicts.has(l));
  const misclassified = OFFLINE_CHECKS.filter((l) => verdicts.has(l) && verdicts.get(l) !== 'passed');
  if (passedWithoutServer.length > 0) {
    problems.push(
      `${passedWithoutServer.length} live-DB leg(s) PASSED with no database behind them (${UNREACHABLE.TEST_DB_HOST}:${UNREACHABLE.TEST_DB_PORT} refuses every connection). A leg that passes without a server never dialled one, so its green above says nothing about a live database:\n` +
        list(passedWithoutServer) +
        `\n\n      An emptied body, a removed assertion block, or a connect that is never made all look\n` +
        `      exactly like this. The other ${dialling.length - passedWithoutServer.length} failed as they should.`,
    );
  }
  if (noVerdict.length > 0) {
    problems.push(
      `${noVerdict.length} live-DB leg(s) reported NO verdict from the unreachable-database run, so nothing was learned about them:\n` + list(noVerdict),
    );
  }
  if (misclassified.length > 0) {
    problems.push(
      `${misclassified.length} test(s) named in OFFLINE_CHECKS did NOT pass against an unreachable database, so they are not offline checks after all:\n` +
        list(misclassified) +
        `\n\n      An entry there excuses a test from the "must not pass without a server" rule. One that\n` +
        `      needs a server must be removed from the list, not excused by it.`,
    );
  }
  const stale = OFFLINE_CHECKS.filter((l) => !LIVE_TESTS.includes(l));
  if (stale.length > 0) {
    problems.push(`${stale.length} entry/entries in OFFLINE_CHECKS are not in LIVE_TESTS, so they excuse nothing. Remove them:\n` + list(stale));
  }
  console.log(`phase 2: ${dialling.length} live leg(s) re-run against ${UNREACHABLE.TEST_DB_HOST}:${UNREACHABLE.TEST_DB_PORT}, none passed (${OFFLINE_CHECKS.length} offline checks excepted)`);
}

report(
  problems,
  `✅ the live-DB gates ${GATES_ENV} declares were OPEN in this process before phpunit started — including\n` +
    `   LITEDBMODEL_SKIP_LIVE=0, the INVERTED one, so an inherited \`=1\` could not talk the run out of its\n` +
    `   live legs; each of the ${declared.size} tests the tree declares (PHP's own ReflectionClass, every .php under\n` +
    `   php/${TESTS_DIR}, every \`test*\` method of every class) reported a verdict in phpunit's own --log-junit report,\n` +
    `   and every one of the ${cases.length} testcases was a pass (${skipped.length} skipped, budget ${SKIP_BUDGET}); all ${LIVE_TESTS.length} live-DB legs listed in\n` +
    `   LIVE_TESTS are still present in the tree.\n` +
    `   The suite was then run AGAIN against an UNREACHABLE database (${UNREACHABLE.TEST_DB_HOST}:${UNREACHABLE.TEST_DB_PORT}) and none of the\n` +
    `   ${LIVE_TESTS.length - OFFLINE_CHECKS.length} live legs passed — so each really dials a server rather than passing on an empty body. The\n` +
    `   ${OFFLINE_CHECKS.length} in OFFLINE_CHECKS are excepted BY NAME and were required to pass there instead, since a test that\n` +
    `   needs no server must not be excused by an entry claiming it needs one.\n` +
    `   Not proven, and it falls GREEN: that a leg ASSERTED anything useful about what it read. A body\n` +
    `   reduced to a bare connect dials, so it satisfies both phases.`,
);
