// The SDK-baseline mode of the TypeScript cell — raw better-sqlite3 / pg / mysql2, no litedbmodel.
//
// The apples-to-apples baseline for the codegen mode: the SAME 19 ops over the SAME fixture and the
// SAME database, with every statement hand-written and issued straight at the driver (#157 invariant
// 6). It honours the #145 fairness invariants: prepared-statement reuse, N+1-free relations (one
// parent read + one batched child read per level, grouped in memory), batch writes as ONE statement,
// and the nested graph MATERIALIZED into typed objects with the children moved into their parent —
// the same object graph the codegen mode assembles, not a grouping that is thrown away.
//
// The ops are written ONCE, async, and the sqlite leg pays the same Promise machinery pg and mysql
// do. Writing them twice to give sqlite a sync path is the duplication this repo forbids; the cost is
// a handful of microtasks per op, and it is paid identically across all three dialects.

import Database from 'better-sqlite3';
import { Pool as PgPool } from 'pg';
import mysql from 'mysql2/promise';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { inputFor, userRows, updateManyRows } from './inputs.js';
import type { Cell, Dialect } from './cell.js';
import { MYSQL_CONFIG, PG_CONFIG, setupFor } from './cell.js';

type Row = Record<string, unknown>;

/**
 * The ONE exec seam. Every statement rides these methods, so the counter (the safety proof) and the
 * dialect divergences each live in exactly one place: placeholder render, upsert tail, composite
 * key-set operand, and insert-id recovery.
 */
abstract class Db {
  count = 0;
  /** Rows this driver handed back — the per-row normalization denominator + the fairness proof (#170). */
  rows = 0;
  constructor(readonly dialect: Dialect) {}

  /** `?` → this driver's placeholder. pg binds `$N` positionally; better-sqlite3 and mysql2 take `?`. */
  render(sql: string): string {
    if (this.dialect !== 'postgres') return sql;
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  }

  /**
   * The ONE counted read seam — every SELECT (and every RETURNING write) rides it, so statements and
   * rows are each counted in exactly one place. Subclasses supply only the driver call ({@link fetch}).
   */
  async query(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    this.count++;
    const out = await this.fetch(sql, params);
    this.rows += out.length;
    return out;
  }
  protected abstract fetch(sql: string, params: readonly unknown[]): Promise<Row[]>;
  abstract exec(sql: string, params?: readonly unknown[]): Promise<void>;
  abstract close(): Promise<void>;

  /**
   * A write that hands back the id of the row it wrote. `sql` is the captured statement, which already
   * declares ` RETURNING id` — the baseline reads the same row back rather than taking a free
   * last-insert-id off the driver's result metadata.
   *
   * MySQL cannot parse RETURNING: the runtime's mysql adapter strips the clause (and the
   * `/*scp:pk=…*\/` hint that names the key) and recovers the written rows with a keyed SELECT on the
   * same connection (src/scp/makesql/mysql-returning.ts). `recoverSql` is that same recovery, and it
   * belongs to the SAME logical statement — the runtime's seam counts a MySQL RETURNING write as one (it
   * issues the recovery below the seam) while counting the row it recovers — so its rows are tallied and
   * the statement count is not bumped a second time.
   */
  async writeReturningId(
    sql: string,
    params: readonly unknown[],
    recoverSql: string,
    recoverParams: readonly unknown[],
  ): Promise<number> {
    if (this.dialect !== 'mysql') {
      const rows = await this.query(sql, params);
      return Number(rows[0].id);
    }
    await this.exec(sql.replace(/\s+RETURNING\s+[\s\S]*$/i, ''), params);
    const rows = await this.recoverRows(recoverSql, recoverParams);
    return Number(rows[0].id);
  }

  /** A fetch belonging to the logical statement just issued: rows are tallied, the statement count is not. */
  private async recoverRows(sql: string, params: readonly unknown[]): Promise<Row[]> {
    const out = await this.fetch(sql, params);
    this.rows += out.length;
    return out;
  }
}

class SqliteDb extends Db {
  private readonly stmts = new Map<string, Database.Statement>();
  constructor(readonly db: Database.Database) {
    super('sqlite');
  }
  private prep(sql: string): Database.Statement {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }
  protected async fetch(sql: string, params: readonly unknown[]): Promise<Row[]> {
    return this.prep(sql).all(...(params as unknown[])) as Row[];
  }
  async exec(sql: string, params: readonly unknown[] = []): Promise<void> {
    this.count++;
    if (params.length === 0 && /^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) this.db.exec(sql);
    else this.prep(sql).run(...(params as unknown[]));
  }
  async close(): Promise<void> {
    this.db.close();
  }
}

class PgDb extends Db {
  constructor(readonly pool: PgPool) {
    super('postgres');
  }
  protected async fetch(sql: string, params: readonly unknown[]): Promise<Row[]> {
    // A named statement is prepared once per connection and reused — the pg twin of a statement
    // cache, so the baseline is not re-parsing every SQL the way an unprepared query would.
    const r = await this.pool.query({ text: this.render(sql), values: params as unknown[], name: cacheName(sql) });
    return r.rows as Row[];
  }
  async exec(sql: string, params: readonly unknown[] = []): Promise<void> {
    this.count++;
    await this.pool.query({ text: this.render(sql), values: params as unknown[], name: cacheName(sql) });
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

class MysqlDb extends Db {
  constructor(readonly pool: mysql.Pool) {
    super('mysql');
  }
  protected async fetch(sql: string, params: readonly unknown[]): Promise<Row[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, params as never[]); // `execute` = server-side prepared + cached
    return rows as Row[];
  }
  async exec(sql: string, params: readonly unknown[] = []): Promise<void> {
    this.count++;
    if (params.length === 0) await this.pool.query(sql);
    else await this.pool.execute(sql, params as never[]);
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** A stable per-SQL name so pg prepares each statement once per connection. */
const names = new Map<string, string>();
function cacheName(sql: string): string {
  let n = names.get(sql);
  if (!n) names.set(sql, (n = `s${names.size}`));
  return n;
}

// ── the nested typed graph the codegen mode also builds (children MOVED into their parent) ─────────
interface SdkUser extends Row {
  posts?: SdkPost[];
}
interface SdkPost extends Row {
  comments?: Row[];
}

/** Group `rows` by the value of `cols`, so a parent can take its slice by move. */
function groupBy(rows: Row[], cols: readonly string[]): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = cols.map((c) => String(r[c])).join('');
    const bucket = m.get(k);
    if (bucket) bucket.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/**
 * The key set of one relation level as the ONE param the captured SQL expects. The generated module binds
 * a batched child read's key set as a single JSON array (`json_each(?)` / `JSON_TABLE(?)` /
 * `UNNEST(?::t[])`), never as N placeholders — so the baseline binds it the same way, or it would be
 * running different SQL. Composite keys are an array of tuples; a single key an array of scalars.
 */
function keyParam(rows: readonly Row[], cols: readonly string[], sql: string): string {
  const keys = rows.map((r) => (cols.length === 1 ? r[cols[0]] : cols.map((c) => r[c])));
  // The statement says which encoding it wants: an ARRAY cast (`$1::int[]`, PostgreSQL's single-key
  // predicate) takes a PostgreSQL array literal, a `::json` cast and MySQL/SQLite's json_each /
  // JSON_TABLE take JSON. Reading it off the SQL keeps the encoding tied to the statement rather than to
  // a second table that could disagree with it.
  return pgArrayCast(sql) ? pgArrayLiteral(keys as unknown[]) : JSON.stringify(keys);
}

/** True when the statement casts its param to a PostgreSQL array (`::int[]` / `::text[]`). */
function pgArrayCast(sql: string): boolean {
  return /::\w+\[\]/.test(sql);
}

/**
 * A PostgreSQL array literal (`{1,2,3}`). Bound as TEXT and cast by the statement's own `::int[]` /
 * `::text[]`, so it needs no driver-specific array support — the same text every language's cell can send.
 */
function pgArrayLiteral(values: readonly unknown[]): string {
  const one = (v: unknown): string =>
    typeof v === 'number' || typeof v === 'bigint' ? String(v) : `"${String(v).replace(/(["\\])/g, '\\$1')}"`;
  return `{${values.map(one).join(',')}}`;
}

/** users → ONE batched posts read, moved into their author. `sql` = the op's [parent, child] statements. */
async function attachPosts(db: Db, users: SdkUser[], childSql: string): Promise<SdkUser[]> {
  if (users.length === 0) return users;
  const posts = (await db.query(childSql, [keyParam(users, ['id'], childSql)])) as SdkPost[];
  const byAuthor = groupBy(posts, ['author_id']);
  for (const u of users) u.posts = (byAuthor.get(String(u.id)) as SdkPost[]) ?? [];
  return users;
}

/** users → batched posts → batched comments, assembled into the full three-level graph. */
async function attachPostsAndComments(db: Db, users: SdkUser[], postSql: string, commentSql: string): Promise<SdkUser[]> {
  if (users.length === 0) return users;
  const posts = (await db.query(postSql, [keyParam(users, ['id'], postSql)])) as SdkPost[];
  if (posts.length > 0) {
    const comments = await db.query(commentSql, [keyParam(posts, ['id'], commentSql)]);
    const byPost = groupBy(comments, ['post_id']);
    for (const p of posts) p.comments = byPost.get(String(p.id)) ?? [];
  }
  const byAuthor = groupBy(posts, ['author_id']);
  for (const u of users) u.posts = (byAuthor.get(String(u.id)) as SdkPost[]) ?? [];
  return users;
}

/** tenant_users → batched tenant_posts → batched tenant_comments, on the FULL key tuple. */
async function compositeGraph(db: Db, sql: readonly string[]): Promise<Row[]> {
  const tusers = await db.query(sql[0]);
  if (tusers.length === 0) return tusers;
  const tposts = await db.query(sql[1], [keyParam(tusers, ['tenant_id', 'user_id'], sql[1])]);
  if (tposts.length > 0) {
    const tcomments = await db.query(sql[2], [keyParam(tposts, ['tenant_id', 'post_id'], sql[2])]);
    const byPost = groupBy(tcomments, ['tenant_id', 'post_id']);
    for (const p of tposts) (p as SdkPost).comments = byPost.get(`${p.tenant_id}${p.post_id}`) ?? [];
  }
  const byUser = groupBy(tposts, ['tenant_id', 'user_id']);
  for (const u of tusers) (u as SdkUser).posts = (byUser.get(`${u.tenant_id}${u.user_id}`) as SdkPost[]) ?? [];
  return tusers;
}

/**
 * A batch write's record set as the param(s) the captured statement expects: ONE JSON array on
 * MySQL/SQLite (`json_each(?)` / `JSON_TABLE(?)`), and one array PER COLUMN on PostgreSQL, whose
 * `UNNEST(?::text[], ?::text[])` form takes column arrays rather than a record array. `updateMany` binds
 * the same payload once per `?` (its SET subquery and its WHERE each read it).
 */
function batchParams(db: Db, rows: readonly object[], sqlForArity?: string): unknown[] {
  const cols = Object.keys(rows[0]) as (keyof (typeof rows)[number])[];
  const one =
    db.dialect === 'postgres'
      ? cols.map((c) => pgArrayLiteral(rows.map((r) => (r as Record<string, unknown>)[c])))
      : // A bc `int` input is a BigInt, which `JSON.stringify` refuses; the JSON batch param carries it as
        // a number, exactly as the runtime's own encoder does (src/scp/makesql/json-array.ts).
        [JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v))];
  const arity = sqlForArity === undefined ? 1 : (sqlForArity.match(/\?/g) ?? ['?']).length / one.length;
  return Array.from({ length: Math.max(1, Math.round(arity)) }, () => one).flat();
}

/**
 * The keyed SELECTs the runtime's MySQL adapter recovers a RETURNING write's rows with
 * (src/scp/makesql/mysql-returning.ts): the conflict key for an upsert, the AUTO_INCREMENT range for an
 * insert, the write's own WHERE for an update. Only MySQL runs them — the other dialects have RETURNING.
 */
const RECOVER = {
  byEmail: 'SELECT id FROM benchmark_users WHERE email = ?',
  byLastInsertId: 'SELECT id FROM benchmark_users WHERE id = LAST_INSERT_ID()',
  byId: 'SELECT id FROM benchmark_users WHERE id = ?',
} as const;

/** `UserRow` — the row type the native module declares for the user projections. */
function userRow(r: Row): { id: number; email: unknown; name: unknown } {
  return { id: Number(r.id), email: r.email, name: r.name };
}

/** `PostFullRow` — `filterPaginateSort`'s full projection. */
function postFullRow(r: Row): {
  id: number;
  title: unknown;
  content: unknown;
  published: number;
  author_id: number;
  created_at: unknown;
} {
  return {
    id: Number(r.id),
    title: r.title,
    content: r.content,
    published: Number(r.published),
    author_id: Number(r.author_id),
    created_at: r.created_at,
  };
}

/** The result of the last materialization, held so the engine cannot elide the assembly work. */
let sink: unknown;

/**
 * Run ONE op, issuing the statements the GENERATED module issues for this dialect (`setup.ops[op]`,
 * captured at the runtime seam). The baseline hand-writes no SQL: the ratio the report publishes is
 * `native ÷ sdk`, which only isolates the runtime's cost if both sides send the DB the same statements.
 *
 * What stays hand-written here is what a raw-driver user actually writes: the param binding, the decode,
 * the grouping of children into parents, and the transaction bracket.
 */
async function runOp(db: Db, op: string, it: number, sql: readonly string[]): Promise<void> {
  const input = inputFor(op, it) as Record<string, never>;
  switch (op) {
    // A read is only usable as data once its columns are in typed fields, so the baseline materializes the
    // same row objects the native cell de-boxes into; stopping at the driver's row would compare a decode
    // against no decode.
    case 'findAll':
      sink = (await db.query(sql[0])).map(userRow);
      return;
    case 'filterPaginateSort':
      sink = (await db.query(sql[0], [input.published])).map(postFullRow);
      return;
    case 'findFirst':
      sink = (await db.query(sql[0], [input.name])).map(userRow);
      return;
    case 'findUnique':
      sink = (await db.query(sql[0], [input.email])).map(userRow);
      return;
    case 'nestedFindAll':
      sink = await attachPosts(db, await db.query(sql[0]), sql[1]);
      return;
    case 'nestedFindFirst':
      sink = await attachPosts(db, await db.query(sql[0], [input.name]), sql[1]);
      return;
    case 'nestedFindUnique':
      sink = await attachPosts(db, await db.query(sql[0], [input.email]), sql[1]);
      return;
    case 'nestedRelations':
      sink = await attachPostsAndComments(db, await db.query(sql[0]), sql[1], sql[2]);
      return;
    case 'compositeRelations':
      sink = await compositeGraph(db, sql);
      return;
    case 'create':
      await db.exec(sql[0], [input.email, input.name]);
      return;
    case 'update':
      await db.exec(sql[0], [input.name, input.id]);
      return;
    case 'upsert':
      // The generated statement declares ` RETURNING id`, so the baseline reads the id back too.
      sink = await db.writeReturningId(sql[0], [input.email, input.name], RECOVER.byEmail, [input.email]);
      return;
    case 'createMany':
    case 'upsertMany':
      // ONE statement for the 10 records, the whole record set as ONE JSON param — the batch form the
      // generated module uses (json_each / JSON_TABLE / UNNEST), not a multi-row VALUES list.
      await db.exec(sql[0], batchParams(db, userRows(it, op === 'upsertMany')));
      return;
    case 'updateMany':
      await db.exec(sql[0], batchParams(db, updateManyRows(), sql[0]));
      return;
    case 'nestedCreate': {
      await db.exec('BEGIN');
      const uid = await db.writeReturningId(sql[0], [input.email, input.name], RECOVER.byLastInsertId, []);
      await db.exec(sql[1], [uid, input.title]);
      await db.exec('COMMIT');
      return;
    }
    case 'nestedUpsert': {
      await db.exec('BEGIN');
      const uid = await db.writeReturningId(sql[0], [input.email, input.name], RECOVER.byEmail, [input.email]);
      await db.exec(sql[1], [uid, input.title]);
      await db.exec('COMMIT');
      return;
    }
    case 'nestedUpdate': {
      await db.exec('BEGIN');
      // The generated runner chains the dependent UPDATE off the id the first UPDATE returned; taking the
      // id from the input instead would skip a statement's worth of work.
      const uid = await db.writeReturningId(sql[0], [input.name, input.id], RECOVER.byId, [input.id]);
      await db.exec(sql[1], [input.title, uid]);
      await db.exec('COMMIT');
      return;
    }
    case 'delete': {
      await db.exec('BEGIN');
      const uid = await db.writeReturningId(sql[0], [input.email, input.name], RECOVER.byLastInsertId, []);
      await db.exec(sql[1], [uid]);
      await db.exec('COMMIT');
      return;
    }
    default:
      throw new Error(`unknown op ${op}`);
  }
}

export async function openSdk(dialect: Dialect): Promise<Cell> {
  const setup = setupFor(dialect);
  let db: Db;
  if (dialect === 'sqlite') {
    const conn = new Database(':memory:');
    for (const stmt of setup.schema) conn.exec(stmt);
    db = new SqliteDb(conn);
  } else if (dialect === 'postgres') {
    const pool = new PgPool({ ...PG_CONFIG, max: 4 });
    for (const stmt of setup.schema) await pool.query(stmt);
    db = new PgDb(pool);
  } else {
    const pool = mysql.createPool({
      ...MYSQL_CONFIG,
      connectionLimit: 4,
      multipleStatements: false,
    });
    for (const stmt of setup.schema) await pool.query(stmt);
    db = new MysqlDb(pool);
  }
  return {
    dialect,
    sync: false,
    // The raw baseline needs one extra SELECT for nestedUpsert wherever RETURNING is unavailable.
    seed: async () => {
      for (const stmt of [...setup.delete, ...setup.insert]) {
        if (db instanceof SqliteDb) db.db.exec(stmt);
        else if (db instanceof PgDb) await db.pool.query(stmt);
        else await (db as MysqlDb).pool.query(stmt);
      }
    },
    run: (op, it) => runOp(db, op, it, setup.ops[op]),
    close: () => db.close(),
    statements: () => db.count,
    rows: () => db.rows,
    resetCounters: () => {
      db.count = 0;
      db.rows = 0;
    },
  };
}
