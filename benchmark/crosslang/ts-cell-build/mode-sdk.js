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
import { inputFor, userRows, updateManyRows } from './inputs.js';
import { MYSQL_CONFIG, PG_CONFIG, setupFor } from './cell.js';
/**
 * The ONE exec seam. Every statement rides these methods, so the counter (the safety proof) and the
 * dialect divergences each live in exactly one place: placeholder render, upsert tail, composite
 * key-set operand, and insert-id recovery.
 */
class Db {
    dialect;
    count = 0;
    constructor(dialect) {
        this.dialect = dialect;
    }
    /** `?` → this driver's placeholder. pg binds `$N` positionally; better-sqlite3 and mysql2 take `?`. */
    render(sql) {
        if (this.dialect !== 'postgres')
            return sql;
        let n = 0;
        return sql.replace(/\?/g, () => `$${++n}`);
    }
    /** The dialect's upsert tail for the UNIQUE `email`. */
    upsertTail() {
        return this.dialect === 'mysql'
            ? ' ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name)'
            : ' ON CONFLICT (email) DO UPDATE SET email = excluded.email, name = excluded.name';
    }
    /** The operand of `(k1,k2) IN …`: sqlite needs a VALUES constructor, pg and mysql a bare row list. */
    tupleIn(rows, cols) {
        const one = `(${Array(cols).fill('?').join(',')})`;
        const body = Array(rows).fill(one).join(',');
        return this.dialect === 'sqlite' ? `(VALUES ${body})` : `(${body})`;
    }
}
class SqliteDb extends Db {
    db;
    stmts = new Map();
    constructor(db) {
        super('sqlite');
        this.db = db;
    }
    prep(sql) {
        let s = this.stmts.get(sql);
        if (!s)
            this.stmts.set(sql, (s = this.db.prepare(sql)));
        return s;
    }
    async query(sql, params = []) {
        this.count++;
        return this.prep(sql).all(...params);
    }
    async exec(sql, params = []) {
        this.count++;
        if (params.length === 0 && /^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql))
            this.db.exec(sql);
        else
            this.prep(sql).run(...params);
    }
    async insertUserId(email, name) {
        this.count++;
        const info = this.prep('INSERT INTO benchmark_users (email, name) VALUES (?, ?)').run(email, name);
        return Number(info.lastInsertRowid);
    }
    async close() {
        this.db.close();
    }
}
class PgDb extends Db {
    pool;
    constructor(pool) {
        super('postgres');
        this.pool = pool;
    }
    async query(sql, params = []) {
        this.count++;
        // A named statement is prepared once per connection and reused — the pg twin of a statement
        // cache, so the baseline is not re-parsing every SQL the way an unprepared query would.
        const r = await this.pool.query({ text: this.render(sql), values: params, name: cacheName(sql) });
        return r.rows;
    }
    async exec(sql, params = []) {
        this.count++;
        await this.pool.query({ text: this.render(sql), values: params, name: cacheName(sql) });
    }
    async insertUserId(email, name) {
        const rows = await this.query('INSERT INTO benchmark_users (email, name) VALUES (?, ?) RETURNING id', [email, name]);
        return Number(rows[0].id);
    }
    async close() {
        await this.pool.end();
    }
}
class MysqlDb extends Db {
    pool;
    constructor(pool) {
        super('mysql');
        this.pool = pool;
    }
    async query(sql, params = []) {
        this.count++;
        const [rows] = await this.pool.execute(sql, params); // `execute` = server-side prepared + cached
        return rows;
    }
    async exec(sql, params = []) {
        this.count++;
        if (params.length === 0)
            await this.pool.query(sql);
        else
            await this.pool.execute(sql, params);
    }
    async insertUserId(email, name) {
        this.count++;
        const [res] = await this.pool.execute('INSERT INTO benchmark_users (email, name) VALUES (?, ?)', [email, name]);
        return Number(res.insertId);
    }
    async close() {
        await this.pool.end();
    }
}
/** A stable per-SQL name so pg prepares each statement once per connection. */
const names = new Map();
function cacheName(sql) {
    let n = names.get(sql);
    if (!n)
        names.set(sql, (n = `s${names.size}`));
    return n;
}
/** Group `rows` by the value of `cols`, so a parent can take its slice by move. */
function groupBy(rows, cols) {
    const m = new Map();
    for (const r of rows) {
        const k = cols.map((c) => String(r[c])).join('');
        const bucket = m.get(k);
        if (bucket)
            bucket.push(r);
        else
            m.set(k, [r]);
    }
    return m;
}
/** users → ONE batched posts read, moved into their author. */
async function attachPosts(db, users) {
    if (users.length === 0)
        return users;
    const ids = users.map((u) => u.id);
    const posts = (await db.query(`SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`, ids));
    const byAuthor = groupBy(posts, ['author_id']);
    for (const u of users)
        u.posts = byAuthor.get(String(u.id)) ?? [];
    return users;
}
/** users → batched posts → batched comments, assembled into the full three-level graph. */
async function attachPostsAndComments(db, users) {
    if (users.length === 0)
        return users;
    const uids = users.map((u) => u.id);
    const posts = (await db.query(`SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN (${uids.map(() => '?').join(',')}) ORDER BY id ASC`, uids));
    if (posts.length > 0) {
        const pids = posts.map((p) => p.id);
        const comments = await db.query(`SELECT id, body, post_id FROM benchmark_comments WHERE post_id IN (${pids.map(() => '?').join(',')}) ORDER BY id ASC`, pids);
        const byPost = groupBy(comments, ['post_id']);
        for (const p of posts)
            p.comments = byPost.get(String(p.id)) ?? [];
    }
    const byAuthor = groupBy(posts, ['author_id']);
    for (const u of users)
        u.posts = byAuthor.get(String(u.id)) ?? [];
    return users;
}
/** tenant_users(tenant=1) → batched tenant_posts → batched tenant_comments, on the FULL key tuple. */
async function compositeGraph(db) {
    const tusers = await db.query('SELECT tenant_id, user_id, name FROM benchmark_tenant_users WHERE tenant_id = ? ORDER BY user_id ASC', [1]);
    if (tusers.length === 0)
        return tusers;
    const pparams = tusers.flatMap((u) => [u.tenant_id, u.user_id]);
    const tposts = await db.query(`SELECT tenant_id, post_id, user_id, title FROM benchmark_tenant_posts WHERE (tenant_id, user_id) IN ${db.tupleIn(tusers.length, 2)}`, pparams);
    if (tposts.length > 0) {
        const cparams = tposts.flatMap((p) => [p.tenant_id, p.post_id]);
        const tcomments = await db.query(`SELECT tenant_id, comment_id, post_id, body FROM benchmark_tenant_comments WHERE (tenant_id, post_id) IN ${db.tupleIn(tposts.length, 2)}`, cparams);
        const byPost = groupBy(tcomments, ['tenant_id', 'post_id']);
        for (const p of tposts)
            p.comments = byPost.get(`${p.tenant_id}${p.post_id}`) ?? [];
    }
    const byUser = groupBy(tposts, ['tenant_id', 'user_id']);
    for (const u of tusers)
        u.posts = byUser.get(`${u.tenant_id}${u.user_id}`) ?? [];
    return tusers;
}
/** ONE multi-row INSERT for the 10 rows, optional conflict tail — never 10 statements. */
async function batchInsert(db, rows, tail) {
    const values = rows.map(() => '(?, ?)').join(',');
    await db.exec(`INSERT INTO benchmark_users (email, name) VALUES ${values}${tail}`, rows.flatMap((r) => [r.email, r.name]));
}
/** ONE statement: CASE id … END WHERE id IN (…). */
async function updateMany(db) {
    const rows = updateManyRows();
    const whens = rows.map(() => ' WHEN ? THEN ?').join('');
    const params = [...rows.flatMap((r) => [r.id, r.name]), ...rows.map((r) => r.id)];
    await db.exec(`UPDATE benchmark_users SET name = CASE id${whens} END WHERE id IN (${rows.map(() => '?').join(',')})`, params);
}
/** The result of the last materialization, held so the engine cannot elide the assembly work. */
let sink;
async function runOp(db, op, it) {
    const input = inputFor(op, it);
    switch (op) {
        case 'findAll':
            await db.query('SELECT id, email, name FROM benchmark_users ORDER BY id ASC LIMIT 100');
            return;
        case 'filterPaginateSort':
            await db.query('SELECT id, title, content, published, author_id, created_at FROM benchmark_posts WHERE published = ? ORDER BY created_at DESC LIMIT 20 OFFSET 10', [input.published]);
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
            sink = await attachPosts(db, await db.query('SELECT id, email, name FROM benchmark_users WHERE name LIKE ? LIMIT 1', [input.name]));
            return;
        case 'nestedFindUnique':
            sink = await attachPosts(db, await db.query('SELECT id, email, name FROM benchmark_users WHERE email = ? LIMIT 1', [input.email]));
            return;
        case 'nestedRelations':
            sink = await attachPostsAndComments(db, await db.query('SELECT id, email, name FROM benchmark_users ORDER BY id ASC LIMIT 100'));
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
            await db.exec(`INSERT INTO benchmark_users (email, name) VALUES (?, ?)${db.upsertTail()}`, [input.email, input.name]);
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
            const uid = await db.insertUserId(input.email, input.name);
            await db.exec('INSERT INTO benchmark_posts (author_id, title) VALUES (?, ?)', [uid, input.title]);
            await db.exec('COMMIT');
            return;
        }
        case 'nestedUpsert': {
            await db.exec('BEGIN');
            const rows = await db.query(`INSERT INTO benchmark_users (email, name) VALUES (?, ?)${db.upsertTail()}${db.dialect === 'postgres' ? ' RETURNING id' : ''}`, [input.email, input.name]);
            const uid = db.dialect === 'postgres'
                ? Number(rows[0].id)
                : Number((await db.query('SELECT id FROM benchmark_users WHERE email = ?', [input.email]))[0].id);
            await db.exec('INSERT INTO benchmark_posts (author_id, title) VALUES (?, ?)', [uid, input.title]);
            await db.exec('COMMIT');
            return;
        }
        case 'nestedUpdate':
            await db.exec('BEGIN');
            await db.exec('UPDATE benchmark_users SET name = ? WHERE id = ?', [input.name, input.id]);
            await db.exec('UPDATE benchmark_posts SET title = ? WHERE author_id = ?', [input.title, input.id]);
            await db.exec('COMMIT');
            return;
        case 'delete': {
            await db.exec('BEGIN');
            const uid = await db.insertUserId(input.email, input.name);
            await db.exec('DELETE FROM benchmark_users WHERE id = ?', [uid]);
            await db.exec('COMMIT');
            return;
        }
        default:
            throw new Error(`unknown op ${op}`);
    }
}
export async function openSdk(dialect) {
    const setup = setupFor(dialect);
    let db;
    if (dialect === 'sqlite') {
        const conn = new Database(':memory:');
        for (const stmt of setup.schema)
            conn.exec(stmt);
        db = new SqliteDb(conn);
    }
    else if (dialect === 'postgres') {
        const pool = new PgPool({ ...PG_CONFIG, max: 4 });
        for (const stmt of setup.schema)
            await pool.query(stmt);
        db = new PgDb(pool);
    }
    else {
        const pool = mysql.createPool({
            ...MYSQL_CONFIG,
            connectionLimit: 4,
            multipleStatements: false,
        });
        for (const stmt of setup.schema)
            await pool.query(stmt);
        db = new MysqlDb(pool);
    }
    return {
        dialect,
        sync: false,
        seed: async () => {
            for (const stmt of [...setup.delete, ...setup.insert]) {
                if (db instanceof SqliteDb)
                    db.db.exec(stmt);
                else if (db instanceof PgDb)
                    await db.pool.query(stmt);
                else
                    await db.pool.query(stmt);
            }
        },
        run: (op, it) => runOp(db, op, it),
        close: () => db.close(),
        statements: () => db.count,
        resetStatements: () => {
            db.count = 0;
        },
    };
}
