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

import 'reflect-metadata';
import { model, column, hasMany, belongsTo } from '../../src/decorators';
import type { DeriveColumnsOptions, ModelClassLike } from '../../src/scp/decorator-adapter';
import type { EndpointSet } from '../../src/scp';

@model('e2e_users')
export class User {
  @column() id?: number;
  @column() name?: string;

  @hasMany(() => [User.id, Post.author_id], { order: () => Post.id.asc() })
  declare posts: Promise<Post[]>;
}

@model('e2e_posts')
export class Post {
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
  @column() id?: number;
  @column() post_id?: number;
  @column() body?: string;
}

/** Composite-key models — the two-column relation key path. */
@model('e2e_tenant_users')
export class TenantUser {
  @column() tenant_id?: number;
  @column() user_id?: number;
  @column() name?: string;

  @hasMany(() => [
    [TenantUser.tenant_id, TenantPost.tenant_id],
    [TenantUser.user_id, TenantPost.user_id],
  ])
  declare posts: Promise<TenantPost[]>;
}

@model('e2e_tenant_posts')
export class TenantPost {
  @column() tenant_id?: number;
  @column() user_id?: number;
  @column() title?: string;
}

const REGISTRY: Record<string, unknown> = { User, Post, Comment, TenantUser, TenantPost };

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
  /** Composite-key relation graph (two-column key). */
  tenantUsersWithPosts: {
    kind: 'read',
    model: TenantUser,
    order: 'user_id ASC',
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
