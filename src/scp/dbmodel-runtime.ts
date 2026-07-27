/**
 * litedbmodel v2 SCP — the DBModel ActiveRecord ↔ SCP RUNTIME bridge (Phase F-2, epic #74, issue #105).
 *
 * The runtime glue that puts `DBModel`'s pooled execution on the Phase A-E substrate
 * (`exec-context.ts` / `connection-routing.ts` / `middleware.ts` / `tx-options.ts`). It owns two
 * concerns:
 *
 *  1. **Connection wiring** ({@link buildContextFromConfig}) — a v1 `DBConfig` (+ `writerConfig` /
 *     writer-sticky options) → a {@link PooledAsyncContext} over REAL pg / mysql2 pools (via
 *     `pgPoolFactory` / `mysqlPoolFactory` + `buildRoutingConfig`) and a `close()`. This is the C3
 *     `setConfig → ConnectionRegistry → pool` path. Every statement DBModel issues — a v1-built SELECT
 *     as much as a compiled write bundle — goes through this ONE ctx, so routing, middleware and an
 *     ambient transaction pin apply uniformly.
 *
 *  2. **Write execution** ({@link executeWriteAsync}) — run a compiled write bundle's transaction plan
 *     on the writer through the SCP tx runtime (write=tx guard).
 *
 * There is NO runtime read-compile here. A read whose SHAPE is fixed is declared on the `@behavior` /
 * `@leaf` authoring surface and lowered by `bc generate`; a read whose shape is only known per request
 * (`find({where:{age:{gt:x}}})`) runs the v1 imperative builder — compile-free — and reaches the DB
 * through the SAME ctx seam via `DBModel.execute`.
 *
 * The public API + README code are UNCHANGED: `DBModel`'s method signatures / return shapes are
 * identical; this module is an INTERNAL execution substrate.
 */

import 'reflect-metadata';
import {
  buildRoutingConfig,
  type PoolCloser,
  type ConnectionConfig,
  type ResolvedConnectionConfig,
  type PoolFactory,
} from './connection-routing';
import { PooledAsyncContext } from './exec-context';
import {
  pgPoolFactory,
  mysqlPoolFactory,
} from './makesql/pool-executor';
import type { SqlBundle } from './write-bundle';
import { executeTransactionAsync, type TransactionResult } from './makesql/tx';
import type { TransactionOptions } from './tx-options';
import {
  compileCreateBundle,
  compileUpdateBundle,
  compileDeleteBundle,
  type ModelClassLike,
  type DeriveColumnsOptions,
} from './decorator-adapter';
import { renderPlaceholders } from './makesql/handler';
import type { Scope } from 'behavior-contracts/runtime';
import type { DialectName } from './dialect';

// ── 1. Connection wiring (setConfig → PooledAsyncContext over real pools) ────────────────────────

/** A v1 `DBConfig`-shaped input (host/port/database/user/password + pool sizing + keepAlive). */
export interface RuntimeDbConfig {
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly user?: string;
  readonly password?: string;
  readonly max?: number;
  readonly keepAlive?: boolean;
  readonly keepAliveInitialDelayMillis?: number;
  readonly driver?: 'postgres' | 'mysql' | 'sqlite';
}

/** Options for {@link buildContextFromConfig} — reader/writer split + writer-sticky (C3 / v1 parity). */
export interface RuntimeContextOptions {
  /** A distinct WRITER connection config (reader/writer replica split). Absent ⇒ reader === writer. */
  readonly writerConfig?: RuntimeDbConfig;
  /** Keep routing to the writer for `writerStickyDuration` after a committed tx (read-your-writes). */
  readonly useWriterAfterTransaction?: boolean;
  /** The writer-sticky window in ms (default 5000). */
  readonly writerStickyDuration?: number;
}

/** The assembled runtime context: the routed ctx, the dialect, and a closer. */
export interface RuntimeContext {
  /**
   * The Phase A-E execution context (routing + middleware + tx-pinning) over real pools. This IS the
   * async read/write seam every statement funnels through — a v1-built SELECT via `DBModel.execute`,
   * a compiled write bundle via {@link executeWriteAsync}, and a generated read module via
   * `bindAsync(leafHandlersAsync({ execAsync: ctx, dialect }))`.
   */
  readonly ctx: PooledAsyncContext;
  /** The compiled SQL dialect (`postgres` / `mysql`). */
  readonly dialect: DialectName;
  /** Shut every constructed pool (v1 `closeAllPools`). */
  readonly close: PoolCloser;
}

/** Map a {@link RuntimeDbConfig} to the C3 {@link ConnectionConfig} pool-construction knobs. */
function toConnectionConfig(config: RuntimeDbConfig): ConnectionConfig {
  return {
    ...(config.host !== undefined ? { host: config.host } : {}),
    ...(config.port !== undefined ? { port: config.port } : {}),
    ...(config.database !== undefined ? { database: config.database } : {}),
    ...(config.user !== undefined ? { user: config.user } : {}),
    ...(config.password !== undefined ? { password: config.password } : {}),
    ...(config.max !== undefined ? { maxPool: config.max } : {}),
    ...(config.keepAlive !== undefined ? { keepAlive: config.keepAlive } : {}),
    ...(config.keepAliveInitialDelayMillis !== undefined ? { keepAliveInitialDelayMillis: config.keepAliveInitialDelayMillis } : {}),
  };
}

/** Lazily `require` the pg module (optional peer dep). */
function requirePg(): { Pool: new (config: Record<string, unknown>) => { end?: () => Promise<void> }; types: { setTypeParser(oid: number, parser: (value: string) => unknown): void } } {
  return require('pg');
}

/** Lazily `require` the mysql2/promise module (optional peer dep). */
function requireMysql2(): { createPool(config: Record<string, unknown>): { end?: () => Promise<void> } } {
  return require('mysql2/promise');
}

/**
 * A {@link PoolFactory} that builds the reader pool from the primary config and (when the setup asks
 * for `separateWriter`) the writer pool from `writerConfig` — a genuine reader/writer replica split on
 * distinct hosts. `buildRoutingConfig` calls this with the resolved config so sizing/keepAlive/de-box
 * options land at pool construction; the writer role overlays the `writerConfig` connection params.
 */
function splitPoolFactory(baseFactory: PoolFactory, writerConfig: RuntimeDbConfig | undefined): PoolFactory {
  return (resolved: ResolvedConnectionConfig, role: 'reader' | 'writer') => {
    if (role === 'writer' && writerConfig !== undefined) {
      const overlaid = { ...resolved, ...toConnectionConfig(writerConfig) } as ResolvedConnectionConfig;
      return baseFactory(overlaid, 'writer');
    }
    return baseFactory(resolved, role);
  };
}

/**
 * Build a Phase A-E {@link PooledAsyncContext} + reader executor from a v1 `DBConfig` (the
 * `setConfig → ConnectionRegistry → pool` wiring). Constructs a REAL pg / mysql2 pool via
 * `buildRoutingConfig` + the driver pool factory (sizing/keepAlive applied at pool construction), wires
 * the default connection, and — when `writerConfig` is present — a distinct writer pool (reader/writer
 * replica split). The writer-sticky clock is armed per `useWriterAfterTransaction` / `writerStickyDuration`.
 *
 * `sqlite` is NOT routed here (it keeps the v1 in-proc path). Throws for an unsupported driver.
 */
export function buildContextFromConfig(config: RuntimeDbConfig, options: RuntimeContextOptions = {}): RuntimeContext {
  const driver = config.driver ?? 'postgres';
  if (driver === 'sqlite') {
    throw new Error('scp dbmodel-runtime: the sqlite dialect is not routed through the async SCP runtime (v1 in-proc path).');
  }
  const dialect: DialectName = driver === 'mysql' ? 'mysql' : 'postgres';

  const stickyOpts = {
    ...(options.useWriterAfterTransaction !== undefined ? { useWriterAfterTransaction: options.useWriterAfterTransaction } : {}),
    ...(options.writerStickyDuration !== undefined ? { writerStickyDuration: options.writerStickyDuration } : {}),
  };

  const baseFactory: PoolFactory = dialect === 'mysql' ? mysqlPoolFactory(requireMysql2() as never) : pgPoolFactory(requirePg() as never);
  const hasWriter = options.writerConfig !== undefined;
  const built = buildRoutingConfig(
    [{
      config: toConnectionConfig(config),
      poolFactory: hasWriter ? splitPoolFactory(baseFactory, options.writerConfig) : baseFactory,
      separateWriter: hasWriter,
    }],
    stickyOpts,
  );
  const ctx = new PooledAsyncContext(built.routing);

  // The `ctx` (PooledAsyncContext) IS the async read/write seam — there is no separate reader executor.
  // The closer is REGISTERED as well as returned: a caller that drops its `RuntimeContext` without
  // awaiting `close()` (which `DBModel.setConfig` does on every reconfigure) would otherwise leak the
  // pools with no handle left to reach them. `closeAllScpRuntimes` is the drain.
  const runtime: RuntimeContext = {
    ctx,
    dialect,
    close: async () => {
      liveClosers.delete(built.close);
      await built.close();
    },
  };
  liveClosers.add(built.close);
  return runtime;
}

/**
 * Every pool set this module has constructed and not yet closed.
 *
 * The same shape `src/drivers/mysql.ts` uses for the v1 pools: the module that CREATES the pools owns
 * the registry that can close them. Without it, `closeAllPools()` closed the v1 caches only and the
 * routed SCP pools stayed open — `closeAllPools()` resolved in 0ms with three live sockets, and a
 * consumer process could not exit.
 */
const liveClosers = new Set<PoolCloser>();

/**
 * Close every pool set {@link buildContextFromConfig} has constructed — including runtimes their owner
 * discarded without closing. Part of the v1 `closeAllPools()` teardown, alongside the per-driver caches.
 */
export async function closeAllScpRuntimes(): Promise<void> {
  const closers = [...liveClosers];
  liveClosers.clear();
  for (const close of closers) await close();
}

// ── 2. Write execution (bundle → executeTransactionAsync) ───────────────────────────────────────

/** Run a write bundle's transaction plan on the writer through the SCP tx runtime (write=tx guard). */
export function executeWriteAsync(
  bundle: SqlBundle,
  input: Scope,
  ctx: RuntimeContext,
  options: TransactionOptions = {},
): Promise<TransactionResult> {
  if (bundle.transaction === undefined) {
    throw new Error(`scp dbmodel-runtime: write bundle '${bundle.name}' carries no transaction plan`);
  }
  return executeTransactionAsync(ctx.ctx, bundle.transaction, input, ctx.dialect, options);
}

/**
 * Render a v1-built raw SQL string (with `?` placeholders) to the ctx dialect's placeholder form for
 * the escape-hatch seam path: `postgres` renumbers `?`→`$N` (string-literal-aware, via the SAME
 * `renderPlaceholders` the makesql render uses); `mysql` keeps `?`. v1's DBHandler did this `?`→`$N`
 * conversion on the imperative path — the SCP seam passes SQL verbatim to the driver, so the raw path
 * must renumber here to stay byte-equivalent. Phase F-2 (#105).
 */
export function renderRawSql(sql: string, dialect: DialectName): string {
  return renderPlaceholders(sql, dialect === 'postgres' ? 'postgres' : dialect === 'mysql' ? 'mysql' : 'sqlite');
}

// Re-export the write-bundle compilers so DBModel imports one module.
export { compileCreateBundle, compileUpdateBundle, compileDeleteBundle };
export type { ModelClassLike, DeriveColumnsOptions };
