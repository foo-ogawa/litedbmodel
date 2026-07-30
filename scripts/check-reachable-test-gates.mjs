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
 * body of a shell compound or of a `( … )` / `{ …; }` group; and every workflow whose pull_request /
 * push trigger carries `paths:` / `paths-ignore:`, which gates only some changes. A workflow
 * triggered only by `release` / `workflow_dispatch` satisfies nothing either: publish-time execution
 * is not a gate on the change that broke it.
 *
 * One thing it does NOT check, and it falls GREEN — the direction that matters, which is why it is
 * named: whether a job that fails BLOCKS anything. `if:` and `continue-on-error:` are in the file and
 * are read; a required-status-check is a branch-protection setting, so a job that goes red while the
 * merge proceeds looks identical here to one that gates.
 *
 * Nor does it claim the suites then ran or passed: it reads workflows and `package.json`, nothing
 * else, so `cargo test --no-run` is INVOKED, binding, and runs no test. For Go that second half is
 * `scripts/check-go-test-skips.mjs`, which runs the suite with the gates asserted open.
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
function runBodies(text) {
  const lines = text.split('\n');
  const bodies = [];
  /** The step being read: its `- ` lead, whether a key of its own disowns it, and its commands. */
  let step = null;
  /** The job being read: whether a job-level key disowns every step of it, and their commands. */
  let job = null;
  let inJobs = false;
  /** Whether a workflow-level key disowns every job in the file. */
  let workflowNotGating = false;
  const endStep = () => {
    if (step && job && !step.notGating) job.runs.push(...step.runs);
    step = null;
  };
  const endJob = () => {
    endStep();
    if (job && !job.notGating) bodies.push(...job.runs);
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
        `      (A step title, an \`env:\` value, a \`paths:\`/\`paths-ignore:\` entry, a \`#\` comment and\n` +
        `      anything inside quotes are not commands. Nor does a command count that the shell would\n` +
        `      not hold to account: after \`||\`, left of a \`|\`, \`&\`-backgrounded, after \`set +e\`, or in\n` +
        `      the body of an \`if\`/\`for\`/\`while\`/\`case\` or a \`( … )\`/\`{ …; }\` group. Nor a step or job\n` +
        `      carrying \`if:\`, \`continue-on-error:\` or a \`shell:\` other than bash/sh, nor a\n` +
        `      pull_request/push trigger carrying \`paths:\`/\`paths-ignore:\` — none of those has to run\n` +
        `      and pass on every change.)`,
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
      `   step in a job in a workflow carrying no \`if:\`, no \`continue-on-error:\` other than false and no\n` +
      `   \`shell:\` other than bash/sh — and INVOKED here means the shell would let the failure FAIL THE JOB:\n` +
      `   not in an and-or list carrying \`||\`, not left of a \`|\`, not \`&\`-backgrounded, not after \`set +e\`,\n` +
      `   not in the body of an \`if\`/\`for\`/\`while\`/\`case\` or of a \`( … )\`/\`{ …; }\` group. Each is matched as a\n` +
      `   predicate over one command's argv, with npm aliases (argv[0] \`npm\`) expanded to their package.json\n` +
      `   bodies, \`#\` comments dropped at every level, and the command boundaries found by a tokenizer that\n` +
      `   reads quoting — an operator or \`#\` inside \`'\`/\`"\`/a backtick/\`$(\`/\`\${\` or behind a \`\\\` is text.\n` +
      `   Not checked, and it falls GREEN: whether a job that FAILS blocks anything — a required status\n` +
      `   check is branch protection, not a file this can read.\n` +
      `   That the go suite then really ran is scripts/check-go-test-skips.mjs.`,
  );
  process.exit(0);
}
console.error('❌ tests that CI cannot reach:\n');
for (const p of problems) console.error(`  ${p}`);
console.error(`\n${problems.length} problem(s). A test CI never runs is not a test.`);
process.exit(1);
