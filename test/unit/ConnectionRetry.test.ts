/**
 * Connection error detection and the drivers' re-send after a connection error: the re-send runs on a
 * connection that passed a `SELECT 1` probe; a connection that fails it is destroyed and the next one taken,
 * at most retryLimit connections. Writes are never re-sent.
 */

import { describe, it, expect, vi } from 'vitest';
import { isConnectionError } from '../../src/connection-errors';
import { PostgresDriver } from '../../src/drivers/postgres';
import { MysqlDriver } from '../../src/drivers/mysql';
import type { Logger } from '../../src/drivers/types';
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

describe('isConnectionError', () => {
  it('returns true for "Connection terminated unexpectedly"', () => {
    expect(isConnectionError(makeError('Connection terminated unexpectedly'))).toBe(true);
  });

  it('returns true for "Connection terminated"', () => {
    expect(isConnectionError(makeError('Connection terminated'))).toBe(true);
  });

  it('returns true for "Client has encountered a connection error"', () => {
    expect(isConnectionError(makeError('Client has encountered a connection error'))).toBe(true);
  });

  it('returns true for ECONNRESET error code', () => {
    expect(isConnectionError(makeError('read ECONNRESET', 'ECONNRESET'))).toBe(true);
  });

  it('returns true for ECONNREFUSED error code', () => {
    expect(isConnectionError(makeError('connect ECONNREFUSED', 'ECONNREFUSED'))).toBe(true);
  });

  it('returns true for EPIPE error code', () => {
    expect(isConnectionError(makeError('broken pipe', 'EPIPE'))).toBe(true);
  });

  it('returns true for EAI_AGAIN error code', () => {
    expect(isConnectionError(makeError('getaddrinfo EAI_AGAIN', 'EAI_AGAIN'))).toBe(true);
  });

  it('returns true for "Connection lost" (MySQL)', () => {
    expect(isConnectionError(makeError('Connection lost: The server closed the connection.'))).toBe(true);
  });

  it('returns true for PROTOCOL_CONNECTION_LOST (MySQL)', () => {
    expect(isConnectionError(makeError('PROTOCOL_CONNECTION_LOST', 'PROTOCOL_CONNECTION_LOST'))).toBe(true);
  });

  it('returns true for PG SQLSTATE 57P01 (admin_shutdown: the server ended the connection)', () => {
    expect(isConnectionError(makeError('terminating connection due to administrator command', '57P01'))).toBe(true);
  });

  it('returns false for normal query errors', () => {
    expect(isConnectionError(makeError('syntax error at or near "SELCT"'))).toBe(false);
  });

  it('returns false for constraint violations', () => {
    expect(isConnectionError(makeError('duplicate key value violates unique constraint "users_pkey"'))).toBe(false);
  });

  it('returns true for ECONNRESET code without matching message', () => {
    expect(isConnectionError(makeError('query failed', 'ECONNRESET'))).toBe(true);
  });

  it('returns true for "read ECONNRESET" message without code', () => {
    expect(isConnectionError(makeError('read ECONNRESET'))).toBe(true);
  });

  it('returns true for "This socket has been ended by the other party"', () => {
    expect(isConnectionError(makeError('This socket has been ended by the other party'))).toBe(true);
  });
});

const RETRY_LIMIT = 3; // the default retryLimit: at most this many connections are probed for a re-send

describe.each([
  {
    name: 'PostgresDriver',
    make: () => new PostgresDriver({ config: { host: 'retry-test-pg-host', port: 5432, database: 'retry_test_db', user: 'test', password: 'test' }, logger: silentLogger }),
    fakePool: fakePgPool,
    ok: (rows: unknown[]) => ({ rows, rowCount: rows.length }),
    connectionError: () => makeError('Connection terminated unexpectedly'),
    syntaxError: () => makeError('syntax error at or near "FOO"'),
  },
  {
    name: 'MysqlDriver',
    make: () => new MysqlDriver({ config: { host: 'retry-test-mysql-host', port: 3306, database: 'retry_test_db', user: 'test', password: 'test' }, logger: silentLogger }),
    fakePool: fakeMysqlPool,
    ok: (rows: unknown[]) => [rows, null],
    connectionError: () => makeError('Connection lost: The server closed the connection.', 'PROTOCOL_CONNECTION_LOST'),
    syntaxError: () => makeError('You have an error in your SQL syntax'),
  },
])('$name execute retry', ({ make, fakePool, ok, connectionError, syntaxError }) => {
  const STMT = 'SELECT * FROM users WHERE id = ?';
  const sent = (query: ReturnType<typeof vi.fn>) => sentSql(query).map((s) => s.replace('$1', '?'));

  it('after a connection error, probes a connection with SELECT 1 and re-sends the statement on it', async () => {
    const mockRows = [{ id: 1 }];
    const query = vi.fn()
      .mockRejectedValueOnce(connectionError())
      .mockResolvedValueOnce(ok([{ one: 1 }]))
      .mockResolvedValueOnce(ok(mockRows));
    const pool = fakePool(query);
    const driver = make();
    (driver as unknown as { pool: unknown }).pool = pool;

    const result = await driver.execute(STMT, [1]);

    expect(sent(query)).toEqual([STMT, 'SELECT 1', STMT]);
    expect(result.rows).toEqual(mockRows);
    expect(result.rowCount).toBe(1);
    expect(pool.destroyed()).toBe(0);
  });

  it('destroys a connection that fails the probe and re-sends on the next one that passes', async () => {
    const mockRows = [{ id: 1 }];
    const query = vi.fn()
      .mockRejectedValueOnce(connectionError())
      .mockRejectedValueOnce(connectionError())
      .mockResolvedValueOnce(ok([{ one: 1 }]))
      .mockResolvedValueOnce(ok(mockRows));
    const pool = fakePool(query);
    const driver = make();
    (driver as unknown as { pool: unknown }).pool = pool;

    const result = await driver.execute(STMT, [1]);

    expect(sent(query)).toEqual([STMT, 'SELECT 1', 'SELECT 1', STMT]);
    expect(result.rows).toEqual(mockRows);
    expect(pool.destroyed()).toBe(1);
  });

  it('throws when every probed connection fails, after at most retryLimit connections', async () => {
    const query = vi.fn().mockRejectedValue(connectionError());
    const pool = fakePool(query);
    const driver = make();
    (driver as unknown as { pool: unknown }).pool = pool;

    await expect(driver.execute('SELECT 1')).rejects.toThrow(connectionError().message);
    expect(sent(query)).toEqual(['SELECT 1', ...Array(RETRY_LIMIT).fill('SELECT 1')]);
    expect(pool.destroyed()).toBe(RETRY_LIMIT);
  });

  it('getConnection(checkAttempts) — the transaction retry after a connection error — replaces a connection that fails the probe', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(connectionError())
      .mockResolvedValue(ok([{ one: 1 }]));
    const pool = fakePool(query);
    const driver = make();
    (driver as unknown as { pool: unknown }).pool = pool;

    await driver.getConnection(RETRY_LIMIT);
    expect(sent(query)).toEqual(['SELECT 1', 'SELECT 1']);
    expect(pool.destroyed()).toBe(1);

    query.mockClear();
    await driver.getConnection(); // a first attempt is not probed
    expect(query).not.toHaveBeenCalled();
  });

  it('does not retry on non-connection errors in execute()', async () => {
    const query = vi.fn().mockRejectedValue(syntaxError());
    const driver = make();
    (driver as unknown as { pool: unknown }).pool = fakePool(query);

    await expect(driver.execute('SELCT 1')).rejects.toThrow(syntaxError().message);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not re-send a write after a connection error in executeWrite()', async () => {
    const query = vi.fn().mockRejectedValue(connectionError());
    const driver = make();
    (driver as unknown as { pool: unknown }).pool = fakePool(query);

    await expect(driver.executeWrite('UPDATE users SET name = ? WHERE id = ?', ['alice', 1])).rejects.toThrow(connectionError().message);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not retry on non-connection errors in executeWrite()', async () => {
    const query = vi.fn().mockRejectedValue(syntaxError());
    const driver = make();
    (driver as unknown as { pool: unknown }).pool = fakePool(query);

    await expect(driver.executeWrite('UPDTE users SET name = ? WHERE id = ?', ['alice', 1])).rejects.toThrow(syntaxError().message);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
