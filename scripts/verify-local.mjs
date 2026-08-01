#!/usr/bin/env node
/**
 * `npm run verify` — everything CI gates, in one command, on THIS machine.
 *
 * There was no such command. The repository has twenty-odd individual gates and each of them is
 * correct, but "have I run them all?" was assembled by hand every time, so a red gate could ship: the
 * rust run gate was red on the integration branch for a whole session because #138 added an
 * integration test and nobody ran `npm run rust:test` after it (#261). A gate nobody runs locally is a
 * gate that only fails after the push.
 *
 * ── The list cannot drift from CI ─────────────────────────────────────────────────────────────
 *
 * Every `npm run <script>` a PR-triggered workflow invokes must appear in {@link STEPS}, and the check
 * is a set difference over the workflow text — finite, no interpretation. A gate added to CI and not
 * here fails this script before it runs anything. (The reverse is deliberately allowed: `verify` may
 * run MORE than CI, and does — see the architecture note.)
 *
 * ── Why running this matters even when CI is green ────────────────────────────────────────────
 *
 * CI is x86-64 linux. This is an arm64 mac. That is not a detail: `wireKeyCell` folded a whole float
 * onto an integer key by round-tripping through `int64(f)`, which is implementation-defined out of
 * range — arm64 saturates to MaxInt64, x86-64 yields MinInt64 — so 2^63 and MaxInt64 shared a
 * grouping bucket on arm64 and on arm64 ONLY. The test that catches it was there from the start and
 * green in CI forever (#262). The two architectures are not interchangeable, so BOTH have to run the
 * suites, and this command is the arm64 half. It therefore refuses to run under a mismatched
 * toolchain rather than quietly measuring the wrong machine — the same contract
 * `benchmark/crosslang/run-cells.sh` already enforces for the bench.
 *
 *   node scripts/verify-local.mjs            # everything
 *   node scripts/verify-local.mjs --no-db    # skip the steps that need the dockerized PG/MySQL
 *   node scripts/verify-local.mjs --list     # print the plan and exit
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const NO_DB = argv.includes('--no-db');
const LIST_ONLY = argv.includes('--list');

/**
 * The plan, in the order a failure is most cheaply found: static gates, then the type/lint layer, then
 * the suites that need a database. `db: true` marks a step that cannot run without the dockerized
 * PG+MySQL (`npm run docker:livedb:up`).
 */
const STEPS = [
  { npm: 'deps:installed', db: false },
  { npm: 'deps:check', db: false },
  { npm: 'sync:versions:check', db: false },
  { npm: 'tracked:check', db: false },
  { npm: 'pkg:check', db: false },
  { npm: 'spec:check', db: false },
  { npm: 'gates:check', db: false },
  { npm: 'types:check', db: false },
  { npm: 'lint', db: false },
  { npm: 'build', db: false },
  { npm: 'build:scp', db: false },
  { npm: 'docs', db: false },
  { npm: 'docs:bench:check', db: false },
  { npm: 'go:fmt:check', db: false },
  { npm: 'vendor:bc-php:check', db: false },
  { npm: 'bench:codegen:drift', db: false },
  { cmd: ['bash', 'scripts/verify-rust-lints.sh'], label: 'rust fmt + clippy (all 5 crates, as CI runs them)', db: false },
  { npm: 'conformance:gen', db: false },
  { npm: 'go:test', db: false },
  { npm: 'rust:test', db: true },
  { npm: 'ts:test', db: true },
  { npm: 'py:test', db: true },
  { npm: 'php:test', db: true },
  { npm: 'conformance:gen:livedb', db: true },
  { npm: 'conformance:livedb', db: true },
  // The two halves, not the `conformance:dispatch:check` composite that chains them — the drift check
  // matches CI's invocations by NAME, and CI names these two.
  { npm: 'go:dispatch:check', db: true },
  { npm: 'rust:dispatch:check', db: true },
];

// ── the list cannot drift from CI ───────────────────────────────────────────────────────────────
const WORKFLOWS = join(ROOT, '.github/workflows');
const prWorkflows = readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ f, text: readFileSync(join(WORKFLOWS, f), 'utf8') }))
  .filter((w) => /^on:[\s\S]*?pull_request/m.test(w.text.slice(0, w.text.search(/^jobs:/m) >>> 0)));
const ciScripts = new Set();
for (const w of prWorkflows) {
  for (const m of w.text.matchAll(/npm run ([a-z0-9:._-]+)/g)) ciScripts.add(m[1]);
}
// `prisma:generate` lives in benchmark/package.json, not this manifest — it is not a gate of this tree.
const ours = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts));
const planned = new Set(STEPS.filter((s) => s.npm).map((s) => s.npm));
const missing = [...ciScripts].filter((s) => ours.has(s) && !planned.has(s)).sort();
if (missing.length > 0) {
  console.error(
    `❌ verify: ${missing.length} npm script(s) a PR workflow runs are NOT in this plan, so \`npm run verify\`\n` +
      `   would pass while CI fails on them. Add them to STEPS in scripts/verify-local.mjs:\n` +
      missing.map((s) => `      npm run ${s}`).join('\n'),
  );
  process.exit(1);
}

// ── the toolchain this is allowed to speak for ──────────────────────────────────────────────────
const need = (label, got, want) => {
  if (got !== want) {
    console.error(
      `❌ verify: ${label} is '${got}', not '${want}'.\n` +
        `   CI covers x86-64 linux; this command is the arm64 half (#262), and on the wrong toolchain it\n` +
        `   would report on a machine nobody ships from. Use the arm64 nvm node and /opt/homebrew tools.`,
    );
    process.exit(1);
  }
};
const out = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout?.trim() ?? '';
need('node process.arch', process.arch, 'arm64');
need('go GOARCH', out('go', ['env', 'GOARCH']), 'arm64');
need('php php_uname("m")', out('php', ['-r', 'echo php_uname("m");']), 'arm64');
need('python platform.machine()', out('python3', ['-c', 'import platform;print(platform.machine())']), 'arm64');

if (LIST_ONLY) {
  for (const s of STEPS) console.log(`${s.db ? 'db  ' : '    '}${s.npm ? `npm run ${s.npm}` : s.cmd.join(' ')}`);
  process.exit(0);
}

// The live-DB gates each suite reads (`livedb-gates.env` is the SSoT) must be OPEN in this process, or
// the run gates refuse to start — the same thing CI's "Open the live-DB test gates" step does.
const gateEnv = {};
if (!NO_DB) {
  for (const line of readFileSync(join(ROOT, 'livedb-gates.env'), 'utf8').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) gateEnv[m[1]] = m[2];
  }
}

const results = [];
for (const step of STEPS) {
  if (step.db && NO_DB) {
    results.push({ label: step.npm ?? step.label, state: 'skipped (--no-db)', ms: 0 });
    continue;
  }
  const label = step.npm ? `npm run ${step.npm}` : step.label;
  const [cmd, args] = step.npm ? ['npm', ['run', '--silent', step.npm]] : [step.cmd[0], step.cmd.slice(1)];
  process.stderr.write(`── ${label}\n`);
  const started = Date.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...gateEnv } });
  const ms = Date.now() - started;
  results.push({ label, state: r.status === 0 ? 'ok' : `FAILED (exit ${r.status ?? 'signal'})`, ms });
  if (r.status !== 0 && !argv.includes('--keep-going')) {
    report();
    console.error(`\n❌ verify: stopped at \`${label}\`. Re-run with --keep-going to see the rest.`);
    process.exit(1);
  }
}
report();
const failed = results.filter((r) => r.state.startsWith('FAILED'));
if (failed.length > 0) {
  console.error(`\n❌ verify: ${failed.length} step(s) failed.`);
  process.exit(1);
}
console.error(`\n✅ verify: all ${results.filter((r) => r.state === 'ok').length} step(s) green on ${process.arch}.`);

function report() {
  console.error('\n──────── verify summary ────────');
  for (const r of results) {
    console.error(`  ${r.state === 'ok' ? '✓' : r.state.startsWith('FAILED') ? '✗' : '·'} ${String(Math.round(r.ms / 1000)).padStart(4)}s  ${r.label}  ${r.state === 'ok' ? '' : r.state}`);
  }
  const total = results.reduce((a, r) => a + r.ms, 0);
  console.error(`  total ${Math.round(total / 1000)}s`);
}
