/**
 * Retry after a connection error, on LIVE PG (:5433).
 *
 * The v1 branch (`DBModel.execute` → `DBHandler` → the driver's `execute`) re-sends a statement after a
 * connection error only when `isResendableStatement` allows it (read-only, calls no function). The
 * connection is dropped by a loopback TCP proxy AFTER the server sent ReadyForQuery for the statement —
 * the autocommit statement has committed, the client never sees the answer. A SELECT that calls a
 * writing function then runs once (one ledger row), a plain SELECT is re-sent and answers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'node:net';
import { Client } from 'pg';
import { DBModel } from '../../src/DBModel';
import { DBHandler } from '../../src/DBHandler';
import type { Logger } from '../../src/drivers/types';
import { closeAllPools } from '../../src/drivers/postgres';
import { pgConfig, skipIntegrationTests } from '../helpers/setup';

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
