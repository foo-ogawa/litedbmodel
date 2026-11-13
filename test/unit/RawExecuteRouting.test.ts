/**
 * Raw `DBModel.execute()` routing (#332, #366) and re-sending (#366) are two judgments:
 *   - only a certainly read-only statement (`isReadOnlyStatement`) goes to the reader; everything else
 *     (INSERT/UPDATE/DELETE … RETURNING, data-modifying WITH, EXPLAIN ANALYZE of a write, SELECT … FOR
 *     UPDATE / FOR SHARE / LOCK IN SHARE MODE / INTO, DDL) goes to the writer and is never re-sent;
 *   - only a read-only statement that calls no function (`isResendableStatement`) is re-sent after a
 *     connection error: a function-calling SELECT (`COUNT(*)` included) goes to the reader, once.
 * v1 branch (pg / mysql fake pools on a real DBHandler) and SCP route (fake pools). No live DB.
 */

import { describe, it, expect, vi } from 'vitest';
import { DBModel } from '../../src/DBModel';
import { DBHandler } from '../../src/DBHandler';
import { PooledAsyncContext, ConnectionRegistry, WriterStickyClock, type AsyncConnection, type AsyncConnectionPool } from '../../src/scp';
import type { Logger } from '../../src/drivers/types';
import { fakePgPool, fakeMysqlPool, sentSql } from '../helpers/fakePools';

const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const WRITES = [
  'INSERT INTO t (a) VALUES (1) RETURNING id',
  'UPDATE t SET a = 1 RETURNING id',
  'DELETE FROM t RETURNING id',
  'WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x',
  'EXPLAIN ANALYZE DELETE FROM t',
  'SELECT id FROM t WHERE id = ? FOR UPDATE',
  'SELECT id FROM t WHERE id = ? FOR NO KEY UPDATE',
  'SELECT id FROM t WHERE id = ? FOR SHARE',
  'SELECT id FROM t WHERE id = ? FOR KEY SHARE',
  'SELECT id FROM t WHERE id = ? LOCK IN SHARE MODE',
  'SELECT id INTO @v FROM t WHERE id = ?',
  'SELECT * INTO new_t FROM t',
];
/** Read-only and calling no function: reader, re-sent once after a connection error. */
const READS = [
  'SELECT 1',
  'SELECT col FROM t WHERE id = ?',
  'SELECT a.x FROM t a JOIN u ON (a.id = u.id) WHERE a.id IN (?, ?) AND EXISTS (SELECT 1 FROM v WHERE v.id = a.id)',
  'WITH x AS (SELECT 1 AS a) SELECT * FROM x',
  'EXPLAIN SELECT 1',
];
/** Read-only but calling a function: reader, never re-sent. */
const FUNCTION_READS = [
  'SELECT COUNT(*) FROM t',
  'SELECT charge(?) AS id',
  'SELECT nextval(\'s\')',
  'SELECT billing.charge(?)',
  'SELECT "Charge"(?)',
  'SELECT `charge`(?)',
  'SELECT * FROM t WHERE id IN (SELECT max(id) FROM t)',
];

function connectionError(): Error {
  return Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
}

describe.each([
  { name: 'postgres', driver: 'postgres' as const, port: 5432, fakePool: fakePgPool, ok: { rows: [], rowCount: 0 } },
  { name: 'mysql', driver: 'mysql' as const, port: 3306, fakePool: fakeMysqlPool, ok: [[], null] },
])('DBModel.execute routing on the v1 branch ($name)', ({ driver, port, fakePool, ok }) => {
  /** Each pool fails its first statement with a connection error and answers every later one. */
  function makeModel() {
    const config = { host: `raw-routing-${driver}-reader`, port, database: 'raw_routing', user: 'test', password: 'test', driver };
    const handler = new DBHandler(config, {
      writerConfig: { ...config, host: `raw-routing-${driver}-writer` },
      logger: silentLogger,
    });
    const reader = vi.fn().mockRejectedValueOnce(connectionError()).mockResolvedValue(ok);
    const writer = vi.fn().mockRejectedValueOnce(connectionError()).mockResolvedValue(ok);
    Object.assign(handler.getDriver(), { pool: fakePool(reader), writerPool: fakePool(writer) });
    class RawModel extends DBModel {
      protected static getHandler() { return handler; }
    }
    // No DBConfig on this model ⇒ no SCP runtime ⇒ the v1 branch runs.
    expect((RawModel as unknown as { _getScpRuntime(): unknown })._getScpRuntime()).toBeNull();
    return { RawModel, reader, writer };
  }

  it.each(WRITES)('sends %s to the writer once, never to the reader, and does not re-send it', async (sql) => {
    const { RawModel, reader, writer } = makeModel();
    await expect(RawModel.execute(sql)).rejects.toThrow('Connection terminated unexpectedly');
    expect(reader).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it.each(READS)('sends %s to the reader and re-sends it once on a probed connection after a connection error', async (sql) => {
    const { RawModel, reader, writer } = makeModel();
    await RawModel.execute(sql);
    expect(sentSql(reader).map((s) => s.replace(/\$\d+/g, '?'))).toEqual([sql, 'SELECT 1', sql]);
    expect(writer).not.toHaveBeenCalled();
  });

  it.each(FUNCTION_READS)('sends %s to the reader once and does not re-send it', async (sql) => {
    const { RawModel, reader, writer } = makeModel();
    await expect(RawModel.execute(sql)).rejects.toThrow('Connection terminated unexpectedly');
    expect(reader).toHaveBeenCalledTimes(1);
    expect(writer).not.toHaveBeenCalled();
  });
});

describe('DBModel.execute routing on the SCP route', () => {
  function makePool() {
    const log: string[] = [];
    const conn: AsyncConnection = {
      async execute(sql) { log.push(sql); return []; },
      async run(sql) { log.push(sql); return { changes: 0, lastInsertRowid: 0 }; },
    };
    const pool: AsyncConnectionPool = { async acquire() { return conn; }, async release() {} };
    return { pool, log };
  }

  function makeModel() {
    const reader = makePool();
    const writer = makePool();
    const registry = ConnectionRegistry.fromDefault({ reader: reader.pool, writer: writer.pool }).build();
    const ctx = new PooledAsyncContext({ registry, sticky: new WriterStickyClock({ useWriterAfterTransaction: false }) });
    class ScpModel extends DBModel {
      protected static _getScpRuntime() {
        return { ctx, dialect: 'postgres', close: async () => {} } as never;
      }
    }
    return { ScpModel, reader: reader.log, writer: writer.log };
  }

  it.each(WRITES)('sends %s to the writer, never to the reader', async (sql) => {
    const { ScpModel, reader, writer } = makeModel();
    await ScpModel.execute(sql);
    expect(reader).toEqual([]);
    expect(writer).toHaveLength(1);
  });

  it.each([...READS, ...FUNCTION_READS])('sends %s to the reader', async (sql) => {
    const { ScpModel, reader, writer } = makeModel();
    await ScpModel.execute(sql);
    expect(reader).toHaveLength(1);
    expect(writer).toEqual([]);
  });
});
