/**
 * Transaction connection safety tests
 *
 * - leased pg client 'error' handling (PostgresConnection)
 * - no func retry after a COMMIT connection error
 * - queries after func has settled are rejected
 * - statement_timeout passed to the pg Pool
 * - executeWrite does not resend a write after a connection error (pg, mysql)
 * - a read routed to the writer (withWriter / writer-sticky) retries after a connection error, on a probed
 *   connection (pg, mysql)
 * - a transaction retry after a connection error acquires a probed connection
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PostgresDriver } from '../../src/drivers/postgres';
import { MysqlDriver } from '../../src/drivers/mysql';
import type { Logger, DBConnection } from '../../src/drivers/types';
import { DBModel, getTransactionConnection } from '../../src/DBModel';
import { DBHandler } from '../../src/DBHandler';
import { TransactionClosedError } from '../../src/types';
import { fakePgPool, fakeMysqlPool, sentSql } from '../helpers/fakePools';

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
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    class TxModel extends DBModel {
      protected static getHandler() {
        return { getConnection, getLogger: () => logger } as never;
      }
    }
    return { TxModel, getConnection, logger };
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

  it('takes the retry after a connection error from a probed acquisition (at most retryLimit); a deadlock retry is not probed', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));
    const connection = { query, release: vi.fn() };
    const { TxModel, getConnection } = makeModel(connection);
    const func = vi.fn()
      .mockRejectedValueOnce(makeError('Connection terminated unexpectedly'))
      .mockRejectedValueOnce(makeError('Deadlock found when trying to get lock'))
      .mockResolvedValueOnce('ok');

    await expect(TxModel.transaction(func, { retryLimit: 4, retryDuration: 1 })).resolves.toBe('ok');
    expect((getConnection.mock.calls as unknown[][]).map((c) => c[0])).toEqual([undefined, 4, undefined]);
  });

  it('rejects queries through the transaction connection after func has settled', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));
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
    const query = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));
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
  function makeSerialConnection(gates: Partial<Record<string, Promise<void>>> = {}) {
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

  it('throws TransactionClosedError, not the retryable func error, when func rejects with a query still unfinished', async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const { connection, query, completed } = makeSerialConnection({ 'INSERT slow': gate });
    const { TxModel } = makeModel(connection);
    const funcError = makeError('Deadlock found when trying to get lock; try restarting transaction', '40P01');
    const func = vi.fn(async () => {
      const conn = getTransactionConnection()!;
      void conn.query('INSERT slow'); // started, not awaited
      throw funcError;
    });

    const result = TxModel.transaction(func, { retryDuration: 1 });
    const assertion = result.catch((e) => e);
    await vi.waitFor(() => expect(query.mock.calls.map((c) => c[0])).toContain('ROLLBACK'));
    openGate();
    const thrown = await assertion;

    expect(thrown).toBeInstanceOf(TransactionClosedError);
    expect((thrown as Error).message).toContain('had not finished when the transaction function settled');
    expect((thrown as Error).cause).toBe(funcError);
    // not retried even though the func error is retryable
    expect(func).toHaveBeenCalledTimes(1);
    expect(completed).toEqual(['BEGIN', 'INSERT slow', 'ROLLBACK']);
    expect(query.mock.calls.map((c) => c[0])).not.toContain('COMMIT');
  });

  it('a query issued after func settled does not become an unhandledRejection, and is logged once', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { connection } = makeSerialConnection();
      const { TxModel, logger } = makeModel(connection);
      let leaked: DBConnection | undefined;
      await TxModel.transaction(async () => {
        leaked = getTransactionConnection();
        await leaked!.query('SELECT 1');
      });

      void leaked!.query('SELECT forgotten-await'); // not awaited
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        'Query issued after the transaction function settled. ' +
        'Await every query started inside DBModel.transaction() before returning.',
      );

      // an awaited one still receives the error
      await expect(leaked!.query('SELECT awaited')).rejects.toBeInstanceOf(TransactionClosedError);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
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

describe('DBModel.acquireConnection and TransactionOptions.connection (#329)', () => {
  function makeFake() {
    const sent: string[] = [];
    const query = vi.fn(async (sql: string) => {
      sent.push(sql);
      return { rows: [], rowCount: 0 };
    });
    const raw = { query, release: vi.fn() };
    const getConnection = vi.fn(async () => raw);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    class AcqModel extends DBModel {
      protected static getHandler() {
        return { getConnection, getLogger: () => logger } as never;
      }
    }
    return { AcqModel, raw, query, sent, getConnection };
  }

  it('acquireConnection() returns the writer connection; release() releases it once even when called twice', async () => {
    const { AcqModel, raw, getConnection } = makeFake();

    const conn = await AcqModel.acquireConnection();
    expect(getConnection).toHaveBeenCalledTimes(1);
    const error = makeError('boom');
    conn.release(error);
    conn.release();

    expect(raw.release).toHaveBeenCalledTimes(1);
    expect(raw.release).toHaveBeenCalledWith(error);
  });

  it('opens the transaction on the given connection: BEGIN, statement, COMMIT, no getConnection, no release', async () => {
    const { AcqModel, raw, sent, getConnection } = makeFake();
    const conn = await AcqModel.acquireConnection();
    getConnection.mockClear();

    const result = await AcqModel.transaction(async () => {
      await getTransactionConnection()!.query('INSERT 1');
      return 'done';
    }, { connection: conn });

    expect(result).toBe('done');
    expect(sent).toEqual(['BEGIN', 'INSERT 1', 'COMMIT']);
    expect(getConnection).not.toHaveBeenCalled();
    expect(raw.release).not.toHaveBeenCalled();
    conn.release();
    expect(raw.release).toHaveBeenCalledTimes(1);
  });

  it('does not release the given connection after ROLLBACK either', async () => {
    const { AcqModel, raw, sent } = makeFake();
    const conn = await AcqModel.acquireConnection();
    const failure = new Error('func failed');

    await expect(AcqModel.transaction(async () => { throw failure; }, { connection: conn })).rejects.toBe(failure);

    expect(sent).toEqual(['BEGIN', 'ROLLBACK']);
    expect(raw.release).not.toHaveBeenCalled();
  });

  it('does not retry a connection error on the given connection', async () => {
    const { AcqModel, sent, getConnection } = makeFake();
    const conn = await AcqModel.acquireConnection();
    getConnection.mockClear();
    const connectionError = makeError('Connection terminated unexpectedly');
    const func = vi.fn().mockRejectedValue(connectionError);

    await expect(AcqModel.transaction(func, { connection: conn, retryDuration: 1 })).rejects.toBe(connectionError);

    expect(func).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(['BEGIN', 'ROLLBACK']);
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('retries a deadlock on the same connection: ROLLBACK, then BEGIN again', async () => {
    const { AcqModel, raw, sent, getConnection } = makeFake();
    const conn = await AcqModel.acquireConnection();
    getConnection.mockClear();
    const func = vi.fn()
      .mockRejectedValueOnce(new Error('Deadlock found when trying to get lock'))
      .mockResolvedValueOnce('ok');

    await expect(AcqModel.transaction(func, { connection: conn, retryDuration: 1 })).resolves.toBe('ok');

    expect(func).toHaveBeenCalledTimes(2);
    expect(sent).toEqual(['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
    expect(getConnection).not.toHaveBeenCalled();
    expect(raw.release).not.toHaveBeenCalled();
  });

  it('rejects a query made through the transaction connection after func settled, on the given connection too', async () => {
    const { AcqModel } = makeFake();
    const conn = await AcqModel.acquireConnection();
    let leaked!: DBConnection;

    await AcqModel.transaction(async () => { leaked = getTransactionConnection()!; }, { connection: conn });

    await expect(leaked.query('SELECT 1')).rejects.toBeInstanceOf(TransactionClosedError);
  });

  it('rejects func that returns with a query unfinished on the given connection', async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const sent: string[] = [];
    const raw = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'INSERT slow') await gate;
        sent.push(sql);
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    class GivenModel extends DBModel {
      protected static getHandler() {
        return { getConnection: vi.fn(), getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } as never;
      }
    }

    const result = GivenModel.transaction(async () => {
      void getTransactionConnection()!.query('INSERT slow');
    }, { connection: raw });
    const assertion = expect(result).rejects.toBeInstanceOf(TransactionClosedError);
    openGate();
    await assertion;
  });

  it('nested: the same connection joins the outer transaction; another connection is an error', async () => {
    const { AcqModel, sent } = makeFake();
    const conn = await AcqModel.acquireConnection();
    const other = { query: vi.fn(), release: vi.fn() };

    await AcqModel.transaction(async () => {
      await AcqModel.transaction(async () => {
        await getTransactionConnection()!.query('INSERT inner');
      }, { connection: conn });
      await expect(AcqModel.transaction(async () => 'x', { connection: other })).rejects.toThrow(/different connection/);
    }, { connection: conn });

    expect(sent).toEqual(['BEGIN', 'INSERT inner', 'COMMIT']);
    expect(other.query).not.toHaveBeenCalled();
  });

  it('nested: a connection given inside a transaction that took its own connection is an error', async () => {
    const { AcqModel } = makeFake();
    const other = { query: vi.fn(), release: vi.fn() };

    await AcqModel.transaction(async () => {
      await expect(AcqModel.transaction(async () => 'x', { connection: other })).rejects.toThrow(/different connection/);
    });
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
    (handler.getDriver() as unknown as { writerPool: unknown }).writerPool = (driverType === 'postgres' ? fakePgPool : fakeMysqlPool)(query);
    class ReadModel extends DBModel {
      protected static getHandler() {
        return handler;
      }
    }
    return ReadModel;
  }

  it('PostgresDriver: a SELECT inside withWriter() is sent again on a probed connection and returns the rows', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(makeError('Connection terminated unexpectedly'))
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    const ReadModel = makeReadModel('postgres', query);

    const result = await ReadModel.withWriter(() => ReadModel.execute('SELECT id FROM users WHERE id = $1', [1]));

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(sentSql(query)).toEqual(['SELECT id FROM users WHERE id = $1', 'SELECT 1', 'SELECT id FROM users WHERE id = $1']); // the read, the probe, the re-send
  });

  it('MysqlDriver: a SELECT inside withWriter() is sent again on a probed connection and returns the rows', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(makeError('Connection lost', 'PROTOCOL_CONNECTION_LOST'))
      .mockResolvedValueOnce([[{ 1: 1 }], null])
      .mockResolvedValueOnce([[{ id: 1 }], null]);
    const ReadModel = makeReadModel('mysql', query);

    const result = await ReadModel.withWriter(() => ReadModel.execute('SELECT id FROM users WHERE id = ?', [1]));

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(sentSql(query)).toEqual(['SELECT id FROM users WHERE id = ?', 'SELECT 1', 'SELECT id FROM users WHERE id = ?']); // the read, the probe, the re-send
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

describe('DBModel.execute() routes by whether the statement is read-only (#332)', () => {
  // A separate fake for each pool: the reader pool and the writer pool.
  function makeRoutedModel(driverType: 'postgres' | 'mysql', readerQuery: ReturnType<typeof vi.fn>, writerQuery: ReturnType<typeof vi.fn>) {
    const handler = new DBHandler(
      { driver: driverType, host: `tx-safety-routing-${driverType}`, port: 5432, database: 'tx_safety_db', user: 'test', password: 'test' },
      { logger: silentLogger },
    );
    const driver = handler.getDriver() as unknown as { pool: unknown; writerPool: unknown };
    const fakePool = driverType === 'postgres' ? fakePgPool : fakeMysqlPool;
    driver.pool = fakePool(readerQuery);
    driver.writerPool = fakePool(writerQuery);
    class RoutedModel extends DBModel {
      protected static getHandler() {
        return handler;
      }
    }
    return RoutedModel;
  }

  const drivers = [
    { driverType: 'postgres' as const, connectionError: () => makeError('Connection terminated unexpectedly'), rows: (r: unknown[]) => ({ rows: r, rowCount: r.length }), p: '$1' },
    { driverType: 'mysql' as const, connectionError: () => makeError('Connection lost', 'PROTOCOL_CONNECTION_LOST'), rows: (r: unknown[]) => [r, null], p: '?' },
  ];

  for (const { driverType, connectionError, rows, p } of drivers) {
    describe(driverType, () => {
      const writes = [
        `INSERT INTO users (name) VALUES (${p}) RETURNING id`,
        `UPDATE users SET name = ${p} WHERE id = 1 RETURNING id`,
        `DELETE FROM users WHERE name = ${p} RETURNING id`,
        `WITH x AS (UPDATE users SET name = ${p} WHERE id = 1 RETURNING *) SELECT id FROM x`,
        `EXPLAIN ANALYZE DELETE FROM users WHERE name = ${p}`,
      ];

      for (const sql of writes) {
        it(`${sql} outside withWriter() goes to the writer, not to the reader`, async () => {
          const readerQuery = vi.fn().mockResolvedValue(rows([{ id: 1 }]));
          const writerQuery = vi.fn().mockResolvedValue(rows([{ id: 1 }]));
          const Model = makeRoutedModel(driverType, readerQuery, writerQuery);

          await Model.execute(sql, ['alice']);

          expect(readerQuery).not.toHaveBeenCalled();
          expect(writerQuery).toHaveBeenCalledTimes(1);
        });

        it(`${sql} is not resent after a connection error`, async () => {
          const error = connectionError();
          const readerQuery = vi.fn();
          const writerQuery = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(rows([{ id: 1 }]));
          const Model = makeRoutedModel(driverType, readerQuery, writerQuery);

          await expect(Model.execute(sql, ['alice'])).rejects.toBe(error);
          expect(writerQuery).toHaveBeenCalledTimes(1);
          expect(readerQuery).not.toHaveBeenCalled();
        });
      }

      const reads = [`SELECT id FROM users WHERE id = ${p}`, `WITH x AS (SELECT id FROM users WHERE id = ${p}) SELECT id FROM x`, `EXPLAIN SELECT id FROM users WHERE id = ${p}`];

      for (const sql of reads) {
        it(`${sql} goes to the reader and is resent on a probed connection after a connection error`, async () => {
          const readerQuery = vi.fn()
            .mockRejectedValueOnce(connectionError())
            .mockResolvedValueOnce(rows([{ one: 1 }]))
            .mockResolvedValueOnce(rows([{ id: 1 }]));
          const writerQuery = vi.fn();
          const Model = makeRoutedModel(driverType, readerQuery, writerQuery);

          const result = await Model.execute(sql, [1]);

          expect(result.rows).toEqual([{ id: 1 }]);
          expect(sentSql(readerQuery)).toEqual([sql, 'SELECT 1', sql]); // the read, the probe, the re-send
          expect(writerQuery).not.toHaveBeenCalled();
        });
      }
    });
  }
});
