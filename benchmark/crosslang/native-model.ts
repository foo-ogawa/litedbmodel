// ════════════════════════════════════════════════════════════════════════════
// ORM-bench NATIVE model authoring — the litedbmodel SCP surface for the cross-lang bench.
//
// This module DECLARES the 19 ORM ops on behavior-contracts' native TS authoring surface. It is READ,
// never executed: `bc generate --from <this file> --behavior <DialectClass>` type-extracts each method's
// parameter/return types and lowers its body AST to IR, then runs the emitter. There is no IR dump and no
// programmatic compile in the generation or verification path — the native module
// is bc's own `bc generate` output and the drift gate is bc's own `bc check` (see gen-native.sh).
//
// Because the source is read rather than run, every SQL string is a LITERAL here. THIS FILE is the
// 19-op semantics SSoT (the retired recorder-authored `ops.ts`/`domain.ts` are gone); the schema/seed
// match `orm-domain.ts`.
//
// ── the de-box discipline (one de-box per chain) ──
// The three leaves below are OP-AGNOSTIC: one `executeSQL` covers every statement of every op, and
// `pluck`/`group` cover every relation level. That is possible because their ports are declared
// `WireValue` / `WireValue[]` — the opaque wire type. A binding annotated `WireValue[]` stays opaque
// (wire passthrough), so an intermediate result flows leaf→leaf with NO typed↔generic round-trip; the
// SINGLE de-box happens at the one binding that declares a CONCRETE row type — the terminal. A relation
// op therefore runs `executeSQL → pluck → executeSQL → … → group` entirely on the wire plane and
// materializes the whole nested typed graph exactly once, at the end.
//
// A de-box point is spelled `const rows: Row[] = Db.<leaf>(…) as Row[]` — the ANNOTATION is the
// declaration bc reads and the single assertion is what tells TypeScript about the opaque→concrete
// narrowing, so the file is ordinary `tsc --strict` TypeScript. Dropping the annotation and keeping
// only the cast makes the declaration and the body's derived type diverge, and bc rejects it. An
// opaque chain may not END: a component return type carries no wire-passthrough flag, so every op
// terminates on a concrete type. Inside a `.map`, the binding annotation declares the PER-ELEMENT
// type — the de-box therefore sits on a binding within the arrow body, and the map node yields the
// array of it.
//
// ── per-dialect classes ──
// The SQL differs by dialect (batch binds, relation key-set predicates, upsert syntax), so each dialect
// is one class of the same 19 ops: `BenchSqlite` / `BenchPostgres` / `BenchMysql`. `gen-native.sh` picks
// the class with `--behavior`. Numbers are declared with bc's branded `Int` / `Float` (a bare `number`
// is rejected as ambiguous); nullability follows the column declarations in `orm-domain.ts`.
// ════════════════════════════════════════════════════════════════════════════
import { behavior, type Int, type Float, type WireValue } from 'behavior-contracts';
// The op-agnostic leaf transports are declared ONCE, in the library (`src/scp/leaf-transport.ts`) —
// the SSoT `@leaf static` catalog every authored / emitted litedbmodel model imports. The bench does
// not re-declare them: a second declaration would be a second catalog.
import { Db } from '../../src/scp/leaf-transport.js';

// ── row types: the de-box targets (each is exactly one op's terminal declaration) ────────────────────
// Every numeric column below is an INTEGER column in `orm-domain.ts`'s DDL (INTEGER / INT /
// SERIAL), so each is declared `Int`. `Float` here made bc widen every id to a float, which reads
// back as `1.0` — invisible in a language with one number type, a wrong answer in PHP's `===`.
/** `benchmark_users` projection — `id` is `INTEGER NOT NULL`, the rest nullable. */
interface UserRow { id: Int; email: string | null; name: string | null }
/** `benchmark_posts` full projection (filterPaginateSort). */
interface PostFullRow { id: Int; title: string | null; content: string | null; published: Int | null; author_id: Int | null; created_at: string | null }
/** A RETURNING-id projection: the upsert result, and the source row a tx `.map` chains off. */
interface IdRow { id: Int }
/** The uniform non-RETURNING write summary the `executeSQL` transport returns (`[{changes, …}]`). */
interface WriteSummary { changes: Int; lastInsertRowid: Int }

// Relation graph rows — nested exactly as `group`'s `into` port names each level.
interface CommentRow { id: Int | null; body: string | null; post_id: Int | null }
interface PostRow { id: Int; title: string | null; author_id: Int | null }
interface PostWithComments { id: Int; title: string | null; author_id: Int | null; comments: CommentRow[] }
interface UserWithPosts { id: Int; email: string | null; name: string | null; posts: PostRow[] }
interface UserWithPostsAndComments { id: Int; email: string | null; name: string | null; posts: PostWithComments[] }

// Composite-key (2-column) relation graph — tenant_users → tenant_posts → tenant_comments.
interface TenantCommentRow { tenant_id: Int | null; comment_id: Int | null; post_id: Int | null; body: string | null }
interface TenantPostWithComments { tenant_id: Int | null; post_id: Int | null; user_id: Int | null; title: string | null; comments: TenantCommentRow[] }
interface TenantUserWithPosts { tenant_id: Int | null; user_id: Int | null; name: string | null; posts: TenantPostWithComments[] }

// Batch record-set inputs — bc emits a native `Vec<Row>` / `[]Row` entry parameter and boxes typed→wire
// at the leaf-param boundary, so the bench harness passes native rows.
interface NewUser { email: string; name: string }
interface UserPatch { id: Int; name: string }

export class BenchSqlite {
  @behavior static findAll(): UserRow[] {
    const rows: UserRow[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users ORDER BY id ASC LIMIT 100", [], false, false, false) as UserRow[];
    return rows;
  }

  @behavior static filterPaginateSort(published: Int): PostFullRow[] {
    const rows: PostFullRow[] = Db.executeSQL("SELECT id, title, content, published, author_id, created_at FROM benchmark_posts WHERE published = ? ORDER BY created_at DESC LIMIT 20 OFFSET 10", [published], false, false, false) as PostFullRow[];
    return rows;
  }

  @behavior static findFirst(name: string): UserRow[] {
    const rows: UserRow[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users WHERE name LIKE ? LIMIT 1", [name], false, false, false) as UserRow[];
    return rows;
  }

  @behavior static findUnique(email: string): UserRow[] {
    const rows: UserRow[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users WHERE email = ? LIMIT 1", [email], false, false, false) as UserRow[];
    return rows;
  }

  @behavior static nestedFindAll(): UserWithPosts[] {
    const users: WireValue[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users LIMIT 100", [], false, false, false);
    const userKeys: WireValue[] = Db.pluck(users, ["id"]);
    const posts: WireValue[] = Db.executeSQL("SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN (SELECT value FROM json_each(?)) ORDER BY id ASC", [userKeys], false, false, false);
    const usersWithPosts: UserWithPosts[] = Db.group(users, posts, ["id"], ["author_id"], "posts", false) as UserWithPosts[];
    return usersWithPosts;
  }

  @behavior static nestedFindFirst(name: string): UserWithPosts[] {
    const users: WireValue[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users WHERE name LIKE ? LIMIT 1", [name], false, false, false);
    const userKeys: WireValue[] = Db.pluck(users, ["id"]);
    const posts: WireValue[] = Db.executeSQL("SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN (SELECT value FROM json_each(?)) ORDER BY id ASC", [userKeys], false, false, false);
    const usersWithPosts: UserWithPosts[] = Db.group(users, posts, ["id"], ["author_id"], "posts", false) as UserWithPosts[];
    return usersWithPosts;
  }

  @behavior static nestedFindUnique(email: string): UserWithPosts[] {
    const users: WireValue[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users WHERE email = ? LIMIT 1", [email], false, false, false);
    const userKeys: WireValue[] = Db.pluck(users, ["id"]);
    const posts: WireValue[] = Db.executeSQL("SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN (SELECT value FROM json_each(?)) ORDER BY id ASC", [userKeys], false, false, false);
    const usersWithPosts: UserWithPosts[] = Db.group(users, posts, ["id"], ["author_id"], "posts", false) as UserWithPosts[];
    return usersWithPosts;
  }

  @behavior static nestedRelations(): UserWithPostsAndComments[] {
    const users: WireValue[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users LIMIT 100", [], false, false, false);
    const userKeys: WireValue[] = Db.pluck(users, ["id"]);
    const posts: WireValue[] = Db.executeSQL("SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN (SELECT value FROM json_each(?)) ORDER BY id ASC", [userKeys], false, false, false);
    const postKeys: WireValue[] = Db.pluck(posts, ["id"]);
    const comments: WireValue[] = Db.executeSQL("SELECT id, body, post_id FROM benchmark_comments WHERE post_id IN (SELECT value FROM json_each(?)) ORDER BY id ASC", [postKeys], false, false, false);
    const postsWithComments: WireValue[] = Db.group(posts, comments, ["id"], ["post_id"], "comments", false);
    const usersWithPosts: UserWithPostsAndComments[] = Db.group(users, postsWithComments, ["id"], ["author_id"], "posts", false) as UserWithPostsAndComments[];
    return usersWithPosts;
  }

  @behavior static compositeRelations(): TenantUserWithPosts[] {
    const tenantUsers: WireValue[] = Db.executeSQL("SELECT tenant_id, user_id, name FROM benchmark_tenant_users ORDER BY user_id ASC LIMIT 100", [], false, false, false);
    const tenantUserKeys: WireValue[] = Db.pluck(tenantUsers, ["tenant_id", "user_id"]);
    const tenantPosts: WireValue[] = Db.executeSQL("SELECT tenant_id, post_id, user_id, title FROM benchmark_tenant_posts WHERE EXISTS (SELECT 1 FROM json_each(?) je WHERE json_extract(je.value, '$[0]') = benchmark_tenant_posts.tenant_id AND json_extract(je.value, '$[1]') = benchmark_tenant_posts.user_id) ORDER BY post_id ASC", [tenantUserKeys], false, false, false);
    const tenantPostKeys: WireValue[] = Db.pluck(tenantPosts, ["tenant_id", "post_id"]);
    const tenantComments: WireValue[] = Db.executeSQL("SELECT tenant_id, comment_id, post_id, body FROM benchmark_tenant_comments WHERE EXISTS (SELECT 1 FROM json_each(?) je WHERE json_extract(je.value, '$[0]') = benchmark_tenant_comments.tenant_id AND json_extract(je.value, '$[1]') = benchmark_tenant_comments.post_id) ORDER BY comment_id ASC", [tenantPostKeys], false, false, false);
    const tenantPostsWithComments: WireValue[] = Db.group(tenantPosts, tenantComments, ["tenant_id", "post_id"], ["tenant_id", "post_id"], "comments", false);
    const tenantUsersWithPosts: TenantUserWithPosts[] = Db.group(tenantUsers, tenantPostsWithComments, ["tenant_id", "user_id"], ["tenant_id", "user_id"], "posts", false) as TenantUserWithPosts[];
    return tenantUsersWithPosts;
  }

  @behavior static create(email: string, name: string): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?)", [email, name], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static update(id: Int, name: string): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("UPDATE benchmark_users SET name = ? WHERE id = ?", [name, id], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static upsert(email: string, name: string): IdRow[] {
    const returned: IdRow[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET email = excluded.email, name = excluded.name RETURNING id", [email, name], true, true, false) as IdRow[];
    return returned;
  }

  @behavior static createMany(rows: NewUser[]): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) SELECT json_extract(value, '$.email'), json_extract(value, '$.name') FROM json_each(?)", [rows], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static upsertMany(rows: NewUser[]): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) SELECT json_extract(value, '$.email'), json_extract(value, '$.name') FROM json_each(?) WHERE true ON CONFLICT (email) DO UPDATE SET email = excluded.email, name = excluded.name", [rows], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static updateMany(rows: UserPatch[]): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("UPDATE benchmark_users SET name = (SELECT json_extract(je.value, '$.name') FROM json_each(?) je WHERE json_extract(je.value, '$.id') = benchmark_users.id LIMIT 1) WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?))", [rows, rows], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static nestedCreate(email: string, name: string, title: string): WriteSummary[][] {
    const user: IdRow[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?) RETURNING id", [email, name], true, true, false) as IdRow[];
    return user.map((u) => {
      const written: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_posts (author_id, title) VALUES (?, ?)", [u.id, title], true, false, false) as WriteSummary[];
      return written;
    });
  }

  @behavior static nestedUpsert(email: string, name: string, title: string): WriteSummary[][] {
    const user: IdRow[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET email = excluded.email, name = excluded.name RETURNING id", [email, name], true, true, false) as IdRow[];
    return user.map((u) => {
      const written: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_posts (author_id, title) VALUES (?, ?)", [u.id, title], true, false, false) as WriteSummary[];
      return written;
    });
  }

  @behavior static nestedUpdate(id: Int, name: string, title: string): WriteSummary[][] {
    const user: IdRow[] = Db.executeSQL("UPDATE benchmark_users SET name = ? WHERE id = ? RETURNING id", [name, id], true, true, false) as IdRow[];
    return user.map((u) => {
      const written: WriteSummary[] = Db.executeSQL("UPDATE benchmark_posts SET title = ? WHERE author_id = ?", [title, u.id], true, false, false) as WriteSummary[];
      return written;
    });
  }

  @behavior static delete(email: string, name: string): WriteSummary[][] {
    const user: IdRow[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?) RETURNING id", [email, name], true, true, false) as IdRow[];
    return user.map((u) => {
      const written: WriteSummary[] = Db.executeSQL("DELETE FROM benchmark_users WHERE id = ?", [u.id], true, false, false) as WriteSummary[];
      return written;
    });
  }
}

export class BenchPostgres {
  @behavior static findAll(): UserRow[] {
    const rows: UserRow[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users ORDER BY id ASC LIMIT 100", [], false, false, false) as UserRow[];
    return rows;
  }

  @behavior static filterPaginateSort(published: Int): PostFullRow[] {
    const rows: PostFullRow[] = Db.executeSQL("SELECT id, title, content, published, author_id, created_at FROM benchmark_posts WHERE published = ? ORDER BY created_at DESC LIMIT 20 OFFSET 10", [published], false, false, false) as PostFullRow[];
    return rows;
  }

  @behavior static findFirst(name: string): UserRow[] {
    const rows: UserRow[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users WHERE name LIKE ? LIMIT 1", [name], false, false, false) as UserRow[];
    return rows;
  }

  @behavior static findUnique(email: string): UserRow[] {
    const rows: UserRow[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users WHERE email = ? LIMIT 1", [email], false, false, false) as UserRow[];
    return rows;
  }

  @behavior static nestedFindAll(): UserWithPosts[] {
    const users: WireValue[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users LIMIT 100", [], false, false, false);
    const userKeys: WireValue[] = Db.pluck(users, ["id"]);
    const posts: WireValue[] = Db.executeSQL("SELECT id, title, author_id FROM benchmark_posts WHERE benchmark_posts.author_id = ANY(?::@@PG_ARRAY_CAST@@) ORDER BY id ASC", [userKeys], false, false, false);
    const usersWithPosts: UserWithPosts[] = Db.group(users, posts, ["id"], ["author_id"], "posts", false) as UserWithPosts[];
    return usersWithPosts;
  }

  @behavior static nestedFindFirst(name: string): UserWithPosts[] {
    const users: WireValue[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users WHERE name LIKE ? LIMIT 1", [name], false, false, false);
    const userKeys: WireValue[] = Db.pluck(users, ["id"]);
    const posts: WireValue[] = Db.executeSQL("SELECT id, title, author_id FROM benchmark_posts WHERE benchmark_posts.author_id = ANY(?::@@PG_ARRAY_CAST@@) ORDER BY id ASC", [userKeys], false, false, false);
    const usersWithPosts: UserWithPosts[] = Db.group(users, posts, ["id"], ["author_id"], "posts", false) as UserWithPosts[];
    return usersWithPosts;
  }

  @behavior static nestedFindUnique(email: string): UserWithPosts[] {
    const users: WireValue[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users WHERE email = ? LIMIT 1", [email], false, false, false);
    const userKeys: WireValue[] = Db.pluck(users, ["id"]);
    const posts: WireValue[] = Db.executeSQL("SELECT id, title, author_id FROM benchmark_posts WHERE benchmark_posts.author_id = ANY(?::@@PG_ARRAY_CAST@@) ORDER BY id ASC", [userKeys], false, false, false);
    const usersWithPosts: UserWithPosts[] = Db.group(users, posts, ["id"], ["author_id"], "posts", false) as UserWithPosts[];
    return usersWithPosts;
  }

  @behavior static nestedRelations(): UserWithPostsAndComments[] {
    const users: WireValue[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users LIMIT 100", [], false, false, false);
    const userKeys: WireValue[] = Db.pluck(users, ["id"]);
    const posts: WireValue[] = Db.executeSQL("SELECT id, title, author_id FROM benchmark_posts WHERE benchmark_posts.author_id = ANY(?::@@PG_ARRAY_CAST@@) ORDER BY id ASC", [userKeys], false, false, false);
    const postKeys: WireValue[] = Db.pluck(posts, ["id"]);
    const comments: WireValue[] = Db.executeSQL("SELECT id, body, post_id FROM benchmark_comments WHERE benchmark_comments.post_id = ANY(?::@@PG_ARRAY_CAST@@) ORDER BY id ASC", [postKeys], false, false, false);
    const postsWithComments: WireValue[] = Db.group(posts, comments, ["id"], ["post_id"], "comments", false);
    const usersWithPosts: UserWithPostsAndComments[] = Db.group(users, postsWithComments, ["id"], ["author_id"], "posts", false) as UserWithPostsAndComments[];
    return usersWithPosts;
  }

  @behavior static compositeRelations(): TenantUserWithPosts[] {
    const tenantUsers: WireValue[] = Db.executeSQL("SELECT tenant_id, user_id, name FROM benchmark_tenant_users ORDER BY user_id ASC LIMIT 100", [], false, false, false);
    const tenantUserKeys: WireValue[] = Db.pluck(tenantUsers, ["tenant_id", "user_id"]);
    const tenantPosts: WireValue[] = Db.executeSQL("SELECT tenant_id, post_id, user_id, title FROM benchmark_tenant_posts JOIN (SELECT (_t->>0)::int AS key0, (_t->>1)::int AS key1 FROM json_array_elements(?::json) AS _t) AS _keys ON benchmark_tenant_posts.tenant_id = _keys.key0 AND benchmark_tenant_posts.user_id = _keys.key1 ORDER BY post_id ASC", [tenantUserKeys], false, false, false);
    const tenantPostKeys: WireValue[] = Db.pluck(tenantPosts, ["tenant_id", "post_id"]);
    const tenantComments: WireValue[] = Db.executeSQL("SELECT tenant_id, comment_id, post_id, body FROM benchmark_tenant_comments JOIN (SELECT (_t->>0)::int AS key0, (_t->>1)::int AS key1 FROM json_array_elements(?::json) AS _t) AS _keys ON benchmark_tenant_comments.tenant_id = _keys.key0 AND benchmark_tenant_comments.post_id = _keys.key1 ORDER BY comment_id ASC", [tenantPostKeys], false, false, false);
    const tenantPostsWithComments: WireValue[] = Db.group(tenantPosts, tenantComments, ["tenant_id", "post_id"], ["tenant_id", "post_id"], "comments", false);
    const tenantUsersWithPosts: TenantUserWithPosts[] = Db.group(tenantUsers, tenantPostsWithComments, ["tenant_id", "user_id"], ["tenant_id", "user_id"], "posts", false) as TenantUserWithPosts[];
    return tenantUsersWithPosts;
  }

  @behavior static create(email: string, name: string): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?)", [email, name], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static update(id: Int, name: string): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("UPDATE benchmark_users SET name = ? WHERE id = ?", [name, id], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static upsert(email: string, name: string): IdRow[] {
    const returned: IdRow[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET email = excluded.email, name = excluded.name RETURNING id", [email, name], true, true, false) as IdRow[];
    return returned;
  }

  @behavior static createMany(rows: NewUser[]): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) SELECT v.email, v.name FROM UNNEST(?::text[], ?::text[]) AS v(email, name)", [rows], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static upsertMany(rows: NewUser[]): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) SELECT v.email, v.name FROM UNNEST(?::text[], ?::text[]) AS v(email, name) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name", [rows, rows], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static updateMany(rows: UserPatch[]): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("UPDATE benchmark_users AS t SET name = v.name FROM UNNEST(?::int[], ?::text[]) AS v(id, name) WHERE t.id = v.id", [rows], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static nestedCreate(email: string, name: string, title: string): WriteSummary[][] {
    const user: IdRow[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?) RETURNING id", [email, name], true, true, false) as IdRow[];
    return user.map((u) => {
      const written: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_posts (author_id, title) VALUES (?, ?)", [u.id, title], true, false, false) as WriteSummary[];
      return written;
    });
  }

  @behavior static nestedUpsert(email: string, name: string, title: string): WriteSummary[][] {
    const user: IdRow[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET email = excluded.email, name = excluded.name RETURNING id", [email, name], true, true, false) as IdRow[];
    return user.map((u) => {
      const written: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_posts (author_id, title) VALUES (?, ?)", [u.id, title], true, false, false) as WriteSummary[];
      return written;
    });
  }

  @behavior static nestedUpdate(id: Int, name: string, title: string): WriteSummary[][] {
    const user: IdRow[] = Db.executeSQL("UPDATE benchmark_users SET name = ? WHERE id = ? RETURNING id", [name, id], true, true, false) as IdRow[];
    return user.map((u) => {
      const written: WriteSummary[] = Db.executeSQL("UPDATE benchmark_posts SET title = ? WHERE author_id = ?", [title, u.id], true, false, false) as WriteSummary[];
      return written;
    });
  }

  @behavior static delete(email: string, name: string): WriteSummary[][] {
    const user: IdRow[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?) RETURNING id", [email, name], true, true, false) as IdRow[];
    return user.map((u) => {
      const written: WriteSummary[] = Db.executeSQL("DELETE FROM benchmark_users WHERE id = ?", [u.id], true, false, false) as WriteSummary[];
      return written;
    });
  }
}

export class BenchMysql {
  @behavior static findAll(): UserRow[] {
    const rows: UserRow[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users ORDER BY id ASC LIMIT 100", [], false, false, false) as UserRow[];
    return rows;
  }

  @behavior static filterPaginateSort(published: Int): PostFullRow[] {
    const rows: PostFullRow[] = Db.executeSQL("SELECT id, title, content, published, author_id, created_at FROM benchmark_posts WHERE published = ? ORDER BY created_at DESC LIMIT 20 OFFSET 10", [published], false, false, false) as PostFullRow[];
    return rows;
  }

  @behavior static findFirst(name: string): UserRow[] {
    const rows: UserRow[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users WHERE name LIKE ? LIMIT 1", [name], false, false, false) as UserRow[];
    return rows;
  }

  @behavior static findUnique(email: string): UserRow[] {
    const rows: UserRow[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users WHERE email = ? LIMIT 1", [email], false, false, false) as UserRow[];
    return rows;
  }

  @behavior static nestedFindAll(): UserWithPosts[] {
    const users: WireValue[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users LIMIT 100", [], false, false, false);
    const userKeys: WireValue[] = Db.pluck(users, ["id"]);
    const posts: WireValue[] = Db.executeSQL("SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN (SELECT JSON_UNQUOTE(v) FROM JSON_TABLE(?, '$[*]' COLUMNS(v JSON PATH '$')) jt) ORDER BY id ASC", [userKeys], false, false, false);
    const usersWithPosts: UserWithPosts[] = Db.group(users, posts, ["id"], ["author_id"], "posts", false) as UserWithPosts[];
    return usersWithPosts;
  }

  @behavior static nestedFindFirst(name: string): UserWithPosts[] {
    const users: WireValue[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users WHERE name LIKE ? LIMIT 1", [name], false, false, false);
    const userKeys: WireValue[] = Db.pluck(users, ["id"]);
    const posts: WireValue[] = Db.executeSQL("SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN (SELECT JSON_UNQUOTE(v) FROM JSON_TABLE(?, '$[*]' COLUMNS(v JSON PATH '$')) jt) ORDER BY id ASC", [userKeys], false, false, false);
    const usersWithPosts: UserWithPosts[] = Db.group(users, posts, ["id"], ["author_id"], "posts", false) as UserWithPosts[];
    return usersWithPosts;
  }

  @behavior static nestedFindUnique(email: string): UserWithPosts[] {
    const users: WireValue[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users WHERE email = ? LIMIT 1", [email], false, false, false);
    const userKeys: WireValue[] = Db.pluck(users, ["id"]);
    const posts: WireValue[] = Db.executeSQL("SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN (SELECT JSON_UNQUOTE(v) FROM JSON_TABLE(?, '$[*]' COLUMNS(v JSON PATH '$')) jt) ORDER BY id ASC", [userKeys], false, false, false);
    const usersWithPosts: UserWithPosts[] = Db.group(users, posts, ["id"], ["author_id"], "posts", false) as UserWithPosts[];
    return usersWithPosts;
  }

  @behavior static nestedRelations(): UserWithPostsAndComments[] {
    const users: WireValue[] = Db.executeSQL("SELECT id, email, name FROM benchmark_users LIMIT 100", [], false, false, false);
    const userKeys: WireValue[] = Db.pluck(users, ["id"]);
    const posts: WireValue[] = Db.executeSQL("SELECT id, title, author_id FROM benchmark_posts WHERE author_id IN (SELECT JSON_UNQUOTE(v) FROM JSON_TABLE(?, '$[*]' COLUMNS(v JSON PATH '$')) jt) ORDER BY id ASC", [userKeys], false, false, false);
    const postKeys: WireValue[] = Db.pluck(posts, ["id"]);
    const comments: WireValue[] = Db.executeSQL("SELECT id, body, post_id FROM benchmark_comments WHERE post_id IN (SELECT JSON_UNQUOTE(v) FROM JSON_TABLE(?, '$[*]' COLUMNS(v JSON PATH '$')) jt) ORDER BY id ASC", [postKeys], false, false, false);
    const postsWithComments: WireValue[] = Db.group(posts, comments, ["id"], ["post_id"], "comments", false);
    const usersWithPosts: UserWithPostsAndComments[] = Db.group(users, postsWithComments, ["id"], ["author_id"], "posts", false) as UserWithPostsAndComments[];
    return usersWithPosts;
  }

  @behavior static compositeRelations(): TenantUserWithPosts[] {
    const tenantUsers: WireValue[] = Db.executeSQL("SELECT tenant_id, user_id, name FROM benchmark_tenant_users ORDER BY user_id ASC LIMIT 100", [], false, false, false);
    const tenantUserKeys: WireValue[] = Db.pluck(tenantUsers, ["tenant_id", "user_id"]);
    const tenantPosts: WireValue[] = Db.executeSQL("SELECT tenant_id, post_id, user_id, title FROM benchmark_tenant_posts WHERE (benchmark_tenant_posts.tenant_id, benchmark_tenant_posts.user_id) IN (SELECT JSON_UNQUOTE(c0), JSON_UNQUOTE(c1) FROM JSON_TABLE(?, '$[*]' COLUMNS(c0 JSON PATH '$[0]', c1 JSON PATH '$[1]')) jt) ORDER BY post_id ASC", [tenantUserKeys], false, false, false);
    const tenantPostKeys: WireValue[] = Db.pluck(tenantPosts, ["tenant_id", "post_id"]);
    const tenantComments: WireValue[] = Db.executeSQL("SELECT tenant_id, comment_id, post_id, body FROM benchmark_tenant_comments WHERE (benchmark_tenant_comments.tenant_id, benchmark_tenant_comments.post_id) IN (SELECT JSON_UNQUOTE(c0), JSON_UNQUOTE(c1) FROM JSON_TABLE(?, '$[*]' COLUMNS(c0 JSON PATH '$[0]', c1 JSON PATH '$[1]')) jt) ORDER BY comment_id ASC", [tenantPostKeys], false, false, false);
    const tenantPostsWithComments: WireValue[] = Db.group(tenantPosts, tenantComments, ["tenant_id", "post_id"], ["tenant_id", "post_id"], "comments", false);
    const tenantUsersWithPosts: TenantUserWithPosts[] = Db.group(tenantUsers, tenantPostsWithComments, ["tenant_id", "user_id"], ["tenant_id", "user_id"], "posts", false) as TenantUserWithPosts[];
    return tenantUsersWithPosts;
  }

  @behavior static create(email: string, name: string): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?)", [email, name], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static update(id: Int, name: string): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("UPDATE benchmark_users SET name = ? WHERE id = ?", [name, id], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static upsert(email: string, name: string): IdRow[] {
    const returned: IdRow[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name) RETURNING id /*scp:pk=id;ai=id;conflict=email*/", [email, name], true, true, false) as IdRow[];
    return returned;
  }

  @behavior static createMany(rows: NewUser[]): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) SELECT JSON_UNQUOTE(jt.email), JSON_UNQUOTE(jt.name) FROM JSON_TABLE(?, '$[*]' COLUMNS(email JSON PATH '$.email', name JSON PATH '$.name')) jt", [rows], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static upsertMany(rows: NewUser[]): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) SELECT JSON_UNQUOTE(jt.email), JSON_UNQUOTE(jt.name) FROM JSON_TABLE(?, '$[*]' COLUMNS(email JSON PATH '$.email', name JSON PATH '$.name')) jt ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name)", [rows], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static updateMany(rows: UserPatch[]): WriteSummary[] {
    const summary: WriteSummary[] = Db.executeSQL("UPDATE benchmark_users AS u JOIN JSON_TABLE(?, '$[*]' COLUMNS(id JSON PATH '$.id', name JSON PATH '$.name')) AS v ON u.id = JSON_UNQUOTE(v.id) SET u.name = JSON_UNQUOTE(v.name)", [rows], true, false, false) as WriteSummary[];
    return summary;
  }

  @behavior static nestedCreate(email: string, name: string, title: string): WriteSummary[][] {
    const user: IdRow[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?) RETURNING id /*scp:pk=id;ai=id*/", [email, name], true, true, false) as IdRow[];
    return user.map((u) => {
      const written: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_posts (author_id, title) VALUES (?, ?)", [u.id, title], true, false, false) as WriteSummary[];
      return written;
    });
  }

  @behavior static nestedUpsert(email: string, name: string, title: string): WriteSummary[][] {
    const user: IdRow[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name) RETURNING id /*scp:pk=id;ai=id;conflict=email*/", [email, name], true, true, false) as IdRow[];
    return user.map((u) => {
      const written: WriteSummary[] = Db.executeSQL("INSERT INTO benchmark_posts (author_id, title) VALUES (?, ?)", [u.id, title], true, false, false) as WriteSummary[];
      return written;
    });
  }

  @behavior static nestedUpdate(id: Int, name: string, title: string): WriteSummary[][] {
    const user: IdRow[] = Db.executeSQL("UPDATE benchmark_users SET name = ? WHERE id = ? RETURNING id /*scp:pk=id;ai=id*/", [name, id], true, true, false) as IdRow[];
    return user.map((u) => {
      const written: WriteSummary[] = Db.executeSQL("UPDATE benchmark_posts SET title = ? WHERE author_id = ?", [title, u.id], true, false, false) as WriteSummary[];
      return written;
    });
  }

  @behavior static delete(email: string, name: string): WriteSummary[][] {
    const user: IdRow[] = Db.executeSQL("INSERT INTO benchmark_users (email, name) VALUES (?, ?) RETURNING id /*scp:pk=id;ai=id*/", [email, name], true, true, false) as IdRow[];
    return user.map((u) => {
      const written: WriteSummary[] = Db.executeSQL("DELETE FROM benchmark_users WHERE id = ?", [u.id], true, false, false) as WriteSummary[];
      return written;
    });
  }
}
