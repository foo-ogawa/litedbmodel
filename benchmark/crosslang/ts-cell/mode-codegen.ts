// The CODEGEN mode of the TypeScript cell — the TS twin of the go/rust/python/php native cells.
//
// `bc generate --lang typescript-native` (gen-native.sh) emits `behaviors_<dialect>.ts` from the SAME
// authored `@behavior` source every other language's module is generated from. TypeScript is
// type-erased, so the transport cannot be baked into the call the way `--leaf-transport-import` bakes
// it for go/rust; the emitted module takes it as `bindTyped(handlers)`. The handlers are litedbmodel's
// own `leafHandlers` (src/scp/leaves.ts) — the ONE op-agnostic transport, the same one the conformance
// harness wires (conformance/harness.ts). The cell writes no SQL and no node handler of its own.

import Database from 'better-sqlite3';
import { Pool as PgPool, types as pgTypes } from 'pg';
import mysql from 'mysql2/promise';
import {
  clearMiddlewares,
  configurePgDeboxTypeParsers,
  createMiddleware,
  connectionForDriver,
  contextForConnection,
  leafHandlers,
  leafHandlersAsync,
  mysqlConnectionPool,
  mysqlDeboxPoolOptions,
  pgConnectionPool,
  PooledAsyncContext,
  transaction,
  use,
  withTransactionSync,
} from '../../../dist/scp/index.mjs';

import { inputFor, TX_OPS } from './inputs.js';
import type { Cell, Dialect } from './cell.js';
import { MYSQL_CONFIG, PG_CONFIG, setupFor } from './cell.js';

/** The generated module's public surface, as much of it as the cell touches. */
interface GeneratedModule {
  bindTyped(handlers: ReturnType<typeof leafHandlers>): Record<string, (input?: Record<string, unknown>) => unknown>;
  bindTypedAsync(
    handlers: ReturnType<typeof leafHandlersAsync>,
  ): Record<string, (input?: Record<string, unknown>) => Promise<unknown>>;
}

export async function openCodegen(dialect: Dialect): Promise<Cell> {
  const setup = setupFor(dialect);
  // Count at the runtime's own SQL middleware seam — the same place the go/rust cells count, and the
  // only point every read, write and tx-control statement funnels through.
  let count = 0;
  clearMiddlewares();
  use(
    createMiddleware({
      execute(next: (s: string, p?: readonly unknown[]) => unknown, sql: string, params: readonly unknown[]) {
        count++;
        return next(sql, params);
      },
    }),
  );
  const mod = (await import(`./behaviors_${dialect}.js`)) as unknown as GeneratedModule;

  if (dialect === 'sqlite') {
    const db = new Database(':memory:');
    for (const stmt of setup.schema) db.exec(stmt);
    const ctx = contextForConnection(connectionForDriver(db as never));
    const facade = mod.bindTyped(leafHandlers({ exec: ctx, dialect }));
    return {
      dialect,
      sync: true,
      // The fixture is applied on the RAW driver, never through the seam, so it can neither be
      // counted nor timed (the same rule every other cell follows).
      seed: () => {
        for (const stmt of [...setup.delete, ...setup.insert]) db.exec(stmt);
      },
      // A RETURNING-chained op runs inside the runtime's transaction boundary: BEGIN, the two body
      // statements through the leaf, COMMIT. That boundary is the CONSUMER's responsibility (the
      // generated runner emits no BEGIN/COMMIT) — the same wiring go and rust do.
      run: (op, it) => {
        if (!TX_OPS.has(op)) {
          facade[op](inputFor(op, it));
          return;
        }
        withTransactionSync(ctx, () => ({ commit: true, value: facade[op](inputFor(op, it)) }), dialect);
      },
      close: () => {
        clearMiddlewares();
        db.close();
      },
      statements: () => count,
      resetStatements: () => {
        count = 0;
      },
    };
  }

  // The read-path de-box knobs the LIBRARY owns (#59): without them `pg` hands back a JS Date and
  // `mysql2` a JS Date for a TIMESTAMP column. They are part of the artifact, not cell convenience —
  // the conformance harness applies exactly these.
  const driverPool =
    dialect === 'postgres'
      ? (configurePgDeboxTypeParsers(pgTypes), new PgPool({ ...PG_CONFIG, max: 4 }))
      : mysql.createPool({ ...MYSQL_CONFIG, ...mysqlDeboxPoolOptions, connectionLimit: 4 });
  const pool =
    dialect === 'postgres'
      ? pgConnectionPool(driverPool as never)
      : mysqlConnectionPool(driverPool as never);
  const rawQuery = (sql: string): Promise<unknown> =>
    dialect === 'postgres' ? (driverPool as PgPool).query(sql) : (driverPool as mysql.Pool).query(sql);
  for (const stmt of setup.schema) await rawQuery(stmt);
  const ctx = new PooledAsyncContext(pool);
  const facade = mod.bindTypedAsync(leafHandlersAsync({ execAsync: ctx, dialect }));
  return {
    dialect,
    sync: false,
    seed: async () => {
      for (const stmt of [...setup.delete, ...setup.insert]) await rawQuery(stmt);
    },
    run: async (op, it) => {
      if (!TX_OPS.has(op)) {
        await facade[op](inputFor(op, it));
        return;
      }
      await transaction(ctx, () => facade[op](inputFor(op, it)) as Promise<unknown>, {}, dialect);
    },
    close: async () => {
      clearMiddlewares();
      await driverPool.end();
    },
    statements: () => count,
    resetStatements: () => {
      count = 0;
    },
  };
}
