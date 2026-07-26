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

  /** The dialect's upsert tail for the UNIQUE `email`. */
  upsertTail(): string {
    return this.dialect === 'mysql'
      ? ' ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name)'
      : ' ON CONFLICT (email) DO UPDATE SET email = excluded.email, name = excluded.name';
  }

  /** The operand of `(k1,k2) IN …`: sqlite needs a VALUES constructor, pg and mysql a bare row list. */
  tupleIn(rows: number, cols: number): string {
    const one = `(${Array(cols).fill('?').join(',')})`;
    const body = Array(rows).fill(one).join(',');
    return this.dialect === 'sqlite' ? `(VALUES ${body})` : `(${body})`;
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
   * A write that hands back the id of the row it wrote — the ` RETURNING id` the authored native module
   * declares for every id-chaining write (`benchmark/crosslang/native-model.ts`). The baseline issues the
   * SAME statement and reads the SAME row back, so the two surfaces do the same work.
   *
   * MySQL has no RETURNING: the runtime's mysql adapter strips the clause and recovers the written rows
   * with a keyed SELECT on the same connection (`src/scp/makesql/mysql-returning.ts`). `recoverSql` /
   * `recoverParams` are that same recovery, so the baseline pays it too rather than reading a free
   * `insertId` off the driver's result metadata.
   */
  async writeReturningId(
    sql: string,
    params: readonly unknown[],
    recoverSql: string,
    recoverParams: readonly unknown[],
  ): Promise<number> {
    if (this.dialect !== 'mysql') {
      const rows = await this.query(`${sql} RETURNING id`, params);
      return Number(rows[0].id);
    }
    await this.exec(sql, params);
    // The recovery is part of the SAME logical statement: the runtime's own seam counts a MySQL
    // RETURNING write as ONE statement (it issues the recovery below the seam) while counting the row it
    // recovers. Counting it as a second statement here would make the baseline look like it issued more
    // work than it does — both surfaces send MySQL the same two SQL statements.
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

/** users → ONE batched posts read, moved into their author. */
async function attachPosts(db: Db, users: SdkUser[]): Promise<SdkUser[]> {
  if (users.length === 0) return users;
  const ids = users.map((u) => u.id);
  const posts = (await db.query(
    `SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`,
    ids,
  )) as SdkPost[];
  const byAuthor = groupBy(posts, ['author_id']);
  for (const u of users) u.posts = (byAuthor.get(String(u.id)) as SdkPost[]) ?? [];
  return users;
}

/** users → batched posts → batched comments, assembled into the full three-level graph. */
async function attachPostsAndComments(db: Db, users: SdkUser[]): Promise<SdkUser[]> {
  if (users.length === 0) return users;
  const uids = users.map((u) => u.id);
  const posts = (await db.query(
    `SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN (${uids.map(() => '?').join(',')}) ORDER BY id ASC`,
    uids,
  )) as SdkPost[];
  if (posts.length > 0) {
    const pids = posts.map((p) => p.id);
    const comments = await db.query(
      `SELECT id, body, post_id FROM benchmark_comments WHERE post_id IN (${pids.map(() => '?').join(',')}) ORDER BY id ASC`,
      pids,
    );
    const byPost = groupBy(comments, ['post_id']);
    for (const p of posts) p.comments = byPost.get(String(p.id)) ?? [];
  }
  const byAuthor = groupBy(posts, ['author_id']);
  for (const u of users) u.posts = (byAuthor.get(String(u.id)) as SdkPost[]) ?? [];
  return users;
}

/** tenant_users(tenant=1) → batched tenant_posts → batched tenant_comments, on the FULL key tuple. */
async function compositeGraph(db: Db): Promise<Row[]> {
  const tusers = await db.query(
    'SELECT tenant_id, user_id, name FROM benchmark_tenant_users WHERE tenant_id = ? ORDER BY user_id ASC',
    [1],
  );
  if (tusers.length === 0) return tusers;
  const pparams = tusers.flatMap((u) => [u.tenant_id, u.user_id]);
  const tposts = await db.query(
    `SELECT tenant_id, post_id, user_id, title FROM benchmark_tenant_posts WHERE (tenant_id, user_id) IN ${db.tupleIn(tusers.length, 2)}`,
    pparams,
  );
  if (tposts.length > 0) {
    const cparams = tposts.flatMap((p) => [p.tenant_id, p.post_id]);
    const tcomments = await db.query(
      `SELECT tenant_id, comment_id, post_id, body FROM benchmark_tenant_comments WHERE (tenant_id, post_id) IN ${db.tupleIn(tposts.length, 2)}`,
      cparams,
    );
    const byPost = groupBy(tcomments, ['tenant_id', 'post_id']);
    for (const p of tposts) (p as SdkPost).comments = byPost.get(`${p.tenant_id}${p.post_id}`) ?? [];
  }
  const byUser = groupBy(tposts, ['tenant_id', 'user_id']);
  for (const u of tusers) (u as SdkUser).posts = (byUser.get(`${u.tenant_id}${u.user_id}`) as SdkPost[]) ?? [];
  return tusers;
}

/** ONE multi-row INSERT for the 10 rows, optional conflict tail — never 10 statements. */
async function batchInsert(db: Db, rows: readonly { email: string; name: string }[], tail: string): Promise<void> {
  const values = rows.map(() => '(?, ?)').join(',');
  await db.exec(
    `INSERT INTO benchmark_users (email, name) VALUES ${values}${tail}`,
    rows.flatMap((r) => [r.email, r.name]),
  );
}

/** ONE statement: CASE id … END WHERE id IN (…). */
async function updateMany(db: Db): Promise<void> {
  const rows = updateManyRows();
  const whens = rows.map(() => ' WHEN ? THEN ?').join('');
  const params = [...rows.flatMap((r) => [r.id, r.name]), ...rows.map((r) => r.id)];
  await db.exec(
    `UPDATE benchmark_users SET name = CASE id${whens} END WHERE id IN (${rows.map(() => '?').join(',')})`,
    params,
  );
}

/** The result of the last materialization, held so the engine cannot elide the assembly work. */
let sink: unknown;

async function runOp(db: Db, op: string, it: number): Promise<void> {
  const input = inputFor(op, it) as Record<string, never>;
  switch (op) {
    case 'findAll':
      await db.query('SELECT id, email, name FROM benchmark_users ORDER BY id ASC LIMIT 100');
      return;
    case 'filterPaginateSort':
      await db.query(
        'SELECT id, title, content, published, author_id, created_at FROM benchmark_posts WHERE published = ? ORDER BY created_at DESC LIMIT 20 OFFSET 10',
        [input.published],
      );
      return;
    case 'findFirst':
      await db.query('SELECT id, email, name FROM benchmark_users WHERE name LIKE ? LIMIT 1', [input.name]);
      return;
    case 'findUnique':
      await db.query('SELECT id, email, name FROM benchmark_users WHERE email = ? LIMIT 1', [input.email]);
      return;
    case 'nestedFindAll':
      sink = await attachPosts(db, await db.query('SELECT id, email, name FROM benchmark_users ORDER BY id ASC LIMIT 100'));
      return;
    case 'nestedFindFirst':
      sink = await attachPosts(
        db,
        await db.query('SELECT id, email, name FROM benchmark_users WHERE name LIKE ? LIMIT 1', [input.name]),
      );
      return;
    case 'nestedFindUnique':
      sink = await attachPosts(
        db,
        await db.query('SELECT id, email, name FROM benchmark_users WHERE email = ? LIMIT 1', [input.email]),
      );
      return;
    case 'nestedRelations':
      sink = await attachPostsAndComments(
        db,
        await db.query('SELECT id, email, name FROM benchmark_users ORDER BY id ASC LIMIT 100'),
      );
      return;
    case 'compositeRelations':
      sink = await compositeGraph(db);
      return;
    case 'create':
      await db.exec('INSERT INTO benchmark_users (email, name) VALUES (?, ?)', [input.email, input.name]);
      return;
    case 'update':
      await db.exec('UPDATE benchmark_users SET name = ? WHERE id = ?', [input.name, input.id]);
      return;
    case 'upsert':
      // The native module declares ` RETURNING id` here, so the baseline reads the id back too.
      sink = await db.writeReturningId(
        `INSERT INTO benchmark_users (email, name) VALUES (?, ?)${db.upsertTail()}`,
        [input.email, input.name],
        'SELECT id FROM benchmark_users WHERE email = ?', // the runtime's conflict-key recovery
        [input.email],
      );
      return;
    case 'createMany':
      await batchInsert(db, userRows(it, false), '');
      return;
    case 'upsertMany':
      await batchInsert(db, userRows(it, true), db.upsertTail());
      return;
    case 'updateMany':
      await updateMany(db);
      return;
    case 'nestedCreate': {
      await db.exec('BEGIN');
      const uid = await db.writeReturningId(
        'INSERT INTO benchmark_users (email, name) VALUES (?, ?)',
        [input.email, input.name],
        'SELECT id FROM benchmark_users WHERE id = LAST_INSERT_ID()', // the runtime's AUTO_INCREMENT recovery
        [],
      );
      await db.exec('INSERT INTO benchmark_posts (author_id, title) VALUES (?, ?)', [uid, input.title]);
      await db.exec('COMMIT');
      return;
    }
    case 'nestedUpsert': {
      await db.exec('BEGIN');
      const uid = await db.writeReturningId(
        `INSERT INTO benchmark_users (email, name) VALUES (?, ?)${db.upsertTail()}`,
        [input.email, input.name],
        'SELECT id FROM benchmark_users WHERE email = ?',
        [input.email],
      );
      await db.exec('INSERT INTO benchmark_posts (author_id, title) VALUES (?, ?)', [uid, input.title]);
      await db.exec('COMMIT');
      return;
    }
    case 'nestedUpdate': {
      await db.exec('BEGIN');
      // The native module chains the dependent UPDATE off the id the first UPDATE returned; taking the
      // id from the input instead would skip a statement's worth of work.
      const uid = await db.writeReturningId(
        'UPDATE benchmark_users SET name = ? WHERE id = ?',
        [input.name, input.id],
        'SELECT id FROM benchmark_users WHERE id = ?', // the runtime recovers by the write's own WHERE
        [input.id],
      );
      await db.exec('UPDATE benchmark_posts SET title = ? WHERE author_id = ?', [input.title, uid]);
      await db.exec('COMMIT');
      return;
    }
    case 'delete': {
      await db.exec('BEGIN');
      const uid = await db.writeReturningId(
        'INSERT INTO benchmark_users (email, name) VALUES (?, ?)',
        [input.email, input.name],
        'SELECT id FROM benchmark_users WHERE id = LAST_INSERT_ID()',
        [],
      );
      await db.exec('DELETE FROM benchmark_users WHERE id = ?', [uid]);
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
    run: (op, it) => runOp(db, op, it),
    close: () => db.close(),
    statements: () => db.count,
    rows: () => db.rows,
    resetCounters: () => {
      db.count = 0;
      db.rows = 0;
    },
  };
}
