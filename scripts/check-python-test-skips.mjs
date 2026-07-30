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
 * The scan is deliberately WIDER than pytest's own collection rules — every `test*` function in every
 * class, not only `Test*` classes — so a test pytest would not collect is RED here rather than
 * silently absent. It errs loud.
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
 * Not proven, and it falls GREEN: that a live leg TOUCHED a database. An outcome cannot tell a leg
 * that queried PG from one whose body is empty — both pass. Go's gate re-runs its live legs against
 * an unreachable database to close that; here it is open, and it is the reason the green line below
 * says the legs were ENABLED rather than that they ran against a server.
 */
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertGatesOpen, runOwned, mustHaveStarted, exitProblem, junitTestcases, report } from './run-gate.mjs';
import { GATES_ENV } from './livedb-gates.mjs';

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
 * Every `def test*` the tree declares, as `<file relative to tests/>::<Class…>::<name>`, asked of
 * Python's own parser rather than of a regex.
 *
 * EVERY `.py` under tests/ is walked, and `test*` functions in ANY class are reported — both wider
 * than pytest's `python_files`/`python_classes` patterns, so a file or class that pytest has stopped
 * collecting is RED here instead of quietly absent.
 */
const AST_WALK = `
import ast, json, os, sys
root = sys.argv[1]
out = []

def walk(node, rel, prefix):
    for child in node.body:
        if isinstance(child, ast.ClassDef):
            walk(child, rel, prefix + [child.name])
        elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and child.name.startswith("test"):
            out.append("::".join([rel] + prefix + [child.name]))

for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "__pycache__"]
    for name in sorted(filenames):
        if not name.endswith(".py"):
            continue
        path = os.path.join(dirpath, name)
        with open(path, encoding="utf-8") as fh:
            source = fh.read()
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        walk(ast.parse(source, filename=path), rel, [])

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
/** `<file>::<Class…>::<name>` → the label, and the set of files that hold at least one test. */
const declared = new Set(JSON.parse(enumeration.stdout));
const files = new Set([...declared].map((l) => l.split('::')[0]));
/** Live legs as the TREE has them now, for the bidirectional check against `LIVE_TESTS`. */
const liveInTree = new Set(
  [...declared].filter((l) => /LITEDBMODEL_[A-Z0-9_]+/.test(readFileSync(join(TESTS_DIR, l.split('::')[0]), 'utf8'))),
);

assertGatesOpen('python');

const junit = join(mkdtempSync(join(tmpdir(), 'litedbmodel-pytest-')), 'junit.xml');
const label = 'python3 -m pytest';
const run = mustHaveStarted(
  await runOwned('python3', ['-m', 'pytest', '-q', `--junitxml=${junit}`], { cwd: PY_DIR, stdout: 'inherit' }),
  label,
);

const problems = [];
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

report(
  problems,
  `✅ the live-DB gates ${GATES_ENV} declares were OPEN in this process before pytest started; each of the ` +
    `${declared.size} tests\n` +
    `   the tree declares (Python's own \`ast\`, every .py under python/tests, every \`test*\` in any class)\n` +
    `   reported a verdict in pytest's own --junitxml report, and every one of the ${cases.length} testcases was a pass\n` +
    `   (${skipped.length} skipped, budget ${SKIP_BUDGET}); all ${LIVE_TESTS.length} live-DB legs listed in LIVE_TESTS are still present in the tree.\n` +
    `   Not proven, and it falls GREEN: that a live leg TOUCHED a database. An emptied body passes an\n` +
    `   outcome check the same way a real query does — go's gate re-runs its legs against an unreachable\n` +
    `   server to close that, and python has no equivalent yet.`,
);
