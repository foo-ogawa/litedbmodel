/**
 * The shared skeleton of a per-language RUN GATE (#219 go, #220 python/php/rust/TS).
 *
 * `check-reachable-test-gates.mjs` is STATIC: it proves a workflow invokes each language's runner in
 * a way whose failure fails the job. It cannot prove the suite then RAN — every runner reports a
 * skipped test as a success, so a live-DB leg that skips itself is indistinguishable from one that
 * ran and passed, and a test that was never compiled is not even counted. Measured on this tree with
 * the gates closed, every one of these exiting 0:
 *
 *     python3 -m pytest -q                        153 passed, 25 skipped
 *     ./vendor/bin/phpunit  (SKIP_LIVE inherited) Tests: 152, Skipped: 45
 *     cargo test -p litedbmodel_runtime           71 passed + three binaries of `0 tests`
 *     vitest run            (SKIP_INTEGRATION=1)  nothing looks at the skipped count at all
 *
 * A run gate is the running counterpart, and all five ask the same four questions. Those live here so
 * that five copies cannot drift into five different answers:
 *
 *   1. are the gates OPEN in this process — checked BEFORE the suite starts, because a run with them
 *      shut has nothing to say and should not happen ({@link assertGatesOpen});
 *   2. did the runner really start, and did it survive ({@link mustHaveStarted}, {@link exitProblem});
 *   3. does its own machine-readable output account for every test the TREE declares — a suite that
 *      SHRANK reports no skips, so the outcome is checked against an independent enumeration;
 *   4. is every verdict a pass, with the skip budget the language's gate declares.
 *
 * (3) and (4) are per-language, because the enumeration and the report format are. What is NOT
 * per-language is where the enumeration comes from: the language's OWN toolchain (python `ast`, php
 * `ReflectionClass`, `cargo metadata` + libtest, the vitest module graph) rather than a scanner of
 * this repository's making. #222 (A) is why: a hand-written source scanner was fooled twice by
 * comment and string syntax it did not model, and deleting it in favour of the runtime's own dispatch
 * table both shortened the gate and closed the hole.
 */
import { spawn } from 'node:child_process';
import { GATES_ENV, readGateDeclarations } from './livedb-gates.mjs';

/**
 * The precondition every other check in a run gate is read against: the live-DB gates are OPEN.
 * Asserted BEFORE the suite is started.
 *
 * A skip budget is only meaningful with them open — with them closed the honest result IS the skips
 * above. And checking the outcome alone lets the outcome be MANUFACTURED: measured on go, with each
 * live leg's `t.Skip(...)` replaced by a bare `return`, its gate printed `122 passed, 0 failed, 0
 * skipped` and a full green line with the gates closed and no database touched (#219). A budget knows
 * one spelling of "did not run"; the environment the legs read is the same for all of them, so it is
 * checked directly instead.
 *
 * ALL of `livedb-gates.env` is required of every language, not just the gates that language happens
 * to read: the file is the SSoT for "the live legs are open", CI opens it in ONE step for every
 * suite (`conformance.yml`, step "Open the live-DB test gates"), and an environment holding only
 * some of it is not the one CI runs. VALUES are compared, not just presence — `LITEDBMODEL_SKIP_LIVE`
 * has INVERTED polarity and is pinned to `0`, so merely being "set" is satisfied by the value that
 * CLOSES it. That is the php hole in #220: `LITEDBMODEL_SKIP_LIVE=1 ./vendor/bin/phpunit` skipped 45
 * tests and exited 0, and the declaration file's own promise that "a CI run can never be talked out
 * of the live legs by an inherited environment" held only for a path that READ the file.
 */
export function assertGatesOpen(suite) {
  const declarations = readGateDeclarations();
  const shut = [...declarations].filter(([name, value]) => process.env[name] !== value);
  if (shut.length === 0) return declarations;
  console.error(
    `\n❌ ${shut.length} of the ${declarations.size} live-DB gates \`${GATES_ENV}\` declares are not open in this ` +
      `process, so the ${suite} suite would run with its live-DB legs disabled — and a leg that does not run reports ` +
      `nothing this check could catch:\n` +
      shut
        .map(
          ([n, v]) =>
            `      ${n}: declared ${JSON.stringify(v)}, this environment has ${process.env[n] === undefined ? '(unset)' : JSON.stringify(process.env[n])}`,
        )
        .join('\n') +
      `\n\n      npm run docker:livedb:up && set -a && . ./${GATES_ENV} && set +a\n` +
      `      (CI opens them in conformance.yml, step "Open the live-DB test gates".)`,
  );
  process.exit(1);
}

/**
 * One child process, OWNED rather than piped — a pipe loses the runner's exit code unless the caller
 * remembers `set -o pipefail`, and a gate whose redness depends on the shell it was invoked from is
 * the same class of hole it exists to close.
 *
 * `stdout: 'inherit'` is for the runners whose machine-readable output goes to a FILE (pytest's
 * `--junitxml`, phpunit's `--log-junit`, vitest's `--outputFile`): their console output is progress,
 * and swallowing it would leave a CI log with nothing in it for the minutes the suite takes. `'pipe'`
 * is for the ones whose stdout IS the data (`go test -json`, libtest). stderr is always inherited.
 */
export async function runOwned(program, args, { cwd, env = {}, stdout = 'pipe' } = {}) {
  const child = spawn(program, args, { cwd, stdio: ['ignore', stdout, 'inherit'], env: { ...process.env, ...env } });
  let spawnError = null;
  child.on('error', (err) => {
    spawnError = err;
  });
  let out = '';
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
    });
  }
  const { code, signal } = await new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return { stdout: out, exit: code, signal, spawnError, argv: [program, ...args] };
}

/** A runner that could not be STARTED proves nothing at all, so this ends the gate on the spot. */
export function mustHaveStarted(run, label) {
  if (!run.spawnError) return run;
  console.error(`\n❌ could not run \`${label}\`: ${run.spawnError.message}\n      (${run.argv.join(' ')})`);
  process.exit(1);
}

/**
 * The two ways a run can fail that no report format describes: a SIGNAL (the output stops where the
 * process died, so everything after that point was never reported) and an exit code nothing else
 * here explains. Unmodelled ⇒ red, never green.
 */
export function exitProblem(run, label, problems) {
  if (run.signal) {
    problems.push(
      `\`${label}\` was KILLED by ${run.signal}. Its output stops where the process died, so everything after that point was never reported — a partial run is not a green run.`,
    );
  } else if (run.exit !== 0 && problems.length === 0) {
    problems.push(
      `\`${label}\` exited ${run.exit} while everything this gate reads reported success — something failed that this check does not model. Do not read that as green.`,
    );
  }
}

/**
 * The `<testcase>` elements of a JUnit report, with the outcome each one carries — the format BOTH
 * pytest (`--junitxml`) and phpunit (`--log-junit`) write, so it is read in ONE place. Two copies of
 * this parse are free to disagree about what counts as a skip, and the one that is wrong is the one
 * nobody looks at.
 *
 * A regex over MACHINE-WRITTEN XML, which is a different risk from a regex over hand-written source
 * (#222 A): the writers are `_pytest.junitxml` and PHPUnit's JunitXmlLogger, every attribute is
 * double-quoted and every `<`/`&`/`"` inside one is escaped, so a test NAME cannot forge a tag.
 *
 * The verdict is the child element, and its ABSENCE is a pass — so a testcase carrying an element
 * neither of these writers emits would be read as a pass. That is why every caller also checks the
 * runner's own exit code ({@link exitProblem}): unmodelled ⇒ red.
 */
export function junitTestcases(xml) {
  const cases = [];
  for (const [, attrs, , inner = ''] of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = Object.fromEntries([...attrs.matchAll(/\b([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
    const outcome = /<skipped\b/.test(inner)
      ? 'skipped'
      : /<failure\b/.test(inner)
        ? 'failed'
        : /<error\b/.test(inner)
          ? 'error'
          : 'passed';
    cases.push({ attributes, outcome });
  }
  return cases;
}

/** Every problem, NAMED, then exit 1 — or the green line, which is printed only when there are none. */
export function report(problems, green) {
  if (problems.length > 0) {
    console.error('\n' + problems.map((p) => `❌ ${p}`).join('\n\n'));
    process.exit(1);
  }
  console.log(green);
}
