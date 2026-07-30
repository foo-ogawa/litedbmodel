#!/usr/bin/env node
/**
 * The Rust suite's RUN GATE (#220) — the running counterpart of `check-reachable-test-gates.mjs`,
 * built on the same skeleton as the go one (`run-gate.mjs`).
 *
 *     npm run rust:test
 *
 * Rust's live-DB legs do not SKIP. They panic with the way to open the gate
 * (`tests/common/mod.rs:require_live_db`), which is stronger than a skip and is why a skip budget
 * would have found nothing here. What they do instead is CEASE TO EXIST:
 *
 *     $ cargo test -p litedbmodel_runtime          # the `--features livedb` dropped
 *     71 passed   +   0 passed  ×3                 exit 0
 *
 * Both live files open with `#![cfg(feature = "livedb")]`, so without the feature the two test
 * binaries compile to nothing at all and cargo reports `running 0 tests` — twice — and exits 0. Six
 * live tests, no skip, no failure, nothing to count. `RELEASING.md` said in prose that the feature
 * "is not optional"; nothing enforced it.
 *
 * So this OWNS the argv. The suite is not a command in a workflow that someone can narrow — it is
 * derived from `cargo metadata`, which is cargo's own answer to "what does this workspace contain":
 *
 *   - every PACKAGE in the workspace, not just `litedbmodel_runtime`. The canonical command was
 *     `cargo test -p litedbmodel_runtime --features livedb`, and a `-p` is a narrowing that no static
 *     check of the workflow text could ever call complete: `check-reachable-test-gates.mjs` could
 *     only ask for `cargo test`, which this repository does not run.
 *   - every TARGET that carries tests — the lib's unit tests, each `tests/*.rs`, each bin, and the
 *     lib's doc-tests — run ONE AT A TIME. libtest's report says `running N tests` with no mention of
 *     which binary it belongs to (cargo's `Running <path>` line goes to stderr, interleaved), so a
 *     single `cargo test` cannot attribute a count to a target; per-target invocations can, and that
 *     attribution is the whole point here — `0 tests` matters only when you know WHICH target it was.
 *   - `--features livedb` for every package that DECLARES that feature, from the manifest's own
 *     feature table rather than a literal in a workflow.
 *
 * A target reporting ZERO tests is therefore red unless it is named in {@link EXPECTED_EMPTY}, which
 * is bidirectional in both directions: a listed target that grows tests must be removed from the list,
 * and a listed target that stops being RUN is stale. That is the check the missing feature runs into.
 *
 * What `cargo metadata` alone could NOT see is a narrowing of the manifest itself, because that is the
 * same file. Measured: one line, `[lib] test = false`, and this gate ran 3 targets instead of 5 with
 * NOTHING said — the lib's 71 unit tests and the doc-tests simply left the set, which on a tree with a
 * live database is a green run of a suite missing 71 tests; `[lib] doctest = false` did it to `--doc`.
 * Modelling cargo's LAYOUT was not enough either, because a `path` is configurable: `[lib] path` aimed
 * at a renamed file, a `[[bin]]` under `src/bin/`, and a `[[test]]` aimed at a STUB with the right
 * function names each walked past a layout model. So the requirement comes from the SOURCE FILES
 * ({@link treeTests}): every `#[test]` function the tree holds must be reported by a unit that ran.
 * That is the independent enumeration the other four run gates have — go walks `go/**\/*_test.go`,
 * python and php parse every source file, TypeScript globs the tree — and this one did not.
 *
 * It is red when any of the following holds, and prints its green line only when none does:
 *
 *   - a gate `livedb-gates.env` declares is not open in this process — checked before anything runs;
 *   - `cargo metadata` or a `cargo test` could not be started, or was killed by a signal;
 *   - a `#[test]` function in the tree that NO unit which ran reported: a re-pointed `path`, a
 *     `test = false`, a dropped target, an `autotests = false`, a crate left out of `members`, or a
 *     target aimed at a stub — none of which changes the source files;
 *   - a target that reported NO `test result:` line: it did not build, or it did not run. A crate that
 *     fails to compile prints its errors to stderr and runs no test, and `0 targets ran` would
 *     otherwise be as green as a clean suite;
 *   - a target whose invocation printed MORE than one `test result:` line — the attribution this gate
 *     is built on would be wrong, and unmodelled ⇒ red;
 *   - a failing test, each NAMED;
 *   - an IGNORED test (`#[ignore]` is rust's spelling of a skip) — budget {@link IGNORE_BUDGET};
 *   - a non-zero `filtered out` count: something narrowed the set inside the binary (an ambient
 *     filter, a `-- <name>` this gate did not pass);
 *   - a target reporting `0 tests` that {@link EXPECTED_EMPTY} does not name — the missing-feature
 *     hole above — or a listed target that now HAS tests, so the list cannot rot into a rubber stamp;
 *   - the summary's own counts disagreeing with the `test <name> ... <verdict>` lines counted beside
 *     them: this gate reads libtest's human report, and a report it only half-understands is red;
 *   - `LIVE_TESTS` disagreeing with the tree in EITHER direction: a listed leg gone (deleted, renamed,
 *     or no longer in a target whose sources read a gate), or a new live leg not listed;
 *   - a `cargo test` exiting non-zero for a reason none of the above explains. Unmodelled ⇒ red.
 *
 * Then PHASE 2, at the bottom of this file: every unit whose sources read a gate is re-run against a
 * database that is NOT THERE, and a test that PASSES anyway never dialled one. rust needs no exceptions
 * for it — all six live legs panic on a refused connection — and it is also the only thing that can
 * catch a target aimed at a stub whose function NAMES match the real ones.
 *
 * Not proven, and it falls GREEN: that a leg asserted anything USEFUL about what it read. A body
 * reduced to a bare connect dials, so it satisfies both phases.
 */
import { globSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGatesOpen, runOwned, mustHaveStarted, exitProblem, report, UNREACHABLE } from './run-gate.mjs';
import { GATES_ENV, readsAGate } from './livedb-gates.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUST_DIR = join(ROOT, 'rust');

/**
 * How many rust tests may be `#[ignore]`d. ZERO: an ignored test is one that does not run, and the
 * live legs are gated by a panic-if-closed helper rather than by `#[ignore]`, so nothing here needs
 * it. Raising this is a decision about coverage, not a formality: name the tests and why.
 */
const IGNORE_BUDGET = 0;

/**
 * The targets that legitimately report `running 0 tests`, as `<package> <selector>`. Every other
 * target reporting zero is the #220 hole — a test file compiled out of existence.
 *
 * BIDIRECTIONAL: a target listed here that now HAS tests is red too, because the entry would
 * otherwise go on excusing a later emptying of it.
 *
 *   litedbmodel_runtime --doc   the crate carries no ``` examples; `cargo test --doc` runs nothing.
 *   livedb_runner --bin …       the live-DB conformance HARNESS (a litedbmodel consumer). Its
 *                               correctness is checked by running it — `npm run conformance:livedb`
 *                               and `npm run rust:dispatch:check` — not by `#[test]`s.
 */
const EXPECTED_EMPTY = ['litedbmodel_runtime --doc', 'livedb_runner --bin livedb_runner'];

/**
 * The live-DB legs, by name — the tests that only mean anything with a real PG/MySQL behind them,
 * and the ones whose disappearance is invisible: cargo cannot miss a test that is not there.
 *
 * Derived, not guessed: exactly the tests libtest lists for a target whose sources read a
 * `LITEDBMODEL_*` gate. The check below is bidirectional against that derivation, so adding a live
 * leg without listing it here is red too.
 *
 * Removing a name is a decision about coverage, not a formality: say which test and why.
 */
const LIVE_TESTS = [
  'd1_live_concurrent_scope_isolation',
  'd1_live_middleware_intercepts_every_seam_statement',
  'd1_live_runtime_tx_boundaries_are_middleware_visible',
  'd1_red_live_without_registration_nothing_observed',
  'd3_live_raw_execute_query_through_seam_and_logger',
  'phase_c_connection_routing_and_config',
];

/** Every `.rs` under `dir` — a target is LIVE when any source in its own tree reads a gate. */
function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e === 'target' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (e.endsWith('.rs')) out.push(p);
  }
  return out;
}

const metadata = mustHaveStarted(
  await runOwned('cargo', ['metadata', '--no-deps', '--format-version', '1', '--locked'], { cwd: RUST_DIR }),
  'cargo metadata',
);
if (metadata.exit !== 0) {
  console.error(`\n❌ \`cargo metadata\` exited ${metadata.exit} — the set of packages and targets to run is unknown, so nothing below can be checked.`);
  process.exit(1);
}

/**
 * One entry per thing to run: the package, the target selector cargo needs to run JUST that target, the
 * source root it compiles, and whether its sources read a gate.
 *
 * `test: true` / `doctest: true` are cargo's own flags for "this target is compiled as a test harness",
 * so this is what the MANIFEST says there is to run — and the manifest is the same file a narrowing
 * goes into. It is checked against {@link treeTests}, which reads the source files.
 *
 * The doc-tests are pushed independently of `test`, because they are a separate question: `cargo test
 * --doc` runs a lib's doc examples even when `[lib] test = false` turns its unit tests off, so treating
 * `doctest` as reachable only through `test` modelled cargo wrongly and lost `--doc` along with `--lib`.
 */
const packages = JSON.parse(metadata.stdout).packages;
const units = [];
for (const pkg of packages) {
  const features = 'livedb' in pkg.features ? ['--features', 'livedb'] : [];
  for (const t of pkg.targets) {
    const isLib = t.kind.includes('lib');
    const crateDir = relative(ROOT, dirname(pkg.manifest_path)).split(sep).join('/');
    const src = relative(ROOT, t.src_path).split(sep).join('/');
    const live = sources(dirname(t.src_path)).some((f) => readsAGate(readFileSync(f, 'utf8')));
    if (t.test) {
      const selector = isLib ? ['--lib'] : t.kind.includes('bin') ? ['--bin', t.name] : ['--test', t.name];
      units.push({ pkg: pkg.name, selector, features, live, src, crateDir, isLib });
    }
    if (isLib && t.doctest) units.push({ pkg: pkg.name, selector: ['--doc'], features, live: false, src, crateDir, isLib });
  }
}

/**
 * Every `#[test]` function the TREE holds, as file → the names in it. The independent enumeration, and
 * the thing the manifest is checked against.
 *
 * Modelling cargo's LAYOUT instead was not enough, because a path is configurable. Measured on the
 * version before this, each on its own:
 *
 *     [lib] test = false                      3 targets ran, not 5 — the lib's 71 unit tests and the
 *                                             doc-tests left the set in SILENCE
 *     [lib] path = "src/runtime.rs" + the     no requirement was even computed: the layout rule asked
 *       file renamed, test = false            whether `src/lib.rs` EXISTS, and it no longer did
 *     [[bin]] path = "src/bin/extra.rs"       `src/bin/*.rs` was not one of the four rules modelled,
 *       test = false                          and `--bin` matching accepted ANY bin, so a second bin
 *                                             losing its tests was invisible
 *     autotests = false + [[test]] pointed    the real live files were never compiled while stub files
 *       at stubs with the same fn names       carrying the same six names satisfied every name check
 *
 * All four are one hole: the set of things to run was derived from the manifest, and every one of those
 * lines is IN the manifest. So the requirement now comes from the source files themselves — a file
 * holding `#[test]` functions must be OWNED by a unit that ran, and that unit must have reported those
 * names. Renaming a path, dropping a target, or aiming one at a stub all leave the real file with no
 * unit that reported its tests.
 *
 * `#[test]` is matched only at the START of a line, then the first `fn <name>` after it. Not a count of
 * the attribute: `tests/connection_routing.rs:1128` is the comment "── The single #[test] entry", so
 * counting attributes says 2 where there is 1 — #222 (A)'s lesson in one line. Anchoring at line start
 * excludes `//`, `///` and `*` comment bodies. A line inside a raw string that begins with `#[test]`
 * would over-include, which demands a name that never reports: RED, the safe direction.
 */
const TEST_FN = /^[^\S\n]*#\[test\][\s\S]*?\bfn\s+([A-Za-z0-9_]+)/gm;

const problems = [];
/** file (repository-relative) → the `#[test]` names it declares. */
const treeTests = new Map();
for (const file of globSync('rust/**/*.rs', { cwd: ROOT })) {
  const rel = file.split(sep).join('/');
  if (rel.includes('/target/')) continue;
  const names = new Set([...readFileSync(join(ROOT, rel), 'utf8').matchAll(TEST_FN)].map(([, n]) => n));
  if (names.size > 0) treeTests.set(rel, names);
}

assertGatesOpen('rust');

/**
 * libtest's own report, per target.
 *
 * `test result:` and the `test <name> ... <verdict>` lines are the runner's OUTPUT, not this
 * repository's reading of its source — but they are a human format, so the two are cross-checked
 * against each other: the summary's passed/failed/ignored must equal the verdict lines counted
 * beside it. A libtest that reported them differently would be red rather than half-read.
 */
const SUMMARY = /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored; \d+ measured; (\d+) filtered out/gm;
const VERDICT = /^test (\S+) \.\.\. (ok|FAILED|ignored)/gm;

const ran = [];
for (const unit of units) {
  const label = `cargo test -p ${unit.pkg} ${unit.selector.join(' ')}`;
  const run = mustHaveStarted(
    await runOwned(
      'cargo',
      ['test', '--locked', '-p', unit.pkg, ...unit.features, ...unit.selector, '--', '--test-threads=1'],
      { cwd: RUST_DIR },
    ),
    label,
  );
  process.stdout.write(run.stdout);
  const summaries = [...run.stdout.matchAll(SUMMARY)].map((m) => m.slice(1).map(Number));
  const verdicts = [...run.stdout.matchAll(VERDICT)].map(([, name, verdict]) => ({ name, verdict }));
  ran.push({ ...unit, label, run, summaries, verdicts });
}

const named = (rows) => rows.map((r) => `      ${r}`).join('\n');
for (const unit of ran) {
  if (unit.summaries.length === 0) {
    problems.push(
      `${unit.label} reported no \`test result:\` line at all — the target did not build, or did not run. A crate that fails to compile writes its errors to stderr and runs NO test, so the counts of the targets that did compile say nothing about this one.`,
    );
    continue;
  }
  if (unit.summaries.length > 1) {
    problems.push(
      `${unit.label} printed ${unit.summaries.length} \`test result:\` lines for what should be ONE target, so this gate cannot attribute its counts. Unmodelled ⇒ red.`,
    );
    continue;
  }
  const [passed, failed, ignored, filtered] = unit.summaries[0];
  const failures = unit.verdicts.filter((v) => v.verdict === 'FAILED');
  const ignores = unit.verdicts.filter((v) => v.verdict === 'ignored');
  const selector = `${unit.pkg} ${unit.selector.join(' ')}`;
  if (failed > 0) problems.push(`${failed} rust test(s) FAILED in ${unit.label}:\n` + named(failures.map((v) => v.name)));
  if (ignored > IGNORE_BUDGET) {
    problems.push(
      `${ignored} rust test(s) IGNORED in ${unit.label}, budget ${IGNORE_BUDGET}. \`#[ignore]\` is rust's spelling of a skip, and a skipped test is not a passing test:\n` +
        named(ignores.map((v) => v.name)),
    );
  }
  if (filtered > 0) {
    problems.push(
      `${filtered} rust test(s) were FILTERED OUT in ${unit.label} — something narrowed the set inside the binary. This gate passes no name filter, so it did not come from here (check an ambient RUSTFLAGS/argv).`,
    );
  }
  if (passed + failed + ignored === 0 && !EXPECTED_EMPTY.includes(selector)) {
    problems.push(
      `${unit.label} ran 0 TESTS, and EXPECTED_EMPTY does not name it. A target that compiles to no tests is not a passing target:\n` +
        `      This is exactly what dropping \`--features livedb\` does — both live files open with\n` +
        `      \`#![cfg(feature = "livedb")]\`, so the binaries build empty and cargo exits 0. If the\n` +
        `      target is legitimately empty, add "${selector}" to EXPECTED_EMPTY and say why.`,
    );
  }
  if (passed + failed + ignored > 0 && EXPECTED_EMPTY.includes(selector)) {
    problems.push(
      `${unit.label} is listed in EXPECTED_EMPTY but now reports ${passed + failed + ignored} test(s). Remove it from that list — while it is there, a later emptying of this target would be excused.`,
    );
  }
  if (passed + failed + ignored !== unit.verdicts.length) {
    problems.push(
      `${unit.label}'s summary counts ${passed} passed + ${failed} failed + ${ignored} ignored, but ${unit.verdicts.length} \`test … ok/FAILED/ignored\` line(s) were found beside it. This gate reads libtest's human report, and a report it only half-understands is red, not green.`,
    );
  }
}

// Every `#[test]` the TREE holds was reported by a unit that RAN. The manifest says what to run; this
// says what there IS to run, and the two are only both wrong if someone edits the source too.
//
// A file's owner is the unit whose target source IS that file (a `tests/*.rs`, a `src/main.rs`, a
// `src/bin/*.rs`, `src/lib.rs` itself) or — for the submodules a crate root pulls in with `mod`, which
// is where 71 of this workspace's 76 tests live — any unit of the same crate rooted in the same
// directory tree. So `src/tx_options.rs` is owned by `--lib`, and a `[lib] path` pointing elsewhere
// does not change that: it is still the crate's only src-rooted unit.
for (const [file, names] of [...treeTests].sort()) {
  // A top-level `tests/*.rs` IS a target of its own by cargo's rules, so it must be owned EXACTLY —
  // by a unit whose source is that very file. Directory ownership alone let a `[[test]]` re-pointed at
  // a SIBLING stub carrying the same `fn` names answer for it, since both sit in `tests/`. Files in a
  // subdirectory (`tests/common/mod.rs`) are modules of some target, and files under `src/` are modules
  // of the crate root, so those are owned by any unit rooted above them.
  const owners = /^rust\/[^/]+\/tests\/[^/]+\.rs$/.test(file)
    ? ran.filter((u) => u.src === file)
    : ran.filter((u) => u.src === file || file.startsWith(`${dirname(u.src)}/`));
  // libtest reports a unit test by its MODULE PATH (`connection_routing::tests::resolve_defaults`) and
  // an integration test by its bare name, so the tree's `fn` name is matched against the last segment.
  const reported = new Set(owners.flatMap((u) => u.verdicts.map((v) => v.name.split('::').pop())));
  const missing = [...names].filter((n) => !reported.has(n)).sort();
  if (missing.length > 0) {
    problems.push(
      `${missing.length} \`#[test]\` function(s) in ${file} were reported by NO unit that ran, so nothing executed them:\n` +
        missing.map((n) => `      ${n}`).join('\n') +
        `\n\n      ${owners.length === 0 ? 'NO unit compiles that file at all' : `the unit(s) that compile it (${owners.map((u) => u.selector.join(' ')).join(', ')}) reported other names`}.\n` +
        `      A \`test = false\`, a re-pointed \`path\`, a dropped \`[[test]]\`/\`[[bin]]\`, an \`autotests =\n` +
        `      false\`, a crate left out of \`members\`, or a target aimed at a STUB carrying the same\n` +
        `      function names all look exactly like this — and none of them changes the tree.`,
    );
  }
}

// The other half of EXPECTED_EMPTY's bidirectionality: an entry naming a unit that did not RUN is
// stale, and it was silent. Measured on the version before this: `[lib] doctest = false` removed the
// `--doc` unit from the set entirely, and the entry excusing its emptiness went on standing while the
// green line kept saying "the 2 in EXPECTED_EMPTY" — an entry that excuses a target nobody runs.
const didNotRun = EXPECTED_EMPTY.filter((e) => !ran.some((u) => `${u.pkg} ${u.selector.join(' ')}` === e));
if (didNotRun.length > 0) {
  problems.push(
    `${didNotRun.length} entry/entries in EXPECTED_EMPTY name a unit that did not run at all:\n` +
      didNotRun.map((e) => `      ${e}`).join('\n') +
      `\n\n      An entry only means "this target runs and is legitimately empty". If the target is gone,\n` +
      `      remove the entry; if it stopped being reported, that is the hole above, not an exemption.`,
  );
}

// AFTER the per-target analysis, never inside the run loop: `exitProblem` reports an exit code that
// nothing else explains, and "nothing else" is only known once every target has been read. Called
// from inside the loop it announced `exited 101 while everything this gate reads reported success`
// for the target whose own failing test was about to be named two lines later.
for (const unit of ran) exitProblem(unit.run, unit.label, problems);

/** Live legs as the TREE has them now (targets whose sources read a gate), for the LIVE_TESTS check. */
const liveInTree = new Set(ran.filter((u) => u.live).flatMap((u) => u.verdicts.map((v) => v.name)));
const liveGone = LIVE_TESTS.filter((n) => !liveInTree.has(n));
const liveUnlisted = [...liveInTree].filter((n) => !LIVE_TESTS.includes(n)).sort();
if (liveGone.length > 0) {
  problems.push(
    `${liveGone.length} test(s) listed in LIVE_TESTS were not reported by any target whose sources read a LITEDBMODEL_* gate — deleted, renamed, or compiled out:\n` +
      named(liveGone) +
      `\n\n      Nothing else notices this. Both live files read a gate of their own, so removing one\n` +
      `      leaves the declarations in ${GATES_ENV} alive and check-reachable-test-gates.mjs green.`,
  );
}
if (liveUnlisted.length > 0) {
  problems.push(
    `${liveUnlisted.length} live-DB test(s) exist under rust/ but are not in LIVE_TESTS, so deleting them would be silent. List them:\n` + named(liveUnlisted),
  );
}

// ── PHASE 2: the live legs really DIAL a database ───────────────────────────────────────────────────
//
// Everything above reads the OUTCOME of a run against a live server, and an outcome cannot distinguish a
// leg that queried the database from a leg whose body is empty: both pass. So every unit whose sources
// read a gate is re-run against a database that is NOT THERE. A leg that dials must FAIL; one that
// PASSES never touched a server, whatever its body claims — which is also the only thing that can catch
// a target aimed at a stub whose function names match the real ones.
//
// rust needs no exceptions here: all six live legs panic on a refused connection.
if (problems.length === 0) {
  for (const unit of ran.filter((u) => u.live && u.verdicts.length > 0)) {
    const run = mustHaveStarted(
      await runOwned('cargo', ['test', '--locked', '-p', unit.pkg, ...unit.features, ...unit.selector, '--', '--test-threads=1'], {
        cwd: RUST_DIR,
        env: UNREACHABLE,
      }),
      `${unit.label} (unreachable database)`,
    );
    const verdicts = [...run.stdout.matchAll(VERDICT)];
    const passedWithoutServer = verdicts.filter(([, , v]) => v === 'ok').map(([, n]) => n);
    const noVerdict = unit.verdicts.filter((v) => !verdicts.some(([, n]) => n === v.name)).map((v) => v.name);
    if (passedWithoutServer.length > 0) {
      problems.push(
        `${passedWithoutServer.length} live-DB test(s) in ${unit.label} PASSED with no database behind them (${UNREACHABLE.TEST_DB_HOST}:${UNREACHABLE.TEST_DB_PORT} refuses every connection). A test that passes without a server never dialled one, so its green above says nothing about a live database:\n` +
          named(passedWithoutServer) +
          `\n\n      An emptied body, a removed assertion block, a connect that is never made, and a target\n` +
          `      pointed at a STUB with the right function names all look exactly like this.`,
      );
    }
    if (noVerdict.length > 0) {
      problems.push(
        `${noVerdict.length} live-DB test(s) reported no verdict from ${unit.label} against an unreachable database, so nothing was learned about them:\n` + named(noVerdict),
      );
    }
  }
}

const total = ran.reduce((n, u) => n + (u.summaries[0]?.[0] ?? 0), 0);
report(
  problems,
  `✅ the live-DB gates ${GATES_ENV} declares were OPEN in this process before cargo test started; every one of\n` +
    `   the ${[...treeTests.values()].reduce((n, s) => n + s.size, 0)} \`#[test]\` functions in the ${treeTests.size} source files under rust/ that hold one was REPORTED by a\n` +
    `   unit that ran (so no target was re-pointed, dropped, switched off or aimed at a stub), and each of the\n` +
    `   ${units.length} test-carrying targets for the ${new Set(units.map((u) => u.pkg)).size} package(s) \`cargo metadata\`\n` +
    `   reports — lib unit tests,\n` +
    `   every tests/*.rs, every bin and the doc-tests — was run SEPARATELY, with \`--features livedb\` on every\n` +
    `   package that declares it, and every one reported a \`test result:\` line whose counts match the verdict\n` +
    `   lines beside it: ${total} passed, 0 failed, 0 ignored (budget ${IGNORE_BUDGET}), 0 filtered out, and no target ran 0 tests\n` +
    `   except the ${EXPECTED_EMPTY.length} in EXPECTED_EMPTY. All ${LIVE_TESTS.length} live-DB legs in LIVE_TESTS were reported by a target whose\n` +
    `   sources read a gate — so the \`#![cfg(feature = "livedb")]\` files were COMPILED, which is what a\n` +
    `   \`cargo test\` without the feature silently stops doing.\n` +
    `   Each of the ${LIVE_TESTS.length} live-DB legs was then re-run against an UNREACHABLE database (${UNREACHABLE.TEST_DB_HOST}:${UNREACHABLE.TEST_DB_PORT}) and NONE\n` +
    `   of them passed — so each really dials a server rather than passing on an empty body, and no target\n` +
    `   was answering for one with a same-named stub.\n` +
    `   Not proven, and it falls GREEN: that a leg ASSERTED anything useful about what it read. A body\n` +
    `   reduced to a bare connect dials, so it satisfies both phases.`,
);
