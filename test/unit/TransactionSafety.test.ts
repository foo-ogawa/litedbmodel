/**
 * Transaction connection safety tests
 *
 * - leased pg client 'error' handling (PostgresConnection)
 * - no func retry after a COMMIT connection error
 * - queries after func has settled are rejected
 * - statement_timeout passed to the pg Pool
 * - executeWrite does not resend a write after a connection error (pg, mysql)
 * - a read routed to the writer (withWriter / writer-sticky) retries after a connection error (pg, mysql)
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PostgresDriver } from '../../src/drivers/postgres';
import { MysqlDriver } from '../../src/drivers/mysql';
import type { Logger, DBConnection } from '../../src/drivers/types';
import { DBModel, getTransactionConnection } from '../../src/DBModel';
import { DBHandler } from '../../src/DBHandler';
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

  it('rejects an un-awaited query started in func once func has rejected and ROLLBACK was sent', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const connection = { query, release: vi.fn() };
    const { TxModel } = makeModel(connection);
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

    const callsAfterRollback = query.mock.calls.length;
    openGate();
    await expect(pending).rejects.toBeInstanceOf(TransactionClosedError);
    expect(query).toHaveBeenCalledTimes(callsAfterRollback);
    expect(query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'ROLLBACK']);
  });

  // Same-connection queries are processed in the order they were sent (as the pg client's queue does).
  function makeSerialConnection(gates: Record<string, Promise<void>> = {}) {
    const completed: string[] = [];
    let chain: Promise<unknown> = Promise.resolve();
    const query = vi.fn((sql: string) => {
      const run = chain.then(async () => {
        if (gates[sql]) await gates[sql];
        completed.push(sql);
        return { rows: [], rowCount: 0 };
      });
      chain = run.catch(() => {});
      return run;
    });
    return { connection: { query, release: vi.fn() }, query, completed };
  }

  it('rolls back and throws TransactionClosedError when func returns with a query still unfinished', async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const { connection, query, completed } = makeSerialConnection({ 'INSERT slow': gate });
    const { TxModel } = makeModel(connection);
    const func = vi.fn(async () => {
      const conn = getTransactionConnection()!;
      await conn.query('INSERT awaited');
      void conn.query('INSERT slow'); // started, not awaited
      return 'done';
    });

    let settled = false;
    const result = TxModel.transaction(func).finally(() => { settled = true; });
    const assertion = expect(result).rejects.toThrow(
      'A query started inside the transaction had not finished when the transaction function settled. ' +
      'Await every query started inside DBModel.transaction() before returning.',
    );
    await vi.waitFor(() => expect(query.mock.calls.map((c) => c[0])).toContain('ROLLBACK'));

    // ROLLBACK is queued behind the unfinished query: nothing settles before the query finishes
    expect(settled).toBe(false);
    expect(completed).not.toContain('ROLLBACK');
    openGate();
    await assertion;
    await expect(result).rejects.toBeInstanceOf(TransactionClosedError);

    expect(completed).toEqual(['BEGIN', 'INSERT awaited', 'INSERT slow', 'ROLLBACK']);
    expect(query.mock.calls.map((c) => c[0])).not.toContain('COMMIT');
    // a failure caused by the caller's code is not retried
    expect(func).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledWith(true);
  });

  it('TransactionClosedError for an unfinished query is not retryable', () => {
    const { TxModel } = makeModel(makeSerialConnection().connection);
    const isRetryable = (TxModel as unknown as { isRetryableError(e: Error): boolean }).isRetryableError;
    expect(isRetryable.call(TxModel, new TransactionClosedError('unfinished-query'))).toBe(false);
    expect(isRetryable.call(TxModel, new TransactionClosedError())).toBe(false);
  });

  it('commits when every query is awaited, including with Promise.all', async () => {
    const { connection, query } = makeSerialConnection();
    const { TxModel } = makeModel(connection);

    await expect(
      TxModel.transaction(async () => {
        const conn = getTransactionConnection()!;
        await conn.query('INSERT 1');
        await Promise.all([conn.query('INSERT 2'), conn.query('INSERT 3')]);
        return 'ok';
      }),
    ).resolves.toBe('ok');

    expect(query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'INSERT 1', 'INSERT 2', 'INSERT 3', 'COMMIT']);
  });
});

describe('executeWrite does not resend a write after a connection error', () => {
  it('PostgresDriver sends the write once and throws the connection error', async () => {
    const driver = new PostgresDriver({
      config: { host: 'tx-safety-write-pg-host', port: 5432, database: 'tx_safety_db', user: 'test', password: 'test' },
      logger: silentLogger,
    });
    const connectionError = makeError('Connection terminated unexpectedly');
    const query = vi
      .fn()
      .mockRejectedValueOnce(connectionError)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    (driver as unknown as { pool: { query: typeof query } }).pool = { query };

    await expect(
      driver.executeWrite('UPDATE users SET name = ? WHERE id = ?', ['alice', 1]),
    ).rejects.toBe(connectionError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('MysqlDriver sends the write once and throws the connection error', async () => {
    const driver = new MysqlDriver({
      config: { host: 'tx-safety-write-mysql-host', port: 3306, database: 'tx_safety_db', user: 'test', password: 'test' },
      logger: silentLogger,
    });
    const connectionError = makeError('Connection lost', 'PROTOCOL_CONNECTION_LOST');
    const query = vi
      .fn()
      .mockRejectedValueOnce(connectionError)
      .mockResolvedValueOnce([{ affectedRows: 1 }, null]);
    (driver as unknown as { pool: { query: typeof query } }).pool = { query };

    await expect(
      driver.executeWrite('UPDATE users SET name = ? WHERE id = ?', ['alice', 1]),
    ).rejects.toBe(connectionError);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('a read routed to the writer retries after a connection error', () => {
  function makeReadModel(driverType: 'postgres' | 'mysql', query: ReturnType<typeof vi.fn>) {
    const handler = new DBHandler(
      { driver: driverType, host: `tx-safety-writer-read-${driverType}`, port: 5432, database: 'tx_safety_db', user: 'test', password: 'test' },
      { logger: silentLogger },
    );
    (handler.getDriver() as unknown as { writerPool: { query: typeof query } }).writerPool = { query };
    class ReadModel extends DBModel {
      protected static getHandler() {
        return handler;
      }
    }
    return ReadModel;
  }

  it('PostgresDriver: a SELECT inside withWriter() is sent again and returns the rows', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(makeError('Connection terminated unexpectedly'))
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    const ReadModel = makeReadModel('postgres', query);

    const result = await ReadModel.withWriter(() => ReadModel.execute('SELECT id FROM users WHERE id = $1', [1]));

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('MysqlDriver: a SELECT inside withWriter() is sent again and returns the rows', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(makeError('Connection lost', 'PROTOCOL_CONNECTION_LOST'))
      .mockResolvedValueOnce([[{ id: 1 }], null]);
    const ReadModel = makeReadModel('mysql', query);

    const result = await ReadModel.withWriter(() => ReadModel.execute('SELECT id FROM users WHERE id = ?', [1]));

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('a write inside withWriter() is still not resent after a connection error', async () => {
    const connectionError = makeError('Connection terminated unexpectedly');
    const query = vi.fn().mockRejectedValue(connectionError);
    const ReadModel = makeReadModel('postgres', query);

    await expect(
      ReadModel.withWriter(() => ReadModel.execute('UPDATE users SET name = $1 WHERE id = $2', ['alice', 1])),
    ).rejects.toBe(connectionError);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
