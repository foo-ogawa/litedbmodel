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
 * The invariant, in three clauses:
 *
 *   A. Every `LITEDBMODEL_*` gate a test reads is declared in `livedb-gates.env`, and every variable
 *      declared there gates some test (no undeclared gate, no dead declaration).
 *   B. A workflow that a pull_request/push can trigger loads `livedb-gates.env` into the job env —
 *      a declaration no workflow reads sets nothing.
 *   C. That same class of workflow EXECUTES each language's test runner.
 *
 * Clauses B and C are about execution, and every weaker reading of them has been satisfied by text
 * no shell would ever run. Four, each measured on the version that preceded it:
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
 *
 * So a workflow is reduced to the COMMAND LIST it executes — `run:` bodies only, `#` comments
 * dropped per line at every level of resolution, split on the shell operators that end one command
 * and start the next, every `npm run <x>` / `npm test` (argv[0] `npm`) replaced by the commands of
 * its `package.json` body — and each runner, and the `livedb-gates.env` load, is a predicate over
 * one command's argv.
 *
 * Where it errs, it errs RED. Everything it cannot expand it simply does not see, so the clause
 * fails rather than passes: a runner reached through a shell script, a local composite action
 * (`uses: ./.github/actions/…`), a reusable workflow, or a quoted / `$`-substituted command name is
 * not found. Anything it cannot prove will run it drops for the same reason: a step with an `if:`,
 * every step of a job with a job-level `if:` — the condition is not evaluated, and neither `if:` is
 * read positionally, so `if: false` gates the whole job wherever in it the key is written — and
 * every workflow whose pull_request / push trigger carries `paths:` / `paths-ignore:`, which gates
 * only some changes. A workflow triggered only by `release` / `workflow_dispatch` satisfies nothing
 * either: publish-time execution is not a gate on the change that broke it.
 *
 * Two things it does NOT check, and both fall GREEN — the direction that matters, which is why they
 * are named:
 *
 *   - quoting is not interpreted, so a shell operator INSIDE a quoted string still begins what this
 *     reads as a command: `run: echo "see docs; cargo test -p x runs the suite"` counts as Rust.
 *     (Without the `;` the same text is one `echo` command and fails, ❌ exit 1.)
 *   - INVOKED is not "ran, and its failure fails the job". `cargo test … || true` and a step with
 *     `continue-on-error: true` both pass, as does a runner whose exit status nothing reads.
 *
 * Nor does it claim the suites then ran or passed: it reads workflows and `package.json`, nothing
 * else. For Go that second half is `scripts/check-go-test-skips.mjs`, which runs the suite with the
 * gates asserted open.
 *
 *   node scripts/check-reachable-test-gates.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATES_ENV, readGateDeclarations } from './livedb-gates.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
/** Where a language's tests live. A gate read here is a gate CI must be able to open. */
const TEST_DIRS = ['python/tests', 'php/tests', 'go', 'rust/litedbmodel_runtime/tests', 'test', 'conformance'];
const TEST_FILE = /\.(py|php|go|rs|ts|mts)$/;
const GATE = /LITEDBMODEL_[A-Z0-9_]+/g;
/** Carries the corpus path into a runner (set by `conformance/livedb-run.ts`); not a skip gate. */
const NOT_A_GATE = new Set(['LITEDBMODEL_LIVEDB_VECTORS']);

/**
 * The command that runs each language's WHOLE suite, as a predicate over one command's argv.
 *
 * A predicate over argv, not a regex over text, because the question is which PROGRAM the command
 * runs and with which arguments — `echo scripts/check-go-test-skips.mjs` runs `echo`, and a path in
 * `paths-ignore:` runs nothing at all. Absent from CI ⇒ that language is untested.
 *
 * These match the unrestricted invocation on purpose. A path-narrowed run is the same bug one level
 * down: `test:ci` was `vitest run test/unit`, which left test/scp, test/parity and test/integration
 * — 1138 tests — out of CI while the job reported green. So TypeScript must resolve to a `vitest
 * run` whose remaining arguments are all flags (`vitest run test/unit` and `vitest run --config <a
 * narrower project>` both carry a non-flag argument and are rejected). `pytest`, `phpunit` and
 * `cargo test` already mean "everything" when invoked bare.
 *
 * Go must resolve to `node scripts/check-go-test-skips.mjs` and NOT a bare `go test ./...`, because
 * for Go "everything ran" is a claim `go test` does not make: it reports a skipped test as a
 * success, serves a whole cached run without starting the binary, and reports a package that failed
 * to build only inside its -json stream. That script runs the `./...` suite uncached, with the
 * live-DB gates asserted open before it starts, and checks the result against the tree (#219); a
 * workflow — or an alias — that reverts to the bare command is back to green-by-default.
 */
const RUNNERS = [
  [
    'TypeScript',
    'vitest run   (every remaining argument a flag — a path- or config-narrowed run is not the suite)',
    (a) => a[0] === 'vitest' && a[1] === 'run' && a.slice(2).every((w) => w.startsWith('-')),
  ],
  [
    'Python',
    'pytest   (or python3 -m pytest)',
    (a) => /(?:^|\/)pytest$/.test(a[0] ?? '') || (/(?:^|\/)python[0-9.]*$/.test(a[0] ?? '') && a[1] === '-m' && a[2] === 'pytest'),
  ],
  ['PHP', 'phpunit', (a) => /(?:^|\/)phpunit$/.test(a[0] ?? '')],
  [
    'Go',
    'node scripts/check-go-test-skips.mjs   (what `npm run go:test` must bind to)',
    (a) => /(?:^|\/)node$/.test(a[0] ?? '') && (a[1] ?? '').replace(/^\.\//, '') === 'scripts/check-go-test-skips.mjs',
  ],
  ['Rust', 'cargo test', (a) => a[0] === 'cargo' && a[1] === 'test'],
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
    for (const m of readFileSync(file, 'utf8').match(GATE) ?? []) {
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
/** The shell operators that end one command and begin another. */
const COMMAND_SEP = /&&|\|\||[;&|]/;

/**
 * The `run:` bodies a job would UNCONDITIONALLY hand to a shell, in order — the only text of a
 * workflow that is a command. Everything else in the file is configuration — a step's title, its
 * `env:`, its `with:`, the trigger's `paths-ignore:` — and matching against that is how a path CI
 * is configured to IGNORE came to satisfy clause C.
 *
 * A step carrying an `if:`, and every step of a job carrying a job-level `if:`, is dropped:
 * conditional execution is not execution, and `if: false` on the go step is the ordinary way to
 * switch it off. The condition is not evaluated — it is enough that one exists — so this errs
 * toward dropping a step that would in fact have run, which fails RED.
 *
 * A mapping's keys are UNORDERED, so neither `if:` may be read positionally. Both are therefore
 * decided when the thing they gate has been read to its end, not when the key is reached: a step's
 * commands are held until the step ends, and a job's until the JOB ends. Deciding a job at
 * step-flush time meant a job-level `if: false` written after `steps:` gated only the steps that
 * happened to come after it — with one dummy step appended it gated nothing at all, and a wholly
 * disabled job reported all five runners green.
 *
 * Read by indentation rather than through a YAML parser, because the grammar needed is small and
 * total: a `key:` is followed either by an inline value or by a block scalar (`|`/`>`) whose body is
 * every following line indented past the key. EVERY block scalar is consumed, not just `run:`'s, so
 * a line inside some other key's block cannot be mistaken for a step's command. Steps are the
 * sequence items under a job; a job is a key at indent 2 under `jobs:`, the same shape the trigger
 * scan below reads. A `run:` this shape does not place inside a job belongs to no job and is
 * dropped — the same RED direction as everything else here.
 */
function runBodies(text) {
  const lines = text.split('\n');
  const bodies = [];
  /** The step being read: its `- ` lead, whether it is conditional, and the commands it declares. */
  let step = null;
  /** The job being read: whether a job-level `if:` gates it, and the commands its steps declare. */
  let job = null;
  let inJobs = false;
  const endStep = () => {
    if (step && job && !step.conditional) job.runs.push(...step.runs);
    step = null;
  };
  const endJob = () => {
    endStep();
    if (job && !job.conditional) bodies.push(...job.runs);
    job = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*(?:-\s+)?)([A-Za-z_][\w.-]*):[^\S\n]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, lead, key, inline] = m;
    let value = inline;
    if (/^[|>]/.test(inline)) {
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
        step = { lead: lead.length, conditional: false, runs: [] };
      }
    } else if (lead.length === 0) {
      endJob();
      inJobs = key === 'jobs';
    } else if (inJobs && lead.length === 2) {
      endJob();
      job = { conditional: false, runs: [] };
    } else if (inJobs && lead.length === 4 && key === 'if' && job) {
      job.conditional = true; // gates every step of this job, wherever in the job it is written
    }
    if (step === null) continue;
    if (key === 'if' && lead.length === step.lead) step.conditional = true;
    else if (key === 'run' && value) step.runs.push(value);
  }
  endJob();
  return bodies;
}

/**
 * A command's argv, with the words that choose WHICH binary runs but not WHAT it does removed:
 * a leading subshell paren, leading `VAR=value` assignments, and `npx`. Quoting is not interpreted
 * — a runner named by a quoted or `$`-substituted word simply fails to match, which is the safe
 * direction.
 *
 * EVERY question this script asks about a command is asked of this argv: which program it runs
 * (`RUNNERS`, `GATE_LOADER`) and whether it is an npm alias to expand (`npmScriptOf`). Asking the
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

/**
 * The commands a shell would run for `text`, with every `npm run <x>` / `npm test` replaced by the
 * commands of the script body `package.json` binds it to, recursively, with a cycle guard.
 *
 * `#` opens a comment at a word boundary and runs to end of LINE, so it is stripped per line and
 * BEFORE the line is split into commands — and inside this function, which means once per level of
 * resolution rather than once at the top. That ordering is the bug that made
 * `"go:test": "cd go && go test ./... # scripts/check-go-test-skips.mjs"` read as green: comments
 * were dropped from the workflow first and the alias body was substituted in afterwards, so a
 * comment that arrived from `package.json` was never stripped by anything.
 *
 * Expanding an alias replaces the WHOLE command, so anything else on it (a redirect, a trailing
 * flag) is dropped with it — which is why the alias is recognised from argv[0] and not from the
 * name appearing anywhere in the command. That can only remove a match, never invent one.
 */
function commandsOf(text, where, chain = []) {
  const out = [];
  for (const line of text.split('\n')) {
    for (const piece of line.replace(/(?:^|\s)#.*$/, '').split(COMMAND_SEP)) {
      const cmd = piece.trim();
      if (!cmd) continue;
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
  }
  return out;
}

/**
 * Workflows a pull_request/push can trigger on ANY change — the only ones that gate a change. A
 * trigger narrowed by `paths:` / `paths-ignore:` is excluded: it does not run for the changes it
 * filters out, which includes the change that breaks the suite it was supposed to be running.
 */
const onChange = readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => {
    const text = readFileSync(join(WORKFLOWS, f), 'utf8');
    return { name: f, text, commands: runBodies(text).flatMap((b) => commandsOf(b, f)) };
  })
  .filter((w) => {
    const triggers = w.text.slice(0, w.text.search(/^jobs:/m) >>> 0);
    return /^\s{2}(pull_request|push):/m.test(triggers) && !/^\s+paths(-ignore)?:/m.test(triggers);
  });

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
    `no pull_request/push workflow runs a command that LOADS ${GATES_ENV}, so every gate in it stays unset in CI.\n` +
      `      Expected, as a command in a \`run:\` step: ${GATE_LOADER.how}\n` +
      `      (The file's NAME in some other command is not a load — \`rm -f ${GATES_ENV}\` names it too.)`,
  );
}
for (const [lang, how, isRunner] of RUNNERS) {
  if (!onChange.some((w) => w.commands.some((c) => isRunner(argvOf(c))))) {
    problems.push(
      `no pull_request/push workflow EXECUTES the ${lang} test suite — that language is untested on every PR.\n` +
        `      Expected, as a command in a \`run:\` step with npm aliases expanded: ${how}\n` +
        `      (A step title, an \`env:\` value, a \`paths:\`/\`paths-ignore:\` entry and a \`#\` comment\n` +
        `      are not commands. A step carrying an \`if:\`, a job carrying a job-level \`if:\`, and a\n` +
        `      pull_request/push trigger carrying \`paths:\`/\`paths-ignore:\` do not count either —\n` +
        `      none of them runs on every change.)`,
    );
  }
}
for (const u of [...unresolved].sort()) {
  problems.push(`${u} — package.json declares no such script, so that step cannot run at all.`);
}

if (problems.length === 0) {
  console.log(
    `✅ ${gates.size} test gates: each is declared in ${GATES_ENV}, and each declaration gates a test.\n` +
      `   All ${RUNNERS.length} language test runners, and a command that LOADS ${GATES_ENV}, are INVOKED by a\n` +
      `   \`run:\` of a pull_request/push workflow whose trigger carries no \`paths:\`/\`paths-ignore:\`, from a\n` +
      `   step carrying no \`if:\` in a job carrying no \`if:\` — each matched as a predicate over one command's\n` +
      `   argv, with npm aliases (argv[0] \`npm\`) expanded to their package.json bodies and \`#\` comments\n` +
      `   dropped at every level.\n` +
      `   Not checked, and both fall GREEN: quoting is not interpreted, so a shell operator inside a quoted\n` +
      `   string still begins what this reads as a command (\`echo "docs; cargo test -p x"\` counts as Rust);\n` +
      `   and INVOKED is not "ran, and its failure fails the job" (\`|| true\`, \`continue-on-error: true\`).\n` +
      `   That the go suite then really ran is scripts/check-go-test-skips.mjs.`,
  );
  process.exit(0);
}
console.error('❌ tests that CI cannot reach:\n');
for (const p of problems) console.error(`  ${p}`);
console.error(`\n${problems.length} problem(s). A test CI never runs is not a test.`);
process.exit(1);
