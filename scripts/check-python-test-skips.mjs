#!/usr/bin/env node
/**
 * The Python suite's RUN GATE (#220) — the running counterpart of `check-reachable-test-gates.mjs`,
 * built on the same skeleton as the go one (`run-gate.mjs`).
 *
 *     npm run py:test
 *
 * pytest reports a skipped test as a success, so this exited 0 on this tree:
 *
 *     $ env -u LITEDBMODEL_LIVEDB -u LITEDBMODEL_TX_ISOLATION python3 -m pytest -q
 *     153 passed, 25 skipped
 *
 * Twenty-five live-DB legs — tx isolation, tx boundaries, connection routing, middleware and the live
 * corpus — reported nothing, and the run said `passed`. That is the same hole the #215 regression came
 * through in go (#219).
 *
 * So the gates are asserted OPEN before pytest starts, and the run is then checked against what the
 * TREE declares:
 *
 *   - the OUTCOMES come from `--junitxml`, pytest's own machine-readable report. The terse summary
 *     line is not enough: it counts skips but never NAMES them, and it cannot say which of the tests
 *     that exist are missing from it.
 *   - the DECLARATIONS come from Python's own parser. A `python3 -c` subprocess walks every `.py`
 *     under `python/tests` with `ast` and reports every `def test*` / `async def test*`, at module
 *     level or in any class. Not a regex of this repository's making: #222 (A) is what a hand-written
 *     source scanner is worth — it was fooled twice by comment and string syntax it did not model,
 *     and 361 lines of it were deleted in favour of asking the toolchain.
 *
 * Counting is not enough on its own, because a suite that SHRANK reports no skips. Every one of these
 * removes coverage while leaving a green summary, and every one is caught by the enumeration:
 *
 *     an ambient PYTEST_ADDOPTS=-k …          fewer tests run; the summary just gets smaller
 *     testpaths narrowed in pyproject.toml    a whole file stops being collected
 *     `class TestFoo` renamed to `class Foo`  pytest's python_classes no longer matches, so every
 *                                             test in it vanishes silently — this one is invisible to
 *                                             a per-FILE count too, because the file's other tests
 *                                             still report
 *     a file renamed off `test_*.py`          collected by nothing; the walk here reads EVERY `.py`
 *                                             under tests/ for exactly this reason
 *
 * The scan is deliberately WIDER than pytest's own collection rules — every function in every class,
 * prefixed or not — so a test pytest would not collect is RED here rather than silently absent, and a
 * method of a `Test*` class renamed OFF the `test` prefix is a public method that reported no verdict
 * ({@link HELPERS}), which closes the hole php closes with `collectible`/PROVIDERS.
 *
 * NOT caught, and it falls GREEN: a MODULE-LEVEL function renamed off the `test` prefix. pytest collects
 * a module-level test by that prefix ALONE — there is no enclosing `Test*` class to mark it — so `def
 * test_x` renamed to `def x` at module scope is indistinguishable from a helper, to this walk and to
 * pytest alike. php does not share this hole because it has no module-level tests; here it is the residual
 * (the class-method version above is closed), and LIVE_TESTS is the deletion backstop for the live legs.
 *
 * What a source scan structurally CANNOT catch is a test that has been DELETED: it is missing from the
 * scan too. That is what {@link LIVE_TESTS} is for, and only the live-DB legs are listed — a
 * whole-suite inventory would need editing every time anyone adds a test, and a count floor is
 * defeated by deleting one test and adding another. `check-reachable-test-gates.mjs` does not cover
 * this either: all four live files read the SAME `LITEDBMODEL_TX_ISOLATION`, so deleting one leaves
 * its dead-declaration clause green.
 *
 * It is red when any of the following holds, and prints its green line only when none does:
 *
 *   - a gate `livedb-gates.env` declares is not open in this process — checked before anything runs;
 *   - pytest could not be started, or was killed by a signal;
 *   - pytest wrote no report at all: the run never got as far as collecting;
 *   - a failure or an ERROR (a collection error is an error, not a failure, and the terse summary
 *     line is the only other place it appears);
 *   - more skips than {@link SKIP_BUDGET} — each one NAMED;
 *   - a test the tree declares that reported NO verdict: it did not run;
 *   - a verdict for a test the tree does not declare. The scan is then wrong, and a rule built on a
 *     wrong scan passes vacuously; that must be loud, not silent;
 *   - `LIVE_TESTS` disagreeing with the tree in EITHER direction: a listed leg gone (deleted or
 *     renamed), or a new live leg not listed, so it would go unprotected;
 *   - no test reporting a verdict at all: the suite never ran;
 *   - pytest exiting non-zero for a reason none of the above explains. Unmodelled ⇒ red.
 *
 * Then PHASE 2, at the bottom of this file: the live legs are re-run against a database that is NOT
 * THERE, and a leg that PASSES anyway never dialled one — an outcome cannot otherwise tell a real
 * query from an empty body, since both pass.
 *
 * 24 of the 29 must FAIL there. Four are `test_conformance_corpus.py`'s offline corpus checks, which
 * read the frozen corpus and the generated module and touch no database: they are in LIVE_TESTS because
 * they live in a gated FILE, and phase 2 requires them to PASS instead (OFFLINE_CHECKS). Exactly ONE —
 * `test_live_db_conformance_all_vectors_pass`, the only test in that file carrying the `skipif` — goes
 * through the corpus runner, whose pool blocks forever with no connection to be had (#225), so it alone
 * is probed under a timeout (HANGS).
 *
 * That split matters: a single 20s allowance over the whole FILE hid the four that pass with no server,
 * and following its own "remove the allowance" advice then produced four PASSED-without-a-server reds
 * that were not regressions at all.
 *
 * Not proven, and it falls GREEN: that a leg asserted anything USEFUL about what it read. A body
 * reduced to a bare connect dials, so it satisfies both phases.
 */
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertGatesOpen, runOwned, mustHaveStarted, exitProblem, junitTestcases, report, UNREACHABLE } from './run-gate.mjs';
import { GATES_ENV, readsAGate } from './livedb-gates.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PY_DIR = join(ROOT, 'python');
/** `[tool.pytest.ini_options] testpaths` in python/pyproject.toml — the tree pytest is told to walk. */
const TESTS_DIR = join(PY_DIR, 'tests');

/**
 * How many python tests may skip. ZERO: every live-DB leg is gated on a variable `livedb-gates.env`
 * declares and CI opens before the python step — so with the gates asserted open above and the stack
 * up, nothing has a reason to skip. Raising this is a decision about coverage, not a formality: name
 * the tests and why.
 */
const SKIP_BUDGET = 0;

/**
 * The live-DB legs, by `<file>::<test>` — the tests that only mean anything with a real PG/MySQL
 * behind them, and the ones whose disappearance is invisible: a source scan cannot miss a test that
 * is not there.
 *
 * Derived, not guessed: these are exactly the tests declared in a `python/tests/**` file that reads a
 * `LITEDBMODEL_*` gate, and they cover the 25 testcases that skipped with the gates closed (the four
 * extra are `test_conformance_corpus.py`'s offline corpus checks, which live in a gated FILE — the
 * same file-level derivation go uses). The check below is bidirectional against that derivation, so
 * adding a live leg without listing it here is red too.
 *
 * Removing a name is a decision about coverage, not a formality: say which test and why.
 */
const LIVE_TESTS = [
  'test_conformance_corpus.py::test_corpus_carries_a_seeded_schema',
  'test_conformance_corpus.py::test_corpus_covers_both_live_dialects_with_the_same_cases',
  'test_conformance_corpus.py::test_corpus_is_the_supported_version',
  'test_conformance_corpus.py::test_every_vector_names_an_endpoint_the_generated_module_exposes',
  'test_conformance_corpus.py::test_live_db_conformance_all_vectors_pass',
  'test_connection_routing_livedb.py::test_c1_reader_writer_split',
  'test_connection_routing_livedb.py::test_c1_with_writer_scope',
  'test_connection_routing_livedb.py::test_c1_writer_sticky_after_commit',
  'test_connection_routing_livedb.py::test_c2_missing_name_is_loud',
  'test_connection_routing_livedb.py::test_c2_multi_db_name_routing',
  'test_connection_routing_livedb.py::test_c2_named_db_tx_pin_wins_over_routing',
  'test_connection_routing_livedb.py::test_c3_max_pool_is_sole_cap_and_close',
  'test_connection_routing_livedb.py::test_c3_pg_and_mysql_factories_end_to_end',
  'test_connection_routing_livedb.py::test_c3_query_timeout_fires_mysql',
  'test_connection_routing_livedb.py::test_c3_query_timeout_fires_pg',
  'test_connection_routing_livedb.py::test_c3_search_path_reset_on_release_no_session_leak',
  'test_middleware_livedb.py::test_d1_middleware_observes_runtime_begin_commit_of_real_transaction',
  'test_middleware_livedb.py::test_d1_middleware_observes_runtime_rollback_on_body_error',
  'test_middleware_livedb.py::test_d1_per_context_isolation_concurrent',
  'test_middleware_livedb.py::test_d1_red_tx_control_bypassing_seam_is_not_observed',
  'test_middleware_livedb.py::test_d1_red_without_registration_nothing_observed',
  'test_middleware_livedb.py::test_d3_logger_records_live_sql_params_timing',
  'test_middleware_livedb.py::test_d3_query_method_hook_around_raw_query',
  'test_middleware_livedb.py::test_d3_raw_execute_through_seam_and_writer_routing',
  'test_tx_boundary_livedb.py::test_tx_boundary_mysql',
  'test_tx_boundary_livedb.py::test_tx_boundary_postgres',
  'test_tx_isolation.py::test_commit_failure_no_pool_leak_postgres',
  'test_tx_isolation.py::test_tx_isolation_mysql',
  'test_tx_isolation.py::test_tx_isolation_postgres',
];

/**
 * Public, non-fixture methods of a `Test*` class that pytest does NOT collect as tests, with what they
 * are — the php gate's PROVIDERS, in python's clothes. Empty because every test in this tree is a
 * module-level function (no `Test*` class holds a non-test public method), but the allowlist has to
 * EXIST for the rename check to be absolute: a public method of a test class is a test or is named here.
 *
 * BIDIRECTIONAL: an entry that is now collected AS a test, or is no longer a public method of a `Test*`
 * class, is stale and red — so it cannot go on excusing a method that stopped being a helper.
 */
const HELPERS = [];

/**
 * Every function/method the tree declares, as `[<file::Class…::name>, inTestClass, prefixed, excluded]`,
 * asked of Python's own `ast` rather than of a regex — the php gate's shape, so both close the same hole.
 *
 * EVERY `.py` under tests/ is walked, and EVERY function/method is reported — prefixed or NOT, in a class
 * or at module level. Reporting the prefix-LESS ones is what lets the rename hole close: a method of a
 * `Test*` class renamed OFF the `test` prefix (so pytest stops collecting it) used to vanish from a walk
 * that also selected on the prefix, both going blind together. Now such a method is a public method of a
 * class pytest collects from that reported no verdict — RED — exactly as php flags a public method of a
 * TestCase subclass that phpunit did not collect (`collectible`/PROVIDERS there, `collectible`/HELPERS here).
 *
 *   inTestClass  the enclosing class is named `Test*` — pytest's own `python_classes`, the marker that
 *                a method here is a test unless it is plainly a fixture or helper (below). Module-level
 *                functions carry `false`: pytest collects a module-level test by the `test_` prefix
 *                ALONE, so a bare `def foo` there is indistinguishable from a helper — the one form
 *                neither this nor pytest can tell from a renamed test (stated in the green line).
 *   prefixed     the name starts with `test` — what pytest collects on, and what `declared` is built from.
 *   excluded     a leading `_`, a dunder, or a `fixture`/`staticmethod`/`classmethod`/`property`
 *                decorator: a member of a test class that is legitimately not one of its tests.
 */
const AST_WALK = `
import ast, json, os, sys
root = sys.argv[1]
out = []

def excluded(fn):
    if fn.name.startswith("_"):
        return True
    for d in fn.decorator_list:
        base = d.func if isinstance(d, ast.Call) else d
        leaf = base.attr if isinstance(base, ast.Attribute) else getattr(base, "id", "")
        if leaf in ("fixture", "staticmethod", "classmethod", "property"):
            return True
    return False

def walk(node, rel, prefix, in_test_class):
    for child in node.body:
        if isinstance(child, ast.ClassDef):
            walk(child, rel, prefix + [child.name], child.name.startswith("Test"))
        elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out.append(["::".join([rel] + prefix + [child.name]), in_test_class, child.name.startswith("test"), excluded(child)])

for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "__pycache__"]
    for name in sorted(filenames):
        if not name.endswith(".py"):
            continue
        path = os.path.join(dirpath, name)
        with open(path, encoding="utf-8") as fh:
            source = fh.read()
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        walk(ast.parse(source, filename=path), rel, [], False)

json.dump(out, sys.stdout)
`;

const enumeration = mustHaveStarted(
  await runOwned('python3', ['-c', AST_WALK, TESTS_DIR], { cwd: PY_DIR }),
  'python3 -c <ast walk>',
);
if (enumeration.exit !== 0) {
  console.error(`\n❌ the \`ast\` walk of ${relative(ROOT, TESTS_DIR)} exited ${enumeration.exit} — nothing below can be checked against a tree it failed to read.`);
  process.exit(1);
}
/**
 * Every `[label, inTestClass, prefixed, excluded]` the walk found.
 *   declared    the `test*`-prefixed ones — what pytest collects, checked for a verdict each (`neverRan`).
 *   collectible the public, non-fixture methods of a `Test*` class, prefixed OR not — what CLOSES the
 *               rename hole: each must be collected by pytest or named in {@link HELPERS}, exactly as
 *               php requires a public method of a TestCase subclass to be collected or in PROVIDERS.
 */
const reflected = JSON.parse(enumeration.stdout);
const declared = new Set(reflected.filter(([, , prefixed]) => prefixed).map(([label]) => label));
const collectible = reflected.filter(([, inTestClass, , excluded]) => inTestClass && !excluded).map(([label]) => label);
const files = new Set([...declared].map((l) => l.split('::')[0]));
/** Live legs as the TREE has them now, for the bidirectional check against `LIVE_TESTS`. */
const liveInTree = new Set(
  [...declared].filter((l) => readsAGate(readFileSync(join(TESTS_DIR, l.split('::')[0]), 'utf8'))),
);

assertGatesOpen('python');

/**
 * How long the whole suite may take before this gate gives up on it.
 *
 * Not a formality: with the gates OPEN and no database reachable, `test_conformance_corpus.py` blocks
 * FOREVER (#225 — the pool's acquire has no timeout), so `npm run py:test` never returned at all.
 * A gate that hangs is worse than one that fails: CI waits out its own job timeout with no diagnosis.
 * Ten minutes is far above the suite's real cost (~12s offline, minutes with the live stack).
 */
const PHASE1_TIMEOUT_MS = 10 * 60_000;

const junit = join(mkdtempSync(join(tmpdir(), 'litedbmodel-pytest-')), 'junit.xml');
const label = 'python3 -m pytest';
const run = mustHaveStarted(
  await runOwned('python3', ['-m', 'pytest', '-q', `--junitxml=${junit}`], {
    cwd: PY_DIR,
    stdout: 'inherit',
    timeoutMs: PHASE1_TIMEOUT_MS,
  }),
  label,
);

const problems = [];
if (run.timedOut) {
  problems.push(
    `\`${label}\` was still running after ${PHASE1_TIMEOUT_MS / 60000} minutes and was killed, so the suite reported nothing to check. A leg that HANGS is not a leg that passed:\n` +
      `      With the gates open and no database reachable, test_conformance_corpus.py blocks forever\n` +
      `      (#225 — the pool's acquire has no timeout). Bring the stack up: npm run docker:livedb:up`,
  );
  report(problems, '');
}
if (!existsSync(junit)) {
  problems.push(
    `pytest wrote no ${relative(ROOT, junit)} — it never got as far as collecting, so the run reported nothing at all. (exit ${run.exit})`,
  );
  report(problems, '');
}

const cases = junitTestcases(readFileSync(junit, 'utf8'));

/**
 * A junit testcase back to the `<file>::<Class…>::<name>` the tree declares.
 *
 * `classname` is the dotted path from pytest's rootdir (`python/`) — `tests.test_tx_options`, or
 * `tests.test_x.TestY` for a class — and `name` carries the parametrisation, `test_foo[postgres]`.
 * Which of the dotted components are the MODULE is decided against the files the walk above found,
 * not by guessing at the last dot: a nested `tests/sub/test_x.py` is `tests.sub.test_x`, and a class
 * adds a component that looks exactly the same.
 */
function labelOf({ attributes: { classname = '', name = '' } }) {
  const parts = classname.split('.');
  for (let k = parts.length; k > 0; k--) {
    const file = `${parts.slice(1, k).join('/')}.py`;
    if (files.has(file)) return [file, ...parts.slice(k), name.replace(/\[.*$/, '')].join('::');
  }
  return `${classname}::${name.replace(/\[.*$/, '')}`;
}

const verdicts = new Map();
for (const c of cases) {
  const l = labelOf(c);
  if (!verdicts.has(l)) verdicts.set(l, []);
  verdicts.get(l).push(c);
}
const counted = (outcome) => cases.filter((c) => c.outcome === outcome);
const [passed, failed, errored, skipped] = [counted('passed'), counted('failed'), counted('error'), counted('skipped')];
const named = (rows) => rows.map((c) => `      ${labelOf(c)}`).join('\n');
const list = (names) => names.map((n) => `      ${n}`).join('\n');

const neverRan = [...declared].filter((l) => !verdicts.has(l)).sort();
const unscanned = [...verdicts.keys()].filter((l) => !declared.has(l)).sort();
const uncollected = collectible.filter((l) => !verdicts.has(l) && !HELPERS.includes(l)).sort();
const staleHelpers = HELPERS.filter((l) => !collectible.includes(l) || verdicts.has(l)).sort();
const liveGone = LIVE_TESTS.filter((n) => !liveInTree.has(n));
const liveUnlisted = [...liveInTree].filter((n) => !LIVE_TESTS.includes(n)).sort();

console.log(
  `pytest: ${passed.length} passed, ${failed.length} failed, ${errored.length} errored, ${skipped.length} skipped ` +
    `(${cases.length} testcases from ${declared.size} declared tests)`,
);

if (failed.length > 0) problems.push(`${failed.length} python test(s) FAILED:\n` + named(failed));
if (errored.length > 0) {
  problems.push(
    `${errored.length} python test(s) ERRORED:\n` +
      named(errored) +
      `\n\n      An error is not a failure: a collection error, a fixture that raised, a module that\n` +
      `      would not import all land here, and the counts above are only of what got as far as running.`,
  );
}
if (skipped.length > SKIP_BUDGET) {
  problems.push(
    `${skipped.length} python test(s) SKIPPED, budget ${SKIP_BUDGET}. A skipped test is not a passing test:\n` +
      named(skipped) +
      `\n\n      The gates were open, so this is not a closed gate — bring the stack up and re-run:\n` +
      `      npm run docker:livedb:up`,
  );
}
if (neverRan.length > 0) {
  problems.push(
    `${neverRan.length} python test(s) the tree DECLARES reported no verdict — they did not run, and a suite that shrank reports no skips:\n` +
      list(neverRan) +
      `\n\n      An ambient PYTEST_ADDOPTS filter, a narrowed \`testpaths\`, a file renamed off\n` +
      `      \`test_*.py\` and a \`Test*\` class renamed so pytest stops collecting it all look exactly\n` +
      `      like this.`,
  );
}
if (unscanned.length > 0) {
  problems.push(
    `${unscanned.length} python test(s) reported a verdict that the \`ast\` walk of ${relative(ROOT, TESTS_DIR)} never found. The walk is wrong — and the check above is only as strong as the walk, so a broken walk passes it vacuously:\n` +
      list(unscanned),
  );
}
if (uncollected.length > 0) {
  problems.push(
    `${uncollected.length} public method(s) of a \`Test*\` class were NOT COLLECTED by pytest and are not named in HELPERS:\n` +
      list(uncollected) +
      `\n\n      A public, non-fixture method of a test class is a test pytest runs or a helper named in\n` +
      `      HELPERS. This is what catches a method renamed OFF the \`test\` prefix inside a test class —\n` +
      `      pytest stops collecting it and a prefix-based walk stops seeing it, both at once — exactly\n` +
      `      the hole php's \`collectible\`/PROVIDERS check closes.`,
  );
}
if (staleHelpers.length > 0) {
  problems.push(
    `${staleHelpers.length} entry/entries in HELPERS no longer describe a helper — the method is gone, is no longer a public method of a \`Test*\` class, or is now COLLECTED as a test:\n` +
      list(staleHelpers),
  );
}
if (liveGone.length > 0) {
  problems.push(
    `${liveGone.length} test(s) listed in LIVE_TESTS are no longer live legs in the tree — deleted, renamed, or no longer in a file that reads a LITEDBMODEL_* gate:\n` +
      list(liveGone) +
      `\n\n      Nothing else notices this. A source scan cannot miss a test that is not there, and the\n` +
      `      four live files read the SAME LITEDBMODEL_TX_ISOLATION, so the declaration in\n` +
      `      ${GATES_ENV} stays alive and check-reachable-test-gates.mjs stays green.`,
  );
}
if (liveUnlisted.length > 0) {
  problems.push(
    `${liveUnlisted.length} live-DB test(s) exist under python/tests but are not in LIVE_TESTS, so deleting them would be silent. List them:\n` +
      list(liveUnlisted),
  );
}
if (cases.length === 0) problems.push('pytest reported no testcases at all — the suite never ran.');
exitProblem(run, label, problems);

// ── PHASE 2: the live legs really DIAL a database ───────────────────────────────────────────────────
//
// Everything above reads the OUTCOME of a run against a live server, and an outcome cannot distinguish a
// leg that queried the database from a leg whose body is empty: both pass. So the live legs are re-run
// against a database that is NOT THERE, with the gates still open. A leg that dials must FAIL or ERROR;
// one that PASSES never touched a server.
//
// Five of the 29 cannot take part yet: `test_conformance_corpus.py`'s legs go through the live corpus
// runner, whose pool BLOCKS FOREVER when no connection can be opened (#225 — the acquire has no
// timeout). Measured, one of them against 127.0.0.1:1: still running at 45s, killed, exit 124.
//
// They are not excluded by name. They are run under a TIMEOUT, and a timeout is tolerated only for them
// — so the day #225 is fixed and they answer instead of hanging, this gate says the allowance is stale
// and the exclusion lifts itself. That is the difference between an exemption and a measurement.
const HANGS = ['test_conformance_corpus.py::test_live_db_conformance_all_vectors_pass'];
const HANG_TIMEOUT_MS = 20_000;
const OFFLINE_CHECKS = [
  'test_conformance_corpus.py::test_corpus_carries_a_seeded_schema',
  'test_conformance_corpus.py::test_corpus_covers_both_live_dialects_with_the_same_cases',
  'test_conformance_corpus.py::test_corpus_is_the_supported_version',
  'test_conformance_corpus.py::test_every_vector_names_an_endpoint_the_generated_module_exposes',
];
const nodeId = (l) => `tests/${l}`;
if (problems.length === 0) {
  const dialling = LIVE_TESTS.filter((l) => !HANGS.includes(l) && !OFFLINE_CHECKS.includes(l));
  /** One phase-2 run: the ids, the report it wrote, and whether our own timeout killed it. */
  const rerun = async (ids, timeoutMs) => {
    const out = join(mkdtempSync(join(tmpdir(), 'litedbmodel-pytest-p2-')), 'junit.xml');
    const r = mustHaveStarted(
      await runOwned('python3', ['-m', 'pytest', '-q', `--junitxml=${out}`, ...ids.map(nodeId)], {
        cwd: PY_DIR,
        stdout: 'inherit',
        env: UNREACHABLE,
        timeoutMs,
      }),
      `${label} (unreachable database)`,
    );
    const verdicts = new Map();
    if (existsSync(out)) for (const c of junitTestcases(readFileSync(out, 'utf8'))) verdicts.set(labelOf(c), c.outcome);
    return { ...r, verdicts };
  };

  const p2 = await rerun([...dialling, ...OFFLINE_CHECKS], undefined);
  const passedWithoutServer = dialling.filter((l) => p2.verdicts.get(l) === 'passed');
  const noVerdict = [...dialling, ...OFFLINE_CHECKS].filter((l) => !p2.verdicts.has(l));
  const misclassified = OFFLINE_CHECKS.filter((l) => p2.verdicts.has(l) && p2.verdicts.get(l) !== 'passed');
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
      `${noVerdict.length} live-DB leg(s) reported NO verdict from the unreachable-database run, so nothing was learned about them — a set of node ids that matches nothing passes this check vacuously:\n` +
        list(noVerdict),
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
  const stale = [...HANGS, ...OFFLINE_CHECKS].filter((l) => !LIVE_TESTS.includes(l));
  if (stale.length > 0) {
    problems.push(`${stale.length} entry/entries in HANGS/OFFLINE_CHECKS are not in LIVE_TESTS, so they excuse nothing. Remove them:\n` + list(stale));
  }

  const probe = await rerun(HANGS, HANG_TIMEOUT_MS);
  const hangPassed = HANGS.filter((l) => probe.verdicts.get(l) === 'passed');
  if (hangPassed.length > 0) {
    problems.push(`${hangPassed.length} live-DB leg(s) PASSED with no database behind them:\n` + list(hangPassed));
  } else if (!probe.timedOut) {
    problems.push(
      `${HANGS.join(', ')} answered the unreachable-database run in under ${HANG_TIMEOUT_MS / 1000}s instead of hanging, so its timeout allowance is STALE — #225 (the python pool's acquire has no timeout) appears to be fixed.\n` +
        `      Delete HANGS/HANG_TIMEOUT_MS and let it run with the other ${dialling.length}. While the allowance\n` +
        `      stands, a hang in that leg is tolerated, and a hang is not a verdict.`,
    );
  }
  console.log(
    probe.timedOut
      ? `phase 2: ${dialling.length} live leg(s) re-run against ${UNREACHABLE.TEST_DB_HOST}:${UNREACHABLE.TEST_DB_PORT}, none passed; ${OFFLINE_CHECKS.length} offline checks passed there as they must; ${HANGS.length} still hangs (#225), killed at ${HANG_TIMEOUT_MS / 1000}s`
      : `phase 2: ${dialling.length + HANGS.length} live leg(s) re-run against ${UNREACHABLE.TEST_DB_HOST}:${UNREACHABLE.TEST_DB_PORT}, none passed`,
  );
}

report(
  problems,
  `✅ the live-DB gates ${GATES_ENV} declares were OPEN in this process before pytest started; each of the ` +
    `${declared.size} tests\n` +
    `   the tree declares (Python's own \`ast\`, every .py under python/tests, every \`test*\` in any class)\n` +
    `   reported a verdict in pytest's own --junitxml report — and every public method of a \`Test*\` class was\n` +
    `   collected or named in HELPERS, so a method renamed off the \`test\` prefix is red — and every one of the ${cases.length} testcases was a pass\n` +
    `   (${skipped.length} skipped, budget ${SKIP_BUDGET}); all ${LIVE_TESTS.length} live-DB legs listed in LIVE_TESTS are still present in the tree.\n` +
    `   ${LIVE_TESTS.length - HANGS.length - OFFLINE_CHECKS.length} of those legs were then re-run against an UNREACHABLE database (${UNREACHABLE.TEST_DB_HOST}:${UNREACHABLE.TEST_DB_PORT}) and NONE passed —\n` +
    `   so each really dials a server rather than passing on an empty body. The ${OFFLINE_CHECKS.length} in OFFLINE_CHECKS were\n` +
    `   required to PASS there instead (they read only the frozen corpus), and the ${HANGS.length} in HANGS is probed under a\n` +
    `   ${HANG_TIMEOUT_MS / 1000}s timeout because it HANGS against a dead server (#225) — which goes red the day it stops\n` +
    `   hanging, so that allowance cannot outlive its reason.\n` +
    `   Not proven, and it falls GREEN: that a leg ASSERTED anything useful about what it read. A body\n` +
    `   reduced to a bare connect dials, so it satisfies both phases.`,
);
