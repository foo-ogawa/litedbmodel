/**
 * Transaction connection safety tests
 *
 * - leased pg client 'error' handling (PostgresConnection)
 * - no func retry after a COMMIT connection error
 * - queries after func has settled are rejected
 * - statement_timeout passed to the pg Pool
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PostgresDriver } from '../../src/drivers/postgres';
import type { Logger, DBConnection } from '../../src/drivers/types';
import { DBModel, getTransactionConnection } from '../../src/DBModel';
import { TransactionClosedError } from '../../src/types';

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeError(message: string, code?: string): Error {
  const err = new Error(message);
  if (code) {
    (err as NodeJS.ErrnoException).code = code;
  }
  return err;
}

describe('PostgresConnection leased client error handling', () => {
  function makeDriver(client: EventEmitter & { query: unknown; release: unknown }): PostgresDriver {
    const driver = new PostgresDriver({
      config: { host: 'tx-safety-pg-host', port: 5432, database: 'tx_safety_db', user: 'test', password: 'test' },
      logger: silentLogger,
    });
    (driver as unknown as { pool: unknown }).pool = { connect: async () => client };
    return driver;
  }

  it('does not crash on client "error" while leased and destroys the connection on release', async () => {
    const client = Object.assign(new EventEmitter(), { query: vi.fn(), release: vi.fn() });
    const conn = await makeDriver(client).getConnection();

    const error = makeError('Connection terminated unexpectedly');
    expect(() => client.emit('error', error)).not.toThrow();

    conn.release();
    expect(client.release).toHaveBeenCalledWith(error);
  });

  it('removes the error listener on release and does not destroy a healthy connection', async () => {
    const client = Object.assign(new EventEmitter(), { query: vi.fn(), release: vi.fn() });
    const conn = await makeDriver(client).getConnection();
    expect(client.listenerCount('error')).toBe(1);

    conn.release();
    expect(client.listenerCount('error')).toBe(0);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });
});

describe('PostgresDriver pool statement_timeout', () => {
  it('passes the query timeout as statement_timeout to the pg Pool', async () => {
    const driver = new PostgresDriver({
      config: {
        host: 'tx-safety-stmt-timeout-host',
        port: 5432,
        database: 'tx_safety_db',
        user: 'test',
        password: 'test',
        queryTimeout: 7,
      },
      logger: silentLogger,
    });
    const options = (driver as unknown as { pool: { options: Record<string, unknown> } }).pool.options;
    expect(options.query_timeout).toBe(7000);
    expect(options.statement_timeout).toBe(7000);
    await driver.close();
  });
});

describe('DBModel.transaction', () => {
  function makeModel(connection: DBConnection) {
    const getConnection = vi.fn(async () => connection);
    class TxModel extends DBModel {
      protected static getHandler() {
        return { getConnection } as never;
      }
    }
    return { TxModel, getConnection };
  }

  it('does not re-run func when COMMIT fails with a connection error', async () => {
    const commitError = makeError('Connection terminated unexpectedly');
    const query = vi.fn(async (sql: string) => {
      if (sql === 'COMMIT') throw commitError;
      return { rows: [], rowCount: 0 };
    });
    const connection = { query, release: vi.fn() };
    const { TxModel } = makeModel(connection);
    const func = vi.fn(async () => 'done');

    await expect(TxModel.transaction(func, { retryDuration: 1 })).rejects.toBe(commitError);
    expect(func).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledWith(true);
  });

  it('still re-runs func when a connection error occurs inside func', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const connection = { query, release: vi.fn() };
    const { TxModel } = makeModel(connection);
    const func = vi.fn()
      .mockRejectedValueOnce(makeError('Connection terminated unexpectedly'))
      .mockResolvedValueOnce('ok');

    await expect(TxModel.transaction(func, { retryDuration: 1 })).resolves.toBe('ok');
    expect(func).toHaveBeenCalledTimes(2);
  });

  it('rejects queries through the transaction connection after func has settled', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const connection = { query, release: vi.fn() };
    const { TxModel } = makeModel(connection);

    let leaked: DBConnection | undefined;
    await TxModel.transaction(async () => {
      leaked = getTransactionConnection();
      await leaked!.query('SELECT 1');
    });

    const callsAfterSettle = query.mock.calls.length;
    await expect(leaked!.query('SELECT 2')).rejects.toBeInstanceOf(TransactionClosedError);
    expect(query).toHaveBeenCalledTimes(callsAfterSettle);
    // COMMIT is sent by the transaction itself on the original connection
    expect(query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
  });
});
