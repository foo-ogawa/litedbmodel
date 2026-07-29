/**
 * #217 — NAMED-DB ROUTING reaches the CODEGEN path, end to end, against TWO REAL DATABASES.
 *
 *   two decorated models on TWO connections (`test/scp/emit-models.ts` — zero SQL)
 *     → `emitBehaviorModule`                     (the lowering: the model's connection → `opts.db`)
 *     → `tsc --strict` over the emitted source    (bc's authoring requirement)
 *     → `bc generate --lang typescript-native`    (the real CLI)
 *     → `bindTypedAsync(leafHandlersAsync(routedCtx))`
 *     → a ROUTED PooledAsyncContext with TWO named connections registered
 *     → LIVE PostgreSQL
 *
 * ## Why two databases, and why they cannot both hold the table
 *
 * A single-DB run cannot tell a HONORED connection name from a DROPPED one — both statements reach the
 * same server and return the same rows. That is exactly why the defect survived: the conformance and
 * livedb suites are single-DB, and the named-DB tests hand-built their intents and never asked whether
 * a declaration could produce one. So this gate registers TWO connections whose reachable tables are
 * DISJOINT: `default` sees `public`, and `analytics` is a pool whose every checked-out connection runs
 * `SET search_path TO <schema>` (the shipped `ConnectionConfig.searchPath`, applied by `configuredPool`).
 * `scp217_users` exists ONLY in the analytics schema and `scp217_posts` ONLY in public, so a statement
 * that lands on the wrong connection does not return the wrong rows — it cannot see a table at all.
 * A green result is therefore unforgeable, and the RED half is measured below rather than reasoned about.
 *
 * ## The two surfaces a connection name must reach (v1 parity)
 *
 *  - a CROSS-DB RELATION — v1 `LazyRelation.ts:236` batch-loads a relation on the TARGET model's driver
 *    ("Use target model's driver type (important for multi-DB scenarios)"), so `postsWithAuthor` reads
 *    its parent page on `default` and its batched child SELECT on `analytics`;
 *  - an ENDPOINT whose OWN model is on another connection — v1 gives a model that authority through its
 *    `createDBBase` handler — so `usersOnB` (read) and `renameUserOnB` (write) run entirely there.
 *
 * Requires live PG (:5433). Bring up: `npm run docker:livedb:up`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import {
  buildRoutingConfig,
  emitBehaviorModule,
  executeAsync,
  leafHandlersAsync,
  pgPoolFactory,
  PooledAsyncContext,
  type PoolCloser,
} from '../../src/scp';
import { EMIT_COLUMN_OPTIONS, NAMED_DB, NAMED_DB_ENDPOINTS, emitModels } from '../scp/emit-models';

const PG = {
  host: process.env.TEST_DB_HOST || 'localhost',
  port: parseInt(process.env.TEST_DB_PORT || '5433', 10),
  database: process.env.TEST_DB_NAME || 'testdb',
  user: process.env.TEST_DB_USER || 'testuser',
  password: process.env.TEST_DB_PASSWORD || 'testpass',
};

/** The connection params as `ConnectionConfig` fields (what `buildRoutingConfig` takes). */
const PG_CONN = { driver: 'postgres', host: PG.host, port: PG.port, database: PG.database, user: PG.user, password: PG.password } as const;

/** The SCHEMA that IS the `analytics` database for this gate (reached only via its own connection). */
const B_SCHEMA = 'scp217_analytics';

const ROOT = resolve(__dirname, '../..');

interface UserRow { id: number | null; name: string | null }
interface PostWithAuthor { id: number | null; author_id: number | null; title: string | null; author: UserRow | null }
interface WriteSummary { changes: bigint; lastInsertRowid: bigint }

/** The generated module's typed facade for {@link NAMED_DB_ENDPOINTS}. */
interface NamedDb {
  postsWithAuthor(): Promise<PostWithAuthor[]>;
  usersOnB(): Promise<UserRow[]>;
  renameUserOnB(i: { name: string; id: number }): Promise<WriteSummary[]>;
}

let ddl: Pool;
let workDir: string;
let emittedSource: string;

/**
 * Lower → typecheck → `bc generate` → import → bind, over a ROUTED ctx with BOTH connections
 * registered. `transform` rewrites the EMITTED SOURCE before it is generated, which is how the negative
 * controls below drop or corrupt the ONE thing under test (the lowered connection name) while every
 * other link in the chain — bc, the leaf transport, the routing config, the server — stays production.
 */
async function build(transform: (source: string) => string = (s) => s): Promise<{ facade: NamedDb; close: PoolCloser }> {
  const source = transform(
    emitBehaviorModule({
      behavior: 'NamedDb',
      dialect: 'postgres',
      leafImport: resolve(ROOT, 'src/scp/leaf-transport.js'),
      endpoints: NAMED_DB_ENDPOINTS,
      models: emitModels,
      columnOptions: EMIT_COLUMN_OPTIONS,
    }).source,
  );
  // Content-addressed so a transformed source is a NEW module (never a stale ESM import-cache hit).
  const stamp = createHash('sha1').update(source).digest('hex').slice(0, 12);
  const authored = join(workDir, `named-${stamp}.authored.ts`);
  writeFileSync(authored, source, 'utf8');
  execFileSync(
    join(ROOT, 'node_modules/.bin/tsc'),
    ['--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler',
     '--experimentalDecorators', authored],
    { cwd: ROOT, stdio: 'pipe' },
  );
  const out = join(workDir, `named-${stamp}.generated.ts`);
  execFileSync(
    join(ROOT, 'node_modules/.bin/bc'),
    ['generate', '--lang', 'typescript-native', '--from', authored, '--behavior', 'NamedDb', '--out', out],
    { cwd: ROOT, stdio: 'pipe' },
  );

  // TWO named connections, each its OWN constructed pool, through the SHIPPED pg pool factory. The
  // `analytics` one carries `searchPath`, so every connection it hands out sees ONLY that schema — the
  // reason a mis-routed statement fails instead of quietly reading the other database's table.
  const built = buildRoutingConfig([
    { config: { ...PG_CONN }, poolFactory: pgPoolFactory(await import('pg')) },
    { name: NAMED_DB, config: { ...PG_CONN, searchPath: B_SCHEMA }, poolFactory: pgPoolFactory(await import('pg')) },
  ]);
  const execAsync = new PooledAsyncContext(built.routing);
  const generated = (await import(out)) as { bindTypedAsync: (h: ReturnType<typeof leafHandlersAsync>) => NamedDb };
  return { facade: generated.bindTypedAsync(leafHandlersAsync({ execAsync, dialect: 'postgres' })), close: built.close };
}

describe('#217 named-DB routing — declaration → codegen → TWO live databases', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(ROOT, '.emit-e2e-'));
    ddl = new Pool(PG);
    await ddl.query(`DROP SCHEMA IF EXISTS ${B_SCHEMA} CASCADE`);
    await ddl.query('DROP TABLE IF EXISTS public.scp217_posts');
    await ddl.query('DROP TABLE IF EXISTS public.scp217_users');
    await ddl.query(`CREATE SCHEMA ${B_SCHEMA}`);
    // DB "A" (default / public): the parent page ONLY.
    await ddl.query('CREATE TABLE public.scp217_posts (id INT PRIMARY KEY, author_id INT, title TEXT)');
    await ddl.query("INSERT INTO public.scp217_posts VALUES (10,1,'a1'),(11,2,'b1')");
    // DB "B" (analytics): the relation TARGET + the other-connection endpoint's table ONLY. There is
    // deliberately NO scp217_users in public, so routing to A cannot silently succeed.
    await ddl.query(`CREATE TABLE ${B_SCHEMA}.scp217_users (id INT PRIMARY KEY, name TEXT)`);
    await ddl.query(`INSERT INTO ${B_SCHEMA}.scp217_users VALUES (1,'Ada'),(2,'Bob')`);
    emittedSource = emitBehaviorModule({
      behavior: 'NamedDb',
      dialect: 'postgres',
      leafImport: resolve(ROOT, 'src/scp/leaf-transport.js'),
      endpoints: NAMED_DB_ENDPOINTS,
      models: emitModels,
      columnOptions: EMIT_COLUMN_OPTIONS,
    }).source;
  }, 120_000);

  afterAll(async () => {
    if (ddl !== undefined) {
      await ddl.query(`DROP SCHEMA IF EXISTS ${B_SCHEMA} CASCADE`);
      await ddl.query('DROP TABLE IF EXISTS public.scp217_posts');
      await ddl.end();
    }
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
  });

  it('the two databases are genuinely disjoint — neither table is reachable from the other connection', async () => {
    // The premise every assertion below rests on, asserted rather than assumed: if `public` also held
    // scp217_users, a dropped connection name would still return rows and this whole gate would be
    // vacuous (which is how the single-DB suites stayed green with the name never lowered at all).
    await expect(ddl.query('SELECT 1 FROM public.scp217_users')).rejects.toThrow(/does not exist/);
    await expect(ddl.query(`SELECT 1 FROM ${B_SCHEMA}.scp217_posts`)).rejects.toThrow(/does not exist/);
  });

  it('a CROSS-DB relation resolves: the parent page from A, the batched child SELECT from B', async () => {
    const { facade, close } = await build();
    try {
      // Unforgeable: the authors can only have come from the analytics connection — `scp217_users` does
      // not exist on the default one, and the parent rows can only have come from the default —
      // `scp217_posts` does not exist on analytics.
      expect(await facade.postsWithAuthor()).toEqual([
        { id: 10, author_id: 1, title: 'a1', author: { id: 1, name: 'Ada' } },
        { id: 11, author_id: 2, title: 'b1', author: { id: 2, name: 'Bob' } },
      ]);
    } finally {
      await close();
    }
  }, 120_000);

  it('an ENDPOINT on the other connection runs its READ and its WRITE there', async () => {
    const { facade, close } = await build();
    try {
      expect(await facade.usersOnB()).toEqual([{ id: 1, name: 'Ada' }, { id: 2, name: 'Bob' }]);
      // The WRITE lands in B too — proven by reading it back through B and by B's own table being the
      // only place the row exists.
      const summary = await facade.renameUserOnB({ name: 'Ada2', id: 1 });
      expect(summary[0].changes).toBe(1n);
      const back = await ddl.query(`SELECT name FROM ${B_SCHEMA}.scp217_users WHERE id = 1`);
      expect(back.rows[0].name).toBe('Ada2');
      await ddl.query(`UPDATE ${B_SCHEMA}.scp217_users SET name = 'Ada' WHERE id = 1`);
    } finally {
      await close();
    }
  }, 120_000);

  it('NEGATIVE CONTROL — dropping the lowered name runs the statements against the PARENT\'s database', async () => {
    // The faithful mutation of the ONE thing #217 adds: the emitter's `db` field goes back to `null`
    // (the pre-#217 lowering, which emitted no `db` at all). Everything else — bc, the leaf, the two
    // registered connections, the server — is untouched. Both surfaces must go RED, and they must go red
    // by hitting the DEFAULT connection, where the analytics table does not exist.
    const dropName = (s: string) => s.replaceAll(`db: "${NAMED_DB}"`, 'db: null');
    expect(dropName(emittedSource)).not.toContain(NAMED_DB); // the mutation really removed it
    const { facade, close } = await build(dropName);
    try {
      await expect(facade.postsWithAuthor()).rejects.toThrow(/scp217_users.*does not exist|does not exist.*scp217_users/s);
      await expect(facade.usersOnB()).rejects.toThrow(/scp217_users.*does not exist|does not exist.*scp217_users/s);
    } finally {
      await close();
    }
  }, 120_000);

  it('NEGATIVE CONTROL — an UNREGISTERED name is LOUD, never a silent fall back to the default', async () => {
    const ghost = (s: string) => s.replaceAll(`db: "${NAMED_DB}"`, 'db: "ghost"');
    const { facade, close } = await build(ghost);
    try {
      await expect(facade.usersOnB()).rejects.toThrow(/no connection registered under name 'ghost'/);
    } finally {
      await close();
    }
  }, 120_000);

  it('a ctx that registered only the default REJECTS the name at the seam (no silent fall back)', async () => {
    // The registry half of fail-closed, on the SEAM rather than through a generated module: a routed ctx
    // that never registered `analytics` must refuse the statement. Falling back to the default connection
    // is the same wrong-database execution the dropped name causes.
    const built = buildRoutingConfig([{ config: { ...PG_CONN }, poolFactory: pgPoolFactory(await import('pg')) }]);
    const routedWithoutB = new PooledAsyncContext(built.routing);
    try {
      // `connectionFor` throws SYNCHRONOUSLY inside the seam, so the async wrapper surfaces it uniformly
      // as a rejection (the same shape `ConnectionRouting.test.ts` asserts the unknown-name throw with).
      await expect((async () => executeAsync(routedWithoutB, 'SELECT 1', [], { write: false, db: NAMED_DB }))()).rejects.toThrow(
        /no connection registered under name 'analytics'/,
      );
    } finally {
      await built.close();
    }
  }, 60_000);
});
