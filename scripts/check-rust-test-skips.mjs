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
 * So the set to run is also derived from the TREE, by cargo's own layout rules ({@link requiredUnits}),
 * which is the independent enumeration the other four run gates have — go walks `go/**\/*_test.go`,
 * python and php parse every source file, TypeScript globs the tree — and this one did not.
 *
 * It is red when any of the following holds, and prints its green line only when none does:
 *
 *   - a gate `livedb-gates.env` declares is not open in this process — checked before anything runs;
 *   - `cargo metadata` or a `cargo test` could not be started, or was killed by a signal;
 *   - a unit the TREE requires that the manifest does not report, or a crate under `rust/` that is not
 *     a workspace member and not named in {@link NOT_A_MEMBER} (nor the reverse of either);
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
 * Not proven, and it falls GREEN: that a live leg TOUCHED a database. An outcome cannot tell a leg
 * that queried PG from one whose body is empty — both pass. The go and python gates re-run their live legs against an
 * unreachable database to close that; rust has no equivalent yet.
 */
import { existsSync, globSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGatesOpen, runOwned, mustHaveStarted, exitProblem, report } from './run-gate.mjs';
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
 * One entry per thing to run: the package, the target selector cargo needs to run JUST that target,
 * and whether its sources read a gate.
 *
 * `test: true` / `doctest: true` are cargo's own flags for "this target is compiled as a test
 * harness", so this is what the MANIFEST says there is to run — and the manifest is the same file a
 * narrowing goes into. It is checked against {@link requiredUnits}, which reads the tree.
 */
const packages = JSON.parse(metadata.stdout).packages;
const units = [];
for (const pkg of packages) {
  const features = 'livedb' in pkg.features ? ['--features', 'livedb'] : [];
  for (const t of pkg.targets) {
    if (!t.test) continue;
    const selector = t.kind.includes('lib') ? ['--lib'] : t.kind.includes('bin') ? ['--bin', t.name] : ['--test', t.name];
    const tree = dirname(t.src_path);
    const live = sources(tree).some((f) => readsAGate(readFileSync(f, 'utf8')));
    units.push({ pkg: pkg.name, selector, features, live });
    if (t.kind.includes('lib') && t.doctest) units.push({ pkg: pkg.name, selector: ['--doc'], features, live: false });
  }
}

/**
 * Crates under `rust/` that are deliberately NOT workspace members, so no `cargo test` here runs
 * them. BIDIRECTIONAL: one that becomes a member must be removed from this list.
 *
 * The three `orm_bench*` crates are standalone bench consumers, built and run by
 * `benchmark/crosslang/` on their own; `rust/Cargo.toml` is the workspace manifest itself and has no
 * `[package]`.
 */
const NOT_A_MEMBER = ['rust/Cargo.toml', 'rust/orm_bench/Cargo.toml', 'rust/orm_bench_common/Cargo.toml', 'rust/orm_bench_sdk/Cargo.toml'];

/**
 * The units cargo's own LAYOUT rules require of a crate directory — read from the TREE, which is the
 * independent enumeration every other run gate in this repository has and this one did not.
 *
 * Deriving the set from `cargo metadata` alone made the manifest both the thing that says what to run
 * and the thing a narrowing goes into, so a narrowing was invisible. Measured on the version before
 * this: one line, `[lib] test = false`, and only 3 targets ran — the lib's 71 unit tests and the
 * doc-tests dropped out of the set with NOTHING said about them, and on a tree with a live database
 * (where the live legs pass) that is a GREEN run of a suite missing 71 tests. `doctest = false` did
 * the same to `--doc`. `autotests = false` and a deleted `[[test]]` are the same shape.
 *
 * Cargo's rules, so the tree alone decides: `src/lib.rs` is the lib (and its doc-tests), `src/main.rs`
 * is a bin, every top-level `tests/*.rs` and every `tests/<dir>/main.rs` is an integration test.
 * `tests/common/mod.rs` is NOT one — a subdirectory without `main.rs` is a module, which is why the
 * shared `require_live_db` helper lives there.
 *
 * A unit the manifest declares that the tree does not predict is NOT a problem — a `[[test]]` at a
 * custom path still has to run, and it does. Only the reverse direction is a hole.
 */
function requiredUnits(crateDir) {
  const required = [];
  if (existsSync(join(crateDir, 'src', 'lib.rs'))) required.push('--lib', '--doc');
  if (existsSync(join(crateDir, 'src', 'main.rs'))) required.push('--bin');
  const testsDir = join(crateDir, 'tests');
  if (existsSync(testsDir)) {
    for (const e of readdirSync(testsDir)) {
      if (e.endsWith('.rs')) required.push(`--test ${e.slice(0, -3)}`);
      else if (statSync(join(testsDir, e)).isDirectory() && existsSync(join(testsDir, e, 'main.rs'))) required.push(`--test ${e}`);
    }
  }
  return required;
}

const problems = [];
/** Crate directory → the package `cargo metadata` reports for it, for the tree-vs-manifest check. */
const crates = new Map(packages.map((p) => [dirname(p.manifest_path), p]));
for (const manifest of globSync('rust/**/Cargo.toml', { cwd: ROOT }).sort()) {
  const rel = manifest.split(sep).join('/');
  if (rel.includes('/target/')) continue;
  const isMember = crates.has(join(ROOT, dirname(rel)));
  if (!isMember && !NOT_A_MEMBER.includes(rel)) {
    problems.push(
      `${rel} is a crate that \`cargo metadata\` does not report as a workspace member, so NO test of it runs here.\n` +
        `      Add it to \`members\` in rust/Cargo.toml, or to NOT_A_MEMBER in this file with the reason\n` +
        `      nothing needs to test it.`,
    );
  }
  if (isMember && NOT_A_MEMBER.includes(rel)) {
    problems.push(`${rel} is listed in NOT_A_MEMBER but IS a workspace member now. Remove it from that list — while it is there, dropping it from \`members\` again would be silent.`);
  }
}
for (const [crateDir, pkg] of crates) {
  const actual = units.filter((u) => u.pkg === pkg.name).map((u) => u.selector.join(' '));
  const missing = requiredUnits(crateDir).filter((r) => (r === '--bin' ? !actual.some((a) => a.startsWith('--bin ')) : !actual.includes(r)));
  if (missing.length > 0) {
    problems.push(
      `${missing.length} test unit(s) the TREE requires of ${relative(ROOT, crateDir)} are not in what \`cargo metadata\` reports, so nothing runs them:\n` +
        missing.map((m) => `      cargo test -p ${pkg.name} ${m}`).join('\n') +
        `\n\n      cargo's layout says these exist (src/lib.rs is the lib and its doc-tests, src/main.rs a\n` +
        `      bin, every tests/*.rs an integration test). A \`[lib] test = false\`, a \`doctest = false\`,\n` +
        `      an \`autotests = false\` or a deleted \`[[test]]\` removes one from the manifest's answer\n` +
        `      while leaving the tests themselves in the tree — measured, \`[lib] test = false\` alone\n` +
        `      dropped 71 unit tests from this gate's set in silence.`,
    );
  }
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

const total = ran.reduce((n, u) => n + (u.summaries[0]?.[0] ?? 0), 0);
report(
  problems,
  `✅ the live-DB gates ${GATES_ENV} declares were OPEN in this process before cargo test started; every crate\n` +
    `   under rust/ is a workspace member or named as deliberately outside it, every test unit cargo's LAYOUT\n` +
    `   RULES require of each member's tree is one the manifest reports, and each of the ${units.length} test-carrying\n` +
    `   targets for the ${new Set(units.map((u) => u.pkg)).size} package(s) — lib unit tests,\n` +
    `   every tests/*.rs, every bin and the doc-tests — was run SEPARATELY, with \`--features livedb\` on every\n` +
    `   package that declares it, and every one reported a \`test result:\` line whose counts match the verdict\n` +
    `   lines beside it: ${total} passed, 0 failed, 0 ignored (budget ${IGNORE_BUDGET}), 0 filtered out, and no target ran 0 tests\n` +
    `   except the ${EXPECTED_EMPTY.length} in EXPECTED_EMPTY. All ${LIVE_TESTS.length} live-DB legs in LIVE_TESTS were reported by a target whose\n` +
    `   sources read a gate — so the \`#![cfg(feature = "livedb")]\` files were COMPILED, which is what a\n` +
    `   \`cargo test\` without the feature silently stops doing.\n` +
    `   Not proven, and it falls GREEN: that a live leg TOUCHED a database. An emptied body passes an\n` +
    `   outcome check the same way a real query does — the go and python gates re-run theirs against an unreachable\n` +
    `   server to close that, and rust has no equivalent yet.`,
);
