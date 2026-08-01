#!/usr/bin/env node
/**
 * Unreachable-test-gate detector (#168).
 *
 * A test that skips itself unless an environment variable is set is only as real as the CI that sets
 * it, and a language whose test runner CI never invokes is not tested at all. Both holes were open
 * here at once: no workflow named a single `LITEDBMODEL_*` gate, and no workflow ran pytest, phpunit,
 * go test or cargo test — so the tx isolation, tx boundary, connection routing and middleware suites
 * in four languages reported green while never executing.
 *
 * The invariant, in five clauses:
 *
 *   A. Every `LITEDBMODEL_*` gate a test reads is declared in `livedb-gates.env`, and every variable
 *      declared there gates some test (no undeclared gate, no dead declaration).
 *   B. A workflow a pull_request can trigger on any change loads `livedb-gates.env` into the job env —
 *      a declaration no workflow reads sets nothing.
 *   C. That same class of workflow EXECUTES each language's RUN GATE (`scripts/check-*-test-skips.mjs`),
 *      which is the only thing that can report that the suite then ran: see {@link RUNNERS}.
 *   D. NO workflow, on any trigger, gating or not, invokes a BARE runner. A–C ask what gates a change
 *      and so look only at pull_request workflows; that left every other workflow free to run a
 *      command whose green means nothing, and two were — one of them gating the crates.io publish.
 *      See {@link RUNNERS} and {@link NOT_A_SUITE_RUN}.
 *   E. EVERY crate under `rust/` — workspace member or not — is `cargo fmt --check`ed and
 *      `cargo clippy`ed with `-D warnings` by a change-gating workflow. `--workspace`/`--all`/`-p`
 *      all mean "this workspace", so the three ORM-bench cells, each declaring its own
 *      `[workspace]`, were reached by NOTHING and had never been formatted, linted or compiled by
 *      any workflow since they were written (#242). See {@link rustCrates}.
 *
 * Clauses B and C are about execution, and every weaker reading of them has been satisfied by text
 * no shell would ever run, or by a command whose failure nothing was watching. Six, each measured on
 * the version that preceded it:
 *
 *   - matched against the whole workflow file: a step titled `Python — pytest` satisfied it after
 *     the command under that title was deleted;
 *   - matched against `run:` bodies but taking `npm run go:test` at its NAME: rebinding `go:test`
 *     to a bare `cd go && go test ./...` printed `✅ 5 test gates declared and loaded` while the go
 *     suite went back to reporting sixteen skips as success;
 *   - matched against the alias-RESOLVED text as one blob. Reverting the workflow step to a bare
 *     `go test ./...` and leaving the string `scripts/check-go-test-skips.mjs` in `paths-ignore:` —
 *     a setting that means "do NOT run CI when this file changes" — printed ✅ exit 0 on a tree the
 *     version before it had called ❌ exit 1. And `"go:test": "cd go && go test ./... #
 *     scripts/check-go-test-skips.mjs"` printed ✅ as well, because comments were stripped from the
 *     workflow BEFORE script bodies were substituted into it, so a comment arriving from
 *     `package.json` was never stripped at all;
 *   - matched on a command's argv, but with the ALIAS still recognised from a regex over the raw
 *     text: `run: echo "::notice::developers should run npm test before pushing"` printed ✅ exit 0,
 *     because `npm test` matched mid-string and expanding an alias replaces the whole command — so
 *     the echo became the single clean command `vitest run`. Every question asked about a command is
 *     now asked of its argv, including that one.
 *   - splitting a `run:` body on those operators WITHOUT interpreting quoting, so an operator inside
 *     a quoted string ended a command and started another. With the rust step written
 *     `run: echo "see docs; cargo test -p litedbmodel_runtime runs the suite"` — the one thing in the
 *     tree that could satisfy Rust — the tail of an English sentence, closing quote and all, was a
 *     command whose argv began `cargo test`, and it printed ✅ exit 0. The same blindness cost real
 *     commands in the other direction: a `#` inside quotes opened a comment, so
 *     `echo 'run the rust suite #' && cd rust && cargo test …` was ❌ exit 1, and `2>&1` split at its
 *     `&` into `2>` and a command called `1`.
 *   - counting a command as INVOKED without asking whether the shell would let its failure fail the
 *     step. Measured on the rust step, one spelling at a time, ALL ✅ exit 0: `… || true`, `… || :`,
 *     `… || echo skipped`, `… | tee rust.log`, `… &`, a `set +e` above it, `continue-on-error: true`
 *     on the step (written above the `run:`, and below it), the same on the job, `shell: python` on
 *     the step, a workflow-level `defaults: run: shell: python`, the runner inside
 *     `if [ -n "$RUN_RUST" ]; then … fi`, inside `test -f rust/SKIP || { cd rust; cargo test …; }`,
 *     inside `{ cd rust; cargo test …; } || true`, and as the right-hand side of
 *     `test -f rust/SKIP || cargo test …`. Fifteen ways to write "the rust suite did not have to
 *     pass", and the gate called every one of them a suite that had.
 *
 * So a workflow is reduced to the commands whose failure FAILS THE JOB — `run:` bodies only, split by
 * a tokenizer that reads quoting (an operator or a `#` inside `'`/`"`/a backtick/`$(`/`${`, or behind
 * a `\`, is text), `#` comments dropped per line at every level of resolution, every `npm run <x>` /
 * `npm test` (argv[0] `npm`) replaced by the commands of its `package.json` body, and everything the
 * shell would not hold to account dropped — and each runner, and the `livedb-gates.env` load, is a
 * predicate over one command's argv.
 *
 * Where it errs, it errs RED. Everything it cannot expand it simply does not see, so the clause
 * fails rather than passes: a runner reached through a shell script, a local composite action
 * (`uses: ./.github/actions/…`), a reusable workflow, a `$( … )` substitution, or a quoted /
 * `$`-substituted command name is not found. Anything it cannot prove will run, and fail loudly if
 * the suite fails, it drops for the same reason: a step, job or workflow carrying any of the keys
 * `notGatingKey` lists (none read positionally, so `if: false` or `continue-on-error: true` gates
 * wherever in the mapping it is written); a command an `||`, a `|`, a `&` or a `set +e` lets off; the
 * body of a shell compound or of a `( … )` / `{ …; }` group; and every workflow whose pull_request
 * trigger does not fire for every change ({@link gatesEveryChange}). A workflow triggered only by
 * `release` / `workflow_dispatch` satisfies nothing either, and neither does a `push:` — publish-time
 * or POST-MERGE execution is not a gate on the change that broke it.
 *
 * One thing it does NOT check, and it falls GREEN — the direction that matters, which is why it is
 * named: whether a job that fails BLOCKS anything. `if:` and `continue-on-error:` are in the file and
 * are read; a required-status-check is a branch-protection setting, so a job that goes red while the
 * merge proceeds looks identical here to one that gates.
 *
 * Nor does it claim the suites then ran or passed: it reads workflows and `package.json`, nothing
 * else. That second half is each language's run gate — `scripts/check-{ts,python,php,go,rust}-test-skips.mjs`
 * — which runs the suite with the gates asserted open and checks the result against the tree, and which
 * this script requires the workflow to invoke.
 *
 *   node scripts/check-reachable-test-gates.mjs
 */
import { readdirSync, readFileSync, statSync, globSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATES_ENV, GATE_PATTERN, NOT_A_GATE, readGateDeclarations } from './livedb-gates.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
/** Where a language's tests live. A gate read here is a gate CI must be able to open. */
const TEST_DIRS = ['python/tests', 'php/tests', 'go', 'rust/litedbmodel_runtime/tests', 'test', 'conformance'];
const TEST_FILE = /\.(py|php|go|rs|ts|mts)$/;
/**
 * The repository's default branch — the base every merge goes through, so a `pull_request` narrowed
 * to it still gates every change. Also written in `release.yml`'s `push: branches:` trigger.
 */
const DEFAULT_BRANCH = 'main';
/** The `pull_request` activity types GitHub triggers by default; a `types:` must keep all of them. */
const PR_TYPES = ['opened', 'synchronize', 'reopened'];

/**
 * The command that runs each language's WHOLE suite, as a predicate over one command's argv.
 *
 * A predicate over argv, not a regex over text, because the question is which PROGRAM the command
 * runs and with which arguments — `echo scripts/check-go-test-skips.mjs` runs `echo`, and a path in
 * `paths-ignore:` runs nothing at all. Absent from CI ⇒ that language is untested.
 *
 * Every one of them is now that language's RUN GATE, and never the bare runner. "The whole suite ran"
 * is not a claim any of these runners makes:
 *
 *     go test        counts a skipped test as a success, serves a whole CACHED run without starting
 *                    the binary, says nothing when the test set SHRANK, and reports a package that
 *                    failed to BUILD only inside its -json stream (#219)
 *     pytest         153 passed, 25 SKIPPED, exit 0 (#220)
 *     phpunit        `OK, but some tests were skipped!  Tests: 152, Skipped: 45`, exit 0 (#220)
 *     cargo test     71 passed and three binaries of `0 tests` when `--features livedb` is dropped —
 *                    the six live tests are not compiled, so there is nothing to skip (#220)
 *     vitest         `success: true` with tests pending, and nothing read the count (#220)
 *
 * That is also why this table no longer tries to REJECT a narrowed invocation, which is what it used
 * to do for TypeScript alone (`vitest run` with every remaining argument a flag) while its own
 * comment claimed that "`pytest`, `phpunit` and `cargo test` already mean everything when invoked
 * bare" — a claim no code here made, and a claim that was FALSE for the rust command this repository
 * actually runs, `cargo test -p litedbmodel_runtime --features livedb`. Measured green on the version
 * before this one: `python3 -m pytest -q tests/test_dialect.py`, `phpunit --filter NothingMatchesThis`,
 * `cargo test --lib nothing_matches_this`, `npx vitest run --config=…`.
 *
 * A run gate owns the runner's argv in tracked source, so the narrowing cannot come from a workflow
 * at all, and each gate then requires a verdict for every test the TREE declares — which catches the
 * narrowings an argv predicate structurally cannot see: an ambient `GOFLAGS=-run=…`/`PYTEST_ADDOPTS`,
 * a `testpaths` narrowed in pyproject.toml, a `<directory>` narrowed in phpunit.xml, a class renamed
 * so the runner stops collecting it, a build tag, a `#![cfg(feature = …)]`. For rust it is what makes
 * the invariant EXPRESSIBLE: the gate derives the package and target set from `cargo metadata`, so
 * `-p litedbmodel_runtime` is no longer a narrowing anyone has to permit or forbid by hand.
 *
 * What is checked here stays exactly what this script can see: that a `run:` of a change-gating
 * workflow INVOKES the gate, with npm aliases expanded — so rebinding `go:test` to a bare
 * `cd go && go test ./...` is red, as it has been since #219.
 */
const runGate = (script) => (a) =>
  /(?:^|\/)node$/.test(a[0] ?? '') && (a[1] ?? '').replace(/^\.\//, '') === `scripts/${script}`;

/**
 * Per language: the run gate a change-gating workflow MUST invoke, and the bare runner NO workflow may
 * invoke at all. Both facts in one row, because they are one decision — kept apart, a language could
 * end up with a required gate in one table and a permitted lie in the other.
 *
 * The bare-runner half is not a duplicate of the gate half: it is enforced over EVERY workflow, on any
 * trigger, gating or not. That is the hole {@link onChange} cannot see, and two live examples were
 * found by audit rather than by this script:
 *
 *   publish-crates.yml   `cargo test -p litedbmodel_runtime` — no `--features livedb`, so the six live
 *                        tests were NOT COMPILED, and this gated the crates.io publish. `tests/common/
 *                        mod.rs` documents the damage: "publish-crates.yml gated a crate release on ten
 *                        tests that had never executed".
 *   ci.yml, release.yml, `npm run test:ci` = `vitest run test/unit` — 13 of the tree's 51 test files,
 *   publish.yml,         under a step called "Test". The #168 narrowing itself, alive as a second path
 *   npm-audit-remediate  in four workflows, one of them a pull_request.
 *
 * Both are gone, and the steps with them: a DB-less duplicate of a suite conformance.yml already runs
 * through the run gates against a real PG + MySQL adds no coverage, and its green says something untrue.
 */
const RUNNERS = [
  [
    'TypeScript',
    'node scripts/check-ts-test-skips.mjs   (what `npm run ts:test` must bind to)',
    runGate('check-ts-test-skips.mjs'),
    (a) => a[0] === 'vitest',
  ],
  [
    'Python',
    'node scripts/check-python-test-skips.mjs   (what `npm run py:test` must bind to)',
    runGate('check-python-test-skips.mjs'),
    (a) => /(?:^|\/)pytest$/.test(a[0] ?? '') || (/(?:^|\/)python[0-9.]*$/.test(a[0] ?? '') && a[1] === '-m' && a[2] === 'pytest'),
  ],
  [
    'PHP',
    'node scripts/check-php-test-skips.mjs   (what `npm run php:test` must bind to)',
    runGate('check-php-test-skips.mjs'),
    (a) => /(?:^|\/)phpunit$/.test(a[0] ?? ''),
  ],
  [
    'Go',
    'node scripts/check-go-test-skips.mjs   (what `npm run go:test` must bind to)',
    runGate('check-go-test-skips.mjs'),
    (a) => a[0] === 'go' && a[1] === 'test',
  ],
  [
    'Rust',
    'node scripts/check-rust-test-skips.mjs   (what `npm run rust:test` must bind to)',
    runGate('check-rust-test-skips.mjs'),
    (a) => a[0] === 'cargo' && a[1] === 'test',
  ],
];

/**
 * The runner invocations in a workflow that are NOT a suite run, as the exact argv each reduces to.
 * Every other one is red wherever it appears.
 *
 * Both entries drive a vitest project that is not the test suite: the live-DB CORPUS, generated and
 * drift-checked by `conformance/vitest.livedb.config.ts`, and the corpus drift gate + TS reference
 * runner, a single named file. Neither claims to run the suite, and `npm run ts:test` runs it in the
 * same workflow.
 *
 * BIDIRECTIONAL: an entry that matches no command in any workflow is stale and red, so this cannot
 * quietly become a licence for a narrowing nobody runs any more.
 */
const NOT_A_SUITE_RUN = [
  'vitest run --config conformance/vitest.livedb.config.ts',
  'vitest run test/scp/conformance-vectors.test.ts',
];

/**
 * Clause B's command — the one that puts `livedb-gates.env`'s declarations into a job's environment
 * — as a predicate over one command's argv, for the same reason the runners above are. Asking
 * whether the file's NAME occurs in some command accepted `rm -f livedb-gates.env`: the name, in a
 * command that deletes it.
 *
 * Two shapes load it, and nothing else is recognised, so any other way of loading it fails RED:
 *
 *   grep -E '^[A-Z][A-Z0-9_]*=' livedb-gates.env >> "$GITHUB_ENV"   what conformance.yml runs — the
 *     runner reads $GITHUB_ENV into every LATER step's environment;
 *   . ./livedb-gates.env                                            the shell sources it into the
 *     current one.
 */
const GATE_LOADER = {
  how: `grep -E '^[A-Z][A-Z0-9_]*=' ${GATES_ENV} >> "$GITHUB_ENV"   (or \`. ./${GATES_ENV}\`)`,
  is: (a) => {
    if (!a.some((w) => w.replace(/^\.\//, '') === GATES_ENV)) return false;
    if (a[0] === '.' || a[0] === 'source') return true;
    return /(?:^|\/)grep$/.test(a[0] ?? '') && a.some((w) => w.startsWith('>')) && a.some((w) => w.includes('GITHUB_ENV'));
  },
};

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // a language directory that does not exist yet contributes no gates
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'target' || e === 'vendor' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (TEST_FILE.test(e)) out.push(p);
  }
  return out;
}

/** gate → the test files that read it. */
const gates = new Map();
for (const d of TEST_DIRS) {
  for (const file of walk(join(ROOT, d))) {
    for (const m of readFileSync(file, 'utf8').match(GATE_PATTERN) ?? []) {
      if (NOT_A_GATE.has(m)) continue;
      if (!gates.has(m)) gates.set(m, new Set());
      gates.get(m).add(relative(ROOT, file));
    }
  }
}

const declared = new Set(readGateDeclarations().keys());

const PKG_SCRIPTS = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
/** `<workflow>: npm run <name>` for a script `package.json` does not declare — that step cannot run. */
const unresolved = new Set();

/**
 * A key whose presence stops the step, job or workflow carrying it from gating a change — WHEREVER
 * in it the key is written. All three levels ask the one question (is this thing's outcome binding
 * on every change?), so they ask it in one place instead of each keeping its own list:
 *
 *   if:                 conditional execution is not execution, and `if: false` on the go step is
 *                       the ordinary way to switch it off. The condition is not evaluated — it is
 *                       enough that one exists — so a step that would in fact have run is dropped.
 *   continue-on-error:  the failure does not fail anything. A step's is recorded as an outcome the
 *                       job ignores, a job's does not fail the run, so `cargo test` under it IS
 *                       invoked and can make nothing red. Only a literal `false` keeps it binding;
 *                       an expression is not evaluated here, so it counts as swallowing (RED).
 *   shell:              GitHub hands a `run:` body to `bash -e` or `sh -e`, and nothing else gets
 *                       the `-e` — under any other shell a failing command need not end the script,
 *                       and a `python`/`pwsh` body is not a list of shell commands at all.
 *   defaults:           the same `shell:`, set once for every step of a job or of a whole workflow.
 */
function notGatingKey(key, value) {
  if (key === 'if') return true;
  if (key === 'continue-on-error') return value.trim() !== 'false';
  if (key === 'shell') return !/^(bash|sh)$/.test(value.trim());
  if (key === 'defaults') return [...value.matchAll(/shell:\s*(\S*)/g)].some(([, s]) => !/^(bash|sh)$/.test(s));
  return false;
}

/**
 * The `run:` bodies a job would UNCONDITIONALLY hand to a shell, in order — the only text of a
 * workflow that is a command. Everything else in the file is configuration — a step's title, its
 * `env:`, its `with:`, the trigger's `paths-ignore:` — and matching against that is how a path CI
 * is configured to IGNORE came to satisfy clause C.
 *
 * A step carrying one of the keys above, and every step of a job or of a workflow carrying one, is
 * dropped. So this errs toward dropping a step that would in fact have run, which fails RED.
 *
 * A mapping's keys are UNORDERED, so NONE of those keys may be read positionally. Each is decided
 * when the thing it gates has been read to its end, not when the key is reached: a step's commands
 * are held until the step ends, a job's until the JOB ends, a workflow's until the file ends.
 * Deciding a job at step-flush time meant a job-level `if: false` written after `steps:` gated only
 * the steps that happened to come after it — with one dummy step appended it gated nothing at all,
 * and a wholly disabled job reported all five runners green. `continue-on-error: true` lives in the
 * same mapping and has exactly the same property: it gates its step written above or below `run:`.
 *
 * Read by indentation rather than through a YAML parser, because the grammar needed is small and
 * total: a `key:` is followed either by an inline value or by a block whose body is every following
 * line indented past the key. EVERY block scalar (`|`/`>`) is consumed, not just `run:`'s, so a line
 * inside some other key's block cannot be mistaken for a step's command; `defaults:`'s nested
 * mapping is consumed for the mirror reason — its `shell:` has to be read as part of the key that
 * owns it. Steps are the sequence items under a job; a job is a key at indent 2 under `jobs:`, the
 * same shape the trigger scan below reads. A `run:` this shape does not place inside a job belongs
 * to no job and is dropped — the same RED direction as everything else here.
 */
function runBodies(text, { gatingOnly = true } = {}) {
  const lines = text.split('\n');
  const bodies = [];
  /** The step being read: its `- ` lead, whether a key of its own disowns it, and its commands. */
  let step = null;
  /** The job being read: whether a job-level key disowns every step of it, and their commands. */
  let job = null;
  let inJobs = false;
  /** Whether a workflow-level key disowns every job in the file. */
  let workflowNotGating = false;
  // `gatingOnly: false` keeps the steps a key would disown — for the clause that asks what a workflow
  // RUNS rather than what it gates. `publish-crates.yml`'s bare `cargo test` sat behind
  // `if: steps.need.outputs.publish == 'true'`, so the gating read dropped it and it gated a publish
  // while being invisible here.
  const endStep = () => {
    if (step && job && (!gatingOnly || !step.notGating)) job.runs.push(...step.runs);
    step = null;
  };
  const endJob = () => {
    endStep();
    if (job && (!gatingOnly || !job.notGating)) bodies.push(...job.runs);
    job = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*(?:-\s+)?)([A-Za-z_][\w.-]*):[^\S\n]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, lead, key, inline] = m;
    let value = inline;
    if (/^[|>]/.test(inline) || key === 'defaults') {
      const body = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim() !== '' && next.length - next.trimStart().length <= lead.length) break;
        body.push(next);
        i++;
      }
      value = body.join('\n');
    }
    if (/-\s+$/.test(lead)) {
      // A sequence item. One nested inside the current step is part of it, not a new step.
      if (step === null || lead.length <= step.lead) {
        endStep();
        step = { lead: lead.length, notGating: false, runs: [] };
      }
    } else if (lead.length === 0) {
      endJob();
      inJobs = key === 'jobs';
      if (notGatingKey(key, value)) workflowNotGating = true;
    } else if (inJobs && lead.length === 2) {
      endJob();
      job = { notGating: false, runs: [] };
    } else if (inJobs && lead.length === 4 && job && notGatingKey(key, value)) {
      job.notGating = true; // gates every step of this job, wherever in the job it is written
    }
    if (step === null) continue;
    if (lead.length === step.lead && notGatingKey(key, value)) step.notGating = true;
    else if (key === 'run' && value) step.runs.push(value);
  }
  endJob();
  return workflowNotGating ? [] : bodies;
}

/**
 * A command's argv, with the words that choose WHICH binary runs but not WHAT it does removed:
 * a leading subshell paren, leading `VAR=value` assignments, and `npx`. Quoting is not REMOVED —
 * `shellCommands` reads it to find where a command ends, but a word keeps its quotes here, so a
 * runner named by a quoted or `$`-substituted word simply fails to match, which is the safe
 * direction.
 *
 * EVERY question this script asks about a command is asked of this argv: which program it runs
 * (`RUNNERS`, `GATE_LOADER`), whether it is a `set` or a compound keyword (`shellCommands`), and
 * whether it is an npm alias to expand (`npmScriptOf`). Asking the
 * alias question of the raw command text instead is how `echo "developers should run npm test
 * before pushing"` became the command `vitest run` — `npm test` matched mid-string and the alias
 * body replaced the WHOLE command, `echo` and all.
 */
function argvOf(cmd) {
  const argv = cmd.replace(/^\(+\s*/, '').split(/\s+/).filter(Boolean);
  while (argv.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]) || argv[0] === 'npx')) argv.shift();
  return argv;
}

/** The `package.json` script this command INVOKES, if it invokes one — the program must be `npm`. */
function npmScriptOf(argv) {
  if (argv[0] !== 'npm') return undefined;
  if (argv[1] === 'run' || argv[1] === 'run-script') return argv[2];
  if (argv[1] === 'test' || argv[1] === 'start') return argv[1];
  return undefined;
}

/** A `'`, `"`, backtick, `$(` or `${` — the constructs inside which an operator is TEXT. */
const opensRegion = (text, i) => /['"`]/.test(text[i]) || ['$(', '${'].includes(text.slice(i, i + 2));

/**
 * Where the region opened at `i` ends, inclusive — or the last index of `text` if it never closes,
 * so an unbalanced quote swallows the rest of the body. Mis-reading a region can therefore only
 * MERGE what an unquoted read would have split, which removes a match and never invents one.
 *
 * Nested regions are skipped through this same function, so `$(a "b; c")` ends at its own `)` and a
 * `(`/`{` inside one is counted. Inside a double quote only `$(`, `${` and a backtick nest, because
 * a `'` there is an ordinary character.
 */
function regionEnd(text, i) {
  const open = text[i];
  if (open === "'") {
    const j = text.indexOf("'", i + 1);
    return j === -1 ? text.length - 1 : j;
  }
  const two = text.slice(i, i + 2);
  const close = open === '"' ? '"' : open === '`' ? '`' : two === '$(' ? ')' : '}';
  const nest = two === '$(' ? '(' : two === '${' ? '{' : '';
  let depth = 0;
  for (let k = i + (open === '$' ? 2 : 1); k < text.length; k++) {
    const c = text[k];
    if (c === '\\') k++;
    else if (c === nest) depth++;
    else if (c === close && depth-- === 0) return k;
    else if (opensRegion(text, k) && !(open === '"' && c === "'")) k = regionEnd(text, k);
  }
  return text.length - 1;
}

/** The shell keywords that open a compound whose body runs only if the compound's head says so. */
const OPENS_COMPOUND = new Set(['if', 'for', 'while', 'until', 'case', 'select']);
const CLOSES_COMPOUND = new Set(['fi', 'done', 'esac']);

/**
 * The commands `text` gives a shell, reduced to the ones that RUN whenever the step does and whose
 * FAILURE FAILS IT — which is what clause C has to mean, and both halves are decided by the same
 * operators, so they are decided in the one pass that reads them.
 *
 * Quoting is interpreted: a `;`/`&&`/`||`/`|`/`&`, or a `#`, inside `'`/`"`/a backtick/`$(`/`${` or
 * behind a `\` is text, not a boundary. Reading a boundary there is how
 * `echo "see docs; cargo test -p x runs the suite"` counted as the Rust suite; reading a comment
 * there cost the real ones, `echo 'the rust suite #' && cargo test …` losing its `cargo test`. Words
 * KEEP their quotes, so `"cargo" test` still fails to match — the safe direction, unchanged.
 *
 * What is dropped, because none of it is "ran, and its failure fails the job":
 *
 *   - every command of an and-or list containing `||`. Left of the `||` the failure is answered by
 *     the right side (`cargo test … || true`, `… || :`, `… || echo skipped`); right of it the command
 *     runs ONLY when the left side failed, so on the green path it does not run at all.
 *   - a list whose status the shell does not read: the left of a `|` (a pipeline's status is the last
 *     command's unless the invoking shell remembered `set -o pipefail` — the same reason
 *     check-go-test-skips.mjs owns its `go test` process instead of reading a pipe) and a `&`
 *     background command, which nothing waits for.
 *   - everything after a `set +e`: with errexit off, a failing command no longer ends the script.
 *   - the body of a shell compound (`if`/`for`/`while`/`until`/`case`), conditional for the same
 *     reason a step's `if:` is, and the inside of a `( … )` / `{ …; }` group, which is disowned with
 *     the group: `… || { cd rust; cargo test; }` reaches its second command through the `||` too.
 *     Unbalanced keywords or parens leave the compound open and the rest of the body dropped, which
 *     is RED, as everywhere here.
 */
function shellCommands(text) {
  /** Each command, the operator that ENDS it (`;` for a newline, `''` at end of text), and how many
   *  groups it opens (a `( … )` / `{ …; }` closed on the same command nets out to none). */
  const pieces = [];
  let cmd = '';
  let group = 0;
  const end = (sep) => {
    pieces.push({ cmd: cmd.trim(), sep, group });
    cmd = '';
    group = 0;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    if (c === '\\') {
      if (text[i + 1] !== '\n') cmd += two; // a line continuation is removed; any other escape kept
      i++;
    } else if (opensRegion(text, i)) {
      const j = regionEnd(text, i);
      cmd += text.slice(i, j + 1);
      i = j;
    } else if (c === '#' && (cmd === '' || /\s$/.test(cmd))) {
      i = text.indexOf('\n', i) - 1; // a comment opens at a word boundary and runs to end of LINE
      if (i < 0) break;
    } else if (two === '&&' || two === '||') {
      end(two);
      i++;
    } else if (c === ';' || c === '\n') {
      end(';'); // a newline ends a command exactly as `;` does
    } else if ((c === '|' || c === '&') && !/[<>]$/.test(cmd) && text[i + 1] !== '>') {
      end(c); // `2>&1`, `>&2` and `&>log` are redirections, not the end of anything
    } else {
      // A `(`/`)` is always the shell's; a `{`/`}` only where it is a word of its own, so
      // `--opt={a,b}` is not a group. One inside a quote or a `$( … )` never reaches here.
      if (c === '(' || (c === '{' && (cmd === '' || /\s$/.test(cmd)))) group++;
      else if (c === ')' || (c === '}' && (cmd === '' || /\s$/.test(cmd)))) group--;
      cmd += c;
    }
  }
  end('');

  const invoked = [];
  /** The and-or list being read, and whether an `||` anywhere in it answers for its failures. */
  let list = [];
  let hasOr = false;
  /** GitHub hands the body to a shell with `-e`, and `notGatingKey` above is what keeps that true. */
  let errexit = true;
  /** Open `if`/`for`/`while`/`until`/`case` compounds, and open `( … )` / `{ …; }` groups. */
  let compounds = 0;
  let groups = 0;
  /** The last operator was `&&`/`||`, so a NEWLINE after it continues the list rather than ending it. */
  let continued = false;
  for (const p of pieces) {
    if (p.cmd === '' && continued) continue;
    const argv = argvOf(p.cmd);
    if (argv[0] === 'set') {
      for (const w of argv.slice(1)) {
        if (/^\+[A-Za-z]*e/.test(w)) errexit = false;
        else if (/^-[A-Za-z]*e/.test(w)) errexit = true;
      }
    }
    if (OPENS_COMPOUND.has(argv[0])) compounds++;
    else if (CLOSES_COMPOUND.has(argv[0]) && compounds > 0) compounds--;
    if (p.group > 0) groups += p.group;
    if (p.cmd) list.push(p.cmd);
    if (p.sep === '||') hasOr = true;
    if (p.sep !== '&&' && p.sep !== '||') {
      if (errexit && !hasOr && compounds === 0 && groups === 0 && p.sep !== '|' && p.sep !== '&') invoked.push(...list);
      list = [];
      hasOr = false;
    }
    // A group CLOSES only once the list holding its last command has been decided, so that command
    // is judged inside the group and not after it. A stray `)` — a `case` arm's label — cannot open
    // the count from below.
    if (p.group < 0) groups = Math.max(0, groups + p.group);
    continued = p.sep === '&&' || p.sep === '||';
  }
  return invoked;
}

/**
 * The commands a shell would run for `text`, with every `npm run <x>` / `npm test` replaced by the
 * commands of the script body `package.json` binds it to, recursively, with a cycle guard.
 *
 * The splitting, the comment stripping and the "its failure fails the step" judgement are all
 * `shellCommands`, called HERE — which means once per level of resolution rather than once at the
 * top. That ordering is the bug that made
 * `"go:test": "cd go && go test ./... # scripts/check-go-test-skips.mjs"` read as green: comments
 * were dropped from the workflow first and the alias body was substituted in afterwards, so a
 * comment that arrived from `package.json` was never stripped by anything. For the same reason an
 * alias whose invocation was dropped is not expanded at all — nothing in its body could gate a
 * change either, so a typo behind `|| true` is not reported as unresolved.
 *
 * Expanding an alias replaces the WHOLE command, so anything else on it (a redirect, a trailing
 * flag) is dropped with it — which is why the alias is recognised from argv[0] and not from the
 * name appearing anywhere in the command. That can only remove a match, never invent one.
 */
function commandsOf(text, where, chain = []) {
  const out = [];
  for (const cmd of shellCommands(text)) {
    const argv = argvOf(cmd);
    const name = npmScriptOf(argv);
    if (name === undefined) {
      out.push(cmd);
      continue;
    }
    const body = PKG_SCRIPTS[name];
    if (body === undefined) {
      // `--if-present` is npm's own "this script may legitimately not exist".
      if (!argv.includes('--if-present')) unresolved.add(`${where}: npm run ${name}`);
      out.push(cmd);
      continue;
    }
    if (chain.includes(name)) {
      out.push(cmd); // a script reached through itself; leave it as written
      continue;
    }
    out.push(...commandsOf(body, where, [...chain, name]));
  }
  return out;
}

/** A YAML scalar, inline sequence or block sequence, as the list of words it holds. */
function yamlList(raw) {
  return raw
    .replace(/#.*$/gm, '')
    .replace(/[[\]]/g, ' ')
    .split(/[\n,]/)
    .map((s) => s.trim().replace(/^-\s+/, '').replace(/^(['"])(.*)\1$/, '$2'))
    .filter(Boolean);
}

/**
 * The `pull_request:` trigger's own filter keys, or null when the file has no pull_request trigger.
 *
 * Only `pull_request` is read, because only a pull_request runs BEFORE the change lands. A `push:`
 * is post-merge: `release.yml` is `on: push: branches: [main]`, and it used to satisfy this script's
 * every clause (#220) — a suite that runs after the merge did not gate the merge. Read by
 * indentation, the same small total grammar `runBodies` uses: `on:` at indent 0, each trigger at
 * indent 2, each of its filters at indent 4 with an inline or a block value.
 *
 * The three inline forms `on: pull_request` and `on: [push, pull_request]` carry no filters, so they
 * yield `{}` — everything gated. Anything else this does not recognise yields null, and a workflow
 * that yields null gates nothing here: RED, as everywhere in this file.
 */
function pullRequestFilters(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = /^on:[^\S\n]*(.*)$/.exec(lines[i]);
    if (!head) continue;
    if (head[1].trim()) return yamlList(head[1]).includes('pull_request') ? {} : null;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      const indent = lines[j].length - lines[j].trimStart().length;
      if (indent === 0) break; // out of the `on:` block
      const trigger = /^\s{2}([A-Za-z_][\w-]*):[^\S\n]*(.*)$/.exec(lines[j]);
      if (!trigger || trigger[1] !== 'pull_request') continue;
      if (trigger[2].trim()) return {}; // `pull_request: {}` / a flow value — no filters
      const filters = {};
      for (let k = j + 1; k < lines.length; k++) {
        if (lines[k].trim() === '') continue;
        if (lines[k].length - lines[k].trimStart().length <= 2) break; // out of pull_request's block
        const filter = /^\s{4}([A-Za-z_][\w-]*):[^\S\n]*(.*)$/.exec(lines[k]);
        if (!filter) continue;
        let value = filter[2];
        while (!value.trim() && k + 1 < lines.length && lines[k + 1].length - lines[k + 1].trimStart().length > 4) {
          value += `\n${lines[++k]}`;
        }
        filters[filter[1]] = yamlList(value);
      }
      return filters;
    }
    return null; // an `on:` whose block holds no pull_request
  }
  return null;
}

/**
 * Whether a pull_request trigger runs for EVERY change — the only thing that gates one.
 *
 * `branches:` is the one filter that can narrow and still gate: `[main]` means "PRs targeting main",
 * which every merge into main is. `[never-used-branch]` is not, and neither is a `branches-ignore:`
 * naming the default branch — measured green on the version before this one, along with
 * `types: [closed]`, a trigger that never fires while a PR is open (#220).
 *
 * `types:` must keep all three of GitHub's defaults; anything else runs on some PR events and not the
 * ones that carry a change. Every OTHER filter — `paths:`, `paths-ignore:`, `branches-ignore:`, and
 * any key added to GitHub's schema after this was written — disqualifies the workflow, which is the
 * RED direction: it can only refuse to count a workflow that in fact gates.
 */
function gatesEveryChange(filters) {
  if (filters === null) return false;
  return Object.entries(filters).every(([key, values]) =>
    key === 'branches' ? values.includes(DEFAULT_BRANCH) : key === 'types' ? PR_TYPES.every((t) => values.includes(t)) : false,
  );
}

/**
 * Every workflow, with the commands it would run — `commands` as a change GATE (a step, job or
 * workflow a key disowns is dropped), `allCommands` as everything it runs whatever the trigger and
 * whatever guards it. The bare-runner clause needs the second: a lying test step is a lying test step
 * behind an `if:`, on a `release:` trigger, in a scheduled job.
 *
 * `allBodies` keeps the same commands GROUPED BY the `run:` they came from, which is the unit a `cd`
 * is scoped to — clause E has to know which directory `cargo fmt --manifest-path orm_bench/…` names,
 * and that is the body's `cd rust`, not the file's.
 */
const workflows = readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => {
    const text = readFileSync(join(WORKFLOWS, f), 'utf8');
    const allBodies = runBodies(text, { gatingOnly: false }).map((b) => commandsOf(b, f));
    return {
      name: f,
      text,
      commands: runBodies(text).flatMap((b) => commandsOf(b, f)),
      allCommands: allBodies.flat(),
      allBodies,
    };
  });

/** Workflows a pull_request triggers on ANY change — the only ones that gate a change. */
const onChange = workflows.filter((w) => gatesEveryChange(pullRequestFilters(w.text.slice(0, w.text.search(/^jobs:/m) >>> 0))));

/**
 * `Cargo.toml`, reduced to the three facts that decide which cargo commands reach a crate: the
 * package it defines, whether it opens a workspace, and that workspace's DECLARED members.
 *
 * Read line-wise — a `#` comment dropped, a `[table]` header switching section — rather than through
 * a TOML parser, because the grammar needed is three keys and this repository has no TOML dependency.
 * `members` is the only array read, and only under `[workspace]`, so `[workspace.dependencies]` and
 * `default-members` (a NARROWING of members, never a widening) cannot be mistaken for it.
 *
 * A `[workspace]` with no `members` is cargo's "every path dependency is a member" — inferred, not
 * declared, so nothing is claimed for it here and a crate that is only reachable that way is reported
 * as uncovered. RED, as everywhere in this file.
 */
function manifestFacts(text) {
  let section = '';
  let pkg;
  let workspace = false;
  const members = [];
  let array = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (array !== null) {
      array += ` ${line}`;
      if (!line.includes(']')) continue;
      for (const [, m] of array.matchAll(/"([^"]+)"/g)) members.push(m);
      array = null;
      continue;
    }
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1];
      if (section === 'workspace') workspace = true;
      continue;
    }
    const kv = /^([A-Za-z_-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (section === 'package' && kv[1] === 'name') pkg = /^"([^"]*)"/.exec(kv[2])?.[1];
    if (section === 'workspace' && kv[1] === 'members') {
      if (kv[2].includes(']')) for (const [, m] of kv[2].matchAll(/"([^"]+)"/g)) members.push(m);
      else array = kv[2];
    }
  }
  return { pkg, workspace, members };
}

/**
 * Every crate under `rust/`, keyed by the ABSOLUTE directory holding its `Cargo.toml` — the unit
 * clause E asks about. A `target/` is skipped for the reason `check-no-local-deps.mjs` skips it
 * (a build directory holds manifests nobody wrote), and it is the same glob, because "the crates
 * this repository has" is one question.
 *
 * A manifest with no `[package]` is a virtual workspace root (rust/Cargo.toml is one): it is a
 * WORKSPACE and not a crate, so it is something a command can be aimed AT but never something that
 * needs covering.
 */
const rustCrates = new Map(
  globSync('rust/**/Cargo.toml', { cwd: ROOT })
    .filter((p) => !p.split(/[/\\]/).includes('target'))
    .map((p) => [
      dirname(join(ROOT, p)),
      { dir: dirname(p), abs: dirname(join(ROOT, p)), ...manifestFacts(readFileSync(join(ROOT, p), 'utf8')) },
    ]),
);
/** package name → its crate, for the `-p <name>` that is how a workspace member is named. */
const rustByName = new Map([...rustCrates.values()].filter((c) => c.pkg).map((c) => [c.pkg, c]));

/**
 * Which crates each `cargo fmt` / `cargo clippy` of a change-gating workflow reaches: crate dir →
 * the subcommands that reached it.
 *
 * Taken from `allBodies` — the steps a key would DISOWN included — because the rust leg is a matrix
 * shard selected by `if: matrix.lang == 'rust'`, so the gating reading drops the whole leg and would
 * make this clause unsatisfiable without restructuring the job. What is asked here is therefore
 * which crates CI NAMES, not that the step is unconditional; the "its failure fails the step"
 * judgement of `shellCommands` still applies, so a `… || true` reaches nothing.
 *
 * A command is read exactly as cargo would read it:
 *
 *   the manifest    `--manifest-path <p>` (or `=<p>`) resolved against the CWD the body's `cd`s have
 *                   reached, else that CWD's own `Cargo.toml`. A path this cannot resolve to a
 *                   manifest in `rustCrates` reaches nothing.
 *   the packages    `-p`/`--package <name>`, else `--workspace`/`--all` = the manifest's own package
 *                   plus its DECLARED members, else the manifest's own package alone.
 *   and only if it can fail: `cargo fmt` without `--check` REWRITES the tree and exits 0, and
 *                   `cargo clippy` without `-D warnings` prints its lints and exits 0. Neither is a
 *                   check, so neither counts as one.
 */
function rustLintCoverage() {
  const reached = new Map();
  const cover = (crate, sub) => {
    if (!crate) return;
    if (!reached.has(crate.dir)) reached.set(crate.dir, new Set());
    reached.get(crate.dir).add(sub);
  };
  for (const w of onChange) {
    for (const body of w.allBodies) {
      let cwd = ROOT;
      for (const cmd of body) {
        const argv = argvOf(cmd);
        if (argv[0] === 'cd') {
          cwd = resolve(cwd, argv[1] ?? '.');
          continue;
        }
        const sub = argv[0] === 'cargo' ? argv[1] : undefined;
        if (sub !== 'fmt' && sub !== 'clippy') continue;
        const checks =
          sub === 'fmt'
            ? argv.includes('--check')
            : argv.some((a, i) => a === '-Dwarnings' || (a === '-D' && argv[i + 1] === 'warnings'));
        if (!checks) continue;
        const flag = argv.findIndex((a) => a === '--manifest-path' || a.startsWith('--manifest-path='));
        const path = flag === -1 ? undefined : argv[flag].includes('=') ? argv[flag].split('=')[1] : argv[flag + 1];
        const at = rustCrates.get(path === undefined ? cwd : dirname(resolve(cwd, path)));
        if (!at) continue;
        const named = argv.filter((a, i) => argv[i - 1] === '-p' || argv[i - 1] === '--package');
        if (named.length > 0) {
          for (const n of named) cover(rustByName.get(n), sub);
          continue;
        }
        cover(at.pkg ? at : undefined, sub);
        if (argv.includes('--workspace') || argv.includes('--all')) {
          for (const m of at.members) cover(rustCrates.get(resolve(at.abs, m)), sub);
        }
      }
    }
  }
  return reached;
}

const problems = [];

for (const g of [...gates.keys()].sort()) {
  if (declared.has(g)) continue;
  problems.push(
    `${g} is read by a test but not declared in ${GATES_ENV}, so CI never sets it:\n` +
      [...gates.get(g)].sort().map((f) => `      ${f}`).join('\n'),
  );
}
for (const d of [...declared].sort()) {
  if (!gates.has(d)) problems.push(`${d} is declared in ${GATES_ENV} but gates no test — dead declaration, remove it.`);
}
if (!onChange.some((w) => w.commands.some((c) => GATE_LOADER.is(argvOf(c))))) {
  problems.push(
    `no pull_request workflow that fires for every change runs a command that LOADS ${GATES_ENV}, so every gate in it stays unset in CI.\n` +
      `      Expected, as a command in a \`run:\` step: ${GATE_LOADER.how}\n` +
      `      (The file's NAME in some other command is not a load — \`rm -f ${GATES_ENV}\` names it too.)`,
  );
}
for (const [lang, how, isRunner] of RUNNERS) {
  if (!onChange.some((w) => w.commands.some((c) => isRunner(argvOf(c))))) {
    problems.push(
      `no pull_request workflow EXECUTES the ${lang} RUN GATE — that language's suite is not known to run on a PR.\n` +
        `      Expected, as a command in a \`run:\` step with npm aliases expanded: ${how}\n` +
        `      (The bare runner does NOT count. \`go test\`, \`pytest\`, \`phpunit\`, \`cargo test\` and\n` +
        `      \`vitest run\` each report a suite that skipped, shrank or was never compiled as a\n` +
        `      success — see RUNNERS for the measured line from each. Nor is a step title, an \`env:\`\n` +
        `      value, a \`#\` comment or anything inside quotes a command. Nor does a command count\n` +
        `      that the shell would not hold to account: after \`||\`, left of a \`|\`, \`&\`-backgrounded,\n` +
        `      after \`set +e\`, or in the body of an \`if\`/\`for\`/\`while\`/\`case\` or a \`( … )\`/\`{ …; }\`\n` +
        `      group. Nor a step or job carrying \`if:\`, \`continue-on-error:\` or a \`shell:\` other than\n` +
        `      bash/sh, nor a pull_request trigger that does not fire for every change — a \`paths:\`,\n` +
        `      a \`paths-ignore:\`, a \`branches:\` without \`${DEFAULT_BRANCH}\`, a \`types:\` missing one of\n` +
        `      ${PR_TYPES.join('/')}, or a \`push:\` trigger, which is POST-MERGE.)`,
    );
  }
}
// Clause D: NO workflow, on ANY trigger, invokes a bare runner. Each of the five reports a suite that
// skipped, shrank or was never compiled as a success, so a step that runs one is a step whose green
// means nothing — and this is asked of every workflow because the two that were doing it gated a
// crates.io PUBLISH and a pull_request, neither of which any other clause here looks at.
const matchedAllowance = new Set();
for (const w of workflows) {
  for (const cmd of w.allCommands) {
    const argv = argvOf(cmd);
    const normalized = argv.join(' ');
    const runner = RUNNERS.find(([, , , isBare]) => isBare(argv));
    if (!runner) continue;
    if (NOT_A_SUITE_RUN.includes(normalized)) {
      matchedAllowance.add(normalized);
      continue;
    }
    problems.push(
      `${w.name} invokes the BARE ${runner[0]} runner, whose green does not mean the suite ran:\n` +
        `      ${cmd.trim()}\n\n` +
        `      Run the gate instead: ${runner[1]}\n` +
        `      (\`go test\` calls a skipped test a success and replays a cached run; \`pytest\` and\n` +
        `      \`phpunit\` report skips beside "passed"/"OK"; \`cargo test\` without \`--features livedb\`\n` +
        `      compiles the live tests to NOTHING and exits 0; \`vitest\` reports \`success: true\` with\n` +
        `      tests pending. If this invocation is not a suite run at all, add its exact argv to\n` +
        `      NOT_A_SUITE_RUN with the reason.)`,
    );
  }
}
for (const a of NOT_A_SUITE_RUN) {
  if (!matchedAllowance.has(a)) {
    problems.push(
      `NOT_A_SUITE_RUN allows \`${a}\`, but no workflow runs it. Remove the entry — an allowance nothing uses is one nobody re-reads before relying on it.`,
    );
  }
}
// Clause E: every crate under rust/ is fmt-checked AND clippy'd by a change-gating workflow. The
// three ORM-bench cells each declare their own `[workspace]`, so `--all` / `--workspace` / `-p` at
// rust/Cargo.toml never reached one, and nothing else in any workflow named them: from the day they
// were written to #242 they were never formatted, linted or compiled by CI, and `cargo fmt --check`
// was red on two of them the first time it ran. Nothing made that visible — a workflow that says
// `--workspace` READS as if it covered everything, and the crates it silently excludes are named
// nowhere.
const reachedByLint = rustLintCoverage();
for (const crate of [...rustCrates.values()].filter((c) => c.pkg).sort((a, b) => a.dir.localeCompare(b.dir))) {
  const reached = reachedByLint.get(crate.dir) ?? new Set();
  const missing = ['fmt', 'clippy'].filter((s) => !reached.has(s));
  if (missing.length === 0) continue;
  problems.push(
    `no pull_request workflow runs \`cargo ${missing.join('` / `cargo ')}\` over \`${crate.dir}\`\n` +
      `      (package \`${crate.pkg}\`) — CI does not check that crate at all.\n` +
      `      Add it to the rust leg of conformance.yml. A crate outside rust/Cargo.toml's \`members\` is\n` +
      `      reachable ONLY through \`--manifest-path ${relative('rust', crate.dir)}/Cargo.toml\` — \`--workspace\`, \`--all\` and\n` +
      `      \`-p\` all mean "this workspace" and stop at its boundary.\n` +
      `      (\`cargo fmt\` without \`--check\` REWRITES the tree and exits 0, and \`cargo clippy\` without\n` +
      `      \`-D warnings\` prints its lints and exits 0 — neither counts. Nor does a command the shell\n` +
      `      would not hold to account: see the RUN GATE clause for the full list.)`,
  );
}
for (const u of [...unresolved].sort()) {
  problems.push(`${u} — package.json declares no such script, so that step cannot run at all.`);
}

if (problems.length === 0) {
  console.log(
    `✅ ${gates.size} test gates: each is declared in ${GATES_ENV}, and each declaration gates a test.\n` +
      `   All ${RUNNERS.length} language RUN GATES (scripts/check-*-test-skips.mjs — never the bare runner, which\n` +
      `   reports a skipped, shrunken or uncompiled suite as a success), and a command that LOADS ${GATES_ENV},\n` +
      `   are INVOKED by a \`run:\` of a pull_request workflow that fires for EVERY change (no \`paths:\`/\n` +
      `   \`paths-ignore:\`, a \`branches:\` including \`${DEFAULT_BRANCH}\` if present, a \`types:\` keeping ${PR_TYPES.join('/')};\n` +
      `   a \`push:\` does not count, being post-merge), from a step in a job in a workflow carrying no \`if:\`,\n` +
      `   no \`continue-on-error:\` other than false and no \`shell:\` other than bash/sh — and INVOKED here means\n` +
      `   the shell would let the failure FAIL THE JOB: not in an and-or list carrying \`||\`, not left of a \`|\`,\n` +
      `   not \`&\`-backgrounded, not after \`set +e\`, not in the body of an \`if\`/\`for\`/\`while\`/\`case\` or of a\n` +
      `   \`( … )\`/\`{ …; }\` group. Each is matched as a predicate over one command's argv, with npm aliases\n` +
      `   (argv[0] \`npm\`) expanded to their package.json bodies, \`#\` comments dropped at every level, and the\n` +
      `   command boundaries found by a tokenizer that reads quoting — an operator or \`#\` inside\n` +
      `   \`'\`/\`"\`/a backtick/\`$(\`/\`\${\` or behind a \`\\\` is text.\n` +
      `   All ${rustByName.size} crates under rust/ — the ${[...rustCrates.values()].filter((c) => c.pkg && c.workspace).length} that declare their OWN \`[workspace]\` included, which\n` +
      `   \`--workspace\`/\`--all\`/\`-p\` at rust/Cargo.toml cannot reach — are \`cargo fmt\`ed with \`--check\` and\n` +
      `   \`cargo clippy\`ed with \`-D warnings\` by such a workflow, each command resolved to the manifest and\n` +
      `   package set cargo itself would read (the body's \`cd\`s, \`--manifest-path\`, \`-p\`, declared members).\n` +
      `   Not checked, and it falls GREEN: whether a job that FAILS blocks anything — a required status\n` +
      `   check is branch protection, not a file this can read.\n` +
      `   That each suite then really RAN is the run gate this required, not this script.`,
  );
  process.exit(0);
}
console.error('❌ what CI cannot reach:\n');
for (const p of problems) console.error(`  ${p}`);
console.error(`\n${problems.length} problem(s). A test CI never runs is not a test, and a crate CI never lints is not linted.`);
process.exit(1);
