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
import type { ColumnsOf } from '../../src';
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
/** The DBModel-backed tables (a model's table name is fixed when the class is declared). */
const JOBS = `scp_myret_jobs_${process.pid}`;
const ACCTS = `scp_myret_accts_${process.pid}`;

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
  await raw?.query(`DROP TABLE IF EXISTS ${ACCTS}`);
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

  // mysql2 opens every connection with CLIENT_FOUND_ROWS (as sqlx does): a no-op conflict and an insert
  // both report 1 affected row, so the client-keyed insert-or-ignore is decided by its PK lock instead.
  it('client-supplied key on a CLIENT_FOUND_ROWS connection: an insert returns its row, a conflict returns nothing', async () => {
    await table(clientDdl);
    await raw.query(`INSERT INTO ${T} (code, owner) VALUES ('X1', 'victim')`);
    expect(plain(await returning(ignoreClient().sql, ['X2', 'mine']))).toEqual([{ code: 'X2', owner: 'mine' }]);
    expect(plain(await returning(ignoreClient().sql, ['X1', 'mine']))).toEqual([]);
  });

  it('client-supplied key, conflict on another unique key: returns nothing — neither a PK collision nor a conflict-key one', async () => {
    await table('(id VARCHAR(36) PRIMARY KEY, email VARCHAR(64) NOT NULL, owner VARCHAR(64), UNIQUE KEY uq (email))');
    await raw.query(`INSERT INTO ${T} (id, email, owner) VALUES ('u-1', 'a@x', 'victim')`);
    const op = insert({ table: T, 'values.id': { ref: ['i'] }, 'values.email': { ref: ['e'] }, 'values.owner': { ref: ['o'] }, onConflict: 'email', onConflictAction: 'ignore', returning: 'id, email, owner', pk: 'id' });
    // canonical (sorted) INSERT columns: email, id, owner
    expect(plain(await returning(op.sql, ['a@x', 'u-2', 'mine']))).toEqual([]); // the conflict key is taken
    expect(plain(await returning(op.sql, ['b@x', 'u-1', 'mine']))).toEqual([]); // the PK is taken
    expect(plain(await returning(op.sql, ['b@x', 'u-3', 'mine']))).toEqual([{ id: 'u-3', email: 'b@x', owner: 'mine' }]);
  });

  // No lock decides it: under READ COMMITTED a lock on an absent key is no gap lock, and another session
  // can insert that key between it and the write. A BEFORE INSERT trigger parks OUR insert (owner 'mine')
  // on a row another session holds, so the other session's insert of the same key lands exactly there.
  it('READ COMMITTED: another session inserting the same key meanwhile — its row is never returned', async () => {
    const gate = `${T}_gate`;
    await table(clientDdl);
    await raw.query(`DROP TABLE IF EXISTS ${gate}`);
    await raw.query(`CREATE TABLE ${gate} (id INT PRIMARY KEY)`);
    await raw.query(`INSERT INTO ${gate} (id) VALUES (1)`);
    await raw.query(
      `CREATE TRIGGER ${T}_park BEFORE INSERT ON ${T} FOR EACH ROW BEGIN ` +
        `IF NEW.owner = 'mine' THEN SELECT id INTO @scp_park FROM ${gate} WHERE id = 1 FOR UPDATE; END IF; END`,
    );
    const holder = await mysql.createConnection(MY);
    const other = await mysql.createConnection(MY);
    const c = await pool.acquire();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM ${gate} WHERE id = 1 FOR UPDATE`);
      await c.run('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED', []);
      const mine = c.execute(ignoreClient().sql, ['K1', 'mine']);
      await untilRunning(holder, 'SELECT id INTO @scp_park '); // ours: parked in its trigger, before its row
      await other.query(`INSERT INTO ${T} (code, owner) VALUES ('K1', 'victim')`); // committed
      await holder.query('COMMIT');
      expect(plain((await mine) as Record<string, unknown>[])).toEqual([]);
    } finally {
      await c.run('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ', []);
      await pool.release(c);
      await holder.end();
      await other.end();
      await raw.query(`DROP TABLE IF EXISTS ${gate}`);
    }
    const [rows] = await raw.query(`SELECT code, owner FROM ${T}`);
    expect(plain(rows as Record<string, unknown>[])).toEqual([{ code: 'K1', owner: 'victim' }]);
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
class JobModel extends DBModel {
  @column.number({ primaryKey: true }) id?: number;
  @column.text() state?: string;
}
const Job = JobModel as typeof JobModel & ColumnsOf<JobModel>;

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

@model(ACCTS)
class AcctModel extends DBModel {
  @column.number({ primaryKey: true, autoIncrement: true }) id?: number;
  @column.text() email?: string;
  @column.number() tenant_id?: number;
  @column.text() name?: string;
}
const Acct = AcctModel as typeof AcctModel & ColumnsOf<AcctModel>;

/**
 * A registered v1 middleware routes DBModel through the v1 MySQL driver (`src/drivers/mysql.ts`) — the
 * path that kept its own copies of the RETURNING emulation. It runs RETURNING writes through the same
 * executor as the SCP path, so it returns the same rows.
 */
describe('#367 the v1 MySQL driver (a v1 middleware registered) returns the rows each write wrote', () => {
  const v1 = async <R>(fn: () => Promise<R>): Promise<R> => {
    DBModel.setConfig(mysqlConfig);
    const unregister = DBModel.use(DBModel.createMiddleware({}));
    try {
      return await Middleware.run(() => DBModel.transaction(fn));
    } finally {
      unregister();
      await closeAllPools();
    }
  };
  const accts = async (...seed: [string, number, string][]) => {
    await raw.query(`DROP TABLE IF EXISTS ${ACCTS}`);
    await raw.query(`CREATE TABLE ${ACCTS} (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(64) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64), UNIQUE KEY uq (email))`);
    for (const row of seed) await raw.query(`INSERT INTO ${ACCTS} (email, tenant_id, name) VALUES (?, ?, ?)`, row);
  };
  const ids = (r: { values: unknown[][] } | null | undefined) => r!.values.map((v) => Number(v[0]));

  it('an upsert that updates an existing row returns only that row, not the id after it (another tenant\'s)', async () => {
    await accts(['a@x', 1, 'old'], ['b@x', 2, 'victim']);
    const got = await v1(() => Acct.create([[Acct.email, 'a@x'], [Acct.tenant_id, 1], [Acct.name, 'new']], { onConflict: Acct.email, onConflictUpdate: [Acct.name], returning: true }));
    expect(ids(got)).toEqual([1]);
  });

  it('a multi-row upsert returns every row it wrote, not the first alone', async () => {
    await accts(['a@x', 1, 'old'], ['b@x', 2, 'victim']);
    const got = await v1(() => Acct.createMany([
      [[Acct.email, 'a@x'], [Acct.tenant_id, 1], [Acct.name, 'new']],
      [[Acct.email, 'c@x'], [Acct.tenant_id, 1], [Acct.name, 'fresh']],
    ], { onConflict: Acct.email, onConflictUpdate: [Acct.name], returning: true }));
    expect(ids(got)).toEqual([1, 3]);
  });

  it('update({ returning }) returns the PKs it wrote, not []', async () => {
    await accts(['a@x', 1, 'x'], ['b@x', 1, 'x'], ['c@x', 2, 'x']);
    const got = await v1(() => Acct.update([[Acct.tenant_id, 1]], [[Acct.name, 'y']], { returning: true }));
    expect(ids(got)).toEqual([1, 2]);
  });

  it('delete({ returning }) returns the PKs it deleted, not []', async () => {
    await accts(['a@x', 1, 'x'], ['b@x', 2, 'x']);
    const got = await v1(() => Acct.delete([[Acct.tenant_id, 2]], { returning: true }));
    expect(ids(got)).toEqual([2]);
    const [rows] = await raw.query(`SELECT id FROM ${ACCTS} ORDER BY id`);
    expect(plain(rows as Record<string, unknown>[])).toEqual([{ id: 1 }]);
  });
});

/**
 * A batch write keys its rows through its own `JSON_TABLE` declaration (`k BIGINT PATH '$.k'`), so its
 * RETURNING must too: compared as the `JSON_UNQUOTE` string instead, a BIGINT key goes through DOUBLE,
 * and past 2^53 every neighbouring key in the same double matches — other tenants' rows.
 */
describe('#379 a batch RETURNING compares its keys the way the write did (BIGINT past 2^53)', () => {
  const K1 = 2n ** 60n + 1n;
  const K14 = 2n ** 60n + 14n;
  /**
   * Our two keys, plus 38 rows whose keys round to the same doubles (in tenant `other`; ours are tenant 1).
   * `ours` false ⇒ our two rows are not seeded (the createMany inserts them).
   */
  const seed = async (ddl: string, ours: boolean, other: number) => {
    await table(ddl);
    for (let i = 1n; i <= 40n; i++) {
      const k = 2n ** 60n + i;
      const mine = k === K1 || k === K14;
      if (mine && !ours) continue;
      await raw.query(`INSERT INTO ${T} (k, tenant_id, name) VALUES (?, ?, ?)`, [k.toString(), mine ? 1 : other, 'theirs']);
    }
  };
  const run = async (op: { sql: string; params: readonly unknown[] }) => (await returning(op.sql, [...op.params])).length;

  it('updateMany on an unindexed BIGINT key returns the 2 rows it wrote', async () => {
    await seed('(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))', true, 2);
    const recs = [{ k: K1, name: 'mine' }, { k: K14, name: 'mine' }];
    const op = compileUpdateManyBundle('UM', { tableName: T, keyColumns: ['k'], updateColumns: ['name'], records: recs, rawRecords: recs, returning: 'k, tenant_id' } as never, 'mysql').statement;
    expect(await run(op)).toBe(2);
  });

  // The key column is UNINDEXED in each, so the re-select scans the table (an index lookup would
  // compare exactly and hide the defect): an upsertMany whose rows are all new, and a createMany keyed
  // by its declared client key.
  it('upsertMany keyed by an unindexed BIGINT conflict key returns the 2 rows it wrote', async () => {
    await seed('(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))', false, 2);
    const recs = [{ k: K1, tenant_id: 1n, name: 'mine' }, { k: K14, tenant_id: 1n, name: 'mine' }];
    const op = compileCreateManyBundle('U', { tableName: T, records: recs, rawRecords: recs, onConflict: ['k'], onConflictUpdate: 'all', returning: 'k, tenant_id', pk: { columns: ['id'], autoInc: 'id' } } as never, 'mysql').transaction!.statements[0].op;
    expect(await run(op)).toBe(2);
  });

  it('createMany keyed by an unindexed client-supplied BIGINT key returns the 2 rows it wrote', async () => {
    await seed('(k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))', false, 2);
    const recs = [{ k: K1, tenant_id: 1n, name: 'mine' }, { k: K14, tenant_id: 1n, name: 'mine' }];
    const op = compileCreateManyBundle('C', { tableName: T, records: recs, rawRecords: recs, returning: 'k, tenant_id', pk: { columns: ['k'], autoInc: null } } as never, 'mysql').transaction!.statements[0].op;
    expect(await run(op)).toBe(2);
  });

  // #384: the write reads each key by its OWN rule — a declared type, else the JSON value (`v.k`), else
  // text — so the re-select must read it with the write's own expression, typed or not.
  it('updateMany on a DECLARED BIGINT key returns the 2 rows it wrote', async () => {
    await seed('(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))', true, 2);
    const recs = [{ k: K1, name: 'mine' }, { k: K14, name: 'mine' }];
    const types = (_t: string, c: string) => (c === 'k' ? 'BIGINT' : 'VARCHAR(64)');
    const op = compileUpdateManyBundle('UM', { tableName: T, keyColumns: ['k'], updateColumns: ['name'], records: recs, rawRecords: recs, returning: 'k, tenant_id' } as never, 'mysql', types).statement;
    expect(await run(op)).toBe(2);
  });

  describe('a string (UUID) key', () => {
    const U1 = '0b0d8a52-7a7e-4c43-9a8e-000000000001';
    const U2 = '0b0d8a52-7a7e-4c43-9a8e-000000000014';
    const seedText = async (ddl: string, ours: boolean) => {
      await table(ddl);
      for (let i = 1; i <= 40; i++) {
        const k = `0b0d8a52-7a7e-4c43-9a8e-${String(i).padStart(12, '0')}`;
        const mine = k === U1 || k === U2;
        if (mine && !ours) continue;
        await raw.query(`INSERT INTO ${T} (k, tenant_id, name) VALUES (?, ?, ?)`, [k, mine ? 1 : 2, 'theirs']);
      }
    };
    const ddl = '(id INT AUTO_INCREMENT PRIMARY KEY, k VARCHAR(36) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))';
    const recs = [{ k: U1, tenant_id: 1n, name: 'mine' }, { k: U2, tenant_id: 1n, name: 'mine' }];

    it('updateMany, no declared types and declared VARCHAR, returns the 2 rows it wrote', async () => {
      const um = recs.map(({ k, name }) => ({ k, name }));
      for (const types of [undefined, (_t: string, c: string) => (c === 'k' ? 'VARCHAR(36)' : 'VARCHAR(64)')]) {
        await seedText(ddl, true);
        const op = compileUpdateManyBundle('UM', { tableName: T, keyColumns: ['k'], updateColumns: ['name'], records: um, rawRecords: um, returning: 'k, tenant_id' } as never, 'mysql', types).statement;
        expect(await run(op)).toBe(2);
      }
    });

    it('upsertMany returns the 2 rows it wrote', async () => {
      await seedText(ddl, false);
      const op = compileCreateManyBundle('U', { tableName: T, records: recs, rawRecords: recs, onConflict: ['k'], onConflictUpdate: 'all', returning: 'k, tenant_id', pk: { columns: ['id'], autoInc: 'id' } } as never, 'mysql').transaction!.statements[0].op;
      expect(await run(op)).toBe(2);
    });

    it('createMany keyed by a client-supplied UUID returns the 2 rows it wrote', async () => {
      await seedText('(k VARCHAR(36) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))', false);
      const op = compileCreateManyBundle('C', { tableName: T, records: recs, rawRecords: recs, returning: 'k, tenant_id', pk: { columns: ['k'], autoInc: null } } as never, 'mysql').transaction!.statements[0].op;
      expect(await run(op)).toBe(2);
    });
  });
});
