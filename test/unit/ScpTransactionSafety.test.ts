/**
 * Transaction connection safety — SCP route (`DBModel.transaction` → `withTransactionAsync`, the pg pool
 * adapters in `src/scp/makesql/pool-executor.ts`, the queryTimeout wiring DBModel → scp connection config).
 * The v1 branch is covered in `TransactionSafety.test.ts`. No live DB: fake pools / a stubbed `pg.Pool.connect`.
 *
 * - leased pg client 'error' handling (pgConnectionPool) and idle pool 'error' (pgPoolFactory)
 * - no body re-run after a COMMIT connection error
 * - queries through the pinned tx connection after the body settled are rejected and never sent
 * - BEGIN failure releases (destroys) the connection
 * - DBModel `queryTimeout` (seconds) reaches the scp connection's statement_timeout; default 30 s
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
import {
  withTransactionAsync,
  executeAsync,
  PooledAsyncContext,
  resolveConnectionConfig,
  sessionStatements,
  type AsyncConnection,
  type AsyncConnectionPool,
} from '../../src/scp';
import { pgConnectionPool, pgPoolFactory } from '../../src/scp/makesql/pool-executor';
import { DBModel } from '../../src/DBModel';
import { TransactionClosedError } from '../../src/types';

function makeError(message: string, code?: string): Error {
  const err = new Error(message);
  if (code) (err as NodeJS.ErrnoException).code = code;
  return err;
}

/** A fake owned-connection pool recording every statement and every release. */
function makeFakePool(behave: (sql: string) => void = () => {}) {
  const log: string[] = [];
  const releases: boolean[] = [];
  let acquired = 0;
  const conn: AsyncConnection = {
    async execute(sql) { log.push(sql); behave(sql); return []; },
    async run(sql) { log.push(sql); behave(sql); return { changes: 0, lastInsertRowid: 0 }; },
  };
  const pool: AsyncConnectionPool = {
    async acquire() { acquired++; return conn; },
    async release(_c, destroy) { releases.push(destroy === true); },
  };
  return { pool, log, releases, acquired: () => acquired };
}

describe('pgConnectionPool leased client error handling', () => {
  function leasedClient() {
    const client = Object.assign(new EventEmitter(), { query: vi.fn(), release: vi.fn() });
    const pool = pgConnectionPool({ connect: async () => client } as never);
    return { client, pool };
  }

  it('does not crash on client "error" while leased and destroys the connection on release', async () => {
    const { client, pool } = leasedClient();
    const conn = await pool.acquire();

    const error = makeError('Connection terminated unexpectedly');
    expect(() => client.emit('error', error)).not.toThrow();

    await pool.release(conn);
    expect(client.release).toHaveBeenCalledWith(error);
  });

  it('removes the error listener on release and does not destroy a healthy connection', async () => {
    const { client, pool } = leasedClient();
    const conn = await pool.acquire();
    expect(client.listenerCount('error')).toBe(1);

    await pool.release(conn);
    expect(client.listenerCount('error')).toBe(0);
    expect(client.release.mock.calls[0][0]).toBeFalsy();
  });
});

describe('pgPoolFactory idle pool error handling', () => {
  it('does not crash when an idle client of the pool emits "error"', () => {
    const pools: EventEmitter[] = [];
    class FakePool extends EventEmitter {
      constructor(_config: Record<string, unknown>) { super(); pools.push(this); }
      async connect() { return {} as never; }
      async end() {}
    }
    pgPoolFactory({ Pool: FakePool, types: { setTypeParser: () => {} } } as never)(resolveConnectionConfig({}), 'reader');
    expect(pools).toHaveLength(1);
    expect(() => pools[0].emit('error', makeError('Connection terminated unexpectedly'))).not.toThrow();
  });
});

describe('DBModel.transaction (SCP route)', () => {
  function makeModel(pool: AsyncConnectionPool) {
    const ctx = new PooledAsyncContext(pool);
    class ScpModel extends DBModel {
      protected static _getScpRuntime() {
        return { ctx, dialect: 'postgres', close: async () => {} } as never;
      }
      protected static getHandler(): never {
        throw new Error('the v1 handler must not be used on the SCP route');
      }
    }
    return { ScpModel, ctx };
  }

  it('does not re-run func when COMMIT fails with a connection error', async () => {
    const commitError = makeError('Connection terminated unexpectedly');
    const fake = makeFakePool((sql) => { if (sql === 'COMMIT') throw commitError; });
    const { ScpModel } = makeModel(fake.pool);
    const func = vi.fn(async () => 'done');

    await expect(ScpModel.transaction(func, { retryDuration: 1 })).rejects.toBe(commitError);
    expect(fake.acquired()).toBe(1); // the SCP pool served it (v1 handler would have thrown)
    expect(func).toHaveBeenCalledTimes(1);
    expect(fake.releases).toEqual([true]);
  });

  it('still re-runs func when COMMIT fails with a serialization failure', async () => {
    let commits = 0;
    const fake = makeFakePool((sql) => {
      if (sql === 'COMMIT' && ++commits === 1) throw Object.assign(new Error('could not serialize access'), { code: '40001' });
    });
    const { ScpModel } = makeModel(fake.pool);
    const func = vi.fn(async () => 'ok');

    await expect(ScpModel.transaction(func, { retryDuration: 1 })).resolves.toBe('ok');
    expect(fake.acquired()).toBe(2);
    expect(func).toHaveBeenCalledTimes(2);
  });

  it('still re-runs func when a connection error occurs inside func', async () => {
    const fake = makeFakePool();
    const { ScpModel } = makeModel(fake.pool);
    const func = vi.fn()
      .mockRejectedValueOnce(makeError('Connection terminated unexpectedly'))
      .mockResolvedValueOnce('ok');

    await expect(ScpModel.transaction(func, { retryDuration: 1 })).resolves.toBe('ok');
    expect(fake.acquired()).toBe(2);
    expect(func).toHaveBeenCalledTimes(2);
  });

  it('rejects an un-awaited DBModel.execute started in func once func has settled, without sending it', async () => {
    const fake = makeFakePool();
    const { ScpModel } = makeModel(fake.pool);

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    let pending: Promise<unknown> | undefined;
    await ScpModel.transaction(async () => {
      await ScpModel.execute('SELECT 1');
      pending = gate.then(() => ScpModel.execute('SELECT late'));
    });
    expect(fake.acquired()).toBe(1);

    const callsAfterSettle = fake.log.length;
    openGate();
    await expect(pending).rejects.toBeInstanceOf(TransactionClosedError);
    expect(fake.log).toHaveLength(callsAfterSettle);
    expect(fake.log).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
  });
});

describe('withTransactionAsync pinned connection lifetime', () => {
  it('rejects a query started in the body once the body rejected and ROLLBACK was sent', async () => {
    const fake = makeFakePool();
    const ctx = new PooledAsyncContext(fake.pool);
    const funcError = new Error('body failed');

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    let pending: Promise<unknown> | undefined;
    await expect(
      withTransactionAsync(ctx, async (txCtx) => {
        await executeAsync(txCtx, 'SELECT 1', []);
        pending = gate.then(() => executeAsync(txCtx, 'SELECT late', []));
        throw funcError;
      }, { retryOnError: false }),
    ).rejects.toBe(funcError);

    const callsAfterRollback = fake.log.length;
    openGate();
    await expect(pending).rejects.toBeInstanceOf(TransactionClosedError);
    expect(fake.log).toHaveLength(callsAfterRollback);
    expect(fake.log).toEqual(['BEGIN', 'SELECT 1', 'ROLLBACK']);
  });

  it('sends BEGIN, COMMIT and ROLLBACK on the owned connection although the body pin is closed', async () => {
    const fake = makeFakePool();
    const ctx = new PooledAsyncContext(fake.pool);
    await withTransactionAsync(ctx, async (txCtx) => { await executeAsync(txCtx, 'SELECT 1', []); }, { retryOnError: false });
    await expect(withTransactionAsync(ctx, async () => { throw new Error('x'); }, { retryOnError: false })).rejects.toThrow('x');
    expect(fake.log).toEqual(['BEGIN', 'SELECT 1', 'COMMIT', 'BEGIN', 'ROLLBACK']);
  });

  it('releases (destroys) the connection when BEGIN fails', async () => {
    const beginError = new Error('BEGIN failed');
    const fake = makeFakePool((sql) => { if (sql === 'BEGIN') throw beginError; });
    const ctx = new PooledAsyncContext(fake.pool);
    const body = vi.fn(async () => 'never');

    await expect(withTransactionAsync(ctx, body, { retryOnError: false })).rejects.toBe(beginError);
    expect(body).not.toHaveBeenCalled();
    expect(fake.releases).toEqual([true]);
  });
});

describe('queryTimeout reaches the scp connection (DBModel → statement_timeout)', () => {
  const pgModule = createRequire(import.meta.url)('pg') as { Pool: { prototype: { connect: unknown } } };
  const original = pgModule.Pool.prototype.connect;
  afterEach(() => { pgModule.Pool.prototype.connect = original; });

  async function sessionStatementsOf(config: Record<string, unknown>): Promise<string[]> {
    const sent: string[] = [];
    pgModule.Pool.prototype.connect = async () => ({
      query: async (text: string) => { sent.push(text); return { rows: [], rowCount: 0 }; },
      on: () => undefined,
      removeListener: () => undefined,
      release: () => undefined,
    });
    const Base = DBModel.createDBBase({ host: 'tx-safety-timeout-host', port: 5432, database: 'tx_safety_db', user: 'u', password: 'p', ...config } as never);
    const rt = (Base as unknown as { _getScpRuntime(): { ctx: PooledAsyncContext; close(): Promise<void> } | null })._getScpRuntime();
    expect(rt).not.toBeNull(); // the SCP runtime (not the v1 driver) was built
    const pool = rt!.ctx.connectionPoolFor();
    const conn = await pool.acquire();
    await pool.release(conn);
    await rt!.close();
    return sent.filter((s) => s.startsWith('SET statement_timeout'));
  }

  it('converts DBConfig.queryTimeout (seconds) to the connection config (ms)', async () => {
    expect(await sessionStatementsOf({ queryTimeout: 7 })).toEqual(['SET statement_timeout = 7000']);
  });

  it('defaults to 30 seconds like the v1 driver when queryTimeout is not given', async () => {
    expect(await sessionStatementsOf({})).toEqual(['SET statement_timeout = 30000']);
    expect(sessionStatements(resolveConnectionConfig({ driver: 'postgres' }))).toEqual(['SET statement_timeout = 30000']);
  });
});
