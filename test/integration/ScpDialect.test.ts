/**
 * WS6 (#26) SCP dialect integration — the compiled Postgres + MySQL SQL executes correctly
 * against REAL dockerized Postgres + MySQL, and yields RESULT PARITY with v1 direct execution
 * on the same dialect.
 *
 * This is the WS where docker genuinely applies (the SCP TS runtime seam is synchronous SQLite;
 * PG/MySQL are async). It proves BOTH #26 AC clauses that need a live DB:
 *   (a) the SCP-compiled dialect SQL (Backend Compile → render → `?`→`$N` for PG) executes on the
 *       real DB across CRUD + relations + write-tx;
 *   (b) result parity — the SCP path returns the same rows / leaves the same DB state as v1
 *       direct execution of the equivalent v1-SqlBuilder / v1-condition SQL on the SAME dialect.
 *
 * The SCP path renders + executes through the CURRENT shipped makeSQL runtime — reads via
 * `compileSelect` + `executeSQLAsync` (the op-independent leaf transport), writes/tx via
 * `compileWriteNode` + the batch bundles' derived `TransactionPlan` + `renderTxStatement`,
 * relation batches via `compileRelationOp` + its render (resolving the #46 deferred PG array cast
 * from the real keys). No mock, no hand-written SQL for the SCP side. The v1 side calls the REAL v1
 * SqlBuilders / DBConditions / `inferPgArrayType` (not hand-written expectations — avoids the WS3
 * faked-parity pattern).
 *
 * Run in-container via the compose `test-integration` service (TEST_DB_HOST=postgres /
 * TEST_MYSQL_HOST=mysql on the internal network), or locally with published ports + env.
 */

import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import { DBConditions } from '../../src/DBConditions';
import { postgresSqlBuilder } from '../../src/drivers/PostgresSqlBuilder';
import { mysqlSqlBuilder } from '../../src/drivers/MysqlSqlBuilder';
import {
  compileWriteNode,
  compileCreateManyBundle,
  compileUpdateManyBundle,
  compileDeleteManyBundle,
  compileRelationOp,
  executeSQLAsync,
  renderTxStatement,
  renderPlaceholders,
  resolvePgArrayCast,
  inferPgArrayType,
  mysqlConnectionPool,
  MiddlewareChain,
  type SqlBundle,
  type TxOp,
  type AsyncExecutionContext,
  type AsyncConnection,
  type RelationOp,
} from '../../src/scp';
import { compileSelect, type SelectDesc, type Dialect as MakeSQLDialect } from '../../src/scp/makesql';
import { emitBehaviorModule, leafHandlersAsync, PooledAsyncContext, pgConnectionPool, type EndpointSet } from '../../src/scp';
import { model, column } from '../../src/decorators';

// ── Connection config (env-driven; matches docker-compose.test.yml) ────────────

const PG = {
  host: process.env.TEST_DB_HOST || 'localhost',
  port: parseInt(process.env.TEST_DB_PORT || '5433', 10),
  database: process.env.TEST_DB_NAME || 'testdb',
  user: process.env.TEST_DB_USER || 'testuser',
  password: process.env.TEST_DB_PASSWORD || 'testpass',
};
const MY = {
  host: process.env.TEST_MYSQL_HOST || 'localhost',
  port: parseInt(process.env.TEST_MYSQL_PORT || '3307', 10),
  database: process.env.TEST_MYSQL_DB || 'testdb',
  user: process.env.TEST_MYSQL_USER || 'testuser',
  password: process.env.TEST_MYSQL_PASSWORD || 'testpass',
};

// ── Isolated table namespace (fix #37) ─────────────────────────────────────────
// This file owns dedicated `scp_posts` / `scp_users` tables that it seeds and tears
// down itself (see beforeAll/afterAll). This is TRUE data isolation from the shared
// `posts`/`users` seed that other integration files (e.g. Mysql.test.ts) wipe and
// reseed in their own beforeEach — under the single shared MySQL `testdb`, running
// all integration files together previously let that reseed clobber the base seed
// this file depended on, tripping the "rows exist" assertions. Mirrors WS7g's
// per-namespace live-DB isolation (scp_* databases). Same normative render/compile
// path and the same v1 builders/DBConditions — only the table identifiers change.
const T_POSTS = 'scp_posts';
const T_USERS = 'scp_users';
// #46 item 4: a `typed` table with a BIGINT / TEXT / BOOL / TIMESTAMP / NUMERIC key column each, for
// the all-element-types no-cast `= ANY($1)` IN-list live coverage on real PG + MySQL (TS leg).
const T_TYPED = 'scp_typed';
const TYPED_BIG_TS = [5000000001, 5000000002, 5000000003] as const;
const TYPED_TS_TS = ['2026-01-01 00:00:00', '2026-02-01 00:00:00', '2026-03-01 00:00:00'] as const;
// #47 item 1: composite-key relation tables — (tenant_id, doc_id) docs, (tenant_id, uid) users.
const T_DOCS2 = 'scp_docs2';
const T_USERS2 = 'scp_users2';
const T_REVS = 'scp_revs';
// Fixed UUIDs for the #46 uuid IN-list coverage (posts 1/2/3).
const POST_GUIDS = [
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333',
];

const REPO_ROOT = resolve(__dirname, '../..');

// ── #153 / #46 — the DECORATED models + DECLARED IN-list endpoints the emitter lowers ────────────
//
// This is the whole ORM-side input: metadata collectors and endpoint declarations, no SQL. vitest
// (esbuild) has no `emitDecoratorMetadata`, so a bare `@column()` carries no `design:type` and the
// non-INTEGER columns are pinned through the adapter's documented `columnTypes` escape hatch.

@model(T_POSTS)
class ScpPost {
  @column() id?: number;
  @column() user_id?: number;
  @column() title?: string;
  @column() view_count?: number;
  @column() guid?: string;
}

@model(T_TYPED)
class ScpTyped {
  @column() big?: number;
  @column() txt?: string;
  @column() flag?: boolean;
  @column() ts?: string;
  @column() amt?: string;
  @column() label?: string;
}

const IN_LIST_MODELS: Record<string, never> = { ScpPost, ScpTyped } as unknown as Record<string, never>;
const IN_LIST_COLUMN_TYPES = {
  columnTypes: {
    title: 'VARCHAR(255)', guid: 'UUID',
    big: 'BIGINT', txt: 'TEXT', flag: 'BOOLEAN', ts: 'TIMESTAMP', amt: 'NUMERIC(10,2)', label: 'TEXT',
  },
};

/** One IN-list endpoint per element type — each declares only a column and a parameter name. */
const IN_LIST_ENDPOINTS: EndpointSet = {
  byIds: { kind: 'read', model: ScpPost, select: ['id', 'title'], where: [{ kind: 'in', column: 'id', param: 'ids' }], order: 'id ASC' },
  byGuids: { kind: 'read', model: ScpPost, select: ['id', 'guid'], where: [{ kind: 'in', column: 'guid', param: 'guids' }], order: 'id ASC' },
  byBig: { kind: 'read', model: ScpTyped, select: ['label'], where: [{ kind: 'in', column: 'big', param: 'keys' }], order: 'label ASC' },
  byTxt: { kind: 'read', model: ScpTyped, select: ['label'], where: [{ kind: 'in', column: 'txt', param: 'keys' }], order: 'label ASC' },
  byFlag: { kind: 'read', model: ScpTyped, select: ['label'], where: [{ kind: 'in', column: 'flag', param: 'keys' }], order: 'label ASC' },
  byTs: { kind: 'read', model: ScpTyped, select: ['label'], where: [{ kind: 'in', column: 'ts', param: 'keys' }], order: 'label ASC' },
  byAmt: { kind: 'read', model: ScpTyped, select: ['label'], where: [{ kind: 'in', column: 'amt', param: 'keys' }], order: 'label ASC' },
};

/** The generated module's typed facade for {@link IN_LIST_ENDPOINTS}. */
interface InListApi {
  byIds(i: { ids: number[] }): Promise<Row[]>;
  byGuids(i: { guids: string[] }): Promise<Row[]>;
  byBig(i: { keys: unknown[] }): Promise<Row[]>;
  byTxt(i: { keys: unknown[] }): Promise<Row[]>;
  byFlag(i: { keys: unknown[] }): Promise<Row[]>;
  byTs(i: { keys: unknown[] }): Promise<Row[]>;
  byAmt(i: { keys: unknown[] }): Promise<Row[]>;
}

// ── The authored reads (SelectDesc builders, driven ONLY by the real `compileSelect` compiler) ──
//
// `SelectDesc.conditions` takes a v1 `ConditionObject` — exactly what the removed `whereEq`/
// `whereIn`/`inColumn` recorder sugar lowered to before handing it to the SAME `compileSelect` /
// `conditionsFor` compile step used here. So a plain-array condition (`{ id: [...] }`) still
// compiles to the dialect-appropriate IN-list form: PG keeps v1's `IN ($1, $2, …)` (`conditionsFor`
// returns the base `DBConditions` for postgres — byte-identical to the v1 comparison side below);
// MySQL/SQLite get the single-JSON-param `JSON_TABLE`/`json_each` form (`JsonArrayConditions`,
// `json-array.ts` — untouched by the recorder removal).

function byUserDesc(dialect: MakeSQLDialect, userId: number): SelectDesc {
  return { dialect, tableName: T_POSTS, select: 'id, user_id, title, view_count', conditions: { user_id: userId }, order: 'id ASC' };
}

/** #132 — the same read under a ROW LOCK (` FOR UPDATE` / ` FOR SHARE`), for the live lock legs. */
function lockedByUserDesc(dialect: MakeSQLDialect, userId: number, lock: 'forUpdate' | 'forShare'): SelectDesc {
  return { ...byUserDesc(dialect, userId), [lock]: true };
}

function byIdsDesc(dialect: MakeSQLDialect, ids: number[]): SelectDesc {
  return { dialect, tableName: T_POSTS, select: 'id, title', conditions: { id: ids }, order: 'id ASC' };
}

// #46 item 4 (MySQL leg only — see the deletion note below): the single-JSON IN-list binds every PG
// element type live through `T_TYPED`'s bigint/text/bool/timestamp/numeric key columns.
function byTypedDesc(dialect: MakeSQLDialect, col: string, keys: unknown[]): SelectDesc {
  return { dialect, tableName: T_TYPED, select: 'label', conditions: { [col]: keys }, order: 'label ASC' };
}

// #47 item 5 — the WHERE assembly (AND/OR group) + LIMIT/OFFSET tail, driven from v1's
// DBConditions/compileSelect (not a v2 hand-roll). An OR group over two eq members + a LIMIT+OFFSET.
function pageDesc(dialect: MakeSQLDialect, userId: number, otherId: number, offset: number): SelectDesc {
  return {
    dialect,
    tableName: T_POSTS,
    select: 'id, user_id, title',
    conditions: { __or__: [{ user_id: userId }, { user_id: otherId }] },
    order: 'id ASC',
    limit: 2,
    offset,
  };
}

// count() (#47 item 2 — v1 `DBModel._count`): `SELECT COUNT(*) as count FROM t[ WHERE …]`.
function countAllDesc(dialect: MakeSQLDialect): SelectDesc {
  return { dialect, tableName: T_POSTS, select: 'COUNT(*) as count' };
}
function countByUserDesc(dialect: MakeSQLDialect, userId: number): SelectDesc {
  return { dialect, tableName: T_POSTS, select: 'COUNT(*) as count', conditions: { user_id: userId } };
}

// ── The authored writes (TxOp builders via the real `compileWriteNode` SSoT write compiler) ──

function createPostOp(dialect: MakeSQLDialect): TxOp {
  return compileWriteNode(
    {
      component: 'Insert',
      ports: {
        table: T_POSTS,
        'values.user_id': { ref: ['user_id'] },
        'values.title': { ref: ['title'] },
        'values.content': { ref: ['content'] },
        returning: 'id, user_id, title, view_count',
      },
    } as never,
    dialect,
  );
}

// ── Async driver seams: render a compiled op (with dialect) + execute on the real DB ──

type Row = Record<string, unknown>;

async function pgQuery(pool: Pool, sql: string, params: unknown[]): Promise<Row[]> {
  const res = await pool.query(sql, params);
  return res.rows as Row[];
}

async function myQuery(conn: mysql.Connection, sql: string, params: unknown[]): Promise<Row[]> {
  const [rows] = await conn.query(sql, params);
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

/** bc evaluates ints to bigint; convert to a driver-bindable JS value (numbers for i32 range). */
function toPlain(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  return v;
}

/**
 * Adapt a raw async `query(sql, params)` function to the {@link AsyncExecutionContext} seam
 * `executeSQLAsync` (`../../src/scp/leaves`) needs to run a compiled read — a THIN environment
 * adapter (no SQL, no compile), exactly what a `LeafContext`/`AsyncLeafContext` is: the boundary
 * injection point, never a second compiler. `withConnection` is unused for a plain (non-tx) read.
 */
function asyncCtx(queryFn: (sql: string, params: unknown[]) => Promise<Row[]>): AsyncExecutionContext {
  const conn: AsyncConnection = {
    execute: (sql, params) => queryFn(sql, [...params]),
    async run(sql, params) {
      const rows = await queryFn(sql, [...params]);
      return { changes: rows.length, lastInsertRowid: 0 };
    },
  };
  const ctx: AsyncExecutionContext = { connectionFor: () => conn, middleware: new MiddlewareChain(), withConnection: () => ctx };
  return ctx;
}

/**
 * Compile a read with the REAL `compileSelect` SSoT compiler and execute it through the REAL
 * op-independent `executeSQLAsync` leaf transport — the SAME two-step pipeline the removed
 * `whereEq`/`whereIn` recorder sugar drove internally (compile → the ONE SQL transport). Also
 * renders the dialect placeholder form (`renderPlaceholders`) for the SQL-shape assertions.
 */
async function scpSelect(desc: SelectDesc, execAsync: AsyncExecutionContext): Promise<{ rows: Row[]; renderedSql: string }> {
  const compiled = compileSelect(desc);
  const rows = (await executeSQLAsync(
    { sql: compiled.sql, params: compiled.params, write: null },
    { execAsync, dialect: desc.dialect },
  )) as Row[];
  return { rows, renderedSql: renderPlaceholders(compiled.sql, desc.dialect) };
}

/**
 * Render a relation batch op's PG/MySQL SQL for a bound key set — the SAME render `runRelationOp`
 * performs: resolve the deferred PG array cast (#46) from the real keys, then `?`→`$N`. (The
 * MySQL/SQLite JSON single-param form carries no cast token, so it is a straight placeholder render.)
 */
function renderRelationSql(op: RelationOp, keys: unknown[]): string {
  const cast = op.dialect === 'postgres' ? resolvePgArrayCast(op.sql, keys) : op.sql;
  return renderPlaceholders(cast, op.dialect);
}

/**
 * Render + bind a COMPOSITE relation op for a set of parent key tuples (#47 item 1) — the SAME work
 * the composite `runRelationOp` does: `?`→`$N`, then bind the ONE JSON array-of-tuples param every
 * dialect's composite batch expands server-side (#159). Returns `{ sql, params }` for direct pool
 * execution. The composite key set carries no deferred PG cast: its key rows are cast from the
 * DECLARED column types at compile.
 */
function renderCompositeRelation(op: RelationOp, tuples: readonly unknown[][]): { sql: string; params: unknown[] } {
  return { sql: renderPlaceholders(op.sql, op.dialect), params: [JSON.stringify(tuples.map((t) => [...t]))] };
}

/** The composite fixtures' declared column types — what a model's `static columns` supplies. */
const COMPOSITE_COLUMNS: Record<string, Record<string, string>> = {
  [T_USERS2]: { tenant_id: 'INTEGER', uid: 'INTEGER', name: 'TEXT' },
  [T_DOCS2]: { tenant_id: 'INTEGER', doc_id: 'INTEGER', owner_id: 'INTEGER', title: 'TEXT' },
  [T_REVS]: { tenant_id: 'INTEGER', doc_id: 'INTEGER', rev: 'TEXT' },
};
const compositeColumnType = (table: string, column: string): string => {
  const t = COMPOSITE_COLUMNS[table]?.[column];
  if (t === undefined) throw new Error(`no declared column ${table}.${column}`);
  return t;
};

// ── Test lifecycle: connect, add the derive column, clean state ────────────────

let pgPool: Pool | null = null;
let myConn: mysql.Connection | null = null;

beforeAll(async () => {
  try {
    pgPool = new Pool(PG);
    await pgPool.query('SELECT 1');
    // Own, isolated tables (fix #37) — drop-then-create so the seed is deterministic
    // regardless of what other integration files did to the shared `posts`/`users`.
    await pgPool.query(`DROP TABLE IF EXISTS ${T_POSTS} CASCADE`);
    await pgPool.query(`DROP TABLE IF EXISTS ${T_USERS} CASCADE`);
    await pgPool.query(`
      CREATE TABLE ${T_USERS} (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL
      )`);
    await pgPool.query(`
      CREATE TABLE ${T_POSTS} (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES ${T_USERS}(id),
        title VARCHAR(255) NOT NULL,
        content TEXT,
        view_count INTEGER NOT NULL DEFAULT 0,
        guid UUID
      )`);
    // Deterministic seed: users id 1,2; posts id 1,2 (user 1) and id 3 (user 2)
    // — matches the parity fixtures (user_id=1 present, id IN (1,3) present). `guid` is a UUID
    // column (#46 uuid IN-list coverage): posts 1/2/3 carry the three POST_GUIDS values.
    await pgPool.query(`INSERT INTO ${T_USERS} (id, name) VALUES (1, 'Alice'), (2, 'Bob')`);
    await pgPool.query(`SELECT setval('${T_USERS}_id_seq', 2)`);
    await pgPool.query(`INSERT INTO ${T_POSTS} (id, user_id, title, content, view_count, guid) VALUES
      (1, 1, 'First Post', 'Hello World!', 100, '${POST_GUIDS[0]}'),
      (2, 1, 'Second Post', 'Another post', 0, '${POST_GUIDS[1]}'),
      (3, 2, 'Bob''s Post', 'Content here', 50, '${POST_GUIDS[2]}')`);
    await pgPool.query(`SELECT setval('${T_POSTS}_id_seq', 3)`);
    // #46 item 4: the typed IN-list table (bigint/text/bool/timestamp/numeric key columns).
    await pgPool.query(`DROP TABLE IF EXISTS ${T_TYPED} CASCADE`);
    await pgPool.query(`
      CREATE TABLE ${T_TYPED} (
        big BIGINT PRIMARY KEY, txt TEXT NOT NULL, flag BOOLEAN NOT NULL,
        ts TIMESTAMP NOT NULL, amt NUMERIC(10,2) NOT NULL, label TEXT NOT NULL
      )`);
    await pgPool.query(`INSERT INTO ${T_TYPED} VALUES
      (${TYPED_BIG_TS[0]}, 'alpha', TRUE,  '${TYPED_TS_TS[0]}', 10.50, 'A'),
      (${TYPED_BIG_TS[1]}, 'beta',  FALSE, '${TYPED_TS_TS[1]}', 20.25, 'B'),
      (${TYPED_BIG_TS[2]}, 'gamma', TRUE,  '${TYPED_TS_TS[2]}', 30.75, 'C')`);
    // #47 item 1: composite-key relation tables — two tenants share uid/doc_id (100 / 10).
    await pgPool.query(`DROP TABLE IF EXISTS ${T_DOCS2}`);
    await pgPool.query(`DROP TABLE IF EXISTS ${T_USERS2}`);
    await pgPool.query(`DROP TABLE IF EXISTS ${T_REVS}`);
    await pgPool.query(`CREATE TABLE ${T_USERS2} (tenant_id INT, uid INT, name TEXT, PRIMARY KEY (tenant_id, uid))`);
    await pgPool.query(`CREATE TABLE ${T_DOCS2} (tenant_id INT, doc_id INT, owner_id INT, title TEXT, PRIMARY KEY (tenant_id, doc_id))`);
    await pgPool.query(`CREATE TABLE ${T_REVS} (tenant_id INT, doc_id INT, rev TEXT, PRIMARY KEY (tenant_id, doc_id, rev))`);
    await pgPool.query(`INSERT INTO ${T_USERS2} VALUES (1,100,'Ada'),(1,101,'Alan'),(2,100,'Bob')`);
    await pgPool.query(`INSERT INTO ${T_DOCS2} VALUES (1,10,100,'Doc A1'),(1,11,101,'Doc B1'),(2,10,100,'Doc A2')`);
    await pgPool.query(`INSERT INTO ${T_REVS} VALUES (1,10,'r1'),(1,10,'r2'),(1,11,'r3'),(2,10,'r9')`);
  } catch (e) {
    throw new Error(`Postgres is required for WS6 integration but is not reachable at ${PG.host}:${PG.port} — ${(e as Error).message}`);
  }
  try {
    myConn = await mysql.createConnection({ ...MY, multipleStatements: false });
    await myConn.query('SELECT 1');
    await myConn.query(`DROP TABLE IF EXISTS ${T_POSTS}`);
    await myConn.query(`DROP TABLE IF EXISTS ${T_USERS}`);
    await myConn.query(`
      CREATE TABLE ${T_USERS} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL
      )`);
    await myConn.query(`
      CREATE TABLE ${T_POSTS} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        content TEXT,
        view_count INT NOT NULL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES ${T_USERS}(id)
      )`);
    await myConn.query(`INSERT INTO ${T_USERS} (id, name) VALUES (1, 'Alice'), (2, 'Bob')`);
    await myConn.query(`INSERT INTO ${T_POSTS} (id, user_id, title, content, view_count) VALUES
      (1, 1, 'First Post', 'Hello World!', 100),
      (2, 1, 'Second Post', 'Another post', 0),
      (3, 2, 'Bob''s Post', 'Content here', 50)`);
    // #46 item 4: the typed IN-list table (MySQL types; flag as TINYINT(1), ts DATETIME, amt DECIMAL).
    await myConn.query(`DROP TABLE IF EXISTS ${T_TYPED}`);
    await myConn.query(`
      CREATE TABLE ${T_TYPED} (
        big BIGINT PRIMARY KEY, txt VARCHAR(255) NOT NULL, flag TINYINT(1) NOT NULL,
        ts DATETIME NOT NULL, amt DECIMAL(10,2) NOT NULL, label VARCHAR(255) NOT NULL
      )`);
    await myConn.query(`INSERT INTO ${T_TYPED} VALUES
      (${TYPED_BIG_TS[0]}, 'alpha', 1, '${TYPED_TS_TS[0]}', 10.50, 'A'),
      (${TYPED_BIG_TS[1]}, 'beta',  0, '${TYPED_TS_TS[1]}', 20.25, 'B'),
      (${TYPED_BIG_TS[2]}, 'gamma', 1, '${TYPED_TS_TS[2]}', 30.75, 'C')`);
    // #47 item 1: composite-key relation tables (MySQL types).
    await myConn.query(`DROP TABLE IF EXISTS ${T_DOCS2}`);
    await myConn.query(`DROP TABLE IF EXISTS ${T_USERS2}`);
    await myConn.query(`DROP TABLE IF EXISTS ${T_REVS}`);
    await myConn.query(`CREATE TABLE ${T_USERS2} (tenant_id INT, uid INT, name VARCHAR(255), PRIMARY KEY (tenant_id, uid))`);
    await myConn.query(`CREATE TABLE ${T_DOCS2} (tenant_id INT, doc_id INT, owner_id INT, title VARCHAR(255), PRIMARY KEY (tenant_id, doc_id))`);
    await myConn.query(`CREATE TABLE ${T_REVS} (tenant_id INT, doc_id INT, rev VARCHAR(255), PRIMARY KEY (tenant_id, doc_id, rev))`);
    await myConn.query(`INSERT INTO ${T_USERS2} VALUES (1,100,'Ada'),(1,101,'Alan'),(2,100,'Bob')`);
    await myConn.query(`INSERT INTO ${T_DOCS2} VALUES (1,10,100,'Doc A1'),(1,11,101,'Doc B1'),(2,10,100,'Doc A2')`);
    await myConn.query(`INSERT INTO ${T_REVS} VALUES (1,10,'r1'),(1,10,'r2'),(1,11,'r3'),(2,10,'r9')`);
  } catch (e) {
    throw new Error(`MySQL is required for WS6 integration but is not reachable at ${MY.host}:${MY.port} — ${(e as Error).message}`);
  }
});

afterAll(async () => {
  // Tear down our isolated tables so no residue leaks to other files/runs.
  try {
    if (pgPool) {
      await pgPool.query(`DROP TABLE IF EXISTS ${T_TYPED} CASCADE`);
      await pgPool.query(`DROP TABLE IF EXISTS ${T_DOCS2} CASCADE`);
      await pgPool.query(`DROP TABLE IF EXISTS ${T_USERS2} CASCADE`);
      await pgPool.query(`DROP TABLE IF EXISTS ${T_REVS} CASCADE`);
      await pgPool.query(`DROP TABLE IF EXISTS ${T_POSTS} CASCADE`);
      await pgPool.query(`DROP TABLE IF EXISTS ${T_USERS} CASCADE`);
    }
  } catch {
    /* best-effort cleanup */
  }
  try {
    if (myConn) {
      await myConn.query(`DROP TABLE IF EXISTS ${T_TYPED}`);
      await myConn.query(`DROP TABLE IF EXISTS ${T_DOCS2}`);
      await myConn.query(`DROP TABLE IF EXISTS ${T_USERS2}`);
      await myConn.query(`DROP TABLE IF EXISTS ${T_REVS}`);
      await myConn.query(`DROP TABLE IF EXISTS ${T_POSTS}`);
      await myConn.query(`DROP TABLE IF EXISTS ${T_USERS}`);
    }
  } catch {
    /* best-effort cleanup */
  }
  if (pgPool) await pgPool.end();
  if (myConn) await myConn.end();
});

// ── Postgres ───────────────────────────────────────────────────────────────────

describe('WS6 integration — Postgres: SCP-compiled SQL executes + parity with v1 direct execution', () => {
  const execAsync = () => asyncCtx((sql, params) => pgQuery(pgPool!, sql, params));

  it('SELECT by user_id: SCP rows == v1 direct execution (`$N` placeholders on real PG)', async () => {
    // Assert the emitted PG SQL (`$N`) via the real render axis, then execute via the real async
    // runtime (compileSelect + executeSQLAsync).
    const { rows: scpRows, renderedSql } = await scpSelect(byUserDesc('postgres', 1), execAsync());
    expect(renderedSql).toBe(`SELECT id, user_id, title, view_count FROM ${T_POSTS} WHERE user_id = $1 ORDER BY id ASC`);

    // v1 direct execution: build the equivalent WHERE via v1 DBConditions, convert `?`→`$N`.
    const v1Params: unknown[] = [];
    const v1Where = new DBConditions({ user_id: 1 }).compile(v1Params);
    let i = 0;
    const v1Sql = `SELECT id, user_id, title, view_count FROM ${T_POSTS} WHERE ${v1Where} ORDER BY id ASC`.replace(/\?/g, () => `$${++i}`);
    const v1Rows = await pgQuery(pgPool!, v1Sql, v1Params);

    expect(scpRows).toEqual(v1Rows);
    expect(scpRows.length).toBeGreaterThan(0);
    for (const r of scpRows) expect(r.user_id).toBe(1);
  });

  it('#132 row locks: ` FOR UPDATE` and ` FOR SHARE` both EXECUTE on real PG; rows unchanged', async () => {
    // The locking clause is orthogonal to the row RESULT: the same read under either lock returns the
    // unlocked rows. What is proven LIVE is that PostgreSQL PARSES + EXECUTES both tails (a wrong
    // keyword — e.g. MySQL 5.x's `LOCK IN SHARE MODE` — errors out here).
    const plain = await scpSelect(byUserDesc('postgres', 1), execAsync());
    for (const [lock, tail] of [['forUpdate', 'FOR UPDATE'], ['forShare', 'FOR SHARE']] as const) {
      const { rows, renderedSql } = await scpSelect(lockedByUserDesc('postgres', 1, lock), execAsync());
      expect(renderedSql).toBe(
        `SELECT id, user_id, title, view_count FROM ${T_POSTS} WHERE user_id = $1 ORDER BY id ASC ${tail}`,
      );
      expect(rows).toEqual(plain.rows);
    }
    expect(plain.rows.length).toBeGreaterThan(0);
  });

  // ── #153 / #46 — the PG primary-read no-cast `= ANY($1)` IN-list, restored on the EMITTER ──────
  //
  // A declared `in` predicate lowers to the dialect's value-length-INDEPENDENT membership form
  // (`inListPredicate`): on PostgreSQL `col = ANY(?)` with NO element-type cast. The cast is what
  // broke: `inferPgArrayType` sees only the values, so an EMPTY int list infers `text[]` (→ `integer
  // = text`) and a uuid list is indistinguishable from text (→ `uuid = text`). With no cast PG infers
  // the array type FROM THE COLUMN, which is right for every element type — proven live below on
  // int / uuid / bigint / text / bool / timestamp / numeric, empty lists included.
  //
  // The path under test is the REAL one end-to-end: decorated model → `emitBehaviorModule` →
  // `bc generate` → `bindTypedAsync(leafHandlersAsync)` → this live Postgres.
  describe('#46 no-cast `= ANY($1)` IN-list — decorated model → emitter → bc generate → live PG', () => {
    let inWorkDir: string;
    let emittedIn: string;
    let q: InListApi;

    beforeAll(async () => {
      const emitted = emitBehaviorModule({
        behavior: 'InLists',
        dialect: 'postgres',
        leafImport: resolve(REPO_ROOT, 'src/scp/leaf-transport.js'),
        endpoints: IN_LIST_ENDPOINTS,
        models: (n) => IN_LIST_MODELS[n],
        columnOptions: IN_LIST_COLUMN_TYPES,
      });
      emittedIn = emitted.source;
      inWorkDir = mkdtempSync(join(REPO_ROOT, '.emit-e2e-'));
      const authored = join(inWorkDir, 'in-lists.ts');
      writeFileSync(authored, emitted.source, 'utf8');
      const out = join(inWorkDir, 'in-lists-generated.ts');
      execFileSync(
        join(REPO_ROOT, 'node_modules/.bin/bc'),
        ['generate', '--lang', 'typescript-native', '--from', authored, '--behavior', 'InLists', '--out', out],
        { cwd: REPO_ROOT, stdio: 'pipe' },
      );
      const generated = (await import(out)) as { bindTypedAsync: (h: ReturnType<typeof leafHandlersAsync>) => InListApi };
      const execAsyncCtx = new PooledAsyncContext(pgConnectionPool(pgPool as never));
      q = generated.bindTypedAsync(leafHandlersAsync({ execAsync: execAsyncCtx, dialect: 'postgres' }));
    }, 120_000);

    afterAll(() => {
      if (inWorkDir !== undefined) rmSync(inWorkDir, { recursive: true, force: true });
    });

    it('SELECT IN-list on an INT column: no-cast `= ANY(?)` — #46; PG infers int[]; SCP rows == v1', async () => {
      expect(emittedIn).toContain(`SELECT id, title FROM ${T_POSTS} WHERE id = ANY(?) ORDER BY id ASC`);
      expect(emittedIn).not.toContain('::text[]');
      const scpRows = await q.byIds({ ids: [1, 3] });
      expect(scpRows.map((r) => Number(r.id))).toEqual([1, 3]);

      // v1 RESULT parity: v1's IN-list expanded to `id IN ($1, $2)` (DBConditions). Same rows.
      const v1Params: unknown[] = [];
      const v1Where = new DBConditions({ id: [1, 3] }).compile(v1Params);
      let i = 0;
      const v1Sql = `SELECT id, title FROM ${T_POSTS} WHERE ${v1Where} ORDER BY id ASC`.replace(/\?/g, () => `$${++i}`);
      const v1Rows = await pgQuery(pgPool!, v1Sql, v1Params);
      expect(scpRows).toEqual(v1Rows);
    });

    it('SELECT IN-list EMPTY int array: `= ANY(?)` with [] → ZERO rows, no error — #46; == v1 `1 = 0`', async () => {
      // The blocker the cast caused: `inferPgArrayType([])` = `text[]` → `integer = text` at PLAN time.
      expect(await q.byIds({ ids: [] })).toEqual([]);
    });

    it('SELECT IN-list on a UUID column (non-empty): `= ANY(?)` → PG infers uuid[]; correct rows — #46', async () => {
      expect(emittedIn).toContain(`SELECT id, guid FROM ${T_POSTS} WHERE guid = ANY(?) ORDER BY id ASC`);
      const scpRows = await q.byGuids({ guids: [POST_GUIDS[0], POST_GUIDS[2]] });
      expect(scpRows.map((r) => Number(r.id))).toEqual([1, 3]);
      expect(scpRows.map((r) => String(r.guid))).toEqual([POST_GUIDS[0], POST_GUIDS[2]]);
    });

    it('SELECT IN-list EMPTY uuid array: `= ANY(?)` with [] → ZERO rows, no error — #46', async () => {
      expect(await q.byGuids({ guids: [] })).toEqual([]);
    });

    // #46 item 4 — every PG element type binds live through the no-cast `= ANY(?)` IN-list. Each case
    // selects the stable `label`, so `[A,C]` is the dialect-invariant expected result; the test proves
    // the ARRAY BINDING of bigint / text / bool / timestamp / numeric through `pg`.
    const pgTypeCases: { entry: keyof InListApi & string; col: string; keys: unknown[] }[] = [
      { entry: 'byBig', col: 'big', keys: [TYPED_BIG_TS[0], TYPED_BIG_TS[2]] },
      { entry: 'byTxt', col: 'txt', keys: ['alpha', 'gamma'] },
      { entry: 'byFlag', col: 'flag', keys: [true] },
      { entry: 'byTs', col: 'ts', keys: [TYPED_TS_TS[0], TYPED_TS_TS[2]] },
      { entry: 'byAmt', col: 'amt', keys: ['10.50', '30.75'] },
    ];
    for (const c of pgTypeCases) {
      it(`SELECT IN-list on a ${c.col} column: no-cast \`= ANY(?)\` binds live — #46 item 4`, async () => {
        expect(emittedIn).toContain(`SELECT label FROM ${T_TYPED} WHERE ${c.col} = ANY(?) ORDER BY label ASC`);
        const rows = (await (q[c.entry] as (i: Record<string, unknown>) => Promise<Row[]>)({ keys: c.keys })) as Row[];
        expect(rows.map((r) => String(r.label))).toEqual(['A', 'C']);
      });
    }
  });

  // count() (#47 item 2) — `SELECT COUNT(*) as count FROM t[ WHERE …]` executes live + matches v1.
  it('COUNT(*) all rows: SCP `SELECT COUNT(*) as count` == v1 _count (real PG)', async () => {
    const { rows: scpRows, renderedSql } = await scpSelect(countAllDesc('postgres'), execAsync());
    expect(renderedSql).toBe(`SELECT COUNT(*) as count FROM ${T_POSTS}`);
    // v1 _count returns parseInt(rows[0].count); the same one-row [{count}] shape is asserted.
    const v1Rows = await pgQuery(pgPool!, `SELECT COUNT(*) as count FROM ${T_POSTS}`, []);
    expect(Number(scpRows[0].count)).toBe(Number(v1Rows[0].count));
    expect(Number(scpRows[0].count)).toBe(3);
  });

  it('COUNT(*) WHERE user_id: SCP == v1 _count with condition (real PG)', async () => {
    const { rows: scpRows, renderedSql } = await scpSelect(countByUserDesc('postgres', 1), execAsync());
    expect(renderedSql).toBe(`SELECT COUNT(*) as count FROM ${T_POSTS} WHERE user_id = $1`);
    expect(Number(scpRows[0].count)).toBe(2);
    // Empty result → 0 (not null): a real DB always returns one COUNT row.
    const { rows: empty } = await scpSelect(countByUserDesc('postgres', 999), execAsync());
    expect(Number(empty[0].count)).toBe(0);
  });

  // #47 item 5 — the OR-group WHERE + LIMIT/OFFSET tail (v1-sourced) execute live on PG and
  // return the SAME rows as v1 direct execution of the equivalent DBConditions OR + inline LIMIT.
  it('OR-group WHERE + LIMIT/OFFSET: SCP rows == v1 direct execution (real PG)', async () => {
    const { rows: scpRows } = await scpSelect(pageDesc('postgres', 1, 2, 0), execAsync());
    // v1 direct: an OR over the two user_ids + inline LIMIT/OFFSET (v1 inlines the count as a literal).
    const v1Params: unknown[] = [];
    const v1Where = new DBConditions({ __or__: [{ user_id: 1 }, { user_id: 2 }] }).compile(v1Params);
    let i = 0;
    const v1Sql = `SELECT id, user_id, title FROM ${T_POSTS} WHERE ${v1Where} ORDER BY id ASC LIMIT 2 OFFSET 0`.replace(/\?/g, () => `$${++i}`);
    const v1Rows = await pgQuery(pgPool!, v1Sql, v1Params);
    expect(scpRows).toEqual(v1Rows);
    expect(scpRows.length).toBe(2); // LIMIT 2 caps the page (all 3 posts belong to user 1 or 2)
  });

  it('INSERT + RETURNING: SCP persists + returns; parity with v1 postgresSqlBuilder', async () => {
    // The compiled base write statement (canonical column order) — no transaction plan needed here.
    const input = { user_id: 2, title: 'SCP PG Post', content: 'from scp' };
    const { sql, params } = renderTxStatement(createPostOp('postgres'), input as never, 'postgres');
    // The SCP Insert compiles columns in the canonical (alphabetical) order (WS3 SSoT), so the
    // column list is `content, title, user_id` regardless of declaration order.
    expect(sql).toBe(`INSERT INTO ${T_POSTS} (content, title, user_id) VALUES ($1, $2, $3) RETURNING id, user_id, title, view_count`);

    const scpRows = await pgQuery(pgPool!, sql, params.map(toPlain));
    expect(scpRows.length).toBe(1);
    expect(scpRows[0]).toMatchObject({ user_id: 2, title: 'SCP PG Post', view_count: 0 });

    // v1 parity: the REAL v1 builder produces the equivalent INSERT (canonical column order,
    // matching DBModel._insert's Object.keys().sort()), converted `?`→`$N`.
    const v1 = postgresSqlBuilder.buildInsert({
      tableName: T_POSTS,
      columns: ['content', 'title', 'user_id'],
      records: [{ user_id: 2, title: 'v1 PG Post', content: 'from v1' }],
      returning: 'id, user_id, title, view_count',
    });
    let i = 0;
    const v1Sql = v1.sql.replace(/\?/g, () => `$${++i}`);
    const v1Rows = await pgQuery(pgPool!, v1Sql, v1.params as unknown[]);
    expect(v1Rows.length).toBe(1);
    // Same shape + same non-id column values (ids differ by sequence).
    expect(Object.keys(scpRows[0]).sort()).toEqual(Object.keys(v1Rows[0]).sort());
    expect(v1Rows[0]).toMatchObject({ user_id: 2, title: 'v1 PG Post', view_count: 0 });

    // Cleanup the two inserted rows.
    await pgPool!.query(`DELETE FROM ${T_POSTS} WHERE id = ANY($1::int[])`, [[scpRows[0].id, v1Rows[0].id]]);
  });

  it('read-relation batch (belongsTo author, INT key): `$1::int[]` (NOT text[]) — #46; SCP == v1', async () => {
    // scp_posts.user_id → scp_users.id (belongsTo). Compile the relation op, render its batch SELECT.
    const op: RelationOp = compileRelationOp({
      name: 'author',
      kind: 'belongsTo',
      targetTable: T_USERS,
      select: ['id', 'name'],
      parentKey: 'user_id',
      targetKey: 'id',
      dialect: 'postgres',
    });
    const parentRows = await pgQuery(pgPool!, `SELECT id, user_id FROM ${T_POSTS} ORDER BY id`, []);
    const keys = [...new Set(parentRows.map((r) => Number(r.user_id)))];
    // #46: the deferred cast resolves to `int[]` from the real int keys — v1's live-correct form.
    const scpSql = renderRelationSql(op, keys);
    expect(scpSql).toBe(`SELECT id, name FROM ${T_USERS} WHERE ${T_USERS}.id = ANY($1::int[])`);
    const scpChildren = await pgQuery(pgPool!, scpSql, [keys]);

    // v1 parity: the REAL v1 LazyRelation `= ANY(?::type[])` form over the same keys (`?`→`$N`).
    const v1Type = inferPgArrayType(keys);
    const v1Sql = `SELECT id, name FROM ${T_USERS} WHERE ${T_USERS}.id = ANY($1::${v1Type})`;
    const v1Children = await pgQuery(pgPool!, v1Sql, [keys]);
    expect(scpChildren).toEqual(v1Children);
    expect(scpChildren.length).toBe(keys.length);
  });

  // #47 item 1 / #159 — COMPOSITE-key relation batch binds + executes live on PG (ONE JSON tuple param
  // expanded to typed key rows), and the (tenant_id, …) tuple correctly disambiguates the two tenants
  // sharing uid/doc_id.
  it('composite belongsTo (tenant_id, owner_id) → users2: the single JSON key-tuple param binds live on PG', async () => {
    const op: RelationOp = compileRelationOp({
      name: 'owner', kind: 'belongsTo', targetTable: T_USERS2, select: ['tenant_id', 'uid', 'name'],
      parentKeys: ['tenant_id', 'owner_id'], targetKeys: ['tenant_id', 'uid'], dialect: 'postgres',
    }, compositeColumnType);
    const docs = await pgQuery(pgPool!, `SELECT tenant_id, doc_id, owner_id FROM ${T_DOCS2} ORDER BY tenant_id, doc_id`, []);
    const tuples = docs.map((d) => [Number(d.tenant_id), Number(d.owner_id)]);
    const { sql, params } = renderCompositeRelation(op, tuples);
    expect(sql).toContain('JOIN (SELECT (_t->>0)::int AS key0, (_t->>1)::int AS key1 FROM json_array_elements($1::json) AS _t) AS _keys');
    expect(params).toHaveLength(1); // the WHOLE key set is ONE param, whatever its length
    const children = await pgQuery(pgPool!, sql, params);
    // (2,100) must resolve to Bob (tenant 2), NOT Ada (tenant 1) — the composite key disambiguates.
    const bob = children.find((c) => Number(c.tenant_id) === 2 && Number(c.uid) === 100);
    expect(bob?.name).toBe('Bob');
    const ada = children.find((c) => Number(c.tenant_id) === 1 && Number(c.uid) === 100);
    expect(ada?.name).toBe('Ada');
  });

  it('composite hasMany (tenant_id, doc_id) → revs: per-tenant revisions bind live on PG', async () => {
    const op: RelationOp = compileRelationOp({
      name: 'revisions', kind: 'hasMany', targetTable: T_REVS, select: ['tenant_id', 'doc_id', 'rev'],
      parentKeys: ['tenant_id', 'doc_id'], targetKeys: ['tenant_id', 'doc_id'], order: 'rev ASC', dialect: 'postgres',
    }, compositeColumnType);
    const tuples = [[1, 10], [2, 10]]; // same doc_id 10 across two tenants
    const { sql, params } = renderCompositeRelation(op, tuples);
    const rows = await pgQuery(pgPool!, sql, params);
    const t1 = rows.filter((r) => Number(r.tenant_id) === 1).map((r) => String(r.rev)).sort();
    const t2 = rows.filter((r) => Number(r.tenant_id) === 2).map((r) => String(r.rev)).sort();
    expect(t1).toEqual(['r1', 'r2']); // tenant 1 doc 10 → r1,r2 (NOT r9)
    expect(t2).toEqual(['r9']); // tenant 2 doc 10 → r9 only
  });

  it('composite hasMany + per-parent LIMIT (tenant_id, doc_id) → revs: STATIC LATERAL caps live on PG (#47 last gap)', async () => {
    const op: RelationOp = compileRelationOp({
      name: 'latestRev', kind: 'hasMany', targetTable: T_REVS, select: ['tenant_id', 'doc_id', 'rev'],
      parentKeys: ['tenant_id', 'doc_id'], targetKeys: ['tenant_id', 'doc_id'], order: 'rev DESC', limit: 1, dialect: 'postgres',
    }, compositeColumnType);
    const tuples = [[1, 10], [1, 11], [2, 10]];
    const { sql, params } = renderCompositeRelation(op, tuples);
    // STATIC composite-LIMITED = the v1 LATERAL window over the ONE JSON key-tuple param's key rows.
    expect(sql).toContain('FROM (SELECT (_t->>0)::int AS key0, (_t->>1)::int AS key1 FROM json_array_elements($1::json) AS _t) AS _keys');
    expect(params).toHaveLength(1);
    expect(sql).toContain('CROSS JOIN LATERAL');
    expect(sql).toContain('ORDER BY rev DESC LIMIT 1');
    const rows = await pgQuery(pgPool!, sql, params);
    // Each parent keeps exactly its highest rev: (1,10)→r2 [capped from r1,r2], (1,11)→r3, (2,10)→r9.
    const got = rows
      .map((r) => `${Number(r.tenant_id)}/${Number(r.doc_id)}=${String(r.rev)}`)
      .sort();
    expect(got).toEqual(['1/10=r2', '1/11=r3', '2/10=r9']);
  });

});

// ── MySQL ───────────────────────────────────────────────────────────────────────

describe('WS6 integration — MySQL: SCP-compiled SQL executes + parity with v1 direct execution', () => {
  const execAsync = () => asyncCtx((sql, params) => myQuery(myConn!, sql, params));

  it('SELECT by user_id: SCP rows == v1 direct execution (`?` placeholders on real MySQL)', async () => {
    const { rows: scpRows, renderedSql } = await scpSelect(byUserDesc('mysql', 1), execAsync());
    expect(renderedSql).toBe(`SELECT id, user_id, title, view_count FROM ${T_POSTS} WHERE user_id = ? ORDER BY id ASC`);

    const v1Params: unknown[] = [];
    const v1Where = new DBConditions({ user_id: 1 }).compile(v1Params);
    const v1Sql = `SELECT id, user_id, title, view_count FROM ${T_POSTS} WHERE ${v1Where} ORDER BY id ASC`;
    const v1Rows = await myQuery(myConn!, v1Sql, v1Params);
    expect(scpRows).toEqual(v1Rows);
    expect(scpRows.length).toBeGreaterThan(0);
  });

  it('#132 row locks: ` FOR UPDATE` and ` FOR SHARE` both EXECUTE on real MySQL; rows unchanged', async () => {
    // MySQL 8.0 parses `FOR SHARE` (the 5.x spelling was `LOCK IN SHARE MODE`); the row RESULT is
    // unchanged by either lock. The tail text is the SAME one PG gets — one aggregation point, no
    // per-dialect lock branch.
    const plain = await scpSelect(byUserDesc('mysql', 1), execAsync());
    for (const [lock, tail] of [['forUpdate', 'FOR UPDATE'], ['forShare', 'FOR SHARE']] as const) {
      const { rows, renderedSql } = await scpSelect(lockedByUserDesc('mysql', 1, lock), execAsync());
      expect(renderedSql).toBe(
        `SELECT id, user_id, title, view_count FROM ${T_POSTS} WHERE user_id = ? ORDER BY id ASC ${tail}`,
      );
      expect(rows).toEqual(plain.rows);
    }
    expect(plain.rows.length).toBeGreaterThan(0);
  });

  it('SELECT IN-list: single-JSON-param form (no cast token — MySQL); SCP rows == v1', async () => {
    const { rows: scpRows, renderedSql } = await scpSelect(byIdsDesc('mysql', [1, 3]), execAsync());
    // MySQL uses the single-JSON-param IN-list (epic #43/#45), NOT `IN (?, ?)`; NO PG cast token.
    expect(renderedSql).toContain('JSON_TABLE');
    expect(renderedSql).not.toContain('PG_ARRAY_CAST');
    expect(scpRows.map((r) => Number(r.id))).toEqual([1, 3]);
  });

  // #46 item 4 — every element type binds live through the single-JSON MySQL IN-list form
  // (`JsonArrayConditions`, `json-array.ts` — unaffected by the recorder removal). The BOOLEAN
  // element is encoded `1`/`0` in the JSON param (MySQL's JSON_UNQUOTE would stringify a JSON `true`
  // to `'true'` → coerce to 0 against TINYINT). Each selects the stable `label` → [A,C].
  const myTypeCases: { entry: string; col: string; keys: unknown[] }[] = [
    { entry: 'ByBig', col: 'big', keys: [TYPED_BIG_TS[0], TYPED_BIG_TS[2]] },
    { entry: 'ByTxt', col: 'txt', keys: ['alpha', 'gamma'] },
    { entry: 'ByFlag', col: 'flag', keys: [true] },
    { entry: 'ByTs', col: 'ts', keys: [TYPED_TS_TS[0], TYPED_TS_TS[2]] },
    { entry: 'ByAmt', col: 'amt', keys: [10.5, 30.75] },
  ];
  for (const c of myTypeCases) {
    it(`SELECT IN-list ${c.entry}: single-JSON form binds live on MySQL — #46 item 4`, async () => {
      const { rows: scpRows } = await scpSelect(byTypedDesc('mysql', c.col, c.keys), execAsync());
      expect(scpRows.map((r) => String(r.label))).toEqual(['A', 'C']);
    });
  }

  // count() (#47 item 2) — `SELECT COUNT(*) as count FROM t[ WHERE …]` executes live on MySQL.
  it('COUNT(*) all rows + WHERE: SCP `SELECT COUNT(*) as count` on real MySQL', async () => {
    const all = await scpSelect(countAllDesc('mysql'), execAsync());
    expect(all.renderedSql).toBe(`SELECT COUNT(*) as count FROM ${T_POSTS}`);
    expect(Number(all.rows[0].count)).toBe(3);
    const byUser = await scpSelect(countByUserDesc('mysql', 1), execAsync());
    expect(Number(byUser.rows[0].count)).toBe(2);
  });

  // #47 item 5 — OR-group WHERE + LIMIT/OFFSET tail (v1-sourced) execute live on MySQL, rows == v1.
  it('OR-group WHERE + LIMIT/OFFSET: SCP rows == v1 direct execution (real MySQL)', async () => {
    const { rows: scpRows } = await scpSelect(pageDesc('mysql', 1, 2, 0), execAsync());
    const v1Params: unknown[] = [];
    const v1Where = new DBConditions({ __or__: [{ user_id: 1 }, { user_id: 2 }] }).compile(v1Params);
    const v1Sql = `SELECT id, user_id, title FROM ${T_POSTS} WHERE ${v1Where} ORDER BY id ASC LIMIT 2 OFFSET 0`;
    const v1Rows = await myQuery(myConn!, v1Sql, v1Params);
    expect(scpRows).toEqual(v1Rows);
    expect(scpRows.length).toBe(2);
  });

  it('INSERT: SCP persists (MySQL keeps `?`, RETURNING stripped by re-select) + parity with v1', async () => {
    const input = { user_id: 2, title: 'SCP MY Post', content: 'from scp' };
    const { sql, params } = renderTxStatement(createPostOp('mysql'), input as never, 'mysql');
    // MySQL has no native RETURNING; the compiled text carries it (driver simulates via re-select).
    // For the raw mysql2 seam we execute the INSERT sans RETURNING, then re-select — the v1
    // MysqlSqlBuilder + mysql.ts do the same (RETURNING stripped, re-select the inserted PK).
    const insertSql = sql.replace(/\s+RETURNING\s+.+$/i, '');
    // Canonical (alphabetical) column order (WS3 SSoT): `content, title, user_id`.
    expect(insertSql).toBe(`INSERT INTO ${T_POSTS} (content, title, user_id) VALUES (?, ?, ?)`);
    const res = await myConn!.query(insertSql, params.map(toPlain));
    const scpId = (res[0] as mysql.ResultSetHeader).insertId;
    const scpRows = await myQuery(myConn!, `SELECT id, user_id, title, view_count FROM ${T_POSTS} WHERE id = ?`, [scpId]);
    expect(scpRows[0]).toMatchObject({ user_id: 2, title: 'SCP MY Post', view_count: 0 });

    // v1 parity: the REAL v1 builder produces the equivalent INSERT (canonical column order).
    const v1 = mysqlSqlBuilder.buildInsert({
      tableName: T_POSTS,
      columns: ['content', 'title', 'user_id'],
      records: [{ user_id: 2, title: 'v1 MY Post', content: 'from v1' }],
    });
    const v1res = await myConn!.query(v1.sql, v1.params as unknown[]);
    const v1Id = (v1res[0] as mysql.ResultSetHeader).insertId;
    const v1Rows = await myQuery(myConn!, `SELECT id, user_id, title, view_count FROM ${T_POSTS} WHERE id = ?`, [v1Id]);
    expect(Object.keys(scpRows[0]).sort()).toEqual(Object.keys(v1Rows[0]).sort());
    expect(v1Rows[0]).toMatchObject({ user_id: 2, title: 'v1 MY Post', view_count: 0 });

    await myConn!.query(`DELETE FROM ${T_POSTS} WHERE id IN (?, ?)`, [scpId, v1Id]);
  });

  it('read-relation batch (belongsTo author): SCP single-JSON-param batch == v1 on real MySQL', async () => {
    const op: RelationOp = compileRelationOp({
      name: 'author',
      kind: 'belongsTo',
      targetTable: T_USERS,
      select: ['id', 'name'],
      parentKey: 'user_id',
      targetKey: 'id',
      dialect: 'mysql',
    });
    const parentRows = await myQuery(myConn!, `SELECT id, user_id FROM ${T_POSTS} ORDER BY id`, []);
    const keys = [...new Set(parentRows.map((r) => Number(r.user_id)))];
    // MySQL binds the deduped key set as ONE JSON param (server-side expansion); NO PG cast token.
    const scpSql = renderRelationSql(op, keys);
    expect(scpSql).not.toContain('PG_ARRAY_CAST');
    const scpChildren = await myQuery(myConn!, scpSql, [JSON.stringify(keys)]);

    const v1Params: unknown[] = [];
    const v1Where = new DBConditions({ id: keys }).compile(v1Params);
    const v1Sql = `SELECT id, name FROM ${T_USERS} WHERE ${v1Where}`;
    const v1Children = await myQuery(myConn!, v1Sql, v1Params);
    // Same rows (order-independent — the JSON form does not impose the IN-list order).
    expect([...scpChildren].sort((a, b) => Number(a.id) - Number(b.id))).toEqual(v1Children);
    expect(scpChildren.length).toBe(keys.length);
  });

  // #47 item 1 — COMPOSITE-key relation batch binds + executes live on MySQL (single-JSON tuple
  // param, `(k1,k2) IN (SELECT … JSON_TABLE …)`), disambiguating tenants sharing uid/doc_id.
  it('composite belongsTo (tenant_id, owner_id): single-JSON tuple form binds live on MySQL', async () => {
    const op: RelationOp = compileRelationOp({
      name: 'owner', kind: 'belongsTo', targetTable: T_USERS2, select: ['tenant_id', 'uid', 'name'],
      parentKeys: ['tenant_id', 'owner_id'], targetKeys: ['tenant_id', 'uid'], dialect: 'mysql',
    }, compositeColumnType);
    expect(op.sql).toContain('JSON_TABLE');
    const tuples = [[1, 100], [2, 100]]; // same uid 100 across two tenants
    const { sql, params } = renderCompositeRelation(op, tuples);
    const children = await myQuery(myConn!, sql, params);
    const bob = children.find((c) => Number(c.tenant_id) === 2 && Number(c.uid) === 100);
    const ada = children.find((c) => Number(c.tenant_id) === 1 && Number(c.uid) === 100);
    expect(bob?.name).toBe('Bob');
    expect(ada?.name).toBe('Ada');
    expect(children.length).toBe(2); // exactly the two composite matches, no cross-tenant bleed
  });

  it('composite hasMany (tenant_id, doc_id) → revs: per-tenant revisions bind live on MySQL', async () => {
    const op: RelationOp = compileRelationOp({
      name: 'revisions', kind: 'hasMany', targetTable: T_REVS, select: ['tenant_id', 'doc_id', 'rev'],
      parentKeys: ['tenant_id', 'doc_id'], targetKeys: ['tenant_id', 'doc_id'], order: 'rev ASC', dialect: 'mysql',
    }, compositeColumnType);
    const { sql, params } = renderCompositeRelation(op, [[1, 10], [2, 10]]);
    const rows = await myQuery(myConn!, sql, params);
    const t1 = rows.filter((r) => Number(r.tenant_id) === 1).map((r) => String(r.rev)).sort();
    const t2 = rows.filter((r) => Number(r.tenant_id) === 2).map((r) => String(r.rev)).sort();
    expect(t1).toEqual(['r1', 'r2']);
    expect(t2).toEqual(['r9']);
  });

  it('composite hasMany + per-parent LIMIT (tenant_id, doc_id) → revs: STATIC ROW_NUMBER caps live on MySQL (#47 last gap)', async () => {
    const op: RelationOp = compileRelationOp({
      name: 'latestRev', kind: 'hasMany', targetTable: T_REVS, select: ['tenant_id', 'doc_id', 'rev'],
      parentKeys: ['tenant_id', 'doc_id'], targetKeys: ['tenant_id', 'doc_id'], order: 'rev DESC', limit: 1, dialect: 'mysql',
    }, compositeColumnType);
    const { sql, params } = renderCompositeRelation(op, [[1, 10], [1, 11], [2, 10]]);
    // STATIC composite-LIMITED = v1 ROW_NUMBER window + static JSON key-set predicate (no tuple-IN).
    expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY tenant_id, doc_id ORDER BY rev DESC)');
    expect(sql).toContain('JSON_TABLE');
    expect(sql).not.toContain('IN ((?, ?)');
    const rows = await myQuery(myConn!, sql, params);
    const got = rows
      .map((r) => `${Number(r.tenant_id)}/${Number(r.doc_id)}=${String(r.rev)}`)
      .sort();
    // Each parent keeps exactly its highest rev: (1,10)→r2 [capped], (1,11)→r3, (2,10)→r9.
    expect(got).toEqual(['1/10=r2', '1/11=r3', '2/10=r9']);
  });

});

// ── Write-path completeness (#47 write side): the TS 5th-language live leg ─────
//
// createMany / updateMany / deleteMany — the SAME batch write bundles the decorator write path ships
// (`compileCreateManyBundle` / `compileUpdateManyBundle` / `compileDeleteManyBundle`, called from
// `decorator-adapter.ts`), executed live on PG + MySQL through the TS runtime's tx render
// (`renderTxStatement`). MySQL has no native RETURNING, so a batch INSERT that declares one is run
// stripped and its written rows recovered by the SELECT the connection adapter derives, which is why
// both dialects return the created rows here. A dedicated `wc_posts` table keeps this isolated from
// the seed above.
//
// The SINGLE-row writes (bare UPDATE/DELETE, UPDATE/DELETE … RETURNING, and the client-supplied
// STRING / COMPOSITE primary-key INSERT … RETURNING) are NOT here: they are declared endpoints in the
// conformance corpus (`renamePost` / `removePost` / `renamePostReturning` / `removePostReturning` /
// `removePostsByAuthorReturning` / `createDoc` / `createLine`), captured per dialect from the emitted
// + bc-generated module and executed live by `conformance:livedb` in all five languages.

const WC_POSTS = 'scp_wc_posts';

/** A minimal per-dialect live client seam (parameterized query → rows / affected count). */
interface LiveClient {
  query(sql: string, params: unknown[]): Promise<{ rows: Row[]; affected: number; insertId: number }>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

function pgClient(pool: Pool): LiveClient {
  return {
    async query(sql, params) {
      const res = await pool.query(sql, params);
      return { rows: (res.rows ?? []) as Row[], affected: res.rowCount ?? 0, insertId: 0 };
    },
    begin: async () => void (await pool.query('BEGIN')),
    commit: async () => void (await pool.query('COMMIT')),
    rollback: async () => void (await pool.query('ROLLBACK')),
  };
}

/**
 * The MySQL leg goes through the PRODUCTION connection adapter (`mysqlConnectionPool` over this one
 * connection), NOT a raw `conn.query`, so the RETURNING recovery under test is the one that ships —
 * re-deriving it here would make this suite green against a broken `buildMysqlReselect`. Only the
 * pool shim is local: `getConnection` hands back the test's own connection, and release/destroy are
 * no-ops because the test owns its lifetime.
 */
function myClient(conn: mysql.Connection): LiveClient {
  const pool = mysqlConnectionPool({
    getConnection: async () => ({
      query: (sql: string, values?: unknown[]) => conn.query(sql, values) as Promise<[unknown, unknown]>,
      release: () => {},
      destroy: () => {},
    }),
  });
  return {
    async query(sql, params) {
      // A RETURNING write rides `execute` (where the recovery lives); a bare write rides `run` — the
      // same split `executeSQLAsync` makes from its `returning` port.
      const ac = await pool.acquire();
      if (/^\s*select\b/i.test(sql) || /\breturning\b/i.test(sql)) {
        return { rows: (await ac.execute(sql, params)) as Row[], affected: 0, insertId: 0 };
      }
      const info = await ac.run(sql, params);
      return { rows: [], affected: info.changes, insertId: Number(info.lastInsertRowid ?? 0) };
    },
    begin: async () => void (await conn.beginTransaction()),
    commit: async () => void (await conn.commit()),
    rollback: async () => void (await conn.rollback()),
  };
}

/**
 * Execute a tx/batch bundle live through the TS runtime's render + a per-dialect client, with the
 * PK-aware MySQL RETURNING emulation. Returns the collected body RETURNING rows (batch "all created
 * rows" / single entity). This is the TS twin of the 4 runtimes' execute_transaction_bundle.
 */
async function execTxLive(bundle: SqlBundle, input: Record<string, unknown>, client: LiveClient): Promise<Row[][]> {
  const plan = bundle.transaction!;
  const scope: Record<string, unknown> = { ...input };
  const returned: Row[][] = [];
  await client.begin();
  try {
    for (const stmt of plan.statements) {
      const r = renderTxStatement(stmt.op, scope as never, bundle.dialect);
      // Dialect-BLIND: MySQL's missing RETURNING is the connection adapter's business (`myClient`),
      // exactly as it is in production, so this loop is the same code for both dialects.
      const hasReturn = /^\s*select\b/i.test(r.sql) || /\breturning\b/i.test(r.sql);
      const res = await client.query(r.sql, r.params.map(toPlain));
      const rows = hasReturn ? res.rows : [];
      if (stmt.role === 'body' && rows.length > 0) returned.push(rows);
      if (stmt.id === plan.entityFrom && rows.length > 0) scope.__entity = rows[0];
      if (stmt.binds !== undefined && rows.length > 0) scope[stmt.binds] = rows[0];
    }
    await client.commit();
  } catch (e) {
    await client.rollback();
    throw e;
  }
  return returned;
}

describe('WS#47 write-path completeness — the BATCH write bundles execute live (TS leg, PG + MySQL)', () => {
  async function setupPg(): Promise<void> {
    await pgPool!.query(`DROP TABLE IF EXISTS ${WC_POSTS}`);
    await pgPool!.query(`CREATE TABLE ${WC_POSTS} (id SERIAL PRIMARY KEY, author_id INTEGER NOT NULL, title TEXT NOT NULL, subtitle TEXT)`);
  }
  async function setupMy(): Promise<void> {
    await myConn!.query(`DROP TABLE IF EXISTS ${WC_POSTS}`);
    await myConn!.query(`CREATE TABLE ${WC_POSTS} (id INT AUTO_INCREMENT PRIMARY KEY, author_id INT NOT NULL, title VARCHAR(255) NOT NULL, subtitle VARCHAR(255))`);
  }

  it('createMany (homogeneous, RETURNING) + updateMany + deleteMany execute on PG and MySQL', async () => {
    const records = [
      { author_id: 7, title: 'B1' },
      { author_id: 7, title: 'B2' },
      { author_id: 8, title: 'B3' },
    ];
    const cmOpts = { tableName: WC_POSTS, records, rawRecords: records, returning: 'id, author_id, title', pk: { columns: ['id'], autoInc: 'id' } };

    // ── PG ──
    await setupPg();
    const cmPg = await execTxLive(compileCreateManyBundle('CM', cmOpts, 'postgres'), {}, pgClient(pgPool!));
    expect(cmPg.flat().map((r) => r.title).sort()).toEqual(['B1', 'B2', 'B3']);
    const umPg = compileUpdateManyBundle('UM', { tableName: WC_POSTS, keyColumns: ['id'], updateColumns: ['title'], records: [{ id: 1, title: 'B1x' }, { id: 3, title: 'B3x' }], rawRecords: [{ id: 1, title: 'B1x' }, { id: 3, title: 'B3x' }] }, 'postgres');
    await execTxLive(umPg, {}, pgClient(pgPool!));
    const afterUmPg = await pgQuery(pgPool!, `SELECT id, title FROM ${WC_POSTS} ORDER BY id`, []);
    expect(afterUmPg.map((r) => r.title)).toEqual(['B1x', 'B2', 'B3x']);
    await execTxLive(compileDeleteManyBundle('DM', { tableName: WC_POSTS, keyColumns: ['id'], keys: [{ id: 1 }, { id: 3 }] }, 'postgres'), {}, pgClient(pgPool!));
    const afterDmPg = await pgQuery(pgPool!, `SELECT id FROM ${WC_POSTS} ORDER BY id`, []);
    expect(afterDmPg.map((r) => Number(r.id))).toEqual([2]);

    // ── MySQL ──
    await setupMy();
    const cmMy = await execTxLive(compileCreateManyBundle('CM', cmOpts, 'mysql'), {}, myClient(myConn!));
    expect(cmMy.flat().map((r) => r.title).sort()).toEqual(['B1', 'B2', 'B3']); // multi-row RETURNING range re-select
    const umMy = compileUpdateManyBundle('UM', { tableName: WC_POSTS, keyColumns: ['id'], updateColumns: ['title'], records: [{ id: 1, title: 'B1x' }, { id: 3, title: 'B3x' }] }, 'mysql');
    await execTxLive(umMy, {}, myClient(myConn!));
    const afterUmMy = await myQuery(myConn!, `SELECT id, title FROM ${WC_POSTS} ORDER BY id`, []);
    expect(afterUmMy.map((r) => r.title)).toEqual(['B1x', 'B2', 'B3x']);
    await execTxLive(compileDeleteManyBundle('DM', { tableName: WC_POSTS, keyColumns: ['id'], keys: [{ id: 1 }, { id: 3 }] }, 'mysql'), {}, myClient(myConn!));
    const afterDmMy = await myQuery(myConn!, `SELECT id FROM ${WC_POSTS} ORDER BY id`, []);
    expect(afterDmMy.map((r) => Number(r.id))).toEqual([2]);
  });

  // The batch tables are this describe's own; drop them once the block is done (the deleted
  // single-write cases used to carry this teardown).
  afterAll(async () => {
    await pgPool?.query(`DROP TABLE IF EXISTS ${WC_POSTS}`).catch(() => undefined);
    await myConn?.query(`DROP TABLE IF EXISTS ${WC_POSTS}`).catch(() => undefined);
  });
});
