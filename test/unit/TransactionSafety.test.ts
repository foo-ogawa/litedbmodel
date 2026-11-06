/**
 * Transaction connection safety — v1 branch (the `DBModel.transaction` loop over `handler.getConnection()`,
 * `src/drivers/*`). The SCP route is covered in `ScpTransactionSafety.test.ts`.
 *
 * - leased pg client 'error' handling (PostgresConnection)
 * - no func retry after a COMMIT connection error
 * - queries after func has settled are rejected
 * - statement_timeout passed to the pg Pool
 * - a write is not re-sent after a connection error
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PostgresDriver } from '../../src/drivers/postgres';
import { MysqlDriver } from '../../src/drivers/mysql';
import type { Logger, DBConnection } from '../../src/drivers/types';
import { DBModel, getTransactionConnection } from '../../src/DBModel';
import { DBHandler } from '../../src/DBHandler';
import { TransactionClosedError } from '../../src/types';
import * as publicApi from '../../src';

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
    expect(client.release.mock.calls[0][0]).toBeFalsy();
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

describe('driver executeWrite does not re-send a write after a connection error', () => {
  it('postgres: throws the connection error after one attempt (a read is still retried)', async () => {
    const driver = new PostgresDriver({
      config: { host: 'tx-safety-write-host', port: 5432, database: 'tx_safety_db', user: 'test', password: 'test' },
      logger: silentLogger,
    });
    const error = makeError('Connection terminated unexpectedly');
    const query = vi.fn(async () => { throw error; });
    (driver as unknown as { pool: unknown }).pool = { query };

    await expect(driver.executeWrite('INSERT INTO t (a) VALUES ($1)', [1])).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);

    query.mockClear();
    await expect(driver.execute('SELECT 1')).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('mysql: throws the connection error after one attempt (a read is still retried)', async () => {
    const driver = new MysqlDriver({
      config: { host: 'tx-safety-write-host', port: 3306, database: 'tx_safety_db', user: 'test', password: 'test', driver: 'mysql' },
      logger: silentLogger,
    });
    const error = makeError('Connection lost: The server closed the connection.', 'PROTOCOL_CONNECTION_LOST');
    const query = vi.fn(async () => { throw error; });
    (driver as unknown as { pool: unknown }).pool = { query };

    await expect(driver.executeWrite('INSERT INTO t (a) VALUES (?)', [1])).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);

    query.mockClear();
    await expect(driver.execute('SELECT 1')).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('DBModel.transaction (v1 branch)', () => {
  function makeModel(connection: DBConnection) {
    const getConnection = vi.fn(async () => connection);
    class TxModel extends DBModel {
      protected static getHandler() {
        return { getConnection } as never;
      }
    }
    // No DBConfig on this model ⇒ no SCP runtime ⇒ the v1 loop must be the one that runs.
    const assertV1Route = (): void => {
      expect((TxModel as unknown as { _getScpRuntime(): unknown })._getScpRuntime()).toBeNull();
      expect(getConnection).toHaveBeenCalled();
    };
    return { TxModel, getConnection, assertV1Route };
  }

  it('exports TransactionClosedError from the package entry', () => {
    expect(publicApi.TransactionClosedError).toBe(TransactionClosedError);
  });

  it('does not re-run func when COMMIT fails with a connection error', async () => {
    const commitError = makeError('Connection terminated unexpectedly');
    const query = vi.fn(async (sql: string) => {
      if (sql === 'COMMIT') throw commitError;
      return { rows: [], rowCount: 0 };
    });
    const connection = { query, release: vi.fn() };
    const { TxModel, assertV1Route } = makeModel(connection);
    const func = vi.fn(async () => 'done');

    await expect(TxModel.transaction(func, { retryDuration: 1 })).rejects.toBe(commitError);
    assertV1Route();
    expect(func).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledWith(true);
  });

  it('still re-runs func when COMMIT fails with a serialization failure', async () => {
    let commits = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql === 'COMMIT' && ++commits === 1) {
        throw makeError('could not serialize access due to concurrent update');
      }
      return { rows: [], rowCount: 0 };
    });
    const connection = { query, release: vi.fn() };
    const { TxModel, assertV1Route } = makeModel(connection);
    const func = vi.fn(async () => 'ok');

    await expect(TxModel.transaction(func, { retryDuration: 1 })).resolves.toBe('ok');
    assertV1Route();
    expect(func).toHaveBeenCalledTimes(2);
  });

  it('still re-runs func when a connection error occurs inside func', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const connection = { query, release: vi.fn() };
    const { TxModel, assertV1Route } = makeModel(connection);
    const func = vi.fn()
      .mockRejectedValueOnce(makeError('Connection terminated unexpectedly'))
      .mockResolvedValueOnce('ok');

    await expect(TxModel.transaction(func, { retryDuration: 1 })).resolves.toBe('ok');
    assertV1Route();
    expect(func).toHaveBeenCalledTimes(2);
  });

  it('rejects queries through the transaction connection after func has settled', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const connection = { query, release: vi.fn() };
    const { TxModel, assertV1Route } = makeModel(connection);

    let leaked: DBConnection | undefined;
    await TxModel.transaction(async () => {
      leaked = getTransactionConnection();
      await leaked!.query('SELECT 1');
    });
    assertV1Route();

    const callsAfterSettle = query.mock.calls.length;
    await expect(leaked!.query('SELECT 2')).rejects.toBeInstanceOf(TransactionClosedError);
    expect(query).toHaveBeenCalledTimes(callsAfterSettle);
    // COMMIT is sent by the transaction itself on the original connection
    expect(query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
  });

  it('rejects an un-awaited query started in func once func has rejected and ROLLBACK was sent', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const connection = { query, release: vi.fn() };
    const { TxModel, assertV1Route } = makeModel(connection);
    const funcError = new Error('func failed');

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    let pending: Promise<unknown> | undefined;
    await expect(
      TxModel.transaction(async () => {
        const conn = getTransactionConnection()!;
        // started inside func but not awaited: it reaches the connection only after the gate opens
        pending = gate.then(() => conn.query('SELECT late'));
        throw funcError;
      }, { retryOnError: false }),
    ).rejects.toBe(funcError);
    assertV1Route();

    const callsAfterRollback = query.mock.calls.length;
    openGate();
    await expect(pending).rejects.toBeInstanceOf(TransactionClosedError);
    expect(query).toHaveBeenCalledTimes(callsAfterRollback);
    expect(query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'ROLLBACK']);
  });
});

describe('a read routed to the writer is still retried after a connection error (v1 branch)', () => {
  it('withWriter(): DBModel.execute(SELECT) retries on the writer pool and returns the rows; a write is not re-sent', async () => {
    const config = { host: 'tx-safety-writer-host', port: 5432, database: 'tx_safety_db', user: 'test', password: 'test' };
    const driver = new PostgresDriver({ config, logger: silentLogger });
    const error = makeError('Connection terminated unexpectedly');
    const query = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ rows: [{ n: 1 }], rowCount: 1 });
    (driver as unknown as { pool: unknown }).pool = { query: vi.fn(async () => { throw new Error('reader pool must not be used'); }) };
    (driver as unknown as { writerPool: unknown }).writerPool = { query };

    const handler = new DBHandler(config);
    (handler as unknown as { driver: unknown }).driver = driver;
    class WriterModel extends DBModel {
      protected static getHandler() {
        return handler;
      }
    }

    // Route check: no SCP runtime for this model, so the v1 core with executeOnWriter runs.
    expect((WriterModel as unknown as { _getScpRuntime(): unknown })._getScpRuntime()).toBeNull();
    const result = await WriterModel.withWriter(() => WriterModel.execute('SELECT 1 AS n'));
    expect(result.rows).toEqual([{ n: 1 }]);
    expect(query).toHaveBeenCalledTimes(2);

    query.mockReset();
    query.mockRejectedValue(error);
    await expect(WriterModel.execute('INSERT INTO t (a) VALUES ($1)', [1])).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
