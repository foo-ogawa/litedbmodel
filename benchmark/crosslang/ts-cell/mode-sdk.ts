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

import type { Cell, Dialect, Recovery, RecoveryBind, Setup } from './cell.js';
import { MYSQL_CONFIG, PG_CONFIG, resolveInput, setupFor } from './cell.js';

type Row = Record<string, unknown>;

/** What a driver reports about a write. `insertId` is MySQL's/SQLite's; PostgreSQL has no such thing. */
interface WriteResult {
  readonly insertId?: number;
  readonly affected: number;
}

/**
 * The recovering SELECT's params, resolved from the write's own params and what the driver reported —
 * the `bindReselect` of `src/scp/makesql/mysql-returning.ts`, which is where these three kinds are
 * defined. A kind whose input the driver did not supply is a HARD failure: recovering the wrong rows
 * silently is the defect this whole path exists to remove.
 */
function bindRecovery(binds: readonly RecoveryBind[], params: readonly unknown[], wrote: WriteResult): unknown[] {
  return binds.map((b) => {
    if (b.kind === 'param') return params[b.index];
    if (wrote.insertId === undefined) {
      throw new Error(`the recovery binds '${b.kind}', but this driver reported no insert id for the write`);
    }
    return b.kind === 'lastId' ? wrote.insertId : wrote.insertId + Math.max(1, wrote.affected);
  });
}

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
  abstract exec(sql: string, params?: readonly unknown[]): Promise<WriteResult>;
  abstract close(): Promise<void>;

  /**
   * A write that hands back the id of the row it wrote. `sql` is the captured statement, which already
   * declares ` RETURNING id` — the baseline reads the same row back rather than taking a free
   * last-insert-id off the driver's result metadata.
   *
   * `recovery` is the artifact's entry for this statement: null wherever the database executes the
   * RETURNING itself, and on MySQL — which cannot parse it — the write with the clause stripped plus
   * the keyed SELECT that recovers the written rows. Both come from the library's own
   * `buildMysqlReselect` (`derive-ops.ts`), so the baseline issues exactly what the runtime issues
   * instead of a hand-copied guess at it. The recovery belongs to the SAME logical statement — the
   * runtime's seam counts a MySQL RETURNING write as one and issues the recovery below itself — so its
   * rows are tallied and the statement count is not bumped a second time.
   */
  async writeReturningId(sql: string, params: readonly unknown[], recovery: Recovery | null): Promise<number> {
    if (recovery === null) {
      const rows = await this.query(sql, params);
      return Number(rows[0].id);
    }
    const wrote = await this.exec(recovery.writeSql, params);
    const rows = await this.recoverRows(recovery.selectSql, bindRecovery(recovery.binds, params, wrote));
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
  async exec(sql: string, params: readonly unknown[] = []): Promise<WriteResult> {
    this.count++;
    if (params.length === 0 && /^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      this.db.exec(sql);
      return { affected: 0 };
    }
    const info = this.prep(sql).run(...(params as unknown[]));
    return { insertId: Number(info.lastInsertRowid), affected: info.changes };
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
  async exec(sql: string, params: readonly unknown[] = []): Promise<WriteResult> {
    this.count++;
    const r = await this.pool.query({ text: this.render(sql), values: params as unknown[], name: cacheName(sql) });
    // No `insertId`: PostgreSQL has no last-insert-id, and it never needs one — it executes the
    // declared RETURNING itself, so no statement of its artifact carries a recovery.
    return { affected: r.rowCount ?? 0 };
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
  async exec(sql: string, params: readonly unknown[] = []): Promise<WriteResult> {
    this.count++;
    const [header] =
      params.length === 0
        ? await this.pool.query<ResultSetHeader>(sql)
        : await this.pool.execute<ResultSetHeader>(sql, params as never[]);
    return { insertId: header.insertId, affected: header.affectedRows };
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
function batchParams(db: Db, rows: readonly Row[], sql: string, columns: readonly string[]): unknown[] {
  const one =
    db.dialect === 'postgres'
      ? // One array per column, in the order the statement's own `UNNEST` alias list names them
        // (`setup.batchColumns`, read off the statement by derive-ops.ts). Deriving the order from the
        // record instead is what made go sort its keys and rust pin a tuple position.
        columns.map((c) => pgArrayLiteral(rows.map((r) => r[c])))
      : // A bc `int` input is a BigInt, which `JSON.stringify` refuses; the JSON batch param carries it as
        // a number, exactly as the runtime's own encoder does (src/scp/makesql/json-array.ts).
        [JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v))];
  const arity = (sql.match(/\?/g) ?? ['?']).length / one.length;
  return Array.from({ length: Math.max(1, Math.round(arity)) }, () => one).flat();
}

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
async function runOp(db: Db, setup: Setup, op: string, it: number): Promise<void> {
  const sql = setup.ops[op];
  const input = resolveInput(setup, op, it) as Record<string, never>;
  /** This statement's MySQL RETURNING recovery — null wherever the database executes RETURNING itself. */
  const recovery = (i: number): Recovery | null => setup.recover?.[op]?.[i] ?? null;
  /** The columns this batch statement reads, in its own order (PostgreSQL binds one array per column). */
  const columns = (): readonly string[] => {
    const cols = setup.batchColumns?.[op];
    if (cols === undefined) throw new Error(`.setup/${setup.dialect}.json declares no batchColumns for ${op}`);
    return cols;
  };
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
      sink = await db.writeReturningId(sql[0], [input.email, input.name], recovery(0));
      return;
    case 'createMany':
    case 'upsertMany':
    case 'updateMany':
      // ONE statement for the 10 records, the whole record set as ONE param set — the batch form the
      // generated module uses (json_each / JSON_TABLE / UNNEST), not a multi-row VALUES list.
      await db.exec(sql[0], batchParams(db, input.rows as readonly Row[], sql[0], columns()));
      return;
    case 'nestedCreate': {
      await db.exec('BEGIN');
      const uid = await db.writeReturningId(sql[0], [input.email, input.name], recovery(0));
      await db.exec(sql[1], [uid, input.title]);
      await db.exec('COMMIT');
      return;
    }
    case 'nestedUpsert': {
      await db.exec('BEGIN');
      const uid = await db.writeReturningId(sql[0], [input.email, input.name], recovery(0));
      await db.exec(sql[1], [uid, input.title]);
      await db.exec('COMMIT');
      return;
    }
    case 'nestedUpdate': {
      await db.exec('BEGIN');
      // The generated runner chains the dependent UPDATE off the id the first UPDATE returned; taking the
      // id from the input instead would skip a statement's worth of work.
      const uid = await db.writeReturningId(sql[0], [input.name, input.id], recovery(0));
      await db.exec(sql[1], [input.title, uid]);
      await db.exec('COMMIT');
      return;
    }
    case 'delete': {
      await db.exec('BEGIN');
      const uid = await db.writeReturningId(sql[0], [input.email, input.name], recovery(0));
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
  // ONE connection per dialect, not a pool of four. `exec` sends BEGIN/COMMIT through the pool with no
  // pinned client, so BEGIN, the two body writes and COMMIT could each land on a DIFFERENT connection and
  // the BEGIN'd one went back to the pool holding an open transaction — the four tx ops were not
  // transactions at all, and measured many times the library they are the baseline for.
  //
  // The library itself does this correctly and is NOT affected: `pgConnectionPool`/`mysqlConnectionPool`
  // hand a transaction an OWNED connection (`acquire()` → `connect()`/`getConnection()`,
  // src/scp/makesql/pool-executor.ts:162-171) and `ExecutionContext.withConnection` pins it, which is why
  // the native cell keeps its pool. This cell is the RAW baseline, so it takes the raw fix — which is also
  // what the other three SDK cells already do (rust one `postgres::Client`, python one connection, php one
  // PDO). A serial workload occupies one connection either way.
  if (dialect === 'sqlite') {
    const conn = new Database(':memory:');
    for (const stmt of setup.schema) conn.exec(stmt);
    db = new SqliteDb(conn);
  } else if (dialect === 'postgres') {
    const pool = new PgPool({ ...PG_CONFIG, max: 1 });
    for (const stmt of setup.schema) await pool.query(stmt);
    db = new PgDb(pool);
  } else {
    const pool = mysql.createPool({
      ...MYSQL_CONFIG,
      connectionLimit: 1,
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
    run: (op, it) => runOp(db, setup, op, it),
    close: () => db.close(),
    statements: () => db.count,
    rows: () => db.rows,
    resetCounters: () => {
      db.count = 0;
      db.rows = 0;
    },
  };
}
