/**
 * Retry after a connection error, on LIVE PG (:5433) and MySQL (:3307).
 *
 * 1. The v1 branch (`DBModel.execute` → `DBHandler` → the driver's `execute`) re-sends a statement after a
 *    connection error only when `isResendableStatement` allows it (read-only, calls no function). The
 *    connection is dropped by a loopback TCP proxy AFTER the server sent ReadyForQuery for the statement —
 *    the autocommit statement has committed, the client never sees the answer. A SELECT that calls a
 *    writing function then runs once (one ledger row), a plain SELECT is re-sent and answers.
 *
 * 2. A retry after a connection error runs only on a connection that passed a `SELECT 1` probe. Every
 *    connection of a pool is killed by an admin connection (pg_terminate_backend / KILL, by the ids of that
 *    pool's own connections) while a loopback proxy keeps the client sockets open, as a load balancer or a
 *    failover does: the pool still holds them and learns they are dead only by using them. The v1 re-send,
 *    the v1 `transaction()` retry and the SCP `withTransactionAsync` retry then succeed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'node:net';
import { Client, Pool as PgPool } from 'pg';
import mysql from 'mysql2/promise';
import { DBModel, getTransactionConnection } from '../../src/DBModel';
import { DBHandler } from '../../src/DBHandler';
import type { Logger } from '../../src/drivers/types';
import { closeAllPools, PostgresDriver } from '../../src/drivers/postgres';
import { MysqlDriver } from '../../src/drivers/mysql';
import { PooledAsyncContext, pgConnectionPool, mysqlConnectionPool, withTransactionAsync, runAsync } from '../../src/scp';
import { pgConfig, mysqlConfig, skipIntegrationTests } from '../helpers/setup';

const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const LEDGER = `cer_ledger_${process.pid}`;
const CHARGE = `cer_charge_${process.pid}`;

/**
 * A loopback proxy in front of PG. When armed with `marker`, the first client connection whose bytes
 * contain it gets nothing back once the server has sent ReadyForQuery ('Z') — both sockets are destroyed
 * then, i.e. after the statement completed (and, in autocommit, committed) on the server.
 */
async function dropAfterCommitProxy(): Promise<{ port: number; arm: (marker: string) => void; drops: () => number; close: () => Promise<void> }> {
  let marker: string | null = null;
  let drops = 0;
  const server = net.createServer((client) => {
    const upstream = net.connect(pgConfig.port!, pgConfig.host);
    let target = false;
    let buf = Buffer.alloc(0);
    client.on('data', (d) => {
      if (marker !== null && d.includes(marker)) { target = true; marker = null; }
      upstream.write(d);
    });
    upstream.on('data', (d) => {
      if (!target) { client.write(d); return; }
      buf = Buffer.concat([buf, d]);
      for (let off = 0; off + 5 <= buf.length;) {
        const len = buf.readInt32BE(off + 1);
        if (off + 1 + len > buf.length) break;
        if (buf[off] === 0x5a /* 'Z' */) { drops++; client.destroy(); upstream.destroy(); return; }
        off += 1 + len;
      }
    });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    arm: (m) => { marker = m; },
    drops: () => drops,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(skipIntegrationTests)('v1 re-send after a connection error (live PG)', () => {
  let admin: Client;
  let proxy: Awaited<ReturnType<typeof dropAfterCommitProxy>>;
  let Model: typeof DBModel;

  beforeAll(async () => {
    admin = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password });
    await admin.connect();
    await admin.query(`DROP FUNCTION IF EXISTS ${CHARGE}(int)`);
    await admin.query(`DROP TABLE IF EXISTS ${LEDGER}`);
    await admin.query(`CREATE TABLE ${LEDGER} (id serial PRIMARY KEY, amount int NOT NULL)`);
    await admin.query(`CREATE FUNCTION ${CHARGE}(a int) RETURNS int LANGUAGE sql VOLATILE AS $$ INSERT INTO ${LEDGER}(amount) VALUES (a) RETURNING id $$`);
    proxy = await dropAfterCommitProxy();
    const handler = new DBHandler({ ...pgConfig, port: proxy.port, host: '127.0.0.1', driver: 'postgres' }, { logger: silentLogger });
    // No DBConfig on this model ⇒ no SCP runtime ⇒ the v1 branch runs.
    Model = class extends DBModel {
      protected static getHandler() { return handler; }
    };
  });

  afterAll(async () => {
    await closeAllPools();
    await proxy?.close();
    await admin?.query(`DROP FUNCTION IF EXISTS ${CHARGE}(int)`);
    await admin?.query(`DROP TABLE IF EXISTS ${LEDGER}`);
    await admin?.end();
  });

  it('runs a SELECT that calls a writing function once when the connection drops after the commit', async () => {
    await admin.query(`TRUNCATE ${LEDGER} RESTART IDENTITY`);
    proxy.arm(CHARGE);
    await expect(Model.execute(`SELECT ${CHARGE}(?) AS id`, [100])).rejects.toThrow();
    expect(proxy.drops()).toBe(1);
    const { rows } = await admin.query(`SELECT amount FROM ${LEDGER}`);
    expect(rows.map((r) => Number(r.amount))).toEqual([100]);
  });

  it('re-sends a plain SELECT when the connection drops after the server answered', async () => {
    await admin.query(`TRUNCATE ${LEDGER} RESTART IDENTITY`);
    await admin.query(`INSERT INTO ${LEDGER} (amount) VALUES (7)`);
    const before = proxy.drops();
    proxy.arm(LEDGER);
    const { rows } = await Model.execute(`SELECT amount FROM ${LEDGER} WHERE id = ?`, [1]);
    expect(proxy.drops()).toBe(before + 1);
    expect(rows.map((r) => Number(r.amount))).toEqual([7]);
  });
});

/**
 * A loopback proxy whose `stale()` turns every connection open at that moment into a dead one the client
 * cannot see: nothing more is forwarded to the client (not the server's goodbye either), and the client's
 * next write closes its socket — the connection error a pool meets on a connection that died under it.
 * Connections opened after `stale()` are forwarded normally.
 */
async function staleProxy(host: string, port: number): Promise<{ port: number; stale: () => void; close: () => Promise<void> }> {
  const open = new Set<{ dead: boolean; client: net.Socket; upstream: net.Socket }>();
  const server = net.createServer((client) => {
    const upstream = net.connect(port, host);
    const pair = { dead: false, client, upstream };
    open.add(pair);
    client.on('data', (d) => {
      if (pair.dead) { client.destroy(); upstream.destroy(); } else upstream.write(d);
    });
    upstream.on('data', (d) => { if (!pair.dead) client.write(d); });
    const drop = (): void => {
      open.delete(pair);
      upstream.destroy();
      client.destroy();
    };
    client.on('close', drop);
    client.on('error', drop);
    upstream.on('error', () => { if (!pair.dead) drop(); });
    upstream.on('close', () => { if (!pair.dead) drop(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    stale: () => { for (const pair of open) pair.dead = true; },
    close: async () => {
      for (const pair of open) { pair.client.destroy(); pair.upstream.destroy(); }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Check out `n` connections at once, read each one's server-side id, and return them all to the pool. */
async function idsOf<C>(n: number, acquire: () => Promise<C>, id: (c: C) => Promise<number>, release: (c: C) => void): Promise<number[]> {
  const conns = await Promise.all(Array.from({ length: n }, acquire));
  const ids = await Promise.all(conns.map(id));
  conns.forEach(release);
  return ids;
}

const pgId = async (c: { query(sql: string): Promise<{ rows: Array<{ id: unknown }> }> }): Promise<number> =>
  Number((await c.query('SELECT pg_backend_pid() AS id')).rows[0].id);
const mysqlId = async (c: { query(sql: string): Promise<[unknown, unknown]> }): Promise<number> =>
  Number(((await c.query('SELECT CONNECTION_ID() AS id'))[0] as Array<{ id: unknown }>)[0].id);

const POOL_SIZE = 3; // = the default retryLimit: every connection the pool holds is dead after the kill

describe.skipIf(skipIntegrationTests)('a retry after the pool\'s connections were killed (live PG + MySQL)', () => {
  const TBL = `cer_tx_${process.pid}`;
  let pgAdmin: Client;
  let myAdmin: mysql.Connection;

  beforeAll(async () => {
    pgAdmin = new Client({ host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password });
    await pgAdmin.connect();
    await pgAdmin.query(`DROP TABLE IF EXISTS ${TBL}`);
    await pgAdmin.query(`CREATE TABLE ${TBL} (id serial PRIMARY KEY, label text NOT NULL)`);
    myAdmin = await mysql.createConnection({ host: mysqlConfig.host, port: mysqlConfig.port, database: mysqlConfig.database, user: mysqlConfig.user, password: mysqlConfig.password });
    await myAdmin.query(`DROP TABLE IF EXISTS ${TBL}`);
    await myAdmin.query(`CREATE TABLE ${TBL} (id int AUTO_INCREMENT PRIMARY KEY, label varchar(32) NOT NULL)`);
  });

  afterAll(async () => {
    await pgAdmin?.query(`DROP TABLE IF EXISTS ${TBL}`);
    await pgAdmin?.end();
    await myAdmin?.query(`DROP TABLE IF EXISTS ${TBL}`);
    await myAdmin?.end();
  });

  const killPg = async (ids: number[]): Promise<void> => {
    await pgAdmin.query('SELECT pg_terminate_backend(p) FROM unnest($1::int[]) AS p', [ids]);
  };
  const killMysql = async (ids: number[]): Promise<void> => {
    for (const id of ids) await myAdmin.query(`KILL ${id}`);
  };
  const pgRows = async (label: string): Promise<number> =>
    Number((await pgAdmin.query(`SELECT count(*) AS n FROM ${TBL} WHERE label = $1`, [label])).rows[0].n);
  const mysqlRows = async (label: string): Promise<number> =>
    Number(((await myAdmin.query(`SELECT count(*) AS n FROM ${TBL} WHERE label = ?`, [label]))[0] as Array<{ n: unknown }>)[0].n);

  describe.each([
    {
      name: 'postgres',
      upstream: () => ({ host: pgConfig.host!, port: pgConfig.port! }),
      config: (port: number) => ({ ...pgConfig, host: '127.0.0.1', port, max: POOL_SIZE, driver: 'postgres' as const }),
      ids: (handler: DBHandler) => {
        const pool = (handler.getDriver() as PostgresDriver).getPool();
        return idsOf(POOL_SIZE, () => pool.connect(), pgId, (c) => c.release());
      },
      kill: (ids: number[]) => killPg(ids),
      rows: (label: string) => pgRows(label),
      insert: `INSERT INTO ${TBL} (label) VALUES ($1)`,
    },
    {
      name: 'mysql',
      upstream: () => ({ host: mysqlConfig.host!, port: mysqlConfig.port! }),
      config: (port: number) => ({ ...mysqlConfig, host: '127.0.0.1', port, max: POOL_SIZE, driver: 'mysql' as const }),
      ids: (handler: DBHandler) => {
        const pool = (handler.getDriver() as MysqlDriver).getPool() as unknown as mysql.Pool;
        return idsOf(POOL_SIZE, () => pool.getConnection(), mysqlId, (c) => c.release());
      },
      kill: (ids: number[]) => killMysql(ids),
      rows: (label: string) => mysqlRows(label),
      insert: `INSERT INTO ${TBL} (label) VALUES (?)`,
    },
  ])('v1 branch ($name)', ({ name, upstream, config, ids, kill, rows, insert }) => {
    /** A v1 model on a fresh pool behind a stale proxy, every connection of that pool killed. */
    async function killedPool() {
      const { host, port } = upstream();
      const proxy = await staleProxy(host, port);
      const handler = new DBHandler(config(proxy.port), { logger: silentLogger });
      const killed = await ids(handler);
      proxy.stale();
      await kill(killed);
      const KilledModel = class extends DBModel {
        protected static getHandler() { return handler; }
      };
      return { proxy, handler, KilledModel };
    }

    it('re-sends a read on a live connection', async () => {
      const { proxy, handler, KilledModel } = await killedPool();
      try {
        const { rows: got } = await KilledModel.execute('SELECT 1 AS n');
        expect(got.map((r) => Number(r.n))).toEqual([1]);
      } finally {
        await handler.close();
        await proxy.close();
      }
    });

    it('retries transaction() on a live connection and commits once', async () => {
      const { proxy, handler, KilledModel } = await killedPool();
      const label = `v1-${name}`;
      try {
        await KilledModel.transaction(async () => {
          await getTransactionConnection()!.query(insert, [label]);
        }, { retryDuration: 1 });
        expect(await rows(label)).toBe(1);
      } finally {
        await handler.close();
        await proxy.close();
      }
    });
  });

  it('SCP withTransactionAsync (postgres) retries on a live connection and commits once', async () => {
    const proxy = await staleProxy(pgConfig.host!, pgConfig.port!);
    const pool = new PgPool({ host: '127.0.0.1', port: proxy.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password, max: POOL_SIZE });
    pool.on('error', () => undefined);
    try {
      const killed = await idsOf(POOL_SIZE, () => pool.connect(), pgId, (c) => c.release());
      proxy.stale();
      await killPg(killed);
      await withTransactionAsync(new PooledAsyncContext(pgConnectionPool(pool as never)), async (tx) => {
        await runAsync(tx, `INSERT INTO ${TBL} (label) VALUES ($1)`, ['scp-postgres']);
      }, { retryDuration: 1 }, 'postgres');
      expect(await pgRows('scp-postgres')).toBe(1);
    } finally {
      await pool.end().catch(() => undefined);
      await proxy.close();
    }
  });

  it('SCP withTransactionAsync (mysql) retries on a live connection and commits once', async () => {
    const proxy = await staleProxy(mysqlConfig.host!, mysqlConfig.port!);
    const pool = mysql.createPool({ host: '127.0.0.1', port: proxy.port, database: mysqlConfig.database, user: mysqlConfig.user, password: mysqlConfig.password, connectionLimit: POOL_SIZE });
    try {
      const killed = await idsOf(POOL_SIZE, () => pool.getConnection(), mysqlId, (c) => c.release());
      proxy.stale();
      await killMysql(killed);
      await withTransactionAsync(new PooledAsyncContext(mysqlConnectionPool(pool as never)), async (tx) => {
        await runAsync(tx, `INSERT INTO ${TBL} (label) VALUES (?)`, ['scp-mysql']);
      }, { retryDuration: 1 }, 'mysql');
      expect(await mysqlRows('scp-mysql')).toBe(1);
    } finally {
      await pool.end().catch(() => undefined);
      await proxy.close();
    }
  });
});
