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
 *   C. That same class of workflow invokes each language's test runner — as RESOLVED, not as named.
 *      A workflow step reading `npm run go:test` says nothing on its own; what runs is whatever
 *      `package.json` currently binds that name to. Measured: rebinding `go:test` to a bare
 *      `cd go && go test ./...` left this script printing `✅ 5 test gates declared and loaded`
 *      while the go suite went back to reporting sixteen skips as success. So every `npm run <x>` /
 *      `npm test` in a workflow is expanded to its script body before clause C looks at it.
 *
 * A workflow triggered only by `release` / `workflow_dispatch` satisfies nothing: publish-time
 * execution is not a gate on the change that broke it.
 *
 *   node scripts/check-reachable-test-gates.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GATES_ENV = 'livedb-gates.env';
const WORKFLOWS = join(ROOT, '.github', 'workflows');
/** Where a language's tests live. A gate read here is a gate CI must be able to open. */
const TEST_DIRS = ['python/tests', 'php/tests', 'go', 'rust/litedbmodel_runtime/tests', 'test', 'conformance'];
const TEST_FILE = /\.(py|php|go|rs|ts|mts)$/;
const GATE = /LITEDBMODEL_[A-Z0-9_]+/g;
/** Carries the corpus path into a runner (set by `conformance/livedb-run.ts`); not a skip gate. */
const NOT_A_GATE = new Set(['LITEDBMODEL_LIVEDB_VECTORS']);
/**
 * The command that runs each language's WHOLE suite, matched against the RESOLVED workflow text —
 * every `npm run <x>` already replaced by its `package.json` body. Absent from CI ⇒ that language is
 * untested. Matching the resolved form is what makes an alias unable to lie: the name a workflow
 * writes is not evidence of anything, its body is.
 *
 * These match the unrestricted invocation on purpose. A path-narrowed run is the same bug one level
 * down: `test:ci` was `vitest run test/unit`, which left test/scp, test/parity and test/integration —
 * 1138 tests — out of CI while the job reported green. So TypeScript must resolve to `vitest run`
 * carrying no path (trailing `-`/`--` flags are fine; `vitest run test/unit` and
 * `vitest run --config <a narrower project>` are not). `pytest`, `phpunit` and `cargo test` already
 * mean "everything" when invoked bare.
 *
 * Go must resolve to `scripts/check-go-test-skips.mjs` and NOT a bare `go test ./...`, because for Go
 * "everything ran" is a claim `go test` does not make: it reports a skipped test as a success, serves
 * a whole cached run without starting the binary, and reports a package that failed to build only
 * inside its -json stream. That script runs the `./...` suite uncached and checks it against the tree
 * (#219); a workflow — or an alias — that reverts to the bare command is back to green-by-default.
 */
const RUNNERS = [
  ['TypeScript', /\bvitest run(?:[^\S\n]+-[^\s;&|]*)*[^\S\n]*(?=$|[;&|])/m, 'npm test → vitest run'],
  ['Python', /\bpytest\b/, 'pytest'],
  ['PHP', /\bphpunit\b/, 'phpunit'],
  ['Go', /\bscripts\/check-go-test-skips\.mjs\b/, 'npm run go:test → node scripts/check-go-test-skips.mjs'],
  ['Rust', /\bcargo test\b/, 'cargo test'],
];

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

const declared = new Set(
  readFileSync(join(ROOT, GATES_ENV), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('=')[0]),
);

const PKG_SCRIPTS = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
const NPM_CALL = /\bnpm\s+(?:run(?:-script)?\s+([A-Za-z0-9:_./@-]+)|(test|start))\b/g;
/** `<workflow>: npm run <name>` for a script `package.json` does not declare — that step cannot run. */
const unresolved = new Set();

/**
 * Every `npm run <x>` / `npm test` replaced by the script BODY `package.json` binds it to, applied
 * again to the result because scripts call scripts. An alias is a name, not a command: the whole
 * point of resolving it here is that a workflow step and the thing it actually executes stop being
 * two different facts one of which nobody checks.
 */
function resolveNpmScripts(text, where, chain = []) {
  return text.replace(NPM_CALL, (m, named, builtin, offset, whole) => {
    const name = named ?? builtin;
    const body = PKG_SCRIPTS[name];
    if (body === undefined) {
      // `--if-present` is npm's own "this script may legitimately not exist".
      const end = whole.indexOf('\n', offset);
      if (!whole.slice(offset, end === -1 ? undefined : end).includes('--if-present')) {
        unresolved.add(`${where}: npm run ${name}`);
      }
      return m;
    }
    if (chain.includes(name)) return m; // a script reached through itself; leave it as written
    return resolveNpmScripts(body, where, [...chain, name]);
  });
}

/**
 * What a workflow actually EXECUTES — its `run:` bodies with `#` comments and the `name:` labels
 * dropped, then npm aliases resolved. Matching the whole file would let a step titled
 * "Python — pytest" satisfy the check after its command was deleted, and matching an unresolved
 * `npm run go:test` lets the same deletion happen inside `package.json` instead; both are the
 * green-by-appearance this script exists to stop, so both are handled in this one place.
 */
function commandsOf(text, where) {
  return resolveNpmScripts(
    text
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && !/^\s*-?\s*name:/.test(l))
      .map((l) => l.replace(/\s#.*$/, ''))
      .join('\n'),
    where,
  );
}

/** Workflows a pull_request/push can trigger — the only ones that gate a change. */
const onChange = readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => {
    const text = readFileSync(join(WORKFLOWS, f), 'utf8');
    return { name: f, text, commands: commandsOf(text, f) };
  })
  .filter((w) => /^\s{2}(pull_request|push):/m.test(w.text.slice(0, w.text.search(/^jobs:/m) >>> 0)));

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
if (!onChange.some((w) => w.commands.includes(GATES_ENV))) {
  problems.push(`no pull_request/push workflow loads ${GATES_ENV}, so every gate in it stays unset in CI.`);
}
for (const [lang, re, how] of RUNNERS) {
  if (!onChange.some((w) => re.test(w.commands))) {
    problems.push(
      `no pull_request/push workflow runs the ${lang} test suite — that language is untested on every PR.\n` +
        `      Expected, after npm aliases are resolved: ${how}`,
    );
  }
}
for (const u of [...unresolved].sort()) {
  problems.push(`${u} — package.json declares no such script, so that step cannot run at all.`);
}

if (problems.length === 0) {
  console.log(
    `✅ ${gates.size} test gates declared and loaded, ${RUNNERS.length} language suites run on PR/push ` +
      `(npm aliases resolved to their package.json bodies, not taken at their name)`,
  );
  process.exit(0);
}
console.error('❌ tests that CI cannot reach:\n');
for (const p of problems) console.error(`  ${p}`);
console.error(`\n${problems.length} problem(s). A test CI never runs is not a test.`);
process.exit(1);
