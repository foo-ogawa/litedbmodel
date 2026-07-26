// The V1 IMPERATIVE mode of the TypeScript cell — DBModel, which builds its SQL at run time.
//
// The third real TypeScript execution path (#162). Where the codegen mode runs SQL that was fixed at
// generate time, v1 walks `DBConditions` / `_buildSelectSQL` on every call and loads relations through
// `LazyRelationContext`, which batches (one parent read + one batched child read per level) — so the
// N+1 invariant holds here too. TypeScript is the only language with this path, which is why the TS
// cell has three modes and the other languages have two.
//
// v1's writes are transaction-only by policy (`WriteOutsideTransactionError`), so a single-row create
// here really is BEGIN + INSERT + COMMIT. `EXPECTED` below states that rather than relaxing the check.

import 'reflect-metadata';
import { DBModel, closeAllPools, column, model, hasMany, belongsTo, type ColumnsOf } from '../../../dist/index.cjs';
import { clearMiddlewares, createMiddleware, use } from '../../../dist/scp/index.mjs';

import { EXPECTED_STATEMENTS, inputFor, userRows, updateManyRows } from './inputs.js';
import type { Cell, Dialect } from './cell.js';
import { MYSQL_CONFIG, PG_CONFIG, SQLITE_CONFIG, setupFor, tallyRows } from './cell.js';

// The six benchmark models. Decorators run at class definition, and the transform only accepts them at
// module top level, so the models are declared once against `DBModel` and the dialect is applied by
// `DBModel.setConfig` in `openV1` — correct here because the cell runs ONE dialect per process (the
// same shape benchmark/benchmark.ts uses). Schema and columns match `orm-domain.ts`, the fixture every
// other cell loads.
@model('benchmark_users')
class UserModel extends DBModel {
  @column() id?: number;
  @column() email?: string;
  @column() name?: string;
  @hasMany(() => [User.id, Post.author_id])
  posts?: Promise<PostModel[]>;
}
const User = UserModel as typeof UserModel & ColumnsOf<UserModel>;

@model('benchmark_posts')
class PostModel extends DBModel {
  @column() id?: number;
  @column() title?: string;
  @column() content?: string;
  @column() published?: number;
  @column() author_id?: number;
  @column() created_at?: string;
  @belongsTo(() => [Post.author_id, User.id])
  author?: Promise<UserModel | null>;
  @hasMany(() => [Post.id, Comment.post_id])
  comments?: Promise<CommentModel[]>;
}
const Post = PostModel as typeof PostModel & ColumnsOf<PostModel>;

@model('benchmark_comments')
class CommentModel extends DBModel {
  @column() id?: number;
  @column() body?: string;
  @column() post_id?: number;
  @belongsTo(() => [Comment.post_id, Post.id])
  post?: Promise<PostModel | null>;
}
const Comment = CommentModel as typeof CommentModel & ColumnsOf<CommentModel>;

@model('benchmark_tenant_users')
class TenantUserModel extends DBModel {
  @column({ primaryKey: true }) tenant_id?: number;
  @column({ primaryKey: true }) user_id?: number;
  @column() name?: string;
  @hasMany(() => [
      [TenantUser.tenant_id, TenantPost.tenant_id],
      [TenantUser.user_id, TenantPost.user_id],
    ])
  posts?: Promise<TenantPostModel[]>;
}
const TenantUser = TenantUserModel as typeof TenantUserModel & ColumnsOf<TenantUserModel>;

@model('benchmark_tenant_posts')
class TenantPostModel extends DBModel {
  @column({ primaryKey: true }) tenant_id?: number;
  @column({ primaryKey: true }) post_id?: number;
  @column() user_id?: number;
  @column() title?: string;
  @hasMany(() => [
      [TenantPost.tenant_id, TenantComment.tenant_id],
      [TenantPost.post_id, TenantComment.post_id],
    ])
  comments?: Promise<TenantCommentModel[]>;
}
const TenantPost = TenantPostModel as typeof TenantPostModel & ColumnsOf<TenantPostModel>;

@model('benchmark_tenant_comments')
class TenantCommentModel extends DBModel {
  @column({ primaryKey: true }) tenant_id?: number;
  @column({ primaryKey: true }) comment_id?: number;
  @column() post_id?: number;
  @column() body?: string;
}
const TenantComment = TenantCommentModel as typeof TenantCommentModel & ColumnsOf<TenantCommentModel>;


/**
 * v1's counts. The reads match every other mode; the writes carry the +2 of the mandatory
 * transaction, and the already-transactional ops are unchanged.
 */
const EXPECTED: Readonly<Record<string, number>> = {
  ...EXPECTED_STATEMENTS,
  create: 3,
  update: 3,
  upsert: 3,
  createMany: 3,
  upsertMany: 3,
  updateMany: 3,
};

/** Held so the engine cannot elide the relation materialization. */
let sink: unknown;

export async function openV1(dialect: Dialect): Promise<Cell> {
  const setup = setupFor(dialect);
  const config = dialect === 'sqlite' ? SQLITE_CONFIG : dialect === 'postgres' ? PG_CONFIG : MYSQL_CONFIG;
  // Count at the SCP middleware seam, not the v1 driver's logger. Phase F-2 (#105) routes DBModel
  // through the SCP runtime whenever it is usable, so the driver logger sees only the statements that
  // fall back to v1 — on PostgreSQL that was ZERO, and the counter read 0 for a query that ran.
  let count = 0;
  // Rows are observable ONLY at the SCP middleware, which sees the result. The v1 in-proc path (SQLite)
  // is reached through the driver LOGGER, which carries the SQL text and nothing else — so on that leg
  // the row count is genuinely unavailable and `rows()` reports `null` rather than a misleading 0.
  let rows: number | null = dialect === 'sqlite' ? null : 0;
  clearMiddlewares();
  use(
    createMiddleware({
      execute(next: (s: string, p?: readonly unknown[]) => unknown, sql: string, params: readonly unknown[]) {
        count++;
        return tallyRows(next(sql, params), (n) => {
          if (rows !== null) rows += n;
        });
      },
    }),
  );
  // …and at the v1 driver's logger as well: SQLite is NOT routed to the SCP runtime (it keeps the v1
  // in-proc path), so on that dialect the middleware never fires. v1 has two execution paths and the
  // count is whichever one DBModel picked; a statement can only travel one of them, so summing is exact.
  DBModel.setConfig(
    { ...config, max: 4 },
    {
      logger: {
        debug: (message: string) => {
          if (message.startsWith('SQL: ')) count++;
        },
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    },
  );

  const raw = async (sql: string): Promise<void> => {
    await DBModel.execute(sql);
  };
  for (const stmt of setup.schema) await raw(stmt);

  async function runOp(op: string, it: number): Promise<void> {
    const input = inputFor(op, it) as Record<string, never>;
    switch (op) {
      case 'findAll':
        await User.find([], { limit: 100, order: User.id.asc() });
        return;
      case 'filterPaginateSort':
        await Post.find([[Post.published, input.published]], {
          order: Post.created_at.desc(),
          limit: 20,
          offset: 10,
        });
        return;
      case 'findFirst':
        await User.findOne([[`${User.name} LIKE ?`, input.name]]);
        return;
      case 'findUnique':
        await User.findOne([[User.email, input.email]]);
        return;
      case 'nestedFindAll':
      case 'nestedFindFirst':
      case 'nestedFindUnique': {
        const users =
          op === 'nestedFindAll'
            ? await User.find([], { limit: 100, order: User.id.asc() })
            : op === 'nestedFindFirst'
              ? await User.find([[`${User.name} LIKE ?`, input.name]], { limit: 1 })
              : await User.find([[User.email, input.email]], { limit: 1 });
        // The FIRST access batch-loads every user's posts through the shared LazyRelationContext.
        const graph = [];
        for (const u of users) graph.push({ user: u, posts: await u.posts });
        sink = graph;
        return;
      }
      case 'nestedRelations': {
        const users = await User.find([], { limit: 100, order: User.id.asc() });
        const graph = [];
        for (const u of users) {
          const posts = (await u.posts) ?? [];
          const withComments = [];
          for (const p of posts) withComments.push({ post: p, comments: await p.comments });
          graph.push({ user: u, posts: withComments });
        }
        sink = graph;
        return;
      }
      case 'compositeRelations': {
        const tusers = await TenantUser.find([[TenantUser.tenant_id, 1]], { order: TenantUser.user_id.asc() });
        const graph = [];
        for (const u of tusers) {
          const posts = (await u.posts) ?? [];
          const withComments = [];
          for (const p of posts) withComments.push({ post: p, comments: await p.comments });
          graph.push({ user: u, posts: withComments });
        }
        sink = graph;
        return;
      }
      case 'create':
        await User.transaction(async () =>
          User.create([
            [User.email, input.email],
            [User.name, input.name],
          ]),
        );
        return;
      case 'update':
        await User.transaction(async () => User.update([[User.id, input.id]], [[User.name, input.name]]));
        return;
      case 'upsert':
        await User.transaction(async () =>
          User.create(
            [
              [User.email, input.email],
              [User.name, input.name],
            ],
            { onConflict: User.email, onConflictUpdate: [User.name] },
          ),
        );
        return;
      case 'createMany':
      case 'upsertMany': {
        const rows = userRows(it, op === 'upsertMany').map(
          (r) =>
            [
              [User.email, r.email],
              [User.name, r.name],
            ] as const,
        );
        await User.transaction(async () =>
          op === 'upsertMany'
            ? User.createMany(rows, { onConflict: User.email, onConflictUpdate: [User.name] })
            : User.createMany(rows),
        );
        return;
      }
      case 'updateMany': {
        const rows = updateManyRows().map(
          (r) =>
            [
              [User.id, r.id],
              [User.name, r.name],
            ] as const,
        );
        await User.transaction(async () => User.updateMany(rows, { keyColumns: [User.id] }));
        return;
      }
      case 'nestedCreate':
        await User.transaction(async () => {
          const created = await User.create(
            [
              [User.email, input.email],
              [User.name, input.name],
            ],
            { returning: true },
          );
          await Post.create([
            [Post.author_id, created!.values[0][0] as number],
            [Post.title, input.title],
          ]);
        });
        return;
      case 'nestedUpsert':
        await User.transaction(async () => {
          const upserted = await User.create(
            [
              [User.email, input.email],
              [User.name, input.name],
            ],
            { onConflict: User.email, onConflictUpdate: [User.name], returning: true },
          );
          await Post.create([
            [Post.author_id, upserted!.values[0][0] as number],
            [Post.title, input.title],
          ]);
        });
        return;
      case 'nestedUpdate':
        await User.transaction(async () => {
          await User.update([[User.id, input.id]], [[User.name, input.name]]);
          await Post.update([[Post.author_id, input.id]], [[Post.title, input.title]]);
        });
        return;
      case 'delete':
        await User.transaction(async () => {
          const created = await User.create(
            [
              [User.email, input.email],
              [User.name, input.name],
            ],
            { returning: true },
          );
          await User.delete([[User.id, created!.values[0][0] as number]]);
        });
        return;
      default:
        throw new Error(`unknown op ${op}`);
    }
  }

  return {
    dialect,
    sync: false,
    expectedStatements: EXPECTED,
    seed: async () => {
      const before = count;
      for (const stmt of [...setup.delete, ...setup.insert]) await raw(stmt);
      count = before; // the fixture runs off the counted seam
    },
    run: runOp,
    close: async () => {
      clearMiddlewares();
      await closeAllPools();
    },
    statements: () => count,
    rows: () => rows,
    resetCounters: () => {
      count = 0;
      if (rows !== null) rows = 0;
    },
  };
}
