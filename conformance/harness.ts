/**
 * litedbmodel v2 SCP — the conformance harness (WS7a, #30; emitter cutover #154).
 *
 * The SINGLE source of the conformance vector corpus and the TS reference runner. Every vector is
 * captured from, and replayed through, the ONE settled pipeline (CLAUDE.md §1):
 *
 * ```
 * decorated models + DECLARED endpoints (no SQL — the fixtures below)
 *   → emitBehaviorModule                       the library's lowering (src/scp/emit)
 *   → tsc --strict over the emitted source     bc's authoring requirement
 *   → bc generate --lang typescript-native     the real CLI; no litedbmodel code in the path
 *   → bindTyped(leafHandlers(ctx))             the ONLY hand-wiring: calling the generated method
 *   → SQLite / live PostgreSQL / live MySQL
 * ```
 *
 * There is no second generator and no programmatic compile: the corpus is a contract on the
 * ARTIFACT the other language runtimes run, not on a TS-only build.
 *
 * ## What a vector is
 *
 *   - `exec`         — the endpoint executed end-to-end against a real database for its dialect.
 *                      ONE execution pins BOTH axes: the ORDERED `{sql, params}` the transport
 *                      handed the driver (the render golden — in the driver-bound form, with the
 *                      SKIP fragments already assembled, `?`→`$N` already rendered and the array
 *                      params already encoded), and the FULL materialized result (nested relation
 *                      children included) plus, for a write, the resulting DB state. A render
 *                      golden is therefore always a statement a real database answered.
 *   - `expect-error` — a read whose baked `findHardLimit` cap is exceeded: the read boundary throws
 *                      {@link LimitExceededError} with the exact fields.
 *   - `tx`           — a write-time-relations {@link SqlBundle} run as ONE gate-first transaction.
 *   - `dialect`      — the `orderByNulls` dialect primitive.
 *
 * ## Dialect invariance (§10) is enforced at CAPTURE
 *
 * A read case is generated for all three dialects from the SAME declaration + input, and
 * {@link generateCorpus} FAILS LOUDLY if the three results are not identical; a write case is
 * cross-checked on its `changes` count and its resulting DB state. So "同一宣言+入力 → 同一結果"
 * is not a claim in a comment, it is a generation-time invariant, re-assertable from the frozen
 * corpus (see `test/scp/conformance-vectors.test.ts`).
 *
 * ## Content, never counts (#150)
 *
 * A relation-bearing vector carries a `relationFields` contract, and {@link checkRelationContent}
 * asserts every nested child's EXACT field set plus that each declared field is actually populated
 * in at least one child. The #150 defect (relation children returned as empty structs) passed every
 * row-count check; it cannot pass this one.
 */

import 'reflect-metadata';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool as PgPool } from 'pg';
import mysql from 'mysql2/promise';
import type { Column } from '../src/Column';
import { belongsTo, column, hasMany, model } from '../src/decorators';
import {
  assertFindHardLimit,
  columnTypeResolverFromColumnMap,
  connectionForDriver,
  compileCompositeWriteBundle,
  compileWriteBundle,
  compileWriteNode,
  contextForConnection,
  dialectFor,
  emitBehaviorModule,
  entityWrites,
  executeAsync,
  execute,
  executeTransactionBundle,
  leafHandlers,
  leafHandlersAsync,
  LimitExceededError,
  mysqlConnectionPool,
  pgConnectionPool,
  PooledAsyncContext,
  resetLimitConfig,
  runAsync,
  setLimitConfig,
  type AsyncConnection,
  type AsyncConnectionPool,
  type DeriveColumnsOptions,
  type DialectName,
  type EmittedEndpoint,
  type EndpointSet,
  type ModelClassLike,
  type SqlBundle,
  type SyncConnection,
  type TxOp,
} from '../src/scp/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ── Corpus versioning (SSoT — bumped on any refreeze, PROTOCOL-style) ─────────

/**
 * The conformance corpus schema version. A consumer runner fail-closes on a mismatch. Bumped to 5
 * for the emitter cutover (#154): a vector names a DECLARED ENDPOINT and carries the statements /
 * results the GENERATED module produced; the recorder-era `readGraph` / read-`bundle` artifacts and
 * the separate `write-render` kind are gone (a write is an emitted endpoint like any other).
 */
export const CORPUS_VERSION = 5 as const;

const ALL_DIALECTS: readonly DialectName[] = ['sqlite', 'postgres', 'mysql'] as const;

// ── Canonical JSON value encoding (bigint-safe) ───────────────────────────────

/** A JSON-safe encoding of a runtime value (bigint → tagged decimal string). */
export type EncodedValue =
  | null
  | boolean
  | number
  | string
  | { $bigint: string }
  | EncodedValue[]
  | { [k: string]: EncodedValue };

/** Encode a runtime value (possibly containing bigint) to pure JSON. */
export function encodeValue(v: unknown): EncodedValue {
  if (typeof v === 'bigint') return { $bigint: v.toString() };
  if (v === null || typeof v !== 'object') return v as EncodedValue;
  if (Array.isArray(v)) return v.map(encodeValue);
  const out: Record<string, EncodedValue> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = encodeValue(val);
  return out;
}

/** Decode a canonical value back to a runtime value (bigint tag → bigint). */
function decodeValue(v: EncodedValue): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decodeValue);
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === '$bigint') return BigInt((v as { $bigint: string }).$bigint);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = decodeValue(val as EncodedValue);
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// FIXTURES — the ORM user's whole input: decorated models + declared endpoints.
// There is no SQL here and no SCP here.
// ══════════════════════════════════════════════════════════════════════════════

// `@model` installs one static {@link Column} token per `@column` at runtime (decorators.ts:1123).
// The `declare static` lines below are the TYPE-ONLY view of the tokens a relation key pair names
// (`() => [ConfUser.id, ConfPost.author_id]`), so the fixtures type-check with no untyped escape.
// Only the key columns are declared: a token named `name` would shadow the class's own `Function.name`,
// which `ModelClassLike` reads.

@model('conf_users')
class ConfUser {
  declare static id: Column<number, ConfUser>;

  @column() id?: number;
  @column() name?: string;
  @column() post_count?: number;

  @hasMany(() => [ConfUser.id, ConfPost.author_id], { order: () => ConfPost.id.asc() })
  declare posts: Promise<ConfPost[]>;
}

@model('conf_posts')
class ConfPost {
  declare static id: Column<number, ConfPost>;
  declare static author_id: Column<number, ConfPost>;

  @column() id?: number;
  @column() author_id?: number;
  @column() title?: string;
  @column() status?: string;
  @column() created_at?: string;

  @hasMany(() => [ConfPost.id, ConfTag.post_id], { order: () => ConfTag.id.asc() })
  declare tags: Promise<ConfTag[]>;

  @belongsTo(() => [ConfPost.author_id, ConfUser.id])
  declare author: Promise<ConfUser | null>;
}

@model('conf_tags')
class ConfTag {
  declare static id: Column<number, ConfTag>;
  declare static post_id: Column<number, ConfTag>;

  @column() id?: number;
  @column() post_id?: number;
  @column() label?: string;
}

const MODEL_REGISTRY: Record<string, unknown> = { ConfUser, ConfPost, ConfTag };

/** Model NAME → class, as `relationDeclOf` resolves a relation's target model. */
const conformanceModels = (name: string): ModelClassLike => MODEL_REGISTRY[name] as ModelClassLike;

/**
 * The TEXT columns, pinned. vitest (esbuild) has no `emitDecoratorMetadata`, so a bare `@column()`
 * carries no `design:type` and takes the documented `DEFAULT_UNCAST_SQL_TYPE` (INTEGER); the text
 * columns go through the adapter's documented `columnTypes` escape hatch.
 */
const COLUMN_OPTIONS: DeriveColumnsOptions = {
  columnTypes: { name: 'TEXT', title: 'TEXT', status: 'TEXT', created_at: 'TEXT', label: 'TEXT' },
};

/** The emitted `@behavior` class name (the `bc generate --behavior` argument). */
const BEHAVIOR = 'Conformance';

/**
 * The DECLARED endpoints. Read / SKIP / IN-list / two relation levels / belongsTo / single writes /
 * batch writes — declared without one character of SQL, and expressible on ALL THREE dialects (no
 * RETURNING write, which MySQL loud-rejects; no composite-key relation, which PostgreSQL
 * loud-rejects — both rejections are pinned by `test/scp/emitter.test.ts`).
 */
const ENDPOINTS: EndpointSet = {
  /** A plain author page — the find hard-limit guard TARGET (it declares no limit of its own). */
  posts: {
    kind: 'read',
    model: ConfPost,
    where: [{ column: 'author_id', op: 'eq', param: 'authorId' }],
    order: 'id ASC',
  },
  /** The SAME page with an EXPLICIT limit — an authored LIMIT governs, so no cap is baked. */
  postsTop: { kind: 'read', model: ConfPost, order: 'id ASC', limit: 2 },
  /**
   * #161 — PAGING: the page POSITION is an INPUT, so the counts BIND (`LIMIT ? OFFSET ?`) instead of
   * inlining. One statement serves every window, and the placeholders render per dialect (PG `$N`).
   */
  page: {
    kind: 'read',
    model: ConfPost,
    select: ['id', 'title'],
    order: 'id ASC',
    limit: { param: 'limit' },
    offset: { param: 'offset' },
  },
  /** #46 — a whole key set bound as ONE param (PG `= ANY(?)`, MySQL/SQLite single-JSON). */
  postsByIds: {
    kind: 'read',
    model: ConfPost,
    select: ['id', 'title'],
    where: [{ kind: 'in', column: 'id', param: 'ids' }],
    order: 'id ASC',
  },
  /** SKIP — `authorId` is fixed; `status` and `since` are present-or-absent PER CALL. */
  feed: {
    kind: 'read',
    model: ConfPost,
    select: ['id', 'author_id', 'title', 'status'],
    where: [
      { column: 'author_id', op: 'eq', param: 'authorId' },
      { column: 'status', op: 'eq', param: 'status', optional: true },
      { column: 'created_at', op: 'ge', param: 'since', optional: true },
    ],
    order: 'id ASC',
  },
  /** Two relation levels off ONE parent read: users → posts → tags (3 queries, N+1-free). */
  usersWithPosts: {
    kind: 'read',
    model: ConfUser,
    select: ['id', 'name'],
    order: 'id ASC',
    with: [{ name: 'posts', with: ['tags'] }],
  },
  /** A belongsTo relation — the single-child nesting shape. */
  postsWithAuthor: { kind: 'read', model: ConfPost, order: 'id ASC', with: ['author'] },
  createPost: {
    kind: 'create',
    model: ConfPost,
    values: [
      { column: 'id', param: 'id' },
      { column: 'author_id', param: 'authorId' },
      { column: 'title', param: 'title' },
      { column: 'status', param: 'status' },
      { column: 'created_at', param: 'createdAt' },
    ],
  },
  renamePost: {
    kind: 'update',
    model: ConfPost,
    set: [{ column: 'title', param: 'title' }],
    where: [{ column: 'id', op: 'eq', param: 'id' }],
  },
  removePost: { kind: 'delete', model: ConfPost, where: [{ column: 'id', op: 'eq', param: 'id' }] },
  createTags: { kind: 'createMany', model: ConfTag, columns: ['id', 'post_id', 'label'], param: 'rows' },
  removeTags: { kind: 'deleteMany', model: ConfTag, keyColumn: 'id', param: 'ids' },
};

/**
 * The schema + seed, IDENTICAL for all three dialects (portable DDL). One schema is itself part of
 * the evidence that a divergent result is the dialect SQL diverging, never the fixture.
 */
const SCHEMA: readonly string[] = [
  'DROP TABLE IF EXISTS conf_tags',
  'DROP TABLE IF EXISTS conf_posts',
  'DROP TABLE IF EXISTS conf_users',
  'CREATE TABLE conf_users (id INT PRIMARY KEY, name TEXT, post_count INT NOT NULL DEFAULT 0)',
  'CREATE TABLE conf_posts (id INT PRIMARY KEY, author_id INT NOT NULL, title TEXT NOT NULL, status TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE conf_tags (id INT PRIMARY KEY, post_id INT NOT NULL, label TEXT)',
  "INSERT INTO conf_users (id, name, post_count) VALUES (1, 'Ada', 2)",
  "INSERT INTO conf_users (id, name, post_count) VALUES (2, 'Bob', 1)",
  "INSERT INTO conf_users (id, name, post_count) VALUES (3, 'Cy', 0)",
  "INSERT INTO conf_posts (id, author_id, title, status, created_at) VALUES (10, 1, 'a1', 'live', '2026-02-01')",
  "INSERT INTO conf_posts (id, author_id, title, status, created_at) VALUES (11, 1, 'a2', 'draft', '2026-03-01')",
  "INSERT INTO conf_posts (id, author_id, title, status, created_at) VALUES (12, 2, 'b1', 'live', '2026-01-15')",
  "INSERT INTO conf_tags (id, post_id, label) VALUES (100, 10, 'greeting')",
  "INSERT INTO conf_tags (id, post_id, label) VALUES (101, 10, 'first')",
  "INSERT INTO conf_tags (id, post_id, label) VALUES (102, 12, 'world')",
];

// ══════════════════════════════════════════════════════════════════════════════
// THE PIPELINE — declarations → emitted source → bc generate → a bound module.
// ══════════════════════════════════════════════════════════════════════════════

/** Where the emitted + generated modules land (gitignored; inside the repo so imports resolve). */
const GEN_DIR = join(HERE, '.generated');

/** The typed facade a generated `typescript-native` module binds (methods keyed by endpoint name). */
type SyncFacade = Record<string, (input?: Record<string, unknown>) => unknown>;
type AsyncFacade = Record<string, (input?: Record<string, unknown>) => Promise<unknown>>;

interface GeneratedModule {
  bindTyped(handlers: ReturnType<typeof leafHandlers>): SyncFacade;
  bindTypedAsync(handlers: ReturnType<typeof leafHandlersAsync>): AsyncFacade;
}

/** One built artifact: the emitted source, the per-endpoint call contracts, the generated module. */
interface Built {
  readonly source: string;
  readonly contracts: readonly EmittedEndpoint[];
  readonly module: GeneratedModule;
}

/**
 * The hard-limit config a vector re-applies before EMITTING. The find cap bakes into the read's
 * `LIMIT cap + 1` at emit time ({@link import('../src/scp/limit-config').resolveFindHardLimit}), so
 * the vector CARRIES it and a runner reproduces the artifact by re-emitting under it.
 */
export interface LimitConfigSpec {
  readonly findHardLimit?: number | null;
}

/** The cache key: only what actually changes the EMITTED artifact (the baked find cap). */
function builtKey(dialect: DialectName, config?: LimitConfigSpec): string {
  return `${dialect}:${String(config?.findHardLimit ?? null)}`;
}

const builtCache = new Map<string, Promise<Built>>();
let genDirPrepared = false;

/** Build (or reuse) the generated module for one dialect under one limit config. */
function built(dialect: DialectName, config?: LimitConfigSpec): Promise<Built> {
  const key = builtKey(dialect, config);
  let p = builtCache.get(key);
  if (p === undefined) {
    p = build(dialect, config);
    builtCache.set(key, p);
  }
  return p;
}

async function build(dialect: DialectName, config?: LimitConfigSpec): Promise<Built> {
  if (!genDirPrepared) {
    rmSync(GEN_DIR, { recursive: true, force: true });
    mkdirSync(GEN_DIR, { recursive: true });
    genDirPrepared = true;
  }

  // 1. LOWER. The find cap is read from the config SSoT at EMIT time, so it is applied around the
  //    emit and restored immediately (the config is global — never leak it into another vector).
  resetLimitConfig();
  if (config !== undefined) setLimitConfig(config);
  let emitted;
  try {
    emitted = emitBehaviorModule({
      behavior: BEHAVIOR,
      dialect,
      // The emitted module imports the library's ONE leaf catalog; the specifier must resolve from
      // the emitted file's own location (bc type-checks the source it reads).
      leafImport: join(ROOT, 'src/scp/leaf-transport.js'),
      endpoints: ENDPOINTS,
      models: conformanceModels,
      columnOptions: COLUMN_OPTIONS,
    });
  } finally {
    resetLimitConfig();
  }

  // The artifact is content-addressed, so a changed emitter is a NEW module path — never a stale
  // ESM import-cache hit for a source that changed underneath the same name.
  const stamp = createHash('sha1').update(emitted.source).digest('hex').slice(0, 12);
  const authored = join(GEN_DIR, `${dialect}-${stamp}.authored.ts`);
  const generated = join(GEN_DIR, `${dialect}-${stamp}.generated.ts`);
  if (!existsSync(generated)) {
    writeFileSync(authored, emitted.source, 'utf8');
    // 2. The emitted source must be ORDINARY strict TypeScript — bc's authoring requirement.
    execFileSync(
      join(ROOT, 'node_modules/.bin/tsc'),
      ['--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler',
       '--experimentalDecorators', authored],
      { cwd: ROOT, stdio: 'pipe' },
    );
    // 3. GENERATE with bc's own CLI — no litedbmodel code in the generation path.
    execFileSync(
      join(ROOT, 'node_modules/.bin/bc'),
      ['generate', '--lang', 'typescript-native', '--from', authored, '--behavior', BEHAVIOR, '--out', generated],
      { cwd: ROOT, stdio: 'pipe' },
    );
  }
  const module = (await import(generated)) as GeneratedModule;
  return { source: emitted.source, contracts: emitted.endpoints, module };
}

/** The `findHardLimit` cap the emitter baked into one endpoint (absent ⇒ no cap). */
function bakedCap(b: Built, entry: string): number | undefined {
  const c = b.contracts.find((e) => e.name === entry);
  if (c === undefined) throw new Error(`conformance: no emitted endpoint '${entry}'`);
  return c.findHardLimit;
}

// ── the driver TAP: what the leaf transport actually handed the database ──────────────────────

/** One statement observed at the driver contact point, canonically encoded. */
export interface EncodedStatement {
  readonly sql: string;
  readonly params: readonly EncodedValue[];
}

/** The mutable statement log a seam's tap writes into. */
type StatementLog = { sql: string; params: unknown[] }[];

/**
 * Wrap the ONE sync driver contact point ({@link SyncConnection}) so every statement is logged AND
 * still executed. What the log holds is therefore the exact driver-bound form of a statement that
 * REALLY RAN: the dynamic (SKIP) WHERE already assembled, `?`→`$N` already rendered, the array
 * params already encoded and their PG casts resolved against the real key set. There is no second
 * renderer anywhere — a render golden is a statement the database answered.
 */
function tapSync(conn: SyncConnection, log: StatementLog): SyncConnection {
  return {
    execute(sql, params) {
      log.push({ sql, params: [...params] });
      return conn.execute(sql, params);
    },
    executeSafeIntegers(sql, params) {
      log.push({ sql, params: [...params] });
      return conn.executeSafeIntegers(sql, params);
    },
    run(sql, params) {
      log.push({ sql, params: [...params] });
      return conn.run(sql, params);
    },
  };
}

/** The async twin of {@link tapSync}: tap each pooled connection as it is handed out. */
function tapAsyncPool(pool: AsyncConnectionPool, log: StatementLog): AsyncConnectionPool {
  const originals = new WeakMap<AsyncConnection, AsyncConnection>();
  return {
    async acquire() {
      const real = await pool.acquire();
      const tapped: AsyncConnection = {
        async execute(sql, params) {
          log.push({ sql, params: [...params] });
          return real.execute(sql, params);
        },
        async run(sql, params) {
          log.push({ sql, params: [...params] });
          return real.run(sql, params);
        },
      };
      originals.set(tapped, real);
      return tapped;
    },
    release(conn, destroy) {
      return pool.release(originals.get(conn) ?? conn, destroy);
    },
  };
}

// ── the EXEC seam: one live database per dialect ──────────────────────────────────────────────

const PG_CONFIG = {
  host: process.env.TEST_DB_HOST || 'localhost',
  port: parseInt(process.env.TEST_DB_PORT || '5433', 10),
  database: process.env.TEST_DB_NAME || 'testdb',
  user: process.env.TEST_DB_USER || 'testuser',
  password: process.env.TEST_DB_PASSWORD || 'testpass',
};
const MYSQL_CONFIG = {
  host: process.env.TEST_MYSQL_HOST || 'localhost',
  port: parseInt(process.env.TEST_MYSQL_PORT || '3307', 10),
  database: process.env.TEST_MYSQL_DB || 'testdb',
  user: process.env.TEST_MYSQL_USER || 'testuser',
  password: process.env.TEST_MYSQL_PASSWORD || 'testpass',
};

let pgPool: PgPool | undefined;
let myPool: mysql.Pool | undefined;

/** Release the live PG / MySQL pools (a runner MUST call this, or the process keeps their sockets). */
export async function closeLiveConnections(): Promise<void> {
  if (pgPool !== undefined) {
    const p = pgPool;
    pgPool = undefined;
    await p.end();
  }
  if (myPool !== undefined) {
    const p = myPool;
    myPool = undefined;
    await p.end();
  }
}

/** Build a fresh in-memory SQLite from a schema/seed statement list. */
function seedDb(schema: readonly string[]): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const stmt of schema) db.exec(stmt);
  return db;
}

/** A freshly seeded database for ONE dialect, with the generated module bound to it. */
interface Seam {
  /**
   * Call an emitted endpoint. Returns the module's MARSHALLED (de-boxed) output together with every
   * statement the transport handed the driver DURING that call, in order.
   */
  call(entry: string, input: Record<string, unknown>): Promise<{ result: unknown; statements: EncodedStatement[] }>;
  /** Run an assertion query straight through the same execution seam. */
  query(sql: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** Build the seam over an already-built module + a tapped execution context. */
function seamOver(
  log: StatementLog,
  invoke: (entry: string, input: Record<string, unknown>) => unknown,
  query: (sql: string) => Promise<Record<string, unknown>[]>,
  close: () => Promise<void>,
): Seam {
  return {
    async call(entry, input) {
      // The tap logs the seed/DDL and the assertion queries too, so a call's statements are the
      // slice it appended — never a guess about which log entries belong to it.
      const from = log.length;
      const result = await invoke(entry, input);
      return { result, statements: log.slice(from).map((s) => ({ sql: s.sql, params: s.params.map(encodeValue) })) };
    },
    query,
    close,
  };
}

async function seamFor(dialect: DialectName, config?: LimitConfigSpec): Promise<Seam> {
  const b = await built(dialect, config);
  const log: StatementLog = [];
  if (dialect === 'sqlite') {
    const db = seedDb(SCHEMA);
    const ctx = contextForConnection(tapSync(connectionForDriver(db as never), log));
    const facade = b.module.bindTyped(leafHandlers({ exec: ctx, dialect }));
    return seamOver(
      log,
      (entry, input) => facade[entry](input),
      (sql) => Promise.resolve(execute(ctx, sql, [])),
      () => {
        db.close();
        return Promise.resolve();
      },
    );
  }
  const pool =
    dialect === 'postgres'
      ? pgConnectionPool((pgPool ??= new PgPool(PG_CONFIG)) as never)
      : mysqlConnectionPool((myPool ??= mysql.createPool({ ...MYSQL_CONFIG, connectionLimit: 4 })) as never);
  const ctx = new PooledAsyncContext(tapAsyncPool(pool, log));
  for (const stmt of SCHEMA) await runAsync(ctx, stmt, []);
  const facade = b.module.bindTypedAsync(leafHandlersAsync({ execAsync: ctx, dialect }));
  return seamOver(log, (entry, input) => facade[entry](input), (sql) => executeAsync(ctx, sql, []), () => Promise.resolve());
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTENT-LEVEL relation assertions (#150 — a count-only check is not a check).
// ══════════════════════════════════════════════════════════════════════════════

/**
 * The relation CONTENT contract of a vector: `relation path → the exact field names every child at
 * that path must carry`. A path is dot-separated from the root row (`posts.tags` = the tags of each
 * post of each root user).
 */
export type RelationFields = Readonly<Record<string, readonly string[]>>;

/** Collect every child object at `path` (arrays flattened, `null`/absent skipped). */
function childrenAt(rows: unknown, path: readonly string[]): Record<string, unknown>[] {
  let level = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  for (const seg of path) {
    const next: Record<string, unknown>[] = [];
    for (const row of level) {
      const v = row === null || typeof row !== 'object' ? undefined : row[seg];
      if (Array.isArray(v)) next.push(...(v as Record<string, unknown>[]).filter((c) => c !== null && typeof c === 'object'));
      else if (v !== null && typeof v === 'object') next.push(v as Record<string, unknown>);
    }
    level = next;
  }
  return level;
}

/**
 * Assert the CONTENT of a materialized relation graph. Returns the violations (empty ⇒ conformant).
 *
 * Three checks, each of which the #150 defect fails:
 *  1. the path must materialize at least ONE child object (an all-empty graph is not evidence);
 *  2. every child's field set must be EXACTLY the declared one (an empty struct `{}` fails);
 *  3. every declared field must be non-null in at least one child (a struct of nulls fails).
 *
 * A row-count assertion satisfies none of them, which is the point.
 */
export function checkRelationContent(rows: unknown, spec: RelationFields): string[] {
  const problems: string[] = [];
  for (const [path, fields] of Object.entries(spec)) {
    const children = childrenAt(rows, path.split('.'));
    if (children.length === 0) {
      problems.push(`relation '${path}': no child object materialized — a row-count assertion would still pass`);
      continue;
    }
    const want = [...fields].sort();
    children.forEach((child, i) => {
      const got = Object.keys(child).sort();
      if (got.join(',') !== want.join(',')) {
        problems.push(`relation '${path}'[${i}]: fields {${got.join(', ')}} != declared {${want.join(', ')}}`);
      }
    });
    for (const f of want) {
      if (!children.some((c) => c[f] !== undefined && c[f] !== null)) {
        problems.push(`relation '${path}': field '${f}' is absent/null in EVERY child (an empty struct)`);
      }
    }
  }
  return problems;
}

// ══════════════════════════════════════════════════════════════════════════════
// Vector shapes
// ══════════════════════════════════════════════════════════════════════════════

/**
 * An exec vector: the endpoint executed end-to-end against a real database. It carries BOTH axes,
 * because they are one execution: the statements the transport handed the driver (the render
 * golden) and what came back (the result / DB state).
 */
export interface ExecVector {
  readonly name: string;
  readonly kind: 'exec';
  readonly dialect: DialectName;
  readonly entry: string;
  readonly input: EncodedValue;
  readonly config?: LimitConfigSpec;
  /** The logical case — the SAME id across dialects (§10 cross-check anchor). */
  readonly case: string;
  /** Every statement the call issued, in order, in the driver-bound form. */
  readonly expectedStatements: readonly EncodedStatement[];
  /** The FULL materialized result (nested relation children included). */
  readonly expectedResult: EncodedValue;
  /** The relation CONTENT contract (#150) — asserted, never just counted. */
  readonly relationFields?: RelationFields;
  /** DB state after a write, queried through the same execution seam. */
  readonly expectedDbState?: readonly { readonly query: string; readonly rows: EncodedValue }[];
  /** The `findHardLimit` cap the emitter baked (null ⇒ none — an explicit/absent cap). */
  readonly expectedCap: number | null;
}

/**
 * An EXPECT-ERROR vector: a read whose baked find cap is exceeded. The emitter bakes `LIMIT cap + 1`
 * and the READ BOUNDARY enforces it post-fetch with
 * {@link import('../src/scp/limit-config').assertFindHardLimit} — SCP has no throw, so the cap lives
 * where the caller consumes the rows.
 */
export interface ExpectErrorVector {
  readonly name: string;
  readonly kind: 'expect-error';
  readonly dialect: DialectName;
  readonly entry: string;
  readonly input: EncodedValue;
  readonly config: LimitConfigSpec;
  readonly case: string;
  readonly expectedCap: number;
  /** Every statement the (capped) read issued — the `LIMIT cap + 1` bounded fetch is visible here. */
  readonly expectedStatements: readonly EncodedStatement[];
  readonly expectedError: {
    readonly name: 'LimitExceededError';
    readonly limit: number;
    readonly count: number;
    readonly context: 'find' | 'relation';
    readonly model?: string;
  };
}

/** A write-transaction vector: a {@link SqlBundle} with a transaction plan run as ONE tx. */
export interface TxVector {
  readonly name: string;
  readonly kind: 'tx';
  readonly dialect: DialectName;
  readonly bundle: SqlBundle;
  readonly input: EncodedValue;
  readonly schema: readonly string[];
  readonly expectedResult: EncodedValue;
  readonly expectedDbState?: readonly { readonly query: string; readonly rows: EncodedValue }[];
}

/** A dialect-primitive vector: the `orderByNulls` NULLS-ordering emulation. */
export interface DialectVector {
  readonly name: string;
  readonly kind: 'dialect';
  readonly dialect: DialectName;
  readonly primitive: 'orderByNulls';
  readonly args: { readonly expr: string; readonly dir: 'ASC' | 'DESC'; readonly nulls: 'FIRST' | 'LAST' };
  readonly expected: string;
}

export type Vector = ExecVector | ExpectErrorVector | TxVector | DialectVector;

/** A named suite file of vectors (one JSON per file). */
export interface Suite {
  readonly suite: string;
  readonly corpusVersion: number;
  readonly note: string;
  readonly vectors: readonly Vector[];
}

// ══════════════════════════════════════════════════════════════════════════════
// The CASES — declared once, generated for every dialect.
// ══════════════════════════════════════════════════════════════════════════════

/** A per-dialect input (a PG batch write binds one array PER COLUMN; MySQL/SQLite one record array). */
type InputFor = Record<string, unknown> | ((dialect: DialectName) => Record<string, unknown>);

function inputOf(i: InputFor, dialect: DialectName): Record<string, unknown> {
  return typeof i === 'function' ? i(dialect) : i;
}

interface ExecCase {
  readonly id: string;
  readonly entry: string;
  readonly input: InputFor;
  /** A write case mutates: its result carries per-dialect driver counters, its DB STATE is the invariant. */
  readonly writes?: boolean;
  readonly relationFields?: RelationFields;
  readonly dbState?: readonly string[];
  readonly config?: LimitConfigSpec;
}

const POSTS_STATE = 'SELECT id, author_id, title, status, created_at FROM conf_posts ORDER BY id';
const TAGS_STATE = 'SELECT id, post_id, label FROM conf_tags ORDER BY id';

const EXEC_CASES: readonly ExecCase[] = [
  { id: 'posts: author page', entry: 'posts', input: { authorId: 1 } },
  { id: 'postsTop: explicit LIMIT 2', entry: 'postsTop', input: {} },
  // #161 — the SAME emitted statement, two different windows: a baked count could not produce both.
  { id: 'page: bound LIMIT/OFFSET (first window)', entry: 'page', input: { limit: 2, offset: 0 } },
  { id: 'page: bound LIMIT/OFFSET (second window, same statement)', entry: 'page', input: { limit: 2, offset: 1 } },
  { id: 'postsByIds: IN-list (non-empty)', entry: 'postsByIds', input: { ids: [10, 12] } },
  { id: 'postsByIds: IN-list (EMPTY key set is legal)', entry: 'postsByIds', input: { ids: [] } },
  { id: 'feed: both optional predicates absent (SKIP drop)', entry: 'feed', input: { authorId: 1 } },
  { id: 'feed: status present, since absent', entry: 'feed', input: { authorId: 1, status: 'draft' } },
  { id: 'feed: since present, status absent', entry: 'feed', input: { authorId: 1, since: '2026-03-01' } },
  { id: 'feed: both present', entry: 'feed', input: { authorId: 1, status: 'live', since: '2026-01-01' } },
  {
    id: 'usersWithPosts: two relation levels materialize WITH THEIR FIELDS',
    entry: 'usersWithPosts',
    input: {},
    relationFields: {
      posts: ['id', 'author_id', 'title', 'status', 'created_at', 'tags'],
      'posts.tags': ['id', 'post_id', 'label'],
    },
  },
  {
    id: 'postsWithAuthor: belongsTo nests ONE child WITH ITS FIELDS',
    entry: 'postsWithAuthor',
    input: {},
    relationFields: { author: ['id', 'name', 'post_count'] },
  },
  {
    id: 'createPost: INSERT persists',
    entry: 'createPost',
    input: { id: 13, authorId: 1, title: 'c1', status: 'live', createdAt: '2026-04-01' },
    writes: true,
    dbState: [POSTS_STATE],
  },
  { id: 'renamePost: UPDATE persists', entry: 'renamePost', input: { title: 'a1-renamed', id: 10 }, writes: true, dbState: [POSTS_STATE] },
  { id: 'removePost: DELETE persists', entry: 'removePost', input: { id: 12 }, writes: true, dbState: [POSTS_STATE] },
  {
    id: 'createTags: batch INSERT persists (one statement for N records)',
    entry: 'createTags',
    input: (d) =>
      d === 'postgres'
        ? { rows_id: [103, 104], rows_post_id: [11, 11], rows_label: ['x', 'y'] }
        : { rows: [{ id: 103, post_id: 11, label: 'x' }, { id: 104, post_id: 11, label: 'y' }] },
    writes: true,
    dbState: [TAGS_STATE],
  },
  { id: 'removeTags: batch DELETE by key set persists', entry: 'removeTags', input: { ids: [100, 101] }, writes: true, dbState: [TAGS_STATE] },
  // The find hard-limit SKIP cases: `null` disables the cap, and an endpoint that declares its own
  // LIMIT is never capped — both must run normally (no throw), on every dialect.
  { id: 'guard: findHardLimit null → no cap baked', entry: 'posts', input: { authorId: 1 }, config: { findHardLimit: null } },
  { id: 'guard: an explicit endpoint LIMIT governs → no cap baked', entry: 'postsTop', input: {}, config: { findHardLimit: 1 } },
];

// ══════════════════════════════════════════════════════════════════════════════
// tx fixtures (write-time relations — the gate-first transaction surface)
// ══════════════════════════════════════════════════════════════════════════════

const TX_SCHEMA: readonly string[] = [
  'CREATE TABLE tx_users (id INTEGER PRIMARY KEY, name TEXT, post_count INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE tx_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, author_id INTEGER NOT NULL REFERENCES tx_users(id), title TEXT NOT NULL)',
  'CREATE TABLE tx_idem (token TEXT PRIMARY KEY)',
  'CREATE TABLE tx_uniq (name TEXT NOT NULL, s0 INTEGER NOT NULL, f0 TEXT NOT NULL, PRIMARY KEY (name, s0, f0))',
  'CREATE TABLE tx_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL)',
  "INSERT INTO tx_users (id, name, post_count) VALUES (7, 'Ada', 2)",
  "INSERT INTO tx_users (id, name, post_count) VALUES (8, 'Alan', 0)",
];

const TX_COMPOSITE_SCHEMA: readonly string[] = [
  'CREATE TABLE tx_users (id INTEGER PRIMARY KEY, name TEXT, post_count INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE tx_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, author_id INTEGER NOT NULL REFERENCES tx_users(id), title TEXT NOT NULL)',
  'CREATE TABLE tx_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL REFERENCES tx_posts(id), body TEXT NOT NULL)',
  "INSERT INTO tx_users (id, name, post_count) VALUES (7, 'Ada', 0)",
];

/** The base writes, built by the SSoT write-descriptor → TxOp compiler (`compileWriteNode`). */
function txCreatePostOp(): TxOp {
  return compileWriteNode({
    component: 'Insert',
    ports: {
      table: 'tx_posts',
      'values.author_id': { ref: ['author_id'] },
      'values.title': { ref: ['title'] },
      returning: 'id, author_id, title',
    },
  } as never);
}

/** The child write's `post_id` binds the PARENT's RETURNING id directly — no post-compile surgery. */
function txCreateCommentOp(): TxOp {
  return compileWriteNode({
    component: 'Insert',
    ports: {
      table: 'tx_comments',
      'values.post_id': { ref: ['post', 'id'] },
      'values.body': { ref: ['body'] },
      returning: 'id, post_id, body',
    },
  } as never);
}

/** The gate-first save contract of the single-write Command (spec §2.2). */
const txPostWrites = entityWrites((w) => ({
  create: w.lifecycle({
    requires: [w.exists('tx_users', { id: '$.input.author_id' })],
    idempotency: w.idempotentBy('tx_idem', 'token', '$.input.request_id'),
    unique: [w.unique({ name: 'title_per_author', guardTable: 'tx_uniq', scope: ['$.input.author_id'], fields: ['$.input.title'] })],
    derive: [w.increment('tx_users', { id: '$.input.author_id' }, 'post_count', +1)],
    emits: [w.event('PostCreated', 'tx_outbox', { postId: '$.entity.id', userId: '$.input.author_id' })],
  }),
}));

/** The composite (nested write) members: parent post → child comment, linked by `$.ref.post.id`. */
const txCompositeEntries = [
  {
    name: 'post',
    base: txCreatePostOp(),
    lifecycle: entityWrites((w) => ({
      create: w.lifecycle({
        requires: [w.exists('tx_users', { id: '$.input.author_id' })],
        derive: [w.increment('tx_users', { id: '$.input.author_id' }, 'post_count', +1)],
      }),
    })).create!,
  },
  { name: 'comment', base: txCreateCommentOp(), lifecycle: entityWrites(() => ({ create: { effects: {} } })).create! },
] as const;

/** The column-type SoT that types the write's `TransactionResult` for the typed-de-box emitters. */
const TX_COLUMN_TYPES = columnTypeResolverFromColumnMap(
  new Map([['tx_posts', new Map([['id', 'INTEGER'], ['author_id', 'INTEGER'], ['title', 'TEXT']])]]),
);

// ══════════════════════════════════════════════════════════════════════════════
// Corpus generation — every expected field is CAPTURED from the pipeline.
// ══════════════════════════════════════════════════════════════════════════════

/** Run one exec case on one dialect and capture everything the vector asserts. */
async function execVector(c: ExecCase, dialect: DialectName): Promise<ExecVector> {
  const input = inputOf(c.input, dialect);
  const seam = await seamFor(dialect, c.config);
  try {
    const { result, statements } = await seam.call(c.entry, input);
    const dbState = c.dbState === undefined
      ? undefined
      : await Promise.all(c.dbState.map(async (query) => ({ query, rows: encodeValue(await seam.query(query)) })));
    if (c.relationFields !== undefined) {
      const problems = checkRelationContent(result, c.relationFields);
      if (problems.length > 0) {
        throw new Error(`conformance: case '${c.id}' [${dialect}] violates its relation CONTENT contract:\n  ${problems.join('\n  ')}`);
      }
    }
    return {
      name: `${c.id} [${dialect}]`,
      kind: 'exec',
      dialect,
      entry: c.entry,
      input: encodeValue(input),
      case: c.id,
      ...(c.config !== undefined ? { config: c.config } : {}),
      expectedStatements: statements,
      expectedResult: encodeValue(result),
      ...(c.relationFields !== undefined ? { relationFields: c.relationFields } : {}),
      ...(dbState !== undefined ? { expectedDbState: dbState } : {}),
      expectedCap: bakedCap(await built(dialect, c.config), c.entry) ?? null,
    };
  } finally {
    await seam.close();
  }
}

/**
 * The §10 cross-dialect invariant, enforced at CAPTURE. A read case must produce the IDENTICAL
 * result on all three dialects; a write case's driver counters are dialect-specific
 * (`lastInsertRowid`), so its invariant is the `changes` count plus the resulting DB STATE.
 */
function assertDialectInvariant(c: ExecCase, vectors: readonly ExecVector[]): void {
  const compare = (v: ExecVector): string =>
    JSON.stringify(
      c.writes === true
        ? { changes: (v.expectedResult as { changes?: EncodedValue }[])[0]?.changes ?? null, state: v.expectedDbState }
        : v.expectedResult,
    );
  const [head, ...rest] = vectors;
  for (const v of rest) {
    if (compare(v) !== compare(head)) {
      throw new Error(
        `conformance: case '${c.id}' is NOT dialect-invariant (§10) — ${head.dialect} produced ` +
          `${compare(head)} but ${v.dialect} produced ${compare(v)}`,
      );
    }
  }
}

/** Build the find-cap EXPECT-ERROR vector: the read overruns its baked cap, the boundary throws. */
async function findGuardVector(dialect: DialectName): Promise<ExpectErrorVector> {
  const config: LimitConfigSpec = { findHardLimit: 1 };
  const entry = 'posts';
  const input = { authorId: 1 };
  const b = await built(dialect, config);
  const cap = bakedCap(b, entry);
  if (cap === undefined) throw new Error(`conformance: no find cap baked into '${entry}' under findHardLimit=1`);
  const seam = await seamFor(dialect, config);
  let thrown: unknown;
  let statements: EncodedStatement[] = [];
  try {
    const called = await seam.call(entry, input);
    statements = called.statements;
    assertFindHardLimit(called.result as unknown[], cap, entry);
  } catch (e) {
    thrown = e;
  } finally {
    await seam.close();
  }
  if (!(thrown instanceof LimitExceededError)) {
    throw new Error(`conformance: the find guard did NOT throw on ${dialect} (got ${thrown === undefined ? 'no throw' : String(thrown)})`);
  }
  return {
    name: `guard: the read overruns findHardLimit → throw [${dialect}]`,
    kind: 'expect-error',
    dialect,
    entry,
    input: encodeValue(input),
    config,
    case: 'guard: the read overruns findHardLimit → throw',
    expectedCap: cap,
    expectedStatements: statements,
    expectedError: {
      name: 'LimitExceededError',
      limit: thrown.limit,
      count: thrown.count,
      context: thrown.context,
      ...(thrown.model !== undefined ? { model: thrown.model } : {}),
    },
  };
}

/** Build a tx vector by running the reference transaction bundle against a freshly seeded DB. */
function txVector(name: string, bundle: SqlBundle, input: Record<string, unknown>, schema: readonly string[], dbQueries: readonly string[]): TxVector {
  const db = seedDb(schema);
  const result = executeTransactionBundle(bundle, input as never, { db });
  const dbState = dbQueries.map((query) => ({ query, rows: encodeValue(db.prepare(query).all()) }));
  db.close();
  return {
    name,
    kind: 'tx',
    dialect: bundle.dialect,
    bundle: JSON.parse(JSON.stringify(bundle)) as SqlBundle,
    input: encodeValue(input),
    schema,
    expectedResult: encodeValue(result),
    expectedDbState: dbState,
  };
}

/** Build a dialect-primitive vector capturing the reference `orderByNulls` output. */
function orderByNullsVector(dialect: DialectName, dir: 'ASC' | 'DESC', nulls: 'FIRST' | 'LAST'): DialectVector {
  const expr = 'created_at';
  return {
    name: `orderByNulls ${dialect} ${dir} NULLS ${nulls}`,
    kind: 'dialect',
    dialect,
    primitive: 'orderByNulls',
    args: { expr, dir, nulls },
    expected: dialectFor(dialect).orderByNulls(expr, dir, nulls),
  };
}

/** Generate the full corpus (list of suites). Every expected field is captured, not authored. */
export async function generateCorpus(): Promise<Suite[]> {
  // ── exec: the same declaration executed on SQLite + live PostgreSQL + live MySQL ───────────
  const exec: ExecVector[] = [];
  for (const c of EXEC_CASES) {
    const vectors: ExecVector[] = [];
    for (const dialect of ALL_DIALECTS) vectors.push(await execVector(c, dialect));
    assertDialectInvariant(c, vectors);
    exec.push(...vectors);
  }

  // ── guard: the baked find cap, enforced at the read boundary ───────────────────────────────
  const guard: ExpectErrorVector[] = [];
  for (const dialect of ALL_DIALECTS) guard.push(await findGuardVector(dialect));

  // ── tx: write-time relations (gate-first) + the composite tx-DAG ───────────────────────────
  const txAsserts = [
    'SELECT id, author_id, title FROM tx_posts ORDER BY id',
    'SELECT id, post_count FROM tx_users ORDER BY id',
    'SELECT type, payload FROM tx_outbox ORDER BY id',
  ];
  const bundle = compileWriteBundle('Create', txCreatePostOp(), txPostWrites, 'create', 'sqlite', TX_COLUMN_TYPES);
  const compositeBundle = compileCompositeWriteBundle(txCompositeEntries, 'create', 'sqlite');
  const compositeAsserts = [
    'SELECT id, author_id, title FROM tx_posts ORDER BY id',
    'SELECT id, post_id, body FROM tx_comments ORDER BY id',
    'SELECT id, post_count FROM tx_users ORDER BY id',
  ];
  const tx: TxVector[] = [
    txVector('create: gate-first tx commits (author exists, unique, idempotent)', bundle, { author_id: 7, title: 'New Post', request_id: 'req-1' }, TX_SCHEMA, txAsserts),
    txVector('create: gate short-circuits on missing author (ROLLBACK, no body write)', bundle, { author_id: 999, title: 'Orphan', request_id: 'req-2' }, TX_SCHEMA, txAsserts),
    txVector('composite: nested write commits parent+child in one tx-DAG (child.post_id = $.ref.post.id)', compositeBundle, { author_id: 7, title: 'Nested', body: 'First comment' }, TX_COMPOSITE_SCHEMA, compositeAsserts),
    txVector('composite: gate-first across the DAG short-circuits before parent AND child (ROLLBACK)', compositeBundle, { author_id: 999, title: 'Ghost', body: 'never' }, TX_COMPOSITE_SCHEMA, compositeAsserts),
  ];

  // ── dialect: orderByNulls ──────────────────────────────────────────────────────────────────
  const dialect: DialectVector[] = [];
  for (const d of ALL_DIALECTS) {
    for (const dir of ['ASC', 'DESC'] as const) {
      for (const nulls of ['FIRST', 'LAST'] as const) dialect.push(orderByNullsVector(d, dir, nulls));
    }
  }

  return [
    { suite: 'exec', corpusVersion: CORPUS_VERSION, note: 'The declared endpoints executed end-to-end on SQLite + live PostgreSQL + live MySQL. Each vector pins the statements the transport handed the driver AND what came back: reads are asserted dialect-invariant (§10); writes are asserted on their changes count + resulting DB state; relation vectors carry a field-level content contract (#150).', vectors: exec },
    { suite: 'guard', corpusVersion: CORPUS_VERSION, note: 'The find hard-limit: the emitter bakes LIMIT cap + 1 (visible in the vector statements) and the read boundary throws LimitExceededError post-fetch (assertFindHardLimit). The null-disable and explicit-LIMIT SKIP paths are exec vectors that must NOT throw.', vectors: guard },
    { suite: 'tx', corpusVersion: CORPUS_VERSION, note: 'Write-time-relations gate-first transaction bundles: commit + gate short-circuit + composite tx-DAG.', vectors: tx },
    { suite: 'dialect', corpusVersion: CORPUS_VERSION, note: 'Dialect primitive orderByNulls: PG/SQLite native NULLS, MySQL IS NULL emulation.', vectors: dialect },
  ];
}

// ══════════════════════════════════════════════════════════════════════════════
// Runner: re-derive the reference and assert it equals the frozen corpus.
// ══════════════════════════════════════════════════════════════════════════════

export interface VectorResult {
  readonly name: string;
  readonly suite: string;
  readonly ok: boolean;
  readonly detail?: string;
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Re-execute ONE vector through the live pipeline and compare it to its frozen expected fields.
 * This is the conformance assertion; a language runner mirrors it against its own runtime.
 */
export async function runVector(v: Vector): Promise<VectorResult> {
  const base = { name: v.name, suite: v.kind === 'expect-error' ? 'guard' : v.kind };
  try {
    if (v.kind === 'exec') {
      const seam = await seamFor(v.dialect, v.config);
      let result: unknown;
      let statements: EncodedStatement[] = [];
      let dbState: { query: string; rows: EncodedValue }[] = [];
      try {
        const called = await seam.call(v.entry, decodeValue(v.input) as Record<string, unknown>);
        result = called.result;
        statements = called.statements;
        dbState = await Promise.all((v.expectedDbState ?? []).map(async (s) => ({ query: s.query, rows: encodeValue(await seam.query(s.query)) })));
      } finally {
        await seam.close();
      }
      const problems: string[] = [];
      if (!eq(statements, v.expectedStatements)) problems.push(`statements ${JSON.stringify(statements)} != ${JSON.stringify(v.expectedStatements)}`);
      if (!eq(encodeValue(result), v.expectedResult)) problems.push(`result ${JSON.stringify(encodeValue(result))} != ${JSON.stringify(v.expectedResult)}`);
      if (!eq(dbState, v.expectedDbState ?? [])) problems.push(`db state ${JSON.stringify(dbState)} != ${JSON.stringify(v.expectedDbState)}`);
      if (v.relationFields !== undefined) problems.push(...checkRelationContent(result, v.relationFields));
      const cap = bakedCap(await built(v.dialect, v.config), v.entry) ?? null;
      if (cap !== v.expectedCap) problems.push(`baked find cap ${String(cap)} != ${String(v.expectedCap)}`);
      return { ...base, ok: problems.length === 0, detail: problems.length === 0 ? undefined : problems.join('; ') };
    }
    if (v.kind === 'expect-error') {
      const cap = bakedCap(await built(v.dialect, v.config), v.entry);
      const seam = await seamFor(v.dialect, v.config);
      let thrown: unknown;
      let statements: EncodedStatement[] = [];
      try {
        const called = await seam.call(v.entry, decodeValue(v.input) as Record<string, unknown>);
        statements = called.statements;
        assertFindHardLimit(called.result as unknown[], cap, v.entry);
      } catch (e) {
        thrown = e;
      } finally {
        await seam.close();
      }
      if (!(thrown instanceof LimitExceededError)) {
        return { ...base, ok: false, detail: `expected LimitExceededError, got ${thrown === undefined ? 'no throw' : thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)}` };
      }
      const got = { name: thrown.name, limit: thrown.limit, count: thrown.count, context: thrown.context, ...(thrown.model !== undefined ? { model: thrown.model } : {}) };
      const problems: string[] = [];
      if (!eq(got, v.expectedError)) problems.push(`error ${JSON.stringify(got)} != ${JSON.stringify(v.expectedError)}`);
      if (!eq(statements, v.expectedStatements)) problems.push(`statements ${JSON.stringify(statements)} != ${JSON.stringify(v.expectedStatements)}`);
      if (cap !== v.expectedCap) problems.push(`baked find cap ${String(cap)} != ${String(v.expectedCap)}`);
      return { ...base, ok: problems.length === 0, detail: problems.length === 0 ? undefined : problems.join('; ') };
    }
    if (v.kind === 'tx') {
      const db = seedDb(v.schema);
      const result = encodeValue(executeTransactionBundle(v.bundle, decodeValue(v.input) as never, { db }));
      const stateOk = (v.expectedDbState ?? []).every((s) => eq(encodeValue(db.prepare(s.query).all()), s.rows));
      db.close();
      const ok = eq(result, v.expectedResult) && stateOk;
      return { ...base, ok, detail: ok ? undefined : `result ${JSON.stringify(result)} != ${JSON.stringify(v.expectedResult)} (or db-state mismatch)` };
    }
    const got = dialectFor(v.dialect).orderByNulls(v.args.expr, v.args.dir, v.args.nulls);
    const ok = got === v.expected;
    return { ...base, ok, detail: ok ? undefined : `${JSON.stringify(got)} != ${JSON.stringify(v.expected)}` };
  } catch (e) {
    return { ...base, ok: false, detail: `threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}
