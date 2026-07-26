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
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import 'reflect-metadata';
import { DBModel, closeAllPools, column, model, hasMany, belongsTo } from 'litedbmodel';
import { EXPECTED_STATEMENTS, inputFor, userRows, updateManyRows } from './inputs.js';
import { MYSQL_CONFIG, PG_CONFIG, SQLITE_CONFIG, setupFor } from './cell.js';
// The six benchmark models. Decorators run at class definition, and the transform only accepts them at
// module top level, so the models are declared once against `DBModel` and the dialect is applied by
// `DBModel.setConfig` in `openV1` — correct here because the cell runs ONE dialect per process (the
// same shape benchmark/benchmark.ts uses). Schema and columns match `orm-domain.ts`, the fixture every
// other cell loads.
let UserModel = class UserModel extends DBModel {
    id;
    email;
    name;
    posts;
};
__decorate([
    column(),
    __metadata("design:type", Number)
], UserModel.prototype, "id", void 0);
__decorate([
    column(),
    __metadata("design:type", String)
], UserModel.prototype, "email", void 0);
__decorate([
    column(),
    __metadata("design:type", String)
], UserModel.prototype, "name", void 0);
__decorate([
    hasMany(() => [User.id, Post.author_id]),
    __metadata("design:type", Promise)
], UserModel.prototype, "posts", void 0);
UserModel = __decorate([
    model('benchmark_users')
], UserModel);
const User = UserModel;
let PostModel = class PostModel extends DBModel {
    id;
    title;
    content;
    published;
    author_id;
    created_at;
    author;
    comments;
};
__decorate([
    column(),
    __metadata("design:type", Number)
], PostModel.prototype, "id", void 0);
__decorate([
    column(),
    __metadata("design:type", String)
], PostModel.prototype, "title", void 0);
__decorate([
    column(),
    __metadata("design:type", String)
], PostModel.prototype, "content", void 0);
__decorate([
    column(),
    __metadata("design:type", Number)
], PostModel.prototype, "published", void 0);
__decorate([
    column(),
    __metadata("design:type", Number)
], PostModel.prototype, "author_id", void 0);
__decorate([
    column(),
    __metadata("design:type", String)
], PostModel.prototype, "created_at", void 0);
__decorate([
    belongsTo(() => [Post.author_id, User.id]),
    __metadata("design:type", Promise)
], PostModel.prototype, "author", void 0);
__decorate([
    hasMany(() => [Post.id, Comment.post_id]),
    __metadata("design:type", Promise)
], PostModel.prototype, "comments", void 0);
PostModel = __decorate([
    model('benchmark_posts')
], PostModel);
const Post = PostModel;
let CommentModel = class CommentModel extends DBModel {
    id;
    body;
    post_id;
    post;
};
__decorate([
    column(),
    __metadata("design:type", Number)
], CommentModel.prototype, "id", void 0);
__decorate([
    column(),
    __metadata("design:type", String)
], CommentModel.prototype, "body", void 0);
__decorate([
    column(),
    __metadata("design:type", Number)
], CommentModel.prototype, "post_id", void 0);
__decorate([
    belongsTo(() => [Comment.post_id, Post.id]),
    __metadata("design:type", Promise)
], CommentModel.prototype, "post", void 0);
CommentModel = __decorate([
    model('benchmark_comments')
], CommentModel);
const Comment = CommentModel;
let TenantUserModel = class TenantUserModel extends DBModel {
    tenant_id;
    user_id;
    name;
    posts;
};
__decorate([
    column({ primaryKey: true }),
    __metadata("design:type", Number)
], TenantUserModel.prototype, "tenant_id", void 0);
__decorate([
    column({ primaryKey: true }),
    __metadata("design:type", Number)
], TenantUserModel.prototype, "user_id", void 0);
__decorate([
    column(),
    __metadata("design:type", String)
], TenantUserModel.prototype, "name", void 0);
__decorate([
    hasMany(() => [
        [TenantUser.tenant_id, TenantPost.tenant_id],
        [TenantUser.user_id, TenantPost.user_id],
    ]),
    __metadata("design:type", Promise)
], TenantUserModel.prototype, "posts", void 0);
TenantUserModel = __decorate([
    model('benchmark_tenant_users')
], TenantUserModel);
const TenantUser = TenantUserModel;
let TenantPostModel = class TenantPostModel extends DBModel {
    tenant_id;
    post_id;
    user_id;
    title;
    comments;
};
__decorate([
    column({ primaryKey: true }),
    __metadata("design:type", Number)
], TenantPostModel.prototype, "tenant_id", void 0);
__decorate([
    column({ primaryKey: true }),
    __metadata("design:type", Number)
], TenantPostModel.prototype, "post_id", void 0);
__decorate([
    column(),
    __metadata("design:type", Number)
], TenantPostModel.prototype, "user_id", void 0);
__decorate([
    column(),
    __metadata("design:type", String)
], TenantPostModel.prototype, "title", void 0);
__decorate([
    hasMany(() => [
        [TenantPost.tenant_id, TenantComment.tenant_id],
        [TenantPost.post_id, TenantComment.post_id],
    ]),
    __metadata("design:type", Promise)
], TenantPostModel.prototype, "comments", void 0);
TenantPostModel = __decorate([
    model('benchmark_tenant_posts')
], TenantPostModel);
const TenantPost = TenantPostModel;
let TenantCommentModel = class TenantCommentModel extends DBModel {
    tenant_id;
    comment_id;
    post_id;
    body;
};
__decorate([
    column({ primaryKey: true }),
    __metadata("design:type", Number)
], TenantCommentModel.prototype, "tenant_id", void 0);
__decorate([
    column({ primaryKey: true }),
    __metadata("design:type", Number)
], TenantCommentModel.prototype, "comment_id", void 0);
__decorate([
    column(),
    __metadata("design:type", Number)
], TenantCommentModel.prototype, "post_id", void 0);
__decorate([
    column(),
    __metadata("design:type", String)
], TenantCommentModel.prototype, "body", void 0);
TenantCommentModel = __decorate([
    model('benchmark_tenant_comments')
], TenantCommentModel);
const TenantComment = TenantCommentModel;
/**
 * v1's counts. The reads match every other mode; the writes carry the +2 of the mandatory
 * transaction, and the already-transactional ops are unchanged.
 */
const EXPECTED = {
    ...EXPECTED_STATEMENTS,
    create: 3,
    update: 3,
    upsert: 3,
    createMany: 3,
    upsertMany: 3,
    updateMany: 3,
};
/** Held so the engine cannot elide the relation materialization. */
let sink;
export async function openV1(dialect) {
    const setup = setupFor(dialect);
    const config = dialect === 'sqlite' ? SQLITE_CONFIG : dialect === 'postgres' ? PG_CONFIG : MYSQL_CONFIG;
    let count = 0;
    DBModel.setConfig({ ...config, max: 4 }, {
        // Every driver logs `SQL: <text>` for each statement it issues (src/drivers/*.ts) — the one
        // place all of v1's SQL is observable, including the transaction's BEGIN/COMMIT.
        logger: {
            debug: (message) => {
                if (message.startsWith('SQL: '))
                    count++;
            },
            info: () => { },
            warn: () => { },
            error: () => { },
        },
    });
    const raw = async (sql) => {
        await DBModel.execute(sql);
    };
    for (const stmt of setup.schema)
        await raw(stmt);
    async function runOp(op, it) {
        const input = inputFor(op, it);
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
                const users = op === 'nestedFindAll'
                    ? await User.find([], { limit: 100, order: User.id.asc() })
                    : op === 'nestedFindFirst'
                        ? await User.find([[`${User.name} LIKE ?`, input.name]], { limit: 1 })
                        : await User.find([[User.email, input.email]], { limit: 1 });
                // The FIRST access batch-loads every user's posts through the shared LazyRelationContext.
                const graph = [];
                for (const u of users)
                    graph.push({ user: u, posts: await u.posts });
                sink = graph;
                return;
            }
            case 'nestedRelations': {
                const users = await User.find([], { limit: 100, order: User.id.asc() });
                const graph = [];
                for (const u of users) {
                    const posts = await u.posts;
                    const withComments = [];
                    for (const p of posts)
                        withComments.push({ post: p, comments: await p.comments });
                    graph.push({ user: u, posts: withComments });
                }
                sink = graph;
                return;
            }
            case 'compositeRelations': {
                const tusers = await TenantUser.find([[TenantUser.tenant_id, 1]], { order: TenantUser.user_id.asc() });
                const graph = [];
                for (const u of tusers) {
                    const posts = await u.posts;
                    const withComments = [];
                    for (const p of posts)
                        withComments.push({ post: p, comments: await p.comments });
                    graph.push({ user: u, posts: withComments });
                }
                sink = graph;
                return;
            }
            case 'create':
                await User.transaction(async () => User.create([
                    [User.email, input.email],
                    [User.name, input.name],
                ]));
                return;
            case 'update':
                await User.transaction(async () => User.update([[User.id, input.id]], [[User.name, input.name]]));
                return;
            case 'upsert':
                await User.transaction(async () => User.create([
                    [User.email, input.email],
                    [User.name, input.name],
                ], { onConflict: User.email, onConflictUpdate: [User.name] }));
                return;
            case 'createMany':
            case 'upsertMany': {
                const rows = userRows(it, op === 'upsertMany').map((r) => [
                    [User.email, r.email],
                    [User.name, r.name],
                ]);
                await User.transaction(async () => op === 'upsertMany'
                    ? User.createMany(rows, { onConflict: User.email, onConflictUpdate: [User.name] })
                    : User.createMany(rows));
                return;
            }
            case 'updateMany': {
                const rows = updateManyRows().map((r) => [
                    [User.id, r.id],
                    [User.name, r.name],
                ]);
                await User.transaction(async () => User.updateMany(rows, { keyColumns: [User.id] }));
                return;
            }
            case 'nestedCreate':
                await User.transaction(async () => {
                    const created = await User.create([
                        [User.email, input.email],
                        [User.name, input.name],
                    ], { returning: true });
                    await Post.create([
                        [Post.author_id, created.values[0][0]],
                        [Post.title, input.title],
                    ]);
                });
                return;
            case 'nestedUpsert':
                await User.transaction(async () => {
                    const upserted = await User.create([
                        [User.email, input.email],
                        [User.name, input.name],
                    ], { onConflict: User.email, onConflictUpdate: [User.name], returning: true });
                    await Post.create([
                        [Post.author_id, upserted.values[0][0]],
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
                    const created = await User.create([
                        [User.email, input.email],
                        [User.name, input.name],
                    ], { returning: true });
                    await User.delete([[User.id, created.values[0][0]]]);
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
            for (const stmt of [...setup.delete, ...setup.insert])
                await raw(stmt);
            count = before; // the fixture runs off the counted seam
        },
        run: runOp,
        close: async () => {
            await closeAllPools();
        },
        statements: () => count,
        resetStatements: () => {
            count = 0;
        },
    };
}
