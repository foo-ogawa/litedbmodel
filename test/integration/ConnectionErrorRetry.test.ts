/**
 * Connection-error retry against live PostgreSQL (:5433).
 *
 * Requires live PG. Bring up: `npm run docker:up`.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { DBModel } from '../../src';
import { pgConfig, skipIntegrationTests } from '../helpers/setup';

const adminConfig = { host: pgConfig.host, port: pgConfig.port, database: pgConfig.database, user: pgConfig.user, password: pgConfig.password };

/**
 * #380 — a REAL `pg_terminate_backend` on the transaction's own connection: the server answers the
 * statement in flight with `FATAL 57P01 terminating connection due to administrator command` and closes
 * the connection — what a restart or a failover sends. That is a connection error, so `transaction()`
 * retries on another connection and commits once.
 */
describe.skipIf(skipIntegrationTests)('a transaction whose connection the server terminates (57P01, live PG)', () => {
  const TBL = `cer_admin_shutdown_${process.pid}`;
  let admin: Client;
  const Base = DBModel.createDBBase(pgConfig);

  beforeAll(async () => {
    admin = new Client(adminConfig);
    await admin.connect();
    await admin.query(`DROP TABLE IF EXISTS ${TBL}`);
    await admin.query(`CREATE TABLE ${TBL} (id serial PRIMARY KEY, label text NOT NULL)`);
  });

  afterAll(async () => {
    await admin?.query(`DROP TABLE IF EXISTS ${TBL}`);
    await admin?.end();
  });

  it('retries transaction() after 57P01 and commits once', async () => {
    let attempts = 0;
    await Base.transaction(async () => {
      attempts++;
      if (attempts === 1) {
        const { rows } = await Base.execute('SELECT pg_backend_pid() AS id');
        // Terminate this connection while a statement is in flight on it.
        const kill = new Promise((resolve) => setTimeout(resolve, 200))
          .then(() => admin.query('SELECT pg_terminate_backend($1)', [Number(rows[0].id)]));
        await Promise.all([Base.execute('SELECT pg_sleep(5)'), kill]);
      }
      await Base.execute(`INSERT INTO ${TBL} (label) VALUES (?)`, ['after-admin-shutdown']);
    }, { retryDuration: 1 });
    expect(attempts).toBe(2);
    expect(Number((await admin.query(`SELECT count(*) AS n FROM ${TBL}`)).rows[0].n)).toBe(1);
  });
});
