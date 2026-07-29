/**
 * litedbmodel SCP LIVE-DB orchestrator (#36 WS7g; leaf/emitter cutover #144) — the coordinated
 * cross-language live-DB pass.
 *
 * Runs the live-DB corpus (`conformance/vectors-livedb/livedb.json`) through EACH language leg
 * against ONE shared dockerized Postgres + MySQL stack, sequentially, and asserts every runtime
 * reproduces what the TS leg captured on the SAME servers (the §10 promise). A leg executes the
 * module bc GENERATED for its language from the SAME declaration — nothing is replayed from a
 * serialized bundle, because a leaf-executed module needs a live in-process handle.
 *
 * ## The legs
 *
 *   - `py`   — `python/conformance/livedb_runner.py`          (bc `--lang python`)
 *   - `php`  — `php/conformance/livedb_runner.php`            (bc `--lang php`)
 *   - `go`   — `go/conformance/livedb/livedb_runner.go`       (bc `--lang go-typed-native`)
 *   - `rust` — `rust/livedb_runner` crate                     (bc `--lang rust-typed-native`)
 *
 * All four run the SAME live-DB corpus. go / rust execute the typed-native module bc generates for
 * their language (the SKIP endpoint's `whereDynamic` port lowers to a `{frags}` plan the leaf
 * transport assembles at execution time, CLAUDE.md §2), the SAME way python / php run their literal
 * module. The TS leg over these same vectors is `test/scp/conformance-vectors.test.ts` (main suite).
 *
 * Prerequisite: the docker stack is UP with host-published ports (docker-compose.livedb.yml) and
 * the corpus + language modules are generated. Typical driver:
 *
 *   npm run docker:livedb:up          # postgres+mysql on host ports 5433/3307
 *   npm run conformance:gen:livedb    # regenerate the language modules + the corpus
 *   npm run conformance:livedb        # run every language leg
 *   npm run docker:livedb:down
 *
 * Each leg emits a machine-readable JSON summary as its LAST stdout line:
 *   {"lang":"<x>-livedb","suites":{"livedb-pg":{pass,fail},"livedb-mysql":{pass,fail}},...}
 * and exits 0 (all pass) / 1 (any fail) / 2 (corpus mismatch) / 3 (DB unreachable — LOUD, never
 * a silent skip). This orchestrator fails if ANY leg is not all-pass, or any leg is unrunnable.
 *
 * The Python venv / driver install is environment-specific; set LIVEDB_PY to point at the Python
 * interpreter that has psycopg + pymysql + behavior_contracts (defaults to `python3`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const CORPUS = join(HERE, 'vectors-livedb', 'livedb.json');

interface SuiteTally {
  pass: number;
  fail: number;
}
interface Summary {
  lang: string;
  suites: Record<string, SuiteTally>;
  total_pass: number;
  total_fail: number;
  version_mismatch: boolean;
}

function parseSummary(stdout: string): Summary | null {
  const lines = stdout.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    try {
      const j = JSON.parse(l);
      if (j && typeof j === 'object' && 'lang' in j && 'total_pass' in j) return j as Summary;
    } catch {
      // keep scanning upward
    }
    break;
  }
  return null;
}

interface LangLeg {
  lang: string;
  cmd: string;
  args: string[];
  cwd?: string;
  /** Set while this language has no live-DB runner yet: the issue that will supply it. */
  blockedBy?: string;
}

/**
 * EVERY language the corpus is supposed to run on — including the ones that cannot yet, each naming
 * the issue that blocks it. Listing only the working legs is how a run of 2 languages came to print
 * "PASS (2 language runtime(s) green)": nothing in the output said four were expected. A leg missing
 * from this list is invisible; a leg present without `blockedBy` that fails to run is a FAILURE.
 */
const LEGS: LangLeg[] = [
  { lang: 'py', cmd: process.env.LIVEDB_PY || 'python3', args: [join(REPO, 'python', 'conformance', 'livedb_runner.py')] },
  { lang: 'php', cmd: 'php', args: [join(REPO, 'php', 'conformance', 'livedb_runner.php')] },
  { lang: 'go', cmd: 'go', args: ['run', './conformance/livedb'], cwd: join(REPO, 'go') },
  { lang: 'rust', cmd: 'cargo', args: ['run', '--quiet', '-p', 'livedb_runner', '--features', 'livedb'], cwd: join(REPO, 'rust') },
];

// The env each leg inherits (host-published docker ports; matches docker-compose.livedb.yml).
const env = {
  ...process.env,
  LITEDBMODEL_LIVEDB_VECTORS: CORPUS,
  TEST_DB_HOST: process.env.TEST_DB_HOST || 'localhost',
  TEST_DB_PORT: process.env.TEST_DB_PORT || '5433',
  TEST_MYSQL_HOST: process.env.TEST_MYSQL_HOST || '127.0.0.1',
  TEST_MYSQL_PORT: process.env.TEST_MYSQL_PORT || '3307',
  GOPRIVATE: process.env.GOPRIVATE || 'github.com/foo-ogawa/*',
};

function main(): void {
  console.log('conformance(livedb): litedbmodel SCP live-DB corpus × language runtimes (real PG + MySQL)');
  console.log(`conformance(livedb): corpus ${CORPUS}\n`);
  if (!existsSync(CORPUS)) {
    console.error(`conformance(livedb): FAIL — live-DB corpus missing (run: npm run conformance:gen:livedb)`);
    process.exit(2);
  }

  let anyFail = false;
  const blocked: LangLeg[] = [];
  for (const leg of LEGS) {
    if (leg.blockedBy) {
      blocked.push(leg);
      continue;
    }
    const proc = spawnSync(leg.cmd, leg.args, {
      cwd: leg.cwd ?? REPO,
      env,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    if (proc.error) {
      console.error(`  [ERR ] ${leg.lang.padEnd(4)} could not launch: ${proc.error}`);
      anyFail = true;
      continue;
    }
    const summary = parseSummary(proc.stdout ?? '');
    if (proc.status === 3) {
      console.error(`  [FAIL] ${leg.lang.padEnd(4)} DB UNREACHABLE (exit 3) — start the docker stack first`);
      anyFail = true;
      continue;
    }
    if (!summary) {
      console.error(`  [FAIL] ${leg.lang.padEnd(4)} no JSON summary (exit ${proc.status})`);
      anyFail = true;
      continue;
    }
    const pg = summary.suites['livedb-pg'] ?? { pass: 0, fail: 0 };
    const my = summary.suites['livedb-mysql'] ?? { pass: 0, fail: 0 };
    const ok = summary.total_fail === 0 && proc.status === 0;
    const tag = ok ? 'OK  ' : 'FAIL';
    console.log(
      `  [${tag}] ${leg.lang.padEnd(4)} pg ${pg.pass}/${pg.pass + pg.fail}, mysql ${my.pass}/${my.pass + my.fail} (total ${summary.total_pass}/${summary.total_pass + summary.total_fail}) [exit ${proc.status}]`,
    );
    if (!ok) anyFail = true;
  }

  console.log('');
  for (const leg of blocked) {
    console.log(`  [GAP ] ${leg.lang.padEnd(4)} NOT RUN — no live-DB runner yet (${leg.blockedBy})`);
  }
  if (blocked.length) console.log('');
  if (anyFail) {
    console.error('conformance(livedb): FAIL — a language leg did not pass all live-DB vectors');
    process.exit(1);
  }
  const ran = LEGS.length - blocked.length;
  const gap = blocked.length ? ` — ${blocked.length} NOT RUN: ${blocked.map((l) => `${l.lang} (${l.blockedBy})`).join(', ')}` : '';
  console.log(`conformance(livedb): ${ran}/${LEGS.length} language runtimes green on live PG + MySQL${gap}`);
}

main();
