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
 * What must RUN, and what the run is checked against, both come from cargo — not from a hand-written
 * scan of the source, which #222 (A) is the standing lesson about: a regex over `.rs` UNDER-included
 * (it read `#[cfg_attr(any(), test)]` and `#[ test ]` as non-tests, so the tree it enforced quietly
 * dropped to 69 while 71 ran) and matched by the last `::` segment (so a test renamed onto a name that
 * exists in another module was answered by that one's verdict). Both are gone:
 *
 *   - the SET OF TARGETS is every lib/bin/integration target `cargo metadata` reports, selected by
 *     KIND rather than by the `test` flag — because `cargo test --lib` runs a target's tests even under
 *     `[lib] test = false` (measured: 71 listed AND 71 run with that line present), so keying off
 *     `t.test` was the one line that could drop a whole target's tests in SILENCE. Doc-tests are their
 *     own target, kept when `[lib] doctest = false` is absent and caught by EXPECTED_EMPTY when present.
 *   - the ROSTER each target must fully report is `cargo test <selector> -- --list`: rustc's own list
 *     AFTER it expands `cfg_attr`, so what is listed is exactly what will run. The run is checked
 *     against it by FULL PATH, both directions — a listed test with no verdict did not run, a verdict
 *     for an unlisted test is an unmodelled roster and red.
 *
 * A `path` re-point or a member drop leaves the target present-but-empty or gone, which the ZERO-tests
 * / EXPECTED_EMPTY checks and the LIVE_TESTS inventory (the only `tests/*.rs` here hold the live legs)
 * catch. What NO enumeration downstream of the build can see is a non-live unit test DELETED from the
 * source — it is gone from `--list` and the run alike; there are no such orphan files here (every unit
 * test is a `src/` module compiled by `--lib`), and LIVE_TESTS is the deletion backstop for the legs.
 *
 * It is red when any of the following holds, and prints its green line only when none does:
 *
 *   - a gate `livedb-gates.env` declares is not open in this process — checked before anything runs;
 *   - `cargo metadata`, `cargo clean`, a `cargo test -- --list` or a `cargo test` could not be started,
 *     or was killed by a signal;
 *   - a test its target's `-- --list` roster names that reported NO verdict from the run — an ambient
 *     filter, a `-- <name>`, or a panic between listing and running — or a verdict for a test the
 *     roster did not name (a wrong roster passes vacuously);
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
 * for it — every live leg panics on a refused connection — and it is also the only thing that can
 * catch a target aimed at a stub whose function NAMES match the real ones.
 *
 * Not proven, and it falls GREEN: that a leg asserted anything USEFUL about what it read. A body
 * reduced to a bare connect dials, so it satisfies both phases.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
  'isolation_retry_guard_and_nesting_mysql',
  'isolation_retry_guard_and_nesting_pg',
  'one_transaction_owns_one_connection_mysql',
  'one_transaction_owns_one_connection_pg',
  'phase_c_connection_routing_and_config',
  'tx_body_panic_leaves_no_open_transaction_mysql',
  'tx_body_panic_leaves_no_open_transaction_pg',
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
 * The set is every lib/bin/integration target `cargo metadata` reports, by KIND — NOT gated on the
 * `test` flag, because `cargo test --lib`/`--test`/`--bin` runs a target explicitly regardless of a
 * `test = false` in its manifest, so keying off `t.test` was the one line that could drop a whole
 * target in silence. Each unit's real roster is read from `-- --list` below.
 *
 * The doc-tests are their own target: `cargo test --doc` runs a lib's doc examples even when
 * `[lib] test = false` turns its unit tests off, and `[lib] doctest = false` drops the `--doc` unit,
 * which EXPECTED_EMPTY's `didNotRun` check catches.
 */
const packages = JSON.parse(metadata.stdout).packages;
const units = [];
for (const pkg of packages) {
  const features = 'livedb' in pkg.features ? ['--features', 'livedb'] : [];
  for (const t of pkg.targets) {
    const isLib = t.kind.includes('lib');
    const isBin = t.kind.includes('bin');
    const isIntegration = t.kind.includes('test');
    const crateDir = relative(ROOT, dirname(pkg.manifest_path)).split(sep).join('/');
    const src = relative(ROOT, t.src_path).split(sep).join('/');
    const live = sources(dirname(t.src_path)).some((f) => readsAGate(readFileSync(f, 'utf8')));
    // Every lib/bin/integration-test target is run EXPLICITLY (`--lib`/`--bin`/`--test`), which cargo
    // honours REGARDLESS of a `test = false` in the manifest — measured: `[lib] test = false` still
    // lists AND runs all 71 lib unit tests under `cargo test --lib`. Deriving the set from `t.test`
    // instead let that one line drop a whole target's tests SILENTLY; selecting by KIND neutralises it,
    // and `-- --list` below reads the target's real (post-cfg_attr) roster to check the run against.
    if (isLib || isBin || isIntegration) {
      const selector = isLib ? ['--lib'] : isBin ? ['--bin', t.name] : ['--test', t.name];
      units.push({ pkg: pkg.name, selector, features, live, src, crateDir, isLib });
    }
    // Doc-tests are a target of their own; `[lib] doctest = false` drops the `--doc` unit, which
    // EXPECTED_EMPTY's bidirectional `didNotRun` check catches (the entry names a unit that did not run).
    if (isLib && t.doctest) units.push({ pkg: pkg.name, selector: ['--doc'], features, live: false, src, crateDir, isLib });
  }
}

const problems = [];

assertGatesOpen('rust');

// #222 (A): freshness. Unlike go's `-count=1`, cargo will REPLAY a test binary built from source that
// has since changed — a `git status`-clean tree ran a stale binary and went green (binary 13:06 /
// source 07:00). So force a rebuild of just OUR crates (deps stay cached, so this is not a full clean):
// the very next `cargo test` compiles the current source before it can run anything.
const cleaned = mustHaveStarted(
  await runOwned('cargo', ['clean', '-p', 'litedbmodel_runtime', '-p', 'livedb_runner'], { cwd: RUST_DIR }),
  'cargo clean -p litedbmodel_runtime -p livedb_runner',
);
if (cleaned.exit !== 0) {
  console.error(`\n❌ \`cargo clean -p …\` exited ${cleaned.exit}, so a stale prebuilt test binary could still be run instead of the current source.`);
  process.exit(1);
}

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
// `cargo test <selector> -- --list` prints one `<full::module::path>: test` line per test and
// `<name>: benchmark` for benches. This is the target's roster AFTER rustc expands `cfg_attr`, so a
// `#[cfg_attr(any(), test)]` or a `#[ test ]` (which the old source regex miscounted) is listed exactly
// as it will run — measured: the roster falls 71→70 for one such edit. It is the independent
// enumeration replacing the hand-written `#[test]` scanner (#222 A): the SAME full paths libtest's
// VERDICT lines carry, so run and roster are matched EXACTLY, by full path — not by the last `::`
// segment, which let a renamed test be answered by a same-named one in another module.
const LIST = /^(\S.*): test$/gm;

const ran = [];
for (const unit of units) {
  const label = `cargo test -p ${unit.pkg} ${unit.selector.join(' ')}`;
  const args = ['--locked', '-p', unit.pkg, ...unit.features, ...unit.selector];
  // The roster FIRST, from the same selector+features, so a target compiled out of existence lists
  // nothing and the run below is checked against an empty roster rather than a guessed one.
  const listRun = mustHaveStarted(await runOwned('cargo', ['test', ...args, '--', '--list'], { cwd: RUST_DIR }), `${label} -- --list`);
  const listed = new Set([...listRun.stdout.matchAll(LIST)].map(([, name]) => name));
  const run = mustHaveStarted(await runOwned('cargo', ['test', ...args, '--', '--test-threads=1'], { cwd: RUST_DIR }), label);
  process.stdout.write(run.stdout);
  const summaries = [...run.stdout.matchAll(SUMMARY)].map((m) => m.slice(1).map(Number));
  const verdicts = [...run.stdout.matchAll(VERDICT)].map(([, name, verdict]) => ({ name, verdict }));
  ran.push({ ...unit, label, run, listRun, listed, summaries, verdicts });
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
  // The roster (`-- --list`) against what actually reported a verdict, matched by FULL PATH. libtest
  // reports a unit test by its module path and an integration test by its bare name, and `--list`
  // prints the SAME string, so a rename can no longer be answered by a same-named test elsewhere (the
  // last-`::`-segment match did exactly that). Both directions:
  const reported = new Set(unit.verdicts.map((v) => v.name));
  const unrun = [...unit.listed].filter((n) => !reported.has(n)).sort();
  const unlisted = [...reported].filter((n) => !unit.listed.has(n)).sort();
  if (unrun.length > 0) {
    problems.push(
      `${unrun.length} test(s) ${unit.label} LISTS were not reported by the run — listed, never executed:\n` +
        named(unrun) +
        `\n\n      \`cargo test ${unit.selector.join(' ')} -- --list\` names these, but the run's report has no\n` +
        `      \`test <name> ... <verdict>\` for them, so an ambient filter (RUSTFLAGS/argv \`-- <name>\`) or a\n` +
        `      panic between listing and running dropped them.`,
    );
  }
  if (unlisted.length > 0) {
    problems.push(
      `${unlisted.length} test(s) reported a verdict from ${unit.label} that \`-- --list\` did not name. The roster is wrong, and a run checked against a wrong roster passes vacuously — unmodelled ⇒ red:\n` +
        named(unlisted),
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
// rust needs no exceptions here: every live leg panics on a refused connection.
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
const totalListed = ran.reduce((n, u) => n + u.listed.size, 0);
report(
  problems,
  `✅ the live-DB gates ${GATES_ENV} declares were OPEN in this process before cargo test started; OUR crates were\n` +
    `   force-rebuilt (\`cargo clean -p …\`) so no stale binary ran, and each of the ${units.length} lib/bin/integration/doc\n` +
    `   targets for the ${new Set(units.map((u) => u.pkg)).size} package(s) \`cargo metadata\` reports — selected by KIND, so a \`test = false\`\n` +
    `   cannot drop one — was run SEPARATELY with \`--features livedb\` on every package that declares it. Every one\n` +
    `   of the ${totalListed} test(s) its \`-- --list\` roster names (rustc's own post-cfg_attr list) reported a verdict, matched\n` +
    `   by FULL PATH so a rename cannot borrow a same-named test's verdict, and each target's \`test result:\` counts\n` +
    `   match the verdict lines beside it: ${total} passed, 0 failed, 0 ignored (budget ${IGNORE_BUDGET}), 0 filtered out, and no target\n` +
    `   ran 0 tests except the ${EXPECTED_EMPTY.length} in EXPECTED_EMPTY. All ${LIVE_TESTS.length} live-DB legs in LIVE_TESTS were reported by a target whose\n` +
    `   sources read a gate — so the \`#![cfg(feature = "livedb")]\` files were COMPILED, which is what a\n` +
    `   \`cargo test\` without the feature silently stops doing.\n` +
    `   Each of the ${LIVE_TESTS.length} live-DB legs was then re-run against an UNREACHABLE database (${UNREACHABLE.TEST_DB_HOST}:${UNREACHABLE.TEST_DB_PORT}) and NONE\n` +
    `   of them passed — so each really dials a server rather than passing on an empty body, and no target\n` +
    `   was answering for one with a same-named stub.\n` +
    `   Not proven, and it falls GREEN: that a leg ASSERTED anything useful about what it read. A body\n` +
    `   reduced to a bare connect dials, so it satisfies both phases.`,
);
