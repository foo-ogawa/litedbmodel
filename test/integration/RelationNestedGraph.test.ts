/**
 * #150 — a relation op's nested children must be TYPED and POPULATED, end-to-end.
 *
 * The regression this pins: the `group` leaf used to declare its output as an EMPTY `{obj:{}}` and the
 * relation terminal was recorded with no result type, so a component's `outputType` came out as
 * `{arr:{obj:{}}}`. Typed-native codegen then generated an EMPTY struct and returned rows whose nested
 * child list carried no fields. ROW COUNTS were always correct — which is exactly why the defect
 * survived every test that only counted rows. This test therefore asserts the CHILD FIELDS.
 *
 * Under the bc 0.11.2 authoring model the defect is structurally impossible: the endpoint DECLARES its
 * return type (`UserWithPosts[]` with `posts: PostRow[]`), and bc derives the terminal `outType` from
 * that declaration. The test proves it rather than asserting the claim:
 *
 *   authored TS (`./authored/relation-model.ts`, importing the library's ONE `@leaf static` catalog)
 *     → `bc generate --lang typescript-native`   (the real CLI, no litedbmodel code in the path)
 *     → `bindTypedAsync(leafHandlersAsync(ctx))` (the library's leaf handler map — the ONLY wiring)
 *     → LIVE PostgreSQL
 *
 * It also gates the whole new seam: TS authoring + leaf nodes → BC compiles → wiring is automatic, and
 * the only per-language hand-wiring is this harness calling the generated method.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { PooledAsyncContext } from '../../src/scp/exec-context';
import { pgConnectionPool } from '../../src/scp/makesql/pool-executor';
import { leafHandlersAsync } from '../../src/scp/leaves';

const PG = {
  host: process.env.TEST_DB_HOST || 'localhost',
  port: parseInt(process.env.TEST_DB_PORT || '5433', 10),
  database: process.env.TEST_DB_NAME || 'testdb',
  user: process.env.TEST_DB_USER || 'testuser',
  password: process.env.TEST_DB_PASSWORD || 'testpass',
};

const ROOT = resolve(__dirname, '../..');
const AUTHORED = resolve(__dirname, 'authored/relation-model.ts');

/** The declared shape the generated module materializes — the assertion target. */
interface PostRow { id: number; title: string | null; author_id: number | null }
interface UserWithPosts { id: number; name: string | null; posts: PostRow[] }

let pool: Pool;
let outDir: string;
let usersWithPosts: () => Promise<UserWithPosts[]>;

describe('#150 relation nested graph — declared child type, populated children (live Postgres)', () => {
  beforeAll(async () => {
    // GENERATE from the authored source with bc's own CLI. Generating here (rather than committing a
    // module) makes drift impossible: the module under test is always what today's authoring lowers to.
    outDir = mkdtempSync(join(tmpdir(), 'lm-relation-'));
    const out = join(outDir, 'relation-generated.ts');
    execFileSync(
      join(ROOT, 'node_modules/.bin/bc'),
      ['generate', '--lang', 'typescript-native', '--from', AUTHORED, '--behavior', 'Rel', '--out', out],
      { cwd: ROOT, stdio: 'pipe' },
    );
    const generated = (await import(out)) as { bindTypedAsync: (h: ReturnType<typeof leafHandlersAsync>) => { usersWithPosts: () => Promise<UserWithPosts[]> } };

    pool = new Pool(PG);
    await pool.query('DROP TABLE IF EXISTS p150_posts; DROP TABLE IF EXISTS p150_users');
    await pool.query('CREATE TABLE p150_users (id INT PRIMARY KEY, name TEXT)');
    await pool.query('CREATE TABLE p150_posts (id INT PRIMARY KEY, title TEXT, author_id INT)');
    await pool.query("INSERT INTO p150_users VALUES (1,'Ada'),(2,'Bob')");
    await pool.query("INSERT INTO p150_posts VALUES (10,'a1',1),(11,'a2',1),(12,'b1',2)");

    // The ONE piece of hand-wiring: bind the library's leaf transports to the generated module.
    const execAsync = new PooledAsyncContext(pgConnectionPool(pool as never));
    usersWithPosts = generated.bindTypedAsync(leafHandlersAsync({ execAsync, dialect: 'postgres' })).usersWithPosts;
  }, 60_000);

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.query('DROP TABLE IF EXISTS p150_posts; DROP TABLE IF EXISTS p150_users');
      await pool.end();
    }
    if (outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
  });

  it('nests the children under each parent with their REAL FIELDS (not an empty struct)', async () => {
    const rows = await usersWithPosts();

    // Row counts — the part that was ALWAYS right, kept so a shape change is still caught.
    expect(rows.map((u) => u.id)).toEqual([1, 2]);
    expect(rows.map((u) => u.posts.length)).toEqual([2, 1]);

    // The #150 assertion: every nested child carries its declared fields with real values.
    expect(rows[0].posts).toEqual([
      { id: 10, title: 'a1', author_id: 1 },
      { id: 11, title: 'a2', author_id: 1 },
    ]);
    expect(rows[1].posts).toEqual([{ id: 12, title: 'b1', author_id: 2 }]);

    // Fail loudly on the exact old symptom — a child object with no keys.
    for (const u of rows) for (const p of u.posts) expect(Object.keys(p).sort()).toEqual(['author_id', 'id', 'title']);
  });
});
