// What every TypeScript bench mode presents to the runner, and the ONE seed-SSoT reader.
//
// The cell has three modes (#162) because TypeScript is the only language with three real execution
// paths: `codegen` (the bc-generated module over litedbmodel's leaf transport — the twin of the other
// languages' native cells), `v1` (the imperative DBModel path, which builds its SQL at run time), and
// `sdk` (raw better-sqlite3 / pg / mysql2 — the baseline). One `Cell` shape lets the runner time all
// three identically.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Dialect = 'sqlite' | 'postgres' | 'mysql';
export const DIALECTS: readonly Dialect[] = ['sqlite', 'postgres', 'mysql'];

export type Mode = 'codegen' | 'v1' | 'sdk';
export const MODES: readonly Mode[] = ['codegen', 'v1', 'sdk'];

export interface Cell {
  readonly dialect: Dialect;
  /**
   * True when `run` returns synchronously. The sqlite legs of codegen and sdk are genuinely sync, and
   * awaiting them would charge the measurement a microtask the real code never pays — the runner
   * keeps a sync loop for those and an async loop for the rest.
   */
  readonly sync: boolean;
  /** Re-apply the canonical fixture. Runs OFF the counted seam, before each op. */
  seed(): void | Promise<void>;
  run(op: string, it: number): void | Promise<void>;
  close(): void | Promise<void>;
  /** Statements issued since the last {@link resetCounters} — the N+1 / atomic-tx safety proof. */
  statements(): number;
  /**
   * Rows the DB handed back since the last {@link resetCounters}, summed over the op's statements.
   *
   * This is the denominator the report normalizes latency by, and the evidence that every cell — the
   * runtime cells AND the hand-written SDK baselines — really moved the same rows. A baseline that
   * quietly fetched fewer rows would post a flattering ratio; #170 is what happens when nobody looks.
   *
   * `null` means this leg has NO row-observing seam (v1 on SQLite reaches the DB through the in-proc
   * path, whose only hook is a SQL-text logger). The report then renders `—` for it; it never renders a
   * zero, which would read as "moved no rows".
   */
  rows(): number | null;
  /** Zero both counters (called off the timed seam, before each measured iteration). */
  resetCounters(): void;
  /**
   * This mode's expected statement count per op, when it differs from the shared
   * {@link import('./inputs.js').EXPECTED_STATEMENTS}. The v1 path refuses a write outside a
   * transaction (WriteOutsideTransactionError — its safe-operation policy), so every single-row write
   * there really is BEGIN + statement + COMMIT. That is a property of the path, and the bench reports
   * it rather than hiding it behind a relaxed assertion.
   */
  readonly expectedStatements?: Readonly<Record<string, number>>;
  /**
   * Ops this mode cannot express, with why. The v1 imperative API has no upsert, so its cell declares
   * that rather than reaching for hand-written SQL — which would make it an SDK cell wearing a v1
   * label. The runner prints these and emits no rows for them.
   */
  readonly unsupported?: Readonly<Record<string, string>>;
}

/**
 * Tally the rows a runtime SQL-middleware `next()` handed back and pass the result through unchanged —
 * the ONE place the codegen and v1 modes derive `Cell.rows` from, since both ride the same seam.
 *
 * The read seam yields the row array; a non-RETURNING write yields a run summary, which contributes
 * nothing. `next` is sync on an in-proc driver and a promise on a pooled one, so both are handled here
 * rather than at each call site.
 */
export function tallyRows(result: unknown, add: (n: number) => void): unknown {
  const rowsOf = (r: unknown): number => (Array.isArray(r) ? r.length : 0);
  if (result instanceof Promise) {
    return result.then((r) => {
      add(rowsOf(r));
      return r;
    });
  }
  add(rowsOf(result));
  return result;
}

/** One dialect's setup from the ONE seed SSoT (`.setup/<dialect>.json`, emitted by emit-setup.ts). */
export interface Setup {
  readonly dialect: string;
  readonly users: number;
  readonly schema: string[];
  readonly delete: string[];
  readonly insert: string[];
  /**
   * The statements each op issues, in order, captured from the GENERATED module at the runtime seam
   * (`lm_orm_native sql`). The SDK baseline executes THESE rather than hand-writing its own SQL: the
   * report divides native by sdk, which only isolates the runtime's cost if both send the same
   * statements. SQL is a property of the dialect, not of the language.
   */
  readonly ops: Record<string, string[]>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

// The bench's connection targets, from the same TEST_* environment the conformance live legs use —
// the TypeScript member of the per-language bench config set (go: `lm_bench/setup/dsn.go`, rust:
// `orm_bench_common`), so each language's cell owns its connection config next to itself.
//
// The cell loads the BUILT ESM bundles (`dist/*.mjs`), not `src/`. The other cells all consume built
// runtimes too (a go module, a crate, an installed package), and here it is also required:
// behavior-contracts publishes only an `import` condition, and `src/` sits under the CJS root package,
// so nothing outside vitest can load it. The bundles are reached by relative path rather than by
// package name because the nearest package.json above this directory is `benchmark/`'s
// (name: orm-benchmark), which puts a self-reference to `litedbmodel` out of reach. Loading the built
// artifact is what surfaced #169 — until it was fixed, the root entry did not load at all.
const env = (k: string, d: string): string => process.env[k] || d;

/**
 * `driver` is explicit on every config. `DBModel.setConfig` defaults an unspecified driver to
 * `postgres` (src/DBModel.ts:251), so the v1 cell was opening a PostgreSQL pool against MySQL — its
 * MySQL leg never ran (`received invalid response: 4a`, MySQL's handshake reaching the pg parser).
 */
export const PG_CONFIG = {
  driver: 'postgres',
  host: env('TEST_DB_HOST', 'localhost'),
  port: Number(env('TEST_DB_PORT', '5433')),
  database: env('TEST_DB_NAME', 'testdb'),
  user: env('TEST_DB_USER', 'testuser'),
  password: env('TEST_DB_PASSWORD', 'testpass'),
} as const;

export const MYSQL_CONFIG = {
  driver: 'mysql',
  host: env('TEST_MYSQL_HOST', '127.0.0.1'),
  port: Number(env('TEST_MYSQL_PORT', '3307')),
  database: env('TEST_MYSQL_DB', 'testdb'),
  user: env('TEST_MYSQL_USER', 'testuser'),
  password: env('TEST_MYSQL_PASSWORD', 'testpass'),
} as const;

export const SQLITE_CONFIG = { database: ':memory:', driver: 'sqlite' } as const;

/**
 * Walk up from this module to the repo root — the directory that holds the seed SSoT. Anchoring on the
 * repo rather than on this file's own location keeps the path right whether the cell runs from source
 * or from the compiled sibling output, and independent of cwd. Same rule as go's `setup.Load` and
 * rust's `load_setup`.
 */
function repoRoot(): string {
  let dir = HERE;
  while (!existsSync(join(dir, 'benchmark', 'crosslang', '.setup'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('cannot locate benchmark/crosslang/.setup above ' + HERE);
    dir = up;
  }
  return dir;
}

/** The one seed-SSoT path for a dialect — the ONLY place it is spelled (readers and the emitter share it). */
export function setupPathFor(dialect: Dialect): string {
  return join(repoRoot(), 'benchmark', 'crosslang', '.setup', `${dialect}.json`);
}

export function setupFor(dialect: Dialect): Setup {
  return JSON.parse(readFileSync(setupPathFor(dialect), 'utf8')) as Setup;
}
