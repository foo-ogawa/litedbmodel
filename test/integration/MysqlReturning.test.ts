/**
 * MySQL has no `RETURNING`: the SCP emulation (`src/scp/makesql/mysql-returning.ts`, run by the
 * production connection adapter `mysqlConnectionPool`) must return EXACTLY the rows the write wrote —
 * the set PG / SQLite native RETURNING returns — and fail closed where it cannot know that set.
 *
 * Every statement here is the compiler's own output (`compileWriteNode` / the batch bundles), run
 * through the shipped adapter over a real mysql2 pool. Each describe names the issue it pins.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { DBModel, Middleware, model, column, closeAllPools } from '../../src';
import { mysqlConfig } from '../helpers/setup';
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
/** The DBModel-backed table (a model's table name is fixed when the class is declared). */
const JOBS = `scp_myret_jobs_${process.pid}`;

let raw: mysql.Pool;
let pool: AsyncConnectionPool;

beforeAll(async () => {
  raw = mysql.createPool({ ...MY, connectionLimit: 4, ...mysqlDeboxPoolOptions });
  await raw.query('SELECT 1'); // fail-closed: no server ⇒ the hook throws, the file never passes
  pool = mysqlConnectionPool(raw);
});

afterAll(async () => {
  await raw?.query(`DROP TABLE IF EXISTS ${T}`);
  await raw?.query(`DROP TABLE IF EXISTS ${JOBS}`);
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

/** Poll the server until a thread is running a statement that starts with one of `prefixes` (then let it block). */
async function untilRunning(c: mysql.Connection, ...prefixes: string[]): Promise<void> {
  const where = prefixes.map(() => 'INFO LIKE ?').join(' OR ');
  for (let i = 0; i < 200; i++) {
    const [rows] = await c.query(`SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE ${where}`, prefixes.map((p) => `${p}%`));
    if (Number((rows as { n: number }[])[0].n) > 0) {
      await new Promise((r) => setTimeout(r, 300)); // it is past the id allocation and waiting on the lock
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no thread ever ran '${prefixes.join("' / '")}…'`);
}

describe('#360 a bulk INSERT…RETURNING returns its own rows, not the ids another session took between them', () => {
  it('createMany interleaved with a committed foreign insert returns exactly its 4 rows', async () => {
    await table('(id INT AUTO_INCREMENT PRIMARY KEY, uk VARCHAR(32) NOT NULL, tenant_id INT NOT NULL, UNIQUE KEY uq (uk))');
    await raw.query(`INSERT INTO ${T} (uk, tenant_id) VALUES ('seed', 0)`);
    const recs = ['k1', 'k2', 'k3', 'k4'].map((uk) => ({ uk, tenant_id: 1 }));
    const op = compileCreateManyBundle('C', { tableName: T, records: recs, rawRecords: recs, returning: 'uk, tenant_id', pk: { columns: ['id'], autoInc: 'id' } } as never, 'mysql').transaction!.statements[0].op;

    // A bounded two-connection schedule: the other session holds a gap lock the bulk insert must wait
    // on, inserts its own row (taking the next id) while the bulk insert is blocked mid-way, and commits.
    const other = await mysql.createConnection(MY);
    try {
      await other.query('BEGIN');
      await other.query(`SELECT id FROM ${T} WHERE uk = 'k3' FOR UPDATE`);
      const mine = returning(op.sql, [JSON.stringify(recs)]);
      await untilRunning(other, `INSERT INTO ${T} `);
      await other.query(`INSERT INTO ${T} (uk, tenant_id) VALUES ('zz', 2)`);
      await other.query('COMMIT');
      expect(plain(await mine)).toEqual(recs);
    } finally {
      await other.end();
    }
    // The foreign row did land between the bulk insert's ids — the bare id range named it.
    const [ids] = await raw.query(`SELECT uk FROM ${T} ORDER BY id`);
    expect((ids as { uk: string }[]).map((r) => r.uk)).toEqual(['seed', 'k1', 'zz', 'k2', 'k3', 'k4']);
  });

  it('a non-concurrent createMany returns exactly its rows', async () => {
    await table('(id INT AUTO_INCREMENT PRIMARY KEY, uk VARCHAR(32) NOT NULL, tenant_id INT NOT NULL)');
    const recs = Array.from({ length: 50 }, (_, i) => ({ uk: `u${i}`, tenant_id: 1 }));
    const op = compileCreateManyBundle('C', { tableName: T, records: recs, rawRecords: recs, returning: 'uk, tenant_id', pk: { columns: ['id'], autoInc: 'id' } } as never, 'mysql').transaction!.statements[0].op;
    expect(plain(await returning(op.sql, [JSON.stringify(recs)]))).toEqual(recs);
  });
});

@model(JOBS)
class Job extends DBModel {
  @column.number({ primaryKey: true }) id?: number;
  @column.text() state?: string;
}

describe('#361 an UPDATE…RETURNING returns the rows it updated, keyed before the write', () => {
  const jobs = async (...seed: [number, string][]) => {
    await raw.query(`DROP TABLE IF EXISTS ${JOBS}`);
    await raw.query(`CREATE TABLE ${JOBS} (id INT PRIMARY KEY, state VARCHAR(16) NOT NULL)`);
    for (const [id, state] of seed) await raw.query(`INSERT INTO ${JOBS} (id, state) VALUES (?, ?)`, [id, state]);
  };

  it('a state transition (SET changes a WHERE column) returns the rows it moved', async () => {
    await jobs([1, 'open'], [2, 'open'], [3, 'done']);
    const op = compileWriteNode({ id: 'w', component: 'Update', ports: { table: JOBS, 'set.state': { ref: ['to'] }, where: { arr: [{ eq: [{ ref: ['state'] }, { ref: ['from'] }] }] }, returning: 'id, state', pk: 'id' } } as never, 'mysql');
    expect(plain(await returning(op.sql, ['claimed', 'open']))).toEqual([{ id: 1, state: 'claimed' }, { id: 2, state: 'claimed' }]);
  });

  it('DBModel.update({ returning }) does not report a row another session claimed first', async () => {
    await jobs([1, 'open'], [2, 'open']);
    DBModel.setConfig(mysqlConfig);
    const other = await mysql.createConnection(MY);
    try {
      // The other session claims row 1 and holds it; our claim runs meanwhile, then the other commits.
      await other.query('BEGIN');
      await other.query(`UPDATE ${JOBS} SET state = 'claimed' WHERE id = 1`);
      const mine = Middleware.run(() => DBModel.transaction(() => Job.update([[Job.state, 'open']], [[Job.state, 'mine']], { returning: true })));
      // Ours is blocked on row 1: at the locking key read (fixed), or at the UPDATE after an unlocked
      // pre-select (the defect).
      await untilRunning(other, `SELECT id FROM ${JOBS} `, `UPDATE ${JOBS} `);
      await other.query('COMMIT');
      const got = await mine;
      expect(got!.values.map((v) => Number(v[0]))).toEqual([2]);
    } finally {
      await other.end();
      await closeAllPools();
    }
    const [rows] = await raw.query(`SELECT id, state FROM ${JOBS} ORDER BY id`);
    expect(plain(rows as Record<string, unknown>[])).toEqual([{ id: 1, state: 'claimed' }, { id: 2, state: 'mine' }]);
  });
});

describe('#362 a DELETE…RETURNING returns only the rows it deleted', () => {
  const jobs = async (...ids: number[]) => {
    await raw.query(`DROP TABLE IF EXISTS ${JOBS}`);
    await raw.query(`CREATE TABLE ${JOBS} (id INT PRIMARY KEY, state VARCHAR(16) NOT NULL)`);
    for (const id of ids) await raw.query(`INSERT INTO ${JOBS} (id, state) VALUES (?, 'open')`, [id]);
  };
  const del = () => compileWriteNode({ id: 'w', component: 'Delete', ports: { table: JOBS, where: { arr: [{ eq: [{ ref: ['id'] }, { ref: ['id'] }] }] }, returning: 'id, state', pk: 'id' } } as never, 'mysql');

  it('a row another session deleted first (we waited on its lock) is not reported as deleted', async () => {
    await jobs(1);
    const other = await mysql.createConnection(MY);
    try {
      await other.query('BEGIN');
      await other.query(`DELETE FROM ${JOBS} WHERE id = 1`);
      const mine = returning(del().sql, [1]);
      // Ours is blocked on row 1: at the locking pre-image (fixed), or at the DELETE after an unlocked one (the defect).
      await untilRunning(other, `SELECT id, state FROM ${JOBS} `, `DELETE FROM ${JOBS} `);
      await other.query('COMMIT');
      expect(plain(await mine)).toEqual([]);
    } finally {
      await other.end();
    }
  });

  it('a row another session deleted after our snapshot is not reported as deleted', async () => {
    await jobs(8);
    const c = await pool.acquire();
    try {
      await c.run('START TRANSACTION WITH CONSISTENT SNAPSHOT', []);
      await raw.query(`DELETE FROM ${JOBS} WHERE id = 8`); // another session, committed
      expect(plain((await c.execute(del().sql, [8])) as Record<string, unknown>[])).toEqual([]);
      await c.run('COMMIT', []);
    } finally {
      await pool.release(c);
    }
  });

  it('a row it did delete is returned', async () => {
    await jobs(5);
    expect(plain(await returning(del().sql, [5]))).toEqual([{ id: 5, state: 'open' }]);
  });

  it('DBModel.delete({ returning }) does not report a row another session deleted first', async () => {
    await jobs(1);
    DBModel.setConfig(mysqlConfig);
    const other = await mysql.createConnection(MY);
    try {
      await other.query('BEGIN');
      await other.query(`DELETE FROM ${JOBS} WHERE id = 1`);
      const mine = Middleware.run(() => DBModel.transaction(() => Job.delete([[Job.id, 1]], { returning: true })));
      await untilRunning(other, `SELECT id FROM ${JOBS} `, `DELETE FROM ${JOBS} `);
      await other.query('COMMIT');
      expect((await mine)!.values).toEqual([]);
    } finally {
      await other.end();
      await closeAllPools();
    }
  });
});
