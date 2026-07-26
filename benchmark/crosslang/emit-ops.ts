// ════════════════════════════════════════════════════════════════════════════
// Cross-lang ORM-bench OP-SQL capture — the SDK baselines' statements, taken from the native module.
// ════════════════════════════════════════════════════════════════════════════
//
//   npx tsx benchmark/crosslang/emit-ops.ts [dialect...]
//
// The SDK baselines must issue the SAME SQL the generated native module issues: the ratio the report
// publishes is `native ÷ sdk`, and it only isolates the RUNTIME's cost if the SQL on both sides is
// identical. SQL is a property of the DIALECT, not of the language — but each of the five SDK cells
// hand-wrote it, so it drifted from the native module and from the other cells (#172).
//
// This program removes the copies: it runs every op ONCE through the bc-GENERATED module for a dialect
// with a recording middleware on the runtime's SQL seam, and writes the ordered statement texts into
// `.setup/<dialect>.json` as `ops`. Each SDK cell then executes `ops[<op>][i]` and hand-writes no SQL.
//
// Capturing rather than copying is required, not tidier: the final SQL is only knowable at execution.
// PostgreSQL's relation predicates carry a `@@PG_ARRAY_CAST@@` token the runtime resolves from the
// key param's element type (src/scp/makesql/compile-relation.ts), and MySQL's RETURNING writes are
// rewritten by the mysql adapter. What the seam sees IS what the DB runs.
//
// Run AFTER emit-setup.ts (the fixture must exist; this program seeds from it and merges `ops` into the
// same artifact).

import { readFileSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Pool as PgPool, types as pgTypes } from 'pg';
import mysql from 'mysql2/promise';
import {
  clearMiddlewares,
  configurePgDeboxTypeParsers,
  connectionForDriver,
  contextForConnection,
  createMiddleware,
  leafHandlers,
  leafHandlersAsync,
  mysqlConnectionPool,
  mysqlDeboxPoolOptions,
  pgConnectionPool,
  PooledAsyncContext,
  transaction,
  use,
} from '../../dist/scp/index.mjs';

import { ORM_OPS, type OrmDialect } from './contract.js';
import { inputFor, TX_OPS } from './ts-cell/inputs.js';
import { setupPathFor } from './ts-cell/cell.js';

const OPS = ORM_OPS.map((o) => o.id);

const env = (k: string, d: string): string => process.env[k] || d;
const PG_CONFIG = {
  host: env('TEST_DB_HOST', 'localhost'),
  port: Number(env('TEST_DB_PORT', '5433')),
  database: env('TEST_DB_NAME', 'testdb'),
  user: env('TEST_DB_USER', 'testuser'),
  password: env('TEST_DB_PASSWORD', 'testpass'),
} as const;
const MYSQL_CONFIG = {
  host: env('TEST_MYSQL_HOST', '127.0.0.1'),
  port: Number(env('TEST_MYSQL_PORT', '3307')),
  database: env('TEST_MYSQL_DB', 'testdb'),
  user: env('TEST_MYSQL_USER', 'testuser'),
  password: env('TEST_MYSQL_PASSWORD', 'testpass'),
} as const;

interface SetupDoc {
  dialect: OrmDialect;
  schema: string[];
  delete: string[];
  insert: string[];
  ops?: Record<string, string[]>;
  [k: string]: unknown;
}

/** The generated module for one dialect — the SAME artifact the TypeScript native cell measures. */
async function generatedModule(dialect: OrmDialect): Promise<{
  bindTyped(h: ReturnType<typeof leafHandlers>): Record<string, (i?: Record<string, unknown>) => unknown>;
  bindTypedAsync(h: ReturnType<typeof leafHandlersAsync>): Record<string, (i?: Record<string, unknown>) => Promise<unknown>>;
}> {
  return (await import(`./ts-cell/behaviors_${dialect}.js`)) as never;
}

/**
 * Every SQL text the seam saw, in order, keyed by nothing — the caller brackets one op around it. The
 * BEGIN/COMMIT of a transaction op are the runtime's, not the generated runner's, so they are dropped:
 * the baseline brackets its own transaction and needs only the body statements.
 */
function recorder(): { sql: string[]; reset(): void } {
  const seen: string[] = [];
  clearMiddlewares();
  use(
    createMiddleware({
      execute(next: (s: string, p?: readonly unknown[]) => unknown, sql: string, params: readonly unknown[]) {
        if (!/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)/i.test(sql)) seen.push(sql);
        return next(sql, params);
      },
    }),
  );
  return {
    sql: seen,
    reset: () => {
      seen.length = 0;
    },
  };
}

async function captureSqlite(doc: SetupDoc): Promise<Record<string, string[]>> {
  const rec = recorder();
  const mod = await generatedModule('sqlite');
  const db = new Database(':memory:');
  for (const stmt of doc.schema) db.exec(stmt);
  const ctx = contextForConnection(connectionForDriver(db as never));
  const facade = mod.bindTyped(leafHandlers({ exec: ctx, dialect: 'sqlite' }));
  const out: Record<string, string[]> = {};
  try {
    for (const op of OPS) {
      for (const stmt of [...doc.delete, ...doc.insert]) db.exec(stmt);
      rec.reset();
      facade[op](inputFor(op, 0));
      out[op] = [...rec.sql];
    }
  } finally {
    clearMiddlewares();
    db.close();
  }
  return out;
}

async function captureLive(dialect: 'postgres' | 'mysql', doc: SetupDoc): Promise<Record<string, string[]>> {
  const rec = recorder();
  const mod = await generatedModule(dialect);
  const driverPool =
    dialect === 'postgres'
      ? (configurePgDeboxTypeParsers(pgTypes), new PgPool({ ...PG_CONFIG, max: 4 }))
      : mysql.createPool({ ...MYSQL_CONFIG, ...mysqlDeboxPoolOptions, connectionLimit: 4 });
  const raw = (sql: string): Promise<unknown> =>
    dialect === 'postgres' ? (driverPool as PgPool).query(sql) : (driverPool as mysql.Pool).query(sql);
  const pool = dialect === 'postgres' ? pgConnectionPool(driverPool as never) : mysqlConnectionPool(driverPool as never);
  for (const stmt of doc.schema) await raw(stmt);
  const ctx = new PooledAsyncContext(pool);
  const facade = mod.bindTypedAsync(leafHandlersAsync({ execAsync: ctx, dialect }));
  const out: Record<string, string[]> = {};
  try {
    for (const op of OPS) {
      for (const stmt of [...doc.delete, ...doc.insert]) await raw(stmt);
      rec.reset();
      if (TX_OPS.has(op)) await transaction(ctx, () => facade[op](inputFor(op, 0)) as Promise<unknown>, {}, dialect);
      else await facade[op](inputFor(op, 0));
      out[op] = [...rec.sql];
    }
  } finally {
    clearMiddlewares();
    await driverPool.end();
  }
  return out;
}

const dialects = (process.argv.slice(2).length ? process.argv.slice(2) : ['sqlite', 'mysql', 'postgres']) as OrmDialect[];
for (const dialect of dialects) {
  const path = setupPathFor(dialect);
  const doc = JSON.parse(readFileSync(path, 'utf8')) as SetupDoc;
  doc.ops = dialect === 'sqlite' ? await captureSqlite(doc) : await captureLive(dialect, doc);
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  const counts = OPS.map((o) => `${o}=${doc.ops![o].length}`).join(' ');
  console.error(`  ✓ ${path} — ops captured (statements per op: ${counts})`);
}
