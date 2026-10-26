/**
 * One process serving many requests at once (live PG): what each request sees must be its own.
 *
 * Every request goes through a real `node:http` server, so it runs on its own async chain exactly as
 * an application's requests do. The reader and the writer are two DIFFERENT databases with different
 * rows, so which one a read was served from is visible in the rows it returns — no pool is mocked.
 *
 *   - writer-sticky: a request (a `Middleware.run` scope) that committed reads its own row from the
 *     writer — also when the commit happened in a function it awaited, after an `await` — while
 *     requests running at the same time keep reading from the reader; outside a request scope a read
 *     after a commit goes to the reader.
 *   - middleware state: each `Middleware.run` scope (one request) has its own state; state touched
 *     before the server started (outside any scope) is not shared by the requests.
 *   - transactions running at the same time each see only their own uncommitted row.
 *   - `DBConfig.timeout` bounds the wait for a free pooled connection.
 *   - SQL texts seen once are not left behind as server-side prepared statements.
 *   - outside a transaction, `execute()` of DDL / maintenance runs on the writer, and a function that
 *     writes runs on the writer inside `transaction()`.
 *
 * Requires live PG (:5433). Bring up: `npm run docker:livedb:up`.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as http from 'node:http';
import { Client } from 'pg';
import { DBModel, Middleware, model, column, closeAllPools } from '../../src';
import { skipIntegrationTests, pgConfig } from '../helpers/setup';

const READER_DB = 'ldm_concurrent_reader';
const READER_ROW = 'reader-replica';
const readerConfig = { ...pgConfig, database: READER_DB };

@model('cr_items')
class CrItemModel extends DBModel {
  @column({ primaryKey: true }) id?: number;
  @column() label?: string;
}
const CrItem = CrItemModel.asModel();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const labels = async (): Promise<string[]> => (await CrItem.find([], { order: 'id' })).map((r) => r.label!);

async function adminQuery(database: string, sql: string): Promise<void> {
  const client = new Client({ ...pgConfig, database });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Serve `handler` over HTTP; every request body is JSON; returns the base URL and a closer. */
async function serve(handler: (path: string) => Promise<unknown>): Promise<{ get: (path: string) => Promise<any>; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    handler(req.url ?? '/').then(
      (body) => res.end(JSON.stringify({ ok: true, body })),
      (e: Error) => res.end(JSON.stringify({ ok: false, error: e.message })),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    get: (path) => fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.json()),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(skipIntegrationTests)('Concurrent requests in one process (PG)', () => {
  beforeAll(async () => {
    await adminQuery(pgConfig.database, `DROP DATABASE IF EXISTS ${READER_DB}`);
    await adminQuery(pgConfig.database, `CREATE DATABASE ${READER_DB}`);
    for (const db of [pgConfig.database, READER_DB]) {
      await adminQuery(db, 'DROP TABLE IF EXISTS cr_items');
      await adminQuery(db, 'CREATE TABLE cr_items (id SERIAL PRIMARY KEY, label TEXT NOT NULL)');
    }
    await adminQuery(READER_DB, `INSERT INTO cr_items (label) VALUES ('${READER_ROW}')`);
  });

  afterEach(async () => {
    DBModel.clearMiddlewares();
    await closeAllPools();
    await adminQuery(pgConfig.database, 'TRUNCATE cr_items RESTART IDENTITY');
  });

  afterAll(async () => {
    await adminQuery(pgConfig.database, 'DROP TABLE IF EXISTS cr_items');
    await adminQuery(pgConfig.database, `DROP DATABASE IF EXISTS ${READER_DB}`);
  });

  /** A writer request commits its row, then reads; reader requests only read, at the same time. */
  async function stickyScenario(): Promise<void> {
    DBModel.setConfig(readerConfig, { writerConfig: pgConfig, writerStickyDuration: 5000 });
    // Commits in a function the request awaits, after an `await` of its own.
    const commitAfterAwait = async (id: string) => {
      await Promise.resolve();
      await DBModel.transaction(() => CrItem.create([[CrItem.label, id]]));
    };
    const app = await serve((path) => Middleware.run(async () => {
      const [, kind, id] = path.split('/');
      if (kind === 'write-nested') {
        await commitAfterAwait(id);
        return labels();
      }
      if (kind === 'write') {
        await DBModel.transaction(() => CrItem.create([[CrItem.label, id]]));
        await sleep(30);
        return labels();
      }
      if (kind === 'write-pair') {
        // One request, two transactions at once: one commits, one rolls back.
        await Promise.all([
          DBModel.transaction(() => CrItem.create([[CrItem.label, id]])),
          DBModel.transaction(async () => {
            await CrItem.create([[CrItem.label, `${id}-rolled-back`]]);
            throw new Error('rollback');
          }).catch(() => undefined),
        ]);
        await sleep(30);
        return labels();
      }
      await sleep(60); // after the writers have committed
      return labels();
    }));
    try {
      const writers = ['w1', 'w2', 'w3', 'w4'];
      const readers = Array.from({ length: 12 }, (_, i) => `r${i}`);
      const [writeResults, pairResult, nestedResult, readResults] = await Promise.all([
        Promise.all(writers.map((id) => app.get(`/write/${id}`))),
        app.get('/write-pair/p1'),
        app.get('/write-nested/n1'),
        Promise.all(readers.map((id) => app.get(`/read/${id}`))),
      ]);
      writeResults.forEach((res, i) => {
        expect(res.ok).toBe(true);
        expect(res.body).toContain(writers[i]); // its own write, read back from the writer
        expect(res.body).not.toContain(READER_ROW);
      });
      expect(pairResult.ok).toBe(true);
      expect(pairResult.body).toContain('p1');
      expect(pairResult.body).not.toContain('p1-rolled-back');
      expect(pairResult.body).not.toContain(READER_ROW);
      expect(nestedResult.ok).toBe(true);
      expect(nestedResult.body).toContain('n1');
      expect(nestedResult.body).not.toContain(READER_ROW);
      for (const res of readResults) {
        expect(res.ok).toBe(true);
        expect(res.body).toEqual([READER_ROW]); // the reader, although other requests just committed
      }
    } finally {
      await app.close();
    }
  }

  it('writer-sticky is per request', async () => {
    await stickyScenario();
  });

  it('outside a request scope, a read after a commit goes to the reader', async () => {
    DBModel.setConfig(readerConfig, { writerConfig: pgConfig, writerStickyDuration: 5000 });
    const app = await serve(async () => {
      await DBModel.transaction(() => CrItem.create([[CrItem.label, 'no-scope']]));
      return labels();
    });
    try {
      expect((await app.get('/')).body).toEqual([READER_ROW]);
    } finally {
      await app.close();
    }
  });

  it('middleware state is per Middleware.run scope; state touched before the server is not shared', async () => {
    DBModel.setConfig(pgConfig);
    const Counter = DBModel.createMiddleware({
      state: { tag: '', queries: 0 },
      execute: async function (next, sql, params) {
        this.queries++;
        return next(sql, params);
      },
    });
    DBModel.use(Counter);
    Counter.getCurrentContext().tag = 'startup'; // outside any request scope
    await CrItem.find([]);

    const app = await serve((path) => {
      // A request that opens no scope gets a fresh instance per access, never the startup one.
      if (path === '/no-scope') return Promise.resolve({ ...Counter.getCurrentContext() });
      return Middleware.run(async () => {
        const [, id, n] = path.split('/');
        Counter.getCurrentContext().tag = id;
        for (let i = 0; i < Number(n); i++) {
          await CrItem.find([]);
          await sleep(5);
        }
        return { ...Counter.getCurrentContext() };
      });
    });
    try {
      const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => app.get(`/req${n}/${n}`)));
      results.forEach((res, i) => {
        expect(res.ok).toBe(true);
        expect(res.body).toEqual({ tag: `req${i + 1}`, queries: i + 1 });
      });
      expect((await app.get('/no-scope')).body).toEqual({ tag: '', queries: 0 });
    } finally {
      await app.close();
    }
  });

  it('transactions at the same time each see only their own uncommitted row', async () => {
    DBModel.setConfig(pgConfig);
    const app = await serve((path) =>
      DBModel.transaction(async () => {
        const id = path.slice(1);
        await CrItem.create([[CrItem.label, id]]);
        const seen = await labels();
        await sleep(100); // keep every transaction open at once
        return seen;
      }),
    );
    try {
      const ids = ['t1', 't2', 't3', 't4', 't5'];
      const results = await Promise.all(ids.map((id) => app.get(`/${id}`)));
      results.forEach((res, i) => {
        expect(res.ok).toBe(true);
        expect(res.body).toEqual([ids[i]]);
      });
      expect((await labels()).sort()).toEqual([...ids].sort());
    } finally {
      await app.close();
    }
  });

  it('DBConfig.timeout bounds the wait for a free connection', async () => {
    const oneConnection = { ...pgConfig, max: 1, timeout: 1 };
    DBModel.setConfig(oneConnection, { writerConfig: oneConnection }); // transactions use the writer pool
    const holder = DBModel.transaction(async () => {
      await CrItem.create([[CrItem.label, 'holder']]);
      await sleep(2500);
    }).then(() => 'committed', (e: Error) => e.message);
    await sleep(100);
    const started = Date.now();
    await expect(DBModel.transaction(() => CrItem.create([[CrItem.label, 'waiter']]))).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await holder).toBe('committed');
  });

  it('execute(): DDL / maintenance outside a transaction and a writing function inside one run on the writer', async () => {
    // The table and the function exist only on the writer, so a statement sent to the reader fails.
    await adminQuery(pgConfig.database, 'DROP TABLE IF EXISTS cr_maint; CREATE TABLE cr_maint (id int, at timestamptz)');
    await adminQuery(pgConfig.database, "CREATE OR REPLACE FUNCTION cr_touch() RETURNS int LANGUAGE sql AS 'INSERT INTO cr_maint VALUES (1, now()) RETURNING 1'");
    try {
      DBModel.setConfig(readerConfig, { writerConfig: pgConfig });
      await DBModel.execute('VACUUM ANALYZE cr_maint');
      await DBModel.execute('CREATE INDEX CONCURRENTLY cr_maint_at ON cr_maint(at)');
      await DBModel.transaction(() => DBModel.execute('SELECT cr_touch()'));
    } finally {
      await adminQuery(pgConfig.database, 'DROP TABLE IF EXISTS cr_maint; DROP FUNCTION IF EXISTS cr_touch()');
    }
  });

  it('a SQL text seen once does not leave a server-side prepared statement behind', async () => {
    DBModel.setConfig({ ...pgConfig, max: 1 });
    for (let i = 0; i < 50; i++) await DBModel.execute(`SELECT ${i}::int AS n`);
    const once = await DBModel.execute('SELECT count(*)::int AS n FROM pg_prepared_statements');
    expect(Number(once.rows[0].n)).toBe(0);

    await DBModel.execute('SELECT 1 AS repeated');
    await DBModel.execute('SELECT 1 AS repeated');
    const twice = await DBModel.execute('SELECT name FROM pg_prepared_statements');
    expect(twice.rows).toHaveLength(1);
  });
});
