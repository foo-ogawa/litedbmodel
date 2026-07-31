// The CODEGEN mode of the TypeScript cell — the TS twin of the go/rust/python/php native cells.
//
// `bc generate --lang typescript-native` (gen-native.sh) emits `behaviors_<dialect>.ts` from the SAME
// authored `@behavior` source every other language's module is generated from. TypeScript is
// type-erased, so the transport cannot be baked into the call the way `--leaf-transport-import` bakes
// it for go/rust; the emitted module takes it as `bindTyped(handlers)`. The handlers are litedbmodel's
// own `leafHandlers` (src/scp/leaves.ts) — the ONE op-agnostic transport, the same one the conformance
// harness wires (conformance/harness.ts). The cell writes no SQL and no node handler of its own.

import { Pool as PgPool, types as pgTypes } from 'pg';
import mysql from 'mysql2/promise';
import {
  clearMiddlewares,
  configurePgDeboxTypeParsers,
  createMiddleware,
  leafHandlers,
  leafHandlersAsync,
  mysqlConnectionPool,
  mysqlDeboxPoolOptions,
  pgConnectionPool,
  PooledAsyncContext,
  transaction,
  use,
} from '../../../dist/scp/index.mjs';

import { TX_OPS } from './expectations.js';
import type { Cell, Dialect } from './cell.js';
import { MYSQL_CONFIG, PG_CONFIG, resolveInput, setupFor, tallyRows } from './cell.js';

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
  let rows = 0;
  clearMiddlewares();
  use(
    createMiddleware({
      execute(next: (s: string, p?: readonly unknown[]) => unknown, sql: string, params: readonly unknown[]) {
        count++;
        return tallyRows(next(sql, params), (n) => {
          rows += n;
        });
      },
    }),
  );
  const mod = (await import(`./behaviors_${dialect}.js`)) as unknown as GeneratedModule;

  // SQLite has NO codegen path in TypeScript. `buildContextFromConfig` throws for it —
  // "the sqlite dialect is not routed through the async SCP runtime (runtime in-proc path)" — so a TS
  // consumer on SQLite reaches litedbmodel through runtime, and this cell reports that rather than
  // inventing a path the product does not offer.
  if (dialect === 'sqlite') {
    throw new Error(
      'ts-cell: the codegen mode has no SQLite leg — litedbmodel routes SQLite through the runtime in-proc ' +
        'path, not the SCP runtime (src/scp/dbmodel-runtime.ts). Run `runtime` or `sdk` for this dialect.',
    );
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
      const input = resolveInput(setup, op, it);
      if (!TX_OPS.has(op)) {
        await facade[op](input);
        return;
      }
      await transaction(ctx, () => facade[op](input) as Promise<unknown>, {}, dialect);
    },
    close: async () => {
      clearMiddlewares();
      await driverPool.end();
    },
    statements: () => count,
    rows: () => rows,
    resetCounters: () => {
      count = 0;
      rows = 0;
    },
  };
}
