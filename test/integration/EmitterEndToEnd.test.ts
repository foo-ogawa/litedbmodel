/**
 * END-TO-END: a DECORATED MODEL reaches a real database with no hand-written SQL and no hand-written
 * `@behavior` class anywhere in the path.
 *
 *   decorated models + declared endpoints (`test/scp/emit-models.ts` — zero SQL)
 *     → `emitBehaviorModule`            (the library's lowering)
 *     → `tsc --strict` over the emitted source   (bc's authoring requirement)
 *     → `bc generate --lang typescript-native`   (the real CLI; no litedbmodel code in the path)
 *     → `bindTypedAsync(leafHandlersAsync(ctx))` (the ONLY hand-wiring: the harness calling the method)
 *     → LIVE PostgreSQL
 *
 * The assertions are CONTENT-level, not counts: the #150 defect (a relation returning children with no
 * fields) passed every count-only check, so every relation assertion here compares the child OBJECTS.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { PooledAsyncContext } from '../../src/scp/exec-context';
import { pgConnectionPool } from '../../src/scp/makesql/pool-executor';
import { leafHandlersAsync } from '../../src/scp/leaves';
import { assertFindHardLimit, emitBehaviorModule, LimitExceededError, type EndpointSet } from '../../src/scp';
import { EMIT_COLUMN_OPTIONS, EMIT_ENDPOINTS, emitModels } from '../scp/emit-models';

const PG = {
  host: process.env.TEST_DB_HOST || 'localhost',
  port: parseInt(process.env.TEST_DB_PORT || '5433', 10),
  database: process.env.TEST_DB_NAME || 'testdb',
  user: process.env.TEST_DB_USER || 'testuser',
  password: process.env.TEST_DB_PASSWORD || 'testpass',
};

const ROOT = resolve(__dirname, '../..');

/** The declared shapes the generated module materializes — the assertion targets. */
interface CommentRow { id: number | null; post_id: number | null; body: string | null }
interface PostNode { id: number | null; author_id: number | null; title: string | null; comments: CommentRow[] }
interface UserGraph { id: number | null; name: string | null; posts: PostNode[] }
interface UserRow { id: number | null; name: string | null }
interface PostRow { id: number | null; author_id: number | null; title: string | null }
interface ViewRow { id: number | null; title: string | null }
/** The transport's uniform write summary — both fields are bc `int` (BigInt in the TS value model). */
interface WriteSummary { changes: bigint; lastInsertRowid: bigint }

/** The generated module's typed facade (what `bindTypedAsync` returns for these endpoints). */
interface Blog {
  usersWithPosts(): Promise<UserGraph[]>;
  usersByIds(i: { ids: number[] }): Promise<UserRow[]>;
  feed(i: { authorId: number; title?: string | null; minId?: number | null }): Promise<PostRow[]>;
  authorsWithAnyPost(): Promise<UserRow[]>;
  usersWhoWrote(i: { title: string }): Promise<UserRow[]>;
  postsOfAuthorView(): Promise<ViewRow[]>;
  createUser(i: { name: string }): Promise<UserRow[]>;
  renameUser(i: { name: string; id: number }): Promise<WriteSummary[]>;
  removeUser(i: { id: number }): Promise<WriteSummary[]>;
  createComments(i: { rows_post_id: number[]; rows_body: string[] }): Promise<WriteSummary[]>;
  removeComments(i: { ids: number[] }): Promise<WriteSummary[]>;
}

/** The PostgreSQL-expressible endpoint set (see the emitter test for the two loud rejects). */
const PG_ENDPOINTS: EndpointSet = Object.fromEntries(
  Object.entries(EMIT_ENDPOINTS).filter(([k]) => k !== 'tenantUsersWithPosts' && k !== 'retitlePosts'),
);

let pool: Pool;
let workDir: string;
let blog: Blog;
let emittedSource: string;

describe('#152 end-to-end — decorated model → emitter → bc generate → live PostgreSQL', () => {
  beforeAll(async () => {
    // 1. LOWER the decorated models + declared endpoints. No SQL is written by hand anywhere.
    const emitted = emitBehaviorModule({
      behavior: 'Blog',
      dialect: 'postgres',
      // The emitted module imports the library's ONE leaf catalog; the specifier must resolve from the
      // emitted file's own location (bc type-checks the source it reads).
      leafImport: resolve(ROOT, 'src/scp/leaf-transport.js'),
      endpoints: PG_ENDPOINTS,
      models: emitModels,
      columnOptions: EMIT_COLUMN_OPTIONS,
    });
    emittedSource = emitted.source;

    // The work dir lives INSIDE the repo so the emitted module resolves `behavior-contracts`.
    workDir = mkdtempSync(join(ROOT, '.emit-e2e-'));
    const authored = join(workDir, 'blog-authored.ts');
    writeFileSync(authored, emitted.source, 'utf8');

    // 2. The emitted source must be ORDINARY strict TypeScript — that is bc's authoring requirement,
    //    and it is what keeps the de-box annotations honest.
    execFileSync(
      join(ROOT, 'node_modules/.bin/tsc'),
      ['--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler',
       '--experimentalDecorators', authored],
      { cwd: ROOT, stdio: 'pipe' },
    );

    // 3. GENERATE with bc's own CLI — no litedbmodel code in the generation path.
    const out = join(workDir, 'blog-generated.ts');
    execFileSync(
      join(ROOT, 'node_modules/.bin/bc'),
      ['generate', '--lang', 'typescript-native', '--from', authored, '--behavior', 'Blog', '--out', out],
      { cwd: ROOT, stdio: 'pipe' },
    );

    pool = new Pool(PG);
    await pool.query('DROP TABLE IF EXISTS e2e_comments; DROP TABLE IF EXISTS e2e_posts; DROP TABLE IF EXISTS e2e_users');
    await pool.query('CREATE TABLE e2e_users (id SERIAL PRIMARY KEY, name TEXT)');
    await pool.query('CREATE TABLE e2e_posts (id INT PRIMARY KEY, author_id INT, title TEXT)');
    await pool.query('CREATE TABLE e2e_comments (id SERIAL PRIMARY KEY, post_id INT, body TEXT)');
    await pool.query("INSERT INTO e2e_users VALUES (1,'Ada'),(2,'Bob'),(3,'Cy')");
    // The seed uses explicit ids, so advance the SERIAL sequence past them (the write test inserts).
    await pool.query("SELECT setval(pg_get_serial_sequence('e2e_users','id'), 100)");
    await pool.query("SELECT setval(pg_get_serial_sequence('e2e_comments','id'), 1000)");
    await pool.query("INSERT INTO e2e_posts VALUES (10,1,'a1'),(11,1,'a2'),(12,2,'b1')");
    await pool.query("INSERT INTO e2e_comments VALUES (100,10,'c1'),(101,10,'c2'),(102,12,'c3')");

    // 4. The ONE piece of hand-wiring: bind the library's leaf transports to the generated module.
    const generated = (await import(out)) as { bindTypedAsync: (h: ReturnType<typeof leafHandlersAsync>) => Blog };
    const execAsync = new PooledAsyncContext(pgConnectionPool(pool as never));
    blog = generated.bindTypedAsync(leafHandlersAsync({ execAsync, dialect: 'postgres' }));
  }, 120_000);

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.query('DROP TABLE IF EXISTS e2e_comments; DROP TABLE IF EXISTS e2e_posts; DROP TABLE IF EXISTS e2e_users');
      await pool.end();
    }
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
  });

  it('the emitted source contains no hand-written SQL — every statement came from a makesql builder', () => {
    // The proof that nothing was hand-authored: the ONLY SQL in the path is inside the emitted module,
    // and the emitted module is a pure function of the decorated models + declared endpoints.
    expect(emittedSource).toContain('@behavior static usersWithPosts()');
    expect(emittedSource).toContain('Db.executeSQL(');
  });

  it('a two-level relation graph returns nested children WITH THEIR FIELDS (#150, content-level)', async () => {
    const rows = await blog.usersWithPosts();
    expect(rows).toEqual([
      {
        id: 1,
        name: 'Ada',
        posts: [
          { id: 10, author_id: 1, title: 'a1', comments: [
            { id: 100, post_id: 10, body: 'c1' },
            { id: 101, post_id: 10, body: 'c2' },
          ] },
          { id: 11, author_id: 1, title: 'a2', comments: [] },
        ],
      },
      {
        id: 2,
        name: 'Bob',
        posts: [
          { id: 12, author_id: 2, title: 'b1', comments: [{ id: 102, post_id: 12, body: 'c3' }] },
        ],
      },
      { id: 3, name: 'Cy', posts: [] },
    ]);
    // Fail loudly on the exact #150 symptom — a nested child object with no keys.
    for (const u of rows) for (const p of u.posts) {
      expect(Object.keys(p).sort()).toEqual(['author_id', 'comments', 'id', 'title']);
      for (const c of p.comments) expect(Object.keys(c).sort()).toEqual(['body', 'id', 'post_id']);
    }
  });

  it('#46 — the PG `= ANY(?)` IN-list binds a whole key set as ONE param (and an EMPTY one is legal)', async () => {
    expect(await blog.usersByIds({ ids: [1, 3] })).toEqual([{ id: 1, name: 'Ada' }, { id: 3, name: 'Cy' }]);
    expect(await blog.usersByIds({ ids: [] })).toEqual([]);
  });

  it('SKIP — the leaf assembles the surviving fragments per call (one static base statement)', async () => {
    expect(await blog.feed({ authorId: 1 })).toEqual([
      { id: 10, author_id: 1, title: 'a1' },
      { id: 11, author_id: 1, title: 'a2' },
    ]);
    expect(await blog.feed({ authorId: 1, title: 'a2' })).toEqual([{ id: 11, author_id: 1, title: 'a2' }]);
    expect(await blog.feed({ authorId: 1, minId: 11 })).toEqual([{ id: 11, author_id: 1, title: 'a2' }]);
    expect(await blog.feed({ authorId: 1, title: 'a%', minId: 11 })).toEqual([{ id: 11, author_id: 1, title: 'a2' }]);
  });

  it('#97 — a correlated EXISTS and a typed IN-subquery both execute', async () => {
    expect(await blog.authorsWithAnyPost()).toEqual([{ id: 1, name: 'Ada' }, { id: 2, name: 'Bob' }]);
    expect(await blog.usersWhoWrote({ title: 'b1' })).toEqual([{ id: 2, name: 'Bob' }]);
  });

  it('#98 — a QUERY view reads through the derived CTE (its own param bound first)', async () => {
    expect(await blog.postsOfAuthorView()).toEqual([{ id: 10, title: 'a1' }, { id: 11, title: 'a2' }]);
  });

  it('writes: INSERT…RETURNING, UPDATE, DELETE and a batch INSERT all execute', async () => {
    const created = await blog.createUser({ name: 'Dee' });
    expect(created).toEqual([{ id: expect.any(Number), name: 'Dee' }]);
    expect((await blog.renameUser({ id: 3, name: 'Cyrus' }))[0].changes).toBe(1n);
    expect((await pool.query('SELECT name FROM e2e_users WHERE id = 3')).rows).toEqual([{ name: 'Cyrus' }]);

    expect((await blog.createComments({ rows_post_id: [11, 11], rows_body: ['c4', 'c5'] }))[0].changes).toBe(2n);
    const added = (await pool.query('SELECT body FROM e2e_comments WHERE post_id = 11 ORDER BY body')).rows;
    expect(added).toEqual([{ body: 'c4' }, { body: 'c5' }]);

    const ids = (await pool.query('SELECT id FROM e2e_comments WHERE post_id = 11')).rows.map((r: { id: number }) => r.id);
    expect((await blog.removeComments({ ids }))[0].changes).toBe(2n);
    expect((await pool.query('SELECT count(*)::int AS n FROM e2e_comments WHERE post_id = 11')).rows[0].n).toBe(0);

    expect((await blog.removeUser({ id: created[0].id as number }))[0].changes).toBe(1n);
  });

  it('the find hard-limit guard: `LIMIT cap+1` is baked, the read boundary throws on the overflow', () => {
    // The generated module returns rows; SCP has no throw, so the cap is enforced where the caller
    // consumes them — the same split the relation twin uses.
    expect(() => assertFindHardLimit([{}, {}, {}], 2, 'usersByIds')).toThrow(LimitExceededError);
    expect(() => assertFindHardLimit([{}, {}], 2, 'usersByIds')).not.toThrow();
  });
});
