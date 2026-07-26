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
 *   C. That same class of workflow invokes each language's test runner.
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
 * The command that runs each language's WHOLE suite. Absent from CI ⇒ that language is untested.
 *
 * These match the unrestricted invocation on purpose. A path-narrowed run is the same bug one level
 * down: `test:ci` was `vitest run test/unit`, which left test/scp, test/parity and test/integration —
 * 1138 tests — out of CI while the job reported green. So TypeScript must be `npm test` (the full
 * `vitest run`), not any `vitest run <dir>`, and Go must be `./...`, not a single package. `pytest`,
 * `phpunit` and `cargo test` already mean "everything" when invoked bare.
 */
const RUNNERS = [
  ['TypeScript', /\bnpm test\b/],
  ['Python', /\bpytest\b/],
  ['PHP', /\bphpunit\b/],
  ['Go', /\bgo test \.\/\.\.\./],
  ['Rust', /\bcargo test\b/],
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

/**
 * What a workflow actually EXECUTES — its `run:` bodies, with `#` comments and the `name:` labels
 * dropped. Matching the whole file would let a step titled "Python — pytest" satisfy the check after
 * its command was deleted, which is precisely the kind of green-by-appearance this script exists to
 * stop.
 */
function commandsOf(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l) && !/^\s*-?\s*name:/.test(l))
    .map((l) => l.replace(/\s#.*$/, ''))
    .join('\n');
}

/** Workflows a pull_request/push can trigger — the only ones that gate a change. */
const onChange = readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => {
    const text = readFileSync(join(WORKFLOWS, f), 'utf8');
    return { name: f, text, commands: commandsOf(text) };
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
for (const [lang, re] of RUNNERS) {
  if (!onChange.some((w) => re.test(w.commands))) {
    problems.push(`no pull_request/push workflow runs the ${lang} test suite (${re.source}) — that language is untested on every PR.`);
  }
}

if (problems.length === 0) {
  console.log(`✅ ${gates.size} test gates declared and loaded, ${RUNNERS.length} language suites run on PR/push`);
  process.exit(0);
}
console.error('❌ tests that CI cannot reach:\n');
for (const p of problems) console.error(`  ${p}`);
console.error(`\n${problems.length} problem(s). A test CI never runs is not a test.`);
process.exit(1);
