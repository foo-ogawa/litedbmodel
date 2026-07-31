/**
 * The DECORATED models + DECLARED endpoints the emitter tests lower — an ORM user's whole input.
 *
 * There is no SQL here and no SCP here: `@model` / `@column` / `@hasMany` are metadata collectors and
 * the endpoints name model columns, relations and parameters. Everything the generated modules execute
 * is derived from exactly this by `emitBehaviorModule`.
 *
 * Note: vitest (esbuild) does not support `emitDecoratorMetadata`, so a bare `@column()` carries no
 * `design:type` and takes the documented `DEFAULT_UNCAST_SQL_TYPE` (INTEGER); the text columns are
 * pinned through the adapter's `columnTypes` escape hatch ({@link EMIT_COLUMN_OPTIONS}) exactly as the
 * decorator-adapter tests do.
 */

import type { ColumnsOf } from '../../src';
import 'reflect-metadata';
import { model, column, hasMany, belongsTo } from '../../src/decorators';
import type { DeriveColumnsOptions, ModelClassLike } from '../../src/scp/decorator-adapter';
import type { EndpointSet } from '../../src/scp';

@model('e2e_users')
export class User {
  // `@column` installs a STATIC accessor per column at runtime; this names its TYPE so a
  // static reference (User.id) is CHECKED instead of resolving to an implicit any.
  declare static id: ColumnsOf<User>['id'];
  @column() id?: number;
  @column() name?: string;

  @hasMany(() => [User.id, Post.author_id], { order: () => Post.id.asc() })
  declare posts: Promise<Post[]>;
}

@model('e2e_posts')
export class Post {
  // `@column` installs a STATIC accessor per column at runtime; this names its TYPE so a
  // static reference (Post.id) is CHECKED instead of resolving to an implicit any.
  declare static id: ColumnsOf<Post>['id'];
  declare static author_id: ColumnsOf<Post>['author_id'];
  declare static title: ColumnsOf<Post>['title'];
  @column() id?: number;
  @column() author_id?: number;
  @column() title?: string;

  @hasMany(() => [Post.id, Comment.post_id], { order: () => Comment.id.asc() })
  declare comments: Promise<Comment[]>;

  @belongsTo(() => [Post.author_id, User.id])
  declare author: Promise<User | null>;
}

@model('e2e_comments')
export class Comment {
  // `@column` installs a STATIC accessor per column at runtime; this names its TYPE so a
  // static reference (Comment.id) is CHECKED instead of resolving to an implicit any.
  declare static id: ColumnsOf<Comment>['id'];
  declare static post_id: ColumnsOf<Comment>['post_id'];
  declare static body: ColumnsOf<Comment>['body'];
  @column() id?: number;
  @column() post_id?: number;
  @column() body?: string;
}

/** Composite-key models — the two-column relation key path. */
@model('e2e_tenant_users')
export class TenantUser {
  // `@column` installs a STATIC accessor per column at runtime; this names its TYPE so a
  // static reference (TenantUser.tenant_id) is CHECKED instead of resolving to an implicit any.
  declare static tenant_id: ColumnsOf<TenantUser>['tenant_id'];
  declare static user_id: ColumnsOf<TenantUser>['user_id'];
  @column() tenant_id?: number;
  @column() user_id?: number;
  @column() name?: string;

  @hasMany(
    () => [
      [TenantUser.tenant_id, TenantPost.tenant_id],
      [TenantUser.user_id, TenantPost.user_id],
    ],
    { order: () => TenantPost.title.asc() },
  )
  declare posts: Promise<TenantPost[]>;
}

@model('e2e_tenant_posts')
export class TenantPost {
  // `@column` installs a STATIC accessor per column at runtime; this names its TYPE so a
  // static reference (TenantPost.tenant_id) is CHECKED instead of resolving to an implicit any.
  declare static tenant_id: ColumnsOf<TenantPost>['tenant_id'];
  declare static user_id: ColumnsOf<TenantPost>['user_id'];
  declare static title: ColumnsOf<TenantPost>['title'];
  @column() tenant_id?: number;
  @column() user_id?: number;
  @column() title?: string;
}

// ── The TWO-CONNECTION model set (#217 named-DB routing) ────────────────────────────────────────
//
// A single-DB declaration cannot tell a honored connection name from a dropped one: both run against
// the one database. So the named-DB fixture is deliberately a TWO-database one — `NamedUser` lives in
// the connection called `analytics`, `NamedPost` in the default — and the two tables exist in
// DIFFERENT databases, so a statement that lands on the wrong one finds NO table at all.
//
// This is the v1 shape: a v1 model picks its database by extending a `createDBBase(config)` base class,
// and `LazyRelation.ts:236` loads a relation on the TARGET model's driver. `NamedPost.author` is
// therefore a CROSS-DB relation — the parent page reads from the default connection, the batched child
// SELECT must run on `analytics`.

/** The connection name the `analytics`-side models declare (registered by the routing config). */
export const NAMED_DB = 'analytics';

@model('scp217_users', { connection: NAMED_DB })
export class NamedUser {
  // `@column` installs a STATIC accessor per column at runtime; this names its TYPE so a
  // static reference (NamedUser.id) is CHECKED instead of resolving to an implicit any.
  declare static id: ColumnsOf<NamedUser>['id'];
  @column() id?: number;
  @column() name?: string;
}

@model('scp217_posts')
export class NamedPost {
  // `@column` installs a STATIC accessor per column at runtime; this names its TYPE so a
  // static reference (NamedPost.id) is CHECKED instead of resolving to an implicit any.
  declare static id: ColumnsOf<NamedPost>['id'];
  declare static author_id: ColumnsOf<NamedPost>['author_id'];
  declare static title: ColumnsOf<NamedPost>['title'];
  @column() id?: number;
  @column() author_id?: number;
  @column() title?: string;

  /** CROSS-DB: the target model lives in `analytics`, this one in the default connection. */
  @belongsTo(() => [NamedPost.author_id, NamedUser.id])
  declare author: Promise<NamedUser | null>;
}

/**
 * The named-DB endpoints — the TWO surfaces a connection name has to reach:
 *   - `postsWithAuthor` — a CROSS-DB RELATION: the parent read runs on the default connection, the
 *     batched child SELECT on the target model's (`analytics`).
 *   - `usersOnB` / `renameUserOnB` — an ENDPOINT (read AND write) whose OWN model is on `analytics`, so
 *     every statement it issues runs there.
 * They are a SEPARATE set from {@link EMIT_ENDPOINTS} because they need a ROUTED context with two
 * connections registered; the single-connection suites must not pick them up.
 */
export const NAMED_DB_ENDPOINTS: EndpointSet = {
  postsWithAuthor: { kind: 'read', model: NamedPost, order: 'id ASC', with: ['author'] },
  usersOnB: { kind: 'read', model: NamedUser, order: 'id ASC' },
  renameUserOnB: {
    kind: 'update',
    model: NamedUser,
    set: [{ column: 'name', param: 'name' }],
    where: [{ column: 'id', op: 'eq', param: 'id' }],
  },
};

const REGISTRY: Record<string, unknown> = { User, Post, Comment, TenantUser, TenantPost, NamedUser, NamedPost };

/** Model NAME → class, as `relationDeclOf` resolves a relation's target. */
export const emitModels = (name: string): ModelClassLike => REGISTRY[name] as ModelClassLike;

/** The TEXT columns, pinned (no `emitDecoratorMetadata` under vitest — see the module note). */
export const EMIT_COLUMN_OPTIONS: DeriveColumnsOptions = { columnTypes: { name: 'TEXT', title: 'TEXT', body: 'TEXT' } };

/**
 * The declared endpoints. Read / relation graph / IN-list / SKIP / EXISTS+parentRef / QUERY view /
 * single writes / batch writes — the whole emitted surface, declared without one character of SQL.
 */
export const EMIT_ENDPOINTS: EndpointSet = {
  /** Two relation levels off ONE parent read: users → posts → comments (3 queries, N+1-free). */
  usersWithPosts: {
    kind: 'read',
    model: User,
    order: 'id ASC',
    with: [{ name: 'posts', with: ['comments'] }],
  },
  /** #46 — a whole key set bound as ONE param (PG `= ANY(?)`, MySQL/SQLite single-JSON). */
  usersByIds: {
    kind: 'read',
    model: User,
    where: [{ kind: 'in', column: 'id', param: 'ids' }],
    order: 'id ASC',
  },
  /** SKIP — `authorId` is fixed, `title` and `minId` are present-or-absent per call. */
  feed: {
    kind: 'read',
    model: Post,
    where: [
      { column: 'author_id', op: 'eq', param: 'authorId' },
      { column: 'title', op: 'like', param: 'title', optional: true },
      { column: 'id', op: 'ge', param: 'minId', optional: true },
    ],
    order: 'id ASC',
  },
  /** #97 — a correlated EXISTS subquery (the `parentRef` sugar). */
  authorsWithAnyPost: {
    kind: 'read',
    model: User,
    where: [{ kind: 'exists', model: Post, match: [{ column: 'author_id', parentColumn: 'id' }] }],
    order: 'id ASC',
  },
  /** #97 — the typed IN-subquery form. */
  usersWhoWrote: {
    kind: 'read',
    model: User,
    where: [{ kind: 'subquery', columns: ['id'], model: Post, select: ['author_id'], match: [{ column: 'title', param: 'title' }] }],
    order: 'id ASC',
  },
  /** #98 — a QUERY view-model: the read selects from a derived CTE, not the base table. */
  postsOfAuthorView: {
    kind: 'read',
    model: Post,
    select: ['id', 'title'],
    view: { query: { sql: 'SELECT id, title FROM e2e_posts WHERE author_id = ?', params: [1] } },
    order: 'id ASC',
  },
  /** #161 — PAGING: the page POSITION is an input, so LIMIT/OFFSET BIND instead of inlining. */
  pagedPosts: {
    kind: 'read',
    model: Post,
    select: ['id', 'title'],
    order: 'id ASC',
    limit: { param: 'limit' },
    offset: { param: 'offset' },
  },
  /** #132 — a SHARED row lock: the read appends ` FOR SHARE` (readers coexist, writers block). */
  lockedPosts: {
    kind: 'read',
    model: Post,
    select: ['id', 'title'],
    where: [{ column: 'author_id', op: 'eq', param: 'authorId' }],
    order: 'id ASC',
    lock: 'share',
  },
  /** #133 — a COMPOSITE key set bound with a CONSTANT number of params (PG UNNEST). */
  tenantPostsByKeys: {
    kind: 'read',
    model: TenantPost,
    select: ['tenant_id', 'user_id', 'title'],
    where: [{ kind: 'tupleIn', columns: ['tenant_id', 'user_id'], param: 'keys' }],
    order: 'tenant_id ASC, user_id ASC',
  },
  /** Composite-key relation graph (two-column key). */
  tenantUsersWithPosts: {
    kind: 'read',
    model: TenantUser,
    order: 'tenant_id ASC, user_id ASC',
    with: ['posts'],
  },
  createUser: {
    kind: 'create',
    model: User,
    values: [{ column: 'name', param: 'name' }],
    returning: ['id', 'name'],
  },
  renameUser: {
    kind: 'update',
    model: User,
    set: [{ column: 'name', param: 'name' }],
    where: [{ column: 'id', op: 'eq', param: 'id' }],
  },
  removeUser: { kind: 'delete', model: User, where: [{ column: 'id', op: 'eq', param: 'id' }] },
  createComments: { kind: 'createMany', model: Comment, columns: ['post_id', 'body'], param: 'rows' },
  retitlePosts: { kind: 'updateMany', model: Post, keyColumns: ['id'], columns: ['title'], param: 'rows' },
  removeComments: { kind: 'deleteMany', model: Comment, keyColumn: 'id', param: 'ids' },
};
