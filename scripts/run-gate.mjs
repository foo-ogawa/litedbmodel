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
 * per-language is the requirement that the enumeration be INDEPENDENT of the run: the run cannot
 * report a test it was never told about, so the thing it is checked against has to come from
 * somewhere the narrowing does not reach.
 *
 * Where possible that is the language's own parser or manifest, never a scanner of this repository's
 * making — python `ast`, php `ReflectionClass`, cargo's LAYOUT rules read off the tree — because
 * #222 (A) is what a hand-written scanner was worth: fooled twice by comment and string syntax it did
 * not model, 361 lines deleted in favour of asking the runtime. Where a parser would add nothing the
 * instrument is the FILESYSTEM: go globs `go/**\/*_test.go` for its `func Test*`, TypeScript globs
 * its own `test/**\/*.test.ts` for its test files. Neither of those is a toolchain and this
 * comment used to claim otherwise for vitest, which has no such enumeration to give — asking vitest
 * would only have asked the narrowed side twice.
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
 * A database that is NOT THERE — `127.0.0.1:1` refuses every connection instantly.
 *
 * The instrument of every gate's PHASE 2: an outcome cannot tell a leg that queried the database from
 * one whose body is empty, because both pass. Re-run against a server that does not exist, a leg that
 * dials must FAIL; one that PASSES never touched a database, whatever its body claims.
 *
 * It needs no database, which is the point — the ABSENCE of a server is what does the measuring. Nor
 * can it reach the real stack by accident: every live leg in every language builds its DSN from these
 * four variables (the 5433/3307 literals in those files are defaults), and all four are overridden.
 * Shared because it is one idea; two copies could drift into one gate pointing at a port something
 * actually listens on, which would make its phase 2 pass for the wrong reason.
 *
 * `LITEDBMODEL_ACQUIRE_TIMEOUT_SECS` is here for the same reason the ports are. "Refuses instantly" is
 * true of the SOCKET, not of every pool on top of it: `sqlx` RETRIES a refused connection until its
 * acquire budget expires, and that budget is the 30s cross-language default (#225), so each
 * MySQL-touching rust suite spent ~30s re-dialling a port it had already been refused by — ~90s of the
 * rust gate's ~165s (#255). Two seconds is far more than a loopback RST needs and still leaves the
 * refusal as the thing that fails the leg. It is an override of the runtime's default, not a second
 * default: production keeps 30s, which is what absorbs a database restart.
 *
 * Postgres needs no entry — `deadpool`/`tokio-postgres` surfaces the refusal in ~1.5s instead of
 * retrying — and python bounds its hand-rolled pool itself (#225).
 */
export const UNREACHABLE = {
  TEST_DB_HOST: '127.0.0.1',
  TEST_DB_PORT: '1',
  TEST_MYSQL_HOST: '127.0.0.1',
  TEST_MYSQL_PORT: '1',
  LITEDBMODEL_ACQUIRE_TIMEOUT_SECS: '2',
};

/**
 * One child process, OWNED rather than piped — a pipe loses the runner's exit code unless the caller
 * remembers `set -o pipefail`, and a gate whose redness depends on the shell it was invoked from is
 * the same class of hole it exists to close.
 *
 * `timeoutMs` kills the child and reports `timedOut`, for the one case where a runner is expected to
 * HANG rather than answer: python's live corpus leg blocks forever against an unreachable database
 * (#225 — the pool's acquire has no timeout), and a gate that waited for it would never finish. It is
 * reported apart from a real signal so a hang can never be read as a verdict.
 *
 * `stdout: 'inherit'` is for the runners whose machine-readable output goes to a FILE (pytest's
 * `--junitxml`, phpunit's `--log-junit`, vitest's `--outputFile`): their console output is progress,
 * and swallowing it would leave a CI log with nothing in it for the minutes the suite takes. `'pipe'`
 * is for the ones whose stdout IS the data (`go test -json`, libtest). stderr is always inherited.
 */
export async function runOwned(program, args, { cwd, env = {}, stdout = 'pipe', timeoutMs } = {}) {
  const child = spawn(program, args, { cwd, stdio: ['ignore', stdout, 'inherit'], env: { ...process.env, ...env } });
  let spawnError = null;
  child.on('error', (err) => {
    spawnError = err;
  });
  let timedOut = false;
  const timer =
    timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs);
  let out = '';
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
    });
  }
  const { code, signal } = await new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  if (timer) clearTimeout(timer);
  return { stdout: out, exit: code, signal, timedOut, spawnError, argv: [program, ...args] };
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
