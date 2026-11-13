/**
 * MySQL has no `RETURNING`: the SCP emulation (`src/scp/makesql/mysql-returning.ts`, run by the
 * production connection adapter `mysqlConnectionPool`) must return EXACTLY the rows the write wrote —
 * the set PG / SQLite native RETURNING returns — and fail closed where it cannot know that set.
 *
 * Every statement here is the compiler's own output (`compileWriteNode` / the batch bundles), run
 * through the shipped adapter over a real mysql2 pool. Each describe names the issue it pins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { compileWriteNode } from '../../src/scp/makesql/tx';
import { compileCreateManyBundle, compileUpdateManyBundle } from '../../src/scp/write-bundle';
import { mysqlConnectionPool, mysqlDeboxPoolOptions } from '../../src/scp/makesql/pool-executor';
import type { AsyncConnectionPool } from '../../src/scp/exec-context';

const MY = {
  host: process.env.TEST_MYSQL_HOST || 'localhost',
  port: parseInt(process.env.TEST_MYSQL_PORT || '3307', 10),
  database: process.env.TEST_MYSQL_DB || 'testdb',
  user: process.env.TEST_MYSQL_USER || 'testuser',
  password: process.env.TEST_MYSQL_PASSWORD || 'testpass',
};

/** Unique per run: other sessions share the database. */
const T = `scp_myret_${process.pid}`;

let raw: mysql.Pool;
let pool: AsyncConnectionPool;

beforeAll(async () => {
  raw = mysql.createPool({ ...MY, connectionLimit: 4, ...mysqlDeboxPoolOptions });
  await raw.query('SELECT 1'); // fail-closed: no server ⇒ the hook throws, the file never passes
  pool = mysqlConnectionPool(raw);
});

afterAll(async () => {
  await raw?.query(`DROP TABLE IF EXISTS ${T}`);
  await raw?.end();
});

/** Run one statement through the production adapter (where the RETURNING emulation lives). */
async function returning(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const c = await pool.acquire();
  try {
    return (await c.execute(sql, params)) as Record<string, unknown>[];
  } finally {
    await pool.release(c);
  }
}

async function table(ddl: string): Promise<void> {
  await raw.query(`DROP TABLE IF EXISTS ${T}`);
  await raw.query(`CREATE TABLE ${T} ${ddl}`);
}

const plain = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])));

const insert = (ports: Record<string, unknown>) => compileWriteNode({ id: 'w', component: 'Insert', ports } as never, 'mysql');

describe('#358 a composite key is matched on EVERY column, never the first alone', () => {
  const ddl = '(id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(64) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64), UNIQUE KEY uq (email, tenant_id))';

  it('upsert: returns only the caller-tenant row, not another tenant\'s row with the same email', async () => {
    await table(ddl);
    await raw.query(`INSERT INTO ${T} (email, tenant_id, name) VALUES ('a@x', 2, 'victim')`);
    const op = insert({ table: T, 'values.email': { ref: ['e'] }, 'values.tenant_id': { ref: ['t'] }, 'values.name': { ref: ['n'] }, onConflict: 'email, tenant_id', returning: 'email, tenant_id, name', pk: 'id', autoInc: 'id' });
    // canonical (sorted) INSERT columns: email, name, tenant_id
    const rows = plain(await returning(op.sql, ['a@x', 'mine', 1]));
    expect(rows).toEqual([{ email: 'a@x', tenant_id: 1, name: 'mine' }]);
  });

  it('upsertMany: returns only the payload key tuples', async () => {
    await table(ddl);
    await raw.query(`INSERT INTO ${T} (email, tenant_id, name) VALUES ('a@x', 2, 'victim')`);
    const recs = [{ email: 'a@x', tenant_id: 1, name: 'mine' }];
    const bundle = compileCreateManyBundle('U', { tableName: T, records: recs, rawRecords: recs, onConflict: ['email', 'tenant_id'], onConflictUpdate: 'all', returning: 'email, tenant_id, name', pk: { columns: ['id'], autoInc: 'id' } } as never, 'mysql');
    const op = bundle.transaction!.statements[0].op;
    const rows = plain(await returning(op.sql, [JSON.stringify(recs)]));
    expect(rows).toEqual([{ email: 'a@x', tenant_id: 1, name: 'mine' }]);
  });

  it('updateMany: a key tuple that matched no row returns nothing, not the row sharing its id', async () => {
    await table('(tenant_id INT NOT NULL, id INT NOT NULL, name VARCHAR(64), PRIMARY KEY (tenant_id, id))');
    await raw.query(`INSERT INTO ${T} (tenant_id, id, name) VALUES (2, 7, 'victim')`);
    const recs = [{ id: 7, tenant_id: 1, name: 'hijack' }];
    // ON u.id = … AND u.tenant_id = …: the victim shares the FIRST key column (id) only.
    const op = compileUpdateManyBundle('UM', { tableName: T, keyColumns: ['id', 'tenant_id'], updateColumns: ['name'], records: recs, rawRecords: recs, returning: 'tenant_id, id, name' } as never, 'mysql').statement;
    expect(plain(await returning(op.sql, [JSON.stringify(recs)]))).toEqual([]);
    expect(plain((await raw.query(`SELECT name FROM ${T}`))[0] as Record<string, unknown>[])).toEqual([{ name: 'victim' }]);
  });
});

describe('#359 an insert-or-ignore returns only the row it inserted, never the conflicting row', () => {
  const autoIncDdl = '(id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(64) NOT NULL, name VARCHAR(64), UNIQUE KEY uq (email))';
  const ignoreAutoInc = () => insert({ table: T, 'values.email': { ref: ['e'] }, 'values.name': { ref: ['n'] }, onConflict: 'email', onConflictAction: 'ignore', returning: 'email, name', pk: 'id', autoInc: 'id' });
  const clientDdl = '(code VARCHAR(16) PRIMARY KEY, owner VARCHAR(64))';
  const ignoreClient = () => insert({ table: T, 'values.code': { ref: ['c'] }, 'values.owner': { ref: ['o'] }, onConflict: 'code', onConflictAction: 'ignore', returning: 'code, owner', pk: 'code' });

  it('AUTO_INCREMENT key: a conflict returns nothing; an insert returns its own row', async () => {
    await table(autoIncDdl);
    await raw.query(`INSERT INTO ${T} (email, name) VALUES ('a@x', 'victim')`);
    expect(plain(await returning(ignoreAutoInc().sql, ['a@x', 'mine']))).toEqual([]);
    expect(plain(await returning(ignoreAutoInc().sql, ['b@x', 'mine']))).toEqual([{ email: 'b@x', name: 'mine' }]);
    expect(ignoreAutoInc().sql).toContain(';action=ignore*/');
  });

  it('client-supplied key without CLIENT_FOUND_ROWS: a conflict returns nothing; an insert returns its own row', async () => {
    const noFoundRows = mysql.createPool({ ...MY, connectionLimit: 1, flags: ['-FOUND_ROWS'], ...mysqlDeboxPoolOptions });
    try {
      const p = mysqlConnectionPool(noFoundRows);
      const run = async (sql: string, params: unknown[]) => {
        const c = await p.acquire();
        try { return plain((await c.execute(sql, params)) as Record<string, unknown>[]); } finally { await p.release(c); }
      };
      await table(clientDdl);
      await raw.query(`INSERT INTO ${T} (code, owner) VALUES ('X1', 'victim')`);
      expect(await run(ignoreClient().sql, ['X1', 'mine'])).toEqual([]);
      expect(await run(ignoreClient().sql, ['X2', 'mine'])).toEqual([{ code: 'X2', owner: 'mine' }]);
    } finally {
      await noFoundRows.end();
    }
  });

  it('client-supplied key on a CLIENT_FOUND_ROWS connection (mysql2\'s default): fails closed', async () => {
    await table(clientDdl);
    await raw.query(`INSERT INTO ${T} (code, owner) VALUES ('X1', 'victim')`);
    await expect(returning(ignoreClient().sql, ['X1', 'mine'])).rejects.toThrow(/CLIENT_FOUND_ROWS/);
  });

  it('batch (INSERT IGNORE) on a client-supplied key: rows it did not insert fail it closed', async () => {
    await table(clientDdl);
    await raw.query(`INSERT INTO ${T} (code, owner) VALUES ('X1', 'victim')`);
    const recs = [{ code: 'X1', owner: 'mine' }, { code: 'X2', owner: 'mine' }];
    const op = compileCreateManyBundle('I', { tableName: T, records: recs, rawRecords: recs, onConflict: ['code'], onConflictIgnore: true, returning: 'code, owner', pk: { columns: ['code'], autoInc: null } } as never, 'mysql').transaction!.statements[0].op;
    await expect(returning(op.sql, [JSON.stringify(recs)])).rejects.toThrow(/wrote 1 row\(s\) but its RETURNING recovery found 2/);
    const fresh = [{ code: 'X3', owner: 'mine' }];
    expect(plain(await returning(op.sql, [JSON.stringify(fresh)]))).toEqual([{ code: 'X3', owner: 'mine' }]);
    expect(op.sql).toContain(';action=ignore*/');
  });
});
