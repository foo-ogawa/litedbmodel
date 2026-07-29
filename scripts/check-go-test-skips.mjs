#!/usr/bin/env node
/**
 * The Go suite's SKIP BUDGET (#219) — the running counterpart of `check-reachable-test-gates.mjs`.
 *
 * That script is static: it proves a `LITEDBMODEL_*` gate is declared and that some workflow loads
 * the declaration. It cannot prove the gate actually OPENED. `go test` reports a skipped test as a
 * success, so a live-DB leg that skips itself — the environment variable unset, the docker stack
 * down, a `t.Skip` added later — is indistinguishable from one that ran and passed. Sixteen go live
 * tests skipping is a green suite that executed none of them, which is how the #215 regression
 * (a named-DB transaction opening on the WRONG database) reached a commit: the checklist ran
 * `go test ./...` with the gate closed.
 *
 * So this counts. With the gates open the whole go suite runs, and the budget is therefore ZERO:
 *
 *     cd go && go test ./... -json | node ../scripts/check-go-test-skips.mjs
 *
 * Any skip fails the gate and is NAMED, so the fix is either "open the gate" or a deliberate,
 * reviewed raise of the budget below — never a silent green. Test FAILURES fail here too (the JSON
 * stream swallows go's own exit code through the pipe), and their output is replayed so a failing
 * run reads exactly as `go test` would print it.
 */
import { createInterface } from 'node:readline';

/**
 * How many go tests may skip. ZERO: every live-DB leg is gated on `LITEDBMODEL_TX_ISOLATION`, which
 * `livedb-gates.env` declares and CI opens before the go step — so with the stack up nothing has a
 * reason to skip. Raising this is a decision about coverage, not a formality: name the tests and why.
 */
const SKIP_BUDGET = 0;

/** test full name → { action, output[] } for every test the stream reports on. */
const tests = new Map();
const key = (e) => `${e.Package}.${e.Test}`;

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.startsWith('{')) continue; // a non-JSON line (a build error) is replayed below via stderr
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (!e.Test) continue; // package-level events carry no test verdict
  const k = key(e);
  if (!tests.has(k)) tests.set(k, { package: e.Package, test: e.Test, action: null, output: [] });
  const t = tests.get(k);
  if (e.Action === 'output') t.output.push(e.Output);
  else if (e.Action === 'pass' || e.Action === 'fail' || e.Action === 'skip') t.action = e.Action;
}

const by = (a) => [...tests.values()].filter((t) => t.action === a);
const [passed, failed, skipped] = [by('pass'), by('fail'), by('skip')];

for (const t of failed) process.stdout.write(t.output.join(''));
console.log(`go test: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);

if (skipped.length > SKIP_BUDGET) {
  console.error(
    `\n❌ ${skipped.length} go test(s) SKIPPED, budget ${SKIP_BUDGET}. A skipped test is not a passing test:\n` +
      skipped.map((t) => `      ${t.package} ${t.test}`).join('\n') +
      `\n\n   Open the live-DB gates and bring the stack up, then re-run:\n` +
      `      npm run docker:livedb:up && set -a && . ./livedb-gates.env && set +a\n`,
  );
  process.exit(1);
}
if (failed.length > 0) {
  console.error(`\n❌ ${failed.length} go test(s) FAILED.`);
  process.exit(1);
}
if (tests.size === 0) {
  console.error('\n❌ the stream reported no tests at all — the suite never ran.');
  process.exit(1);
}
console.log(`✅ every go test ran (${skipped.length} skipped, budget ${SKIP_BUDGET})`);
