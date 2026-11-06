/**
 * `DBModel.acquireConnection()` and `TransactionOptions.connection` (#329) on both routes: the v1 branch
 * (`handler.getConnection()` loop) and the SCP route (`withTransactionAsync`, `pool.acquire`). No live DB.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, expect, vi } from 'vitest';
import { DBModel } from '../../src/DBModel';
import { PooledAsyncContext, executeAsync, type AsyncConnection, type AsyncConnectionPool } from '../../src/scp';
import { transaction as scpTransaction } from '../../src/scp/exec-context';
import { TransactionClosedError } from '../../src/types';

function connError(): Error {
  return Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
}
function deadlock(): Error {
  return Object.assign(new Error('Deadlock found when trying to get lock; try restarting transaction'), { code: '40P01' });
}

interface Harness {
  Model: typeof DBModel;
  /** every statement sent on any connection, in order */
  log: string[];
  /** how many connections were taken from the pool / handler */
  taken(): number;
  /** the release calls, each as "destroyed?" */
  released: boolean[];
  /** make the next statement matching `sql` throw `error` (once per call) */
  failOn(sql: string, errors: Error[]): void;
}

function makeV1(): Harness {
  const log: string[] = [];
  const released: boolean[] = [];
  const failures = new Map<string, Error[]>();
  let taken = 0;
  const connection = {
    async query(sql: string) {
      log.push(sql);
      const next = failures.get(sql)?.shift();
      if (next) throw next;
      return { rows: [], rowCount: 0 };
    },
    release(error?: Error | boolean) { released.push(!!error); },
  };
  class V1Model extends DBModel {
    protected static getHandler() {
      return { getConnection: async () => { taken++; return connection; } } as never;
    }
  }
  return { Model: V1Model, log, taken: () => taken, released, failOn: (sql, errors) => failures.set(sql, errors) };
}

function makeScp(): Harness {
  const log: string[] = [];
  const released: boolean[] = [];
  const failures = new Map<string, Error[]>();
  let taken = 0;
  const hit = (sql: string) => {
    log.push(sql);
    const next = failures.get(sql)?.shift();
    if (next) throw next;
  };
  const conn: AsyncConnection = {
    async execute(sql) { hit(sql); return []; },
    async run(sql) { hit(sql); return { changes: 0, lastInsertRowid: 0 }; },
  };
  const pool: AsyncConnectionPool = {
    async acquire() { taken++; return conn; },
    async release(_c, destroy) { released.push(destroy === true); },
  };
  const ctx = new PooledAsyncContext(pool);
  // like `createDBBase`: each class has its own transaction context
  const txStore = new AsyncLocalStorage<never>();
  class ScpModel extends DBModel {
    protected static _getTransactionContext() {
      return txStore as never;
    }
    protected static _getScpRuntime() {
      return { ctx, dialect: 'postgres', close: async () => {} } as never;
    }
    protected static getHandler(): never {
      throw new Error('the v1 handler must not be used on the SCP route');
    }
  }
  return { Model: ScpModel, log, taken: () => taken, released, failOn: (sql, errors) => failures.set(sql, errors) };
}

describe('two SCP runtimes nested in opposite directions (#329)', () => {
  it('runs each transaction on its own runtime\'s connection, the given one for A inside B', async () => {
    const a = makeScp();
    const b = makeScp();
    const connA = await a.Model.acquireConnection();

    await b.Model.transaction(async () => {
      await a.Model.transaction(async () => {
        await a.Model.getCurrentConnection()!.query('SELECT in_a');
      }, { connection: connA });
      await b.Model.getCurrentConnection()!.query('SELECT in_b');
    });
    connA.release();

    expect(a.log).toEqual(['BEGIN', 'SELECT in_a', 'COMMIT']);
    expect(b.log).toEqual(['BEGIN', 'SELECT in_b', 'COMMIT']);
    expect(a.taken()).toBe(1);
    expect(b.taken()).toBe(1);
  });
});

describe('scp transaction(ctx, fn, { connection }) nested in a transaction of the same ctx (#329)', () => {
  function makeCtx() {
    const log: string[] = [];
    const connection = (name: string): AsyncConnection => ({
      async execute(sql) { log.push(`${name}:${sql}`); return []; },
      async run(sql) { log.push(`${name}:${sql}`); return { changes: 0, lastInsertRowid: 0 }; },
    });
    const outer = connection('outer');
    const other = connection('other');
    const pool: AsyncConnectionPool = { async acquire() { return outer; }, async release() {} };
    return { ctx: new PooledAsyncContext(pool), log, outer, other };
  }

  it('throws for a connection that is not the enclosing transaction\'s, without running the body', async () => {
    const { ctx, log, other } = makeCtx();
    const inner = vi.fn(async () => undefined);

    await expect(scpTransaction(ctx, async () => {
      await scpTransaction(ctx, inner, { connection: other });
    }, { retryOnError: false })).rejects.toThrow('different connection');
    expect(inner).not.toHaveBeenCalled();
    expect(log).toEqual(['outer:BEGIN', 'outer:ROLLBACK']);
  });

  it('joins when given the enclosing transaction\'s own connection', async () => {
    const { ctx, log, outer } = makeCtx();

    await scpTransaction(ctx, async () => {
      await scpTransaction(ctx, async () => {
        await executeAsync(ctx, 'SELECT inner', []);
      }, { connection: outer });
    }, { connection: outer });
    expect(log).toEqual(['outer:BEGIN', 'outer:SELECT inner', 'outer:COMMIT']);
  });
});

describe.each([
  { route: 'v1 branch', make: makeV1 },
  { route: 'SCP route', make: makeScp },
])('acquireConnection / TransactionOptions.connection ($route)', ({ make }) => {
  it('runs BEGIN, the statement and COMMIT on the given connection without taking a new one, and does not release it', async () => {
    const h = make();
    const conn = await h.Model.acquireConnection();
    expect(h.taken()).toBe(1);

    await h.Model.transaction(async () => {
      await h.Model.getCurrentConnection()!.query('SELECT 1');
    }, { connection: conn });

    expect(h.log).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(h.taken()).toBe(1);
    expect(h.released).toEqual([]);

    conn.release();
    expect(h.released).toEqual([false]);
  });

  it('does not release the given connection after ROLLBACK either', async () => {
    const h = make();
    const conn = await h.Model.acquireConnection();
    const failure = new Error('body failed');

    await expect(h.Model.transaction(async () => { throw failure; }, { connection: conn, retryOnError: false })).rejects.toBe(failure);
    expect(h.log).toEqual(['BEGIN', 'ROLLBACK']);
    expect(h.released).toEqual([]);
    conn.release();
    expect(h.released).toHaveLength(1);
  });

  it('release() is safe to call twice and release(error) destroys the connection', async () => {
    const h = make();
    const first = await h.Model.acquireConnection();
    first.release();
    first.release();
    expect(h.released).toEqual([false]);

    const second = await h.Model.acquireConnection();
    second.release(new Error('broken'));
    second.release();
    expect(h.released).toEqual([false, true]);
  });

  it('does not retry a connection error in the body on a given connection', async () => {
    const h = make();
    const conn = await h.Model.acquireConnection();
    const func = vi.fn(async () => { throw connError(); });

    await expect(h.Model.transaction(func, { connection: conn, retryDuration: 1 })).rejects.toThrow('Connection terminated unexpectedly');
    expect(func).toHaveBeenCalledTimes(1);
    expect(h.taken()).toBe(1);
    expect(h.released).toEqual([]);
  });

  it('does not retry a connection error at COMMIT on a given connection', async () => {
    const h = make();
    const conn = await h.Model.acquireConnection();
    h.failOn('COMMIT', [connError()]);
    const func = vi.fn(async () => 'done');

    await expect(h.Model.transaction(func, { connection: conn, retryDuration: 1 })).rejects.toThrow('Connection terminated unexpectedly');
    expect(func).toHaveBeenCalledTimes(1);
  });

  it('retries a deadlock on the same connection: ROLLBACK, then BEGIN again', async () => {
    const h = make();
    const conn = await h.Model.acquireConnection();
    const func = vi.fn()
      .mockRejectedValueOnce(deadlock())
      .mockResolvedValueOnce('ok');

    await expect(h.Model.transaction(func, { connection: conn, retryDuration: 1 })).resolves.toBe('ok');
    expect(func).toHaveBeenCalledTimes(2);
    expect(h.log).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
    expect(h.taken()).toBe(1);
    expect(h.released).toEqual([]);
  });

  it('guards the connection func sees: a query after the transaction settled rejects and is not sent', async () => {
    const h = make();
    const conn = await h.Model.acquireConnection();
    let leaked: ReturnType<typeof h.Model.getCurrentConnection>;

    await h.Model.transaction(async () => { leaked = h.Model.getCurrentConnection(); }, { connection: conn });
    await expect(leaked!.query('SELECT late')).rejects.toBeInstanceOf(TransactionClosedError);
    expect(h.log).toEqual(['BEGIN', 'COMMIT']);
  });

  it('joins an enclosing transaction when given the enclosing transaction\'s own connection', async () => {
    const h = make();
    const conn = await h.Model.acquireConnection();

    await h.Model.transaction(async () => {
      await h.Model.transaction(async () => {
        await h.Model.getCurrentConnection()!.query('SELECT inner');
      }, { connection: conn });
    }, { connection: conn });

    expect(h.log).toEqual(['BEGIN', 'SELECT inner', 'COMMIT']);
  });

  it('throws when a nested transaction is given a different connection than the enclosing one', async () => {
    const h = make();
    const outer = await h.Model.acquireConnection();
    const other = await h.Model.acquireConnection();
    const inner = vi.fn(async () => undefined);

    await expect(h.Model.transaction(async () => {
      await h.Model.transaction(inner, { connection: other });
    }, { connection: outer, retryOnError: false })).rejects.toThrow('different connection');
    expect(inner).not.toHaveBeenCalled();
  });

  it('throws when a nested transaction is given a connection but the enclosing one took its own', async () => {
    const h = make();
    const conn = await h.Model.acquireConnection();

    await expect(h.Model.transaction(async () => {
      await h.Model.transaction(async () => undefined, { connection: conn });
    }, { retryOnError: false })).rejects.toThrow('different connection');
  });
});
