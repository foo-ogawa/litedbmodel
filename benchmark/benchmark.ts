/**
 * ORM Benchmark: litedbmodel vs Prisma vs Kysely vs Drizzle vs TypeORM
 * 
 * Based on Prisma's official orm-benchmarks:
 * https://github.com/prisma/orm-benchmarks
 * 
 * Reference article:
 * https://izanami.dev/post/1e3fa298-252c-4f6e-8bcc-b225d53c95fb
 * 
 * Test operations:
 * - Find all
 * - Filter, paginate & sort
 * - Nested find all (1-level nesting)
 * - Find first
 * - Nested find first
 * - Find unique
 * - Nested find unique
 * - Create
 * - Nested create
 * - Update
 * - Nested update
 * - Upsert
 * - Nested upsert
 * - Delete
 */
import 'reflect-metadata';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ORM_SERIES, RUNTIME_SERIES, CODEGEN_SERIES, KYSELY, DRIZZLE, TYPEORM, PRISMA, type OrmSeries } from './orm-series.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// Configuration
// ============================================

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433'),
  database: process.env.DB_NAME || 'testdb',
  user: process.env.DB_USER || 'testuser',
  password: process.env.DB_PASSWORD || 'testpass',
};

const ROUNDS = 5;              // Number of rounds (each round runs all ORMs)
const ITERATIONS = 50;         // Each test runs 50 times per round
const WARMUP_ITERATIONS = 5;

// ============================================
// litedbmodel Setup
// ============================================

import { DBModel, model, column, ColumnsOf, closeAllPools, hasMany, belongsTo } from 'litedbmodel';
// The CODEGEN execution mode of litedbmodel v2 (the same authored @behavior source in
// benchmark/crosslang/native-model.ts, run through `bc generate` → behaviors_postgres.ts): the TS twin
// of the go/rust/python/php native cells, and the path litedbmodel v2 ships. The `litedbmodel (codegen)`
// row measures THIS; the `litedbmodel (runtime)` row measures the imperative DBModel path that builds its
// SQL per call. Both are litedbmodel 2.1.0 — two execution modes, not two versions. Inputs come from the
// ONE shared per-op input SSoT (inputs.ts), so this cell issues the same logical work as every other cell.
import { leafHandlersAsync, pgConnectionPool, PooledAsyncContext, transaction, configurePgDeboxTypeParsers } from 'litedbmodel/scp';
import { inputFor, TX_OPS } from './crosslang/ts-cell/inputs.js';
import { bindTypedAsync } from './crosslang/ts-cell/behaviors_postgres.js';
// Per-op DB reset (setup.ts is the seed SSoT). Every op is measured on the SAME clean general graph —
// the crosslang cells reset per op too; without it, a write op's mutations to seed rows leak into later
// ops in the same round (they were only partially cleaned by a DELETE of inserted ids).
import { resetGeneralGraph } from './setup.js';

@model('benchmark_users')
class LiteUserModel extends DBModel {
  @column() id?: number;
  @column() email?: string;
  @column() name?: string;
  @column() created_at?: Date;
  @column() updated_at?: Date;
  
  @hasMany(() => [LiteUser.id, LitePost.author_id])
  declare posts: Promise<LitePostModel[]>;
}
const LiteUser = LiteUserModel as typeof LiteUserModel & ColumnsOf<LiteUserModel>;

@model('benchmark_posts')
class LitePostModel extends DBModel {
  @column() id?: number;
  @column() title?: string;
  @column() content?: string;
  @column() published?: number;
  @column() author_id?: number;
  @column() created_at?: Date;
  
  @belongsTo(() => [LitePost.author_id, LiteUser.id])
  declare author: Promise<LiteUserModel | null>;
  
  @hasMany(() => [LitePost.id, LiteComment.post_id])
  declare comments: Promise<LiteCommentModel[]>;
}
const LitePost = LitePostModel as typeof LitePostModel & ColumnsOf<LitePostModel>;

@model('benchmark_comments')
class LiteCommentModel extends DBModel {
  @column() id?: number;
  @column() body?: string;
  @column() post_id?: number;
  @column() created_at?: Date;
  
  @belongsTo(() => [LiteComment.post_id, LitePost.id])
  declare post: Promise<LitePostModel | null>;
}
const LiteComment = LiteCommentModel as typeof LiteCommentModel & ColumnsOf<LiteCommentModel>;

// Composite key models (multi-tenant)
@model('benchmark_tenant_users')
class LiteTenantUserModel extends DBModel {
  @column({ primaryKey: true }) tenant_id?: number;
  @column({ primaryKey: true }) user_id?: number;
  @column() name?: string;
  
  @hasMany(() => [[LiteTenantUser.tenant_id, LiteTenantPost.tenant_id], [LiteTenantUser.user_id, LiteTenantPost.user_id]])
  declare posts: Promise<LiteTenantPostModel[]>;
}
const LiteTenantUser = LiteTenantUserModel as typeof LiteTenantUserModel & ColumnsOf<LiteTenantUserModel>;

@model('benchmark_tenant_posts')
class LiteTenantPostModel extends DBModel {
  @column({ primaryKey: true }) tenant_id?: number;
  @column({ primaryKey: true }) post_id?: number;
  @column() user_id?: number;
  @column() title?: string;
  
  @belongsTo(() => [[LiteTenantPost.tenant_id, LiteTenantUser.tenant_id], [LiteTenantPost.user_id, LiteTenantUser.user_id]])
  declare user: Promise<LiteTenantUserModel | null>;
  
  @hasMany(() => [[LiteTenantPost.tenant_id, LiteTenantComment.tenant_id], [LiteTenantPost.post_id, LiteTenantComment.post_id]])
  declare comments: Promise<LiteTenantCommentModel[]>;
}
const LiteTenantPost = LiteTenantPostModel as typeof LiteTenantPostModel & ColumnsOf<LiteTenantPostModel>;

@model('benchmark_tenant_comments')
class LiteTenantCommentModel extends DBModel {
  @column({ primaryKey: true }) tenant_id?: number;
  @column({ primaryKey: true }) comment_id?: number;
  @column() post_id?: number;
  @column() body?: string;
  
  @belongsTo(() => [[LiteTenantComment.tenant_id, LiteTenantPost.tenant_id], [LiteTenantComment.post_id, LiteTenantPost.post_id]])
  declare post: Promise<LiteTenantPostModel | null>;
}
const LiteTenantComment = LiteTenantCommentModel as typeof LiteTenantCommentModel & ColumnsOf<LiteTenantCommentModel>;

// ============================================
// Prisma Setup
// ============================================

import { PrismaClient } from '@prisma/client';

// ============================================
// Kysely Setup
// ============================================

import { Kysely, PostgresDialect, Generated, sql } from 'kysely';
import pg from 'pg';

interface KyselyDB {
  benchmark_users: {
    id: Generated<number>;
    email: string;
    name: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  benchmark_posts: {
    id: Generated<number>;
    title: string;
    content: string | null;
    published: Generated<number>;
    author_id: number;
    created_at: Generated<Date>;
  };
  benchmark_comments: {
    id: Generated<number>;
    body: string;
    post_id: number;
    created_at: Generated<Date>;
  };
}

// ============================================
// Drizzle Setup
// ============================================

import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, serial, varchar, integer, smallint, timestamp, text, primaryKey } from 'drizzle-orm/pg-core';
import { eq, desc, and, asc, sql as drizzleSql, relations } from 'drizzle-orm';

const drizzleUsers = pgTable('benchmark_users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }),
  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at').defaultNow(),
});

const drizzlePosts = pgTable('benchmark_posts', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  content: text('content'),
  published: smallint('published').default(0),
  author_id: integer('author_id').notNull(),
  created_at: timestamp('created_at').defaultNow(),
});

const drizzleComments = pgTable('benchmark_comments', {
  id: serial('id').primaryKey(),
  body: text('body').notNull(),
  post_id: integer('post_id').notNull(),
  created_at: timestamp('created_at').defaultNow(),
});

// Composite key tables
const drizzleTenantUsers = pgTable('benchmark_tenant_users', {
  tenant_id: integer('tenant_id').notNull(),
  user_id: integer('user_id').notNull(),
  name: varchar('name', { length: 255 }),
});

const drizzleTenantPosts = pgTable('benchmark_tenant_posts', {
  tenant_id: integer('tenant_id').notNull(),
  post_id: integer('post_id').notNull(),
  user_id: integer('user_id').notNull(),
  title: varchar('title', { length: 255 }).notNull(),
});

const drizzleTenantComments = pgTable('benchmark_tenant_comments', {
  tenant_id: integer('tenant_id').notNull(),
  comment_id: integer('comment_id').notNull(),
  post_id: integer('post_id').notNull(),
  body: text('body'),
}, (table) => [primaryKey({ columns: [table.tenant_id, table.comment_id] })]);

// Drizzle Relations - Single Key
const usersRelations = relations(drizzleUsers, ({ many }) => ({
  posts: many(drizzlePosts),
}));

const postsRelations = relations(drizzlePosts, ({ one, many }) => ({
  author: one(drizzleUsers, { fields: [drizzlePosts.author_id], references: [drizzleUsers.id] }),
  comments: many(drizzleComments),
}));

const commentsRelations = relations(drizzleComments, ({ one }) => ({
  post: one(drizzlePosts, { fields: [drizzleComments.post_id], references: [drizzlePosts.id] }),
}));

// Drizzle Relations - Composite Key
const tenantUsersRelations = relations(drizzleTenantUsers, ({ many }) => ({
  posts: many(drizzleTenantPosts),
}));

const tenantPostsRelations = relations(drizzleTenantPosts, ({ one, many }) => ({
  user: one(drizzleTenantUsers, {
    fields: [drizzleTenantPosts.tenant_id, drizzleTenantPosts.user_id],
    references: [drizzleTenantUsers.tenant_id, drizzleTenantUsers.user_id],
  }),
  comments: many(drizzleTenantComments),
}));

const tenantCommentsRelations = relations(drizzleTenantComments, ({ one }) => ({
  post: one(drizzleTenantPosts, {
    fields: [drizzleTenantComments.tenant_id, drizzleTenantComments.post_id],
    references: [drizzleTenantPosts.tenant_id, drizzleTenantPosts.post_id],
  }),
}));

// Drizzle Schema (needed for query API with relations)
const drizzleSchema = {
  users: drizzleUsers,
  posts: drizzlePosts,
  comments: drizzleComments,
  tenantUsers: drizzleTenantUsers,
  tenantPosts: drizzleTenantPosts,
  tenantComments: drizzleTenantComments,
  usersRelations,
  postsRelations,
  commentsRelations,
  tenantUsersRelations,
  tenantPostsRelations,
  tenantCommentsRelations,
};

// ============================================
// TypeORM Setup
// ============================================

import { DataSource, Entity, PrimaryGeneratedColumn, PrimaryColumn, Column as TypeORMColumn, Repository, ManyToOne, OneToMany, JoinColumn } from 'typeorm';

@Entity('benchmark_users')
class TypeORMUser {
  @PrimaryGeneratedColumn()
  id!: number;
  
  @TypeORMColumn({ type: 'varchar', length: 255 })
  email!: string;
  
  @TypeORMColumn({ type: 'varchar', length: 255, nullable: true })
  name!: string | null;
  
  @TypeORMColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  created_at!: Date;
  
  @TypeORMColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  updated_at!: Date;
  
  @OneToMany(() => TypeORMPost, post => post.author)
  posts!: TypeORMPost[];
}

@Entity('benchmark_posts')
class TypeORMPost {
  @PrimaryGeneratedColumn()
  id!: number;
  
  @TypeORMColumn({ type: 'varchar', length: 255 })
  title!: string;
  
  @TypeORMColumn({ type: 'text', nullable: true })
  content!: string | null;
  
  @TypeORMColumn({ type: 'smallint', default: 0 })
  published!: number;
  
  @TypeORMColumn({ type: 'int' })
  author_id!: number;
  
  @TypeORMColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  created_at!: Date;
  
  @ManyToOne(() => TypeORMUser, user => user.posts)
  @JoinColumn({ name: 'author_id' })
  author!: TypeORMUser;
  
  @OneToMany(() => TypeORMComment, comment => comment.post)
  comments!: TypeORMComment[];
}

@Entity('benchmark_comments')
class TypeORMComment {
  @PrimaryGeneratedColumn()
  id!: number;
  
  @TypeORMColumn({ type: 'text' })
  body!: string;
  
  @TypeORMColumn({ type: 'int' })
  post_id!: number;
  
  @TypeORMColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  created_at!: Date;
  
  @ManyToOne(() => TypeORMPost, post => post.comments)
  @JoinColumn({ name: 'post_id' })
  post!: TypeORMPost;
}

// Composite key entities
@Entity('benchmark_tenant_users')
class TypeORMTenantUser {
  @PrimaryColumn({ type: 'int' })
  tenant_id!: number;
  
  @PrimaryColumn({ type: 'int' })
  user_id!: number;
  
  @TypeORMColumn({ type: 'varchar', length: 255, nullable: true })
  name!: string | null;
  
  @OneToMany(() => TypeORMTenantPost, post => post.user)
  posts!: TypeORMTenantPost[];
}

@Entity('benchmark_tenant_posts')
class TypeORMTenantPost {
  @PrimaryColumn({ type: 'int' })
  tenant_id!: number;
  
  @PrimaryColumn({ type: 'int' })
  post_id!: number;
  
  @TypeORMColumn({ type: 'int' })
  user_id!: number;
  
  @TypeORMColumn({ type: 'varchar', length: 255 })
  title!: string;
  
  @ManyToOne(() => TypeORMTenantUser, user => user.posts)
  @JoinColumn([{ name: 'tenant_id', referencedColumnName: 'tenant_id' }, { name: 'user_id', referencedColumnName: 'user_id' }])
  user!: TypeORMTenantUser;
  
  @OneToMany(() => TypeORMTenantComment, comment => comment.post)
  comments!: TypeORMTenantComment[];
}

@Entity('benchmark_tenant_comments')
class TypeORMTenantComment {
  @PrimaryColumn({ type: 'int' })
  tenant_id!: number;
  
  @PrimaryColumn({ type: 'int' })
  comment_id!: number;
  
  @TypeORMColumn({ type: 'int' })
  post_id!: number;
  
  @TypeORMColumn({ type: 'text', nullable: true })
  body!: string | null;
  
  @ManyToOne(() => TypeORMTenantPost, post => post.comments)
  @JoinColumn([{ name: 'tenant_id', referencedColumnName: 'tenant_id' }, { name: 'post_id', referencedColumnName: 'post_id' }])
  post!: TypeORMTenantPost;
}

// ============================================
// Types
// ============================================

interface BenchmarkResult {
  name: string;
  median: number;
  iqr: number;
  stdDev: number;
  min: number;
  max: number;
}

// ============================================
// Benchmark Utilities
// ============================================

/**
 * Run a single benchmark iteration
 */
async function runIteration(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  const end = performance.now();
  return end - start;
}

/**
 * Warmup a function
 */
async function warmup(fn: () => Promise<unknown>, iterations: number): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
}

/**
 * Compute statistics from times (based on Prisma benchmark methodology)
 */
function computeStats(allTimes: number[]): BenchmarkResult {
  const sorted = [...allTimes].sort((a, b) => a - b);
  const len = sorted.length;
  
  // Median
  const median = len % 2 === 0
    ? (sorted[len / 2 - 1] + sorted[len / 2]) / 2
    : sorted[Math.floor(len / 2)];
  
  // IQR (Interquartile Range)
  const q1Index = Math.floor(len * 0.25);
  const q3Index = Math.floor(len * 0.75);
  const q1 = sorted[q1Index];
  const q3 = sorted[q3Index];
  const iqr = q3 - q1;
  
  // Standard Deviation
  const avg = allTimes.reduce((a, b) => a + b, 0) / len;
  const variance = allTimes.reduce((sum, t) => sum + Math.pow(t - avg, 2), 0) / len;
  const stdDev = Math.sqrt(variance);
  
  return {
    name: '',
    median: Math.round(median * 100) / 100,
    iqr: Math.round(iqr * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[len - 1] * 100) / 100,
  };
}

function printResults(category: string, results: BenchmarkResult[]) {
  console.log(`\n${'='.repeat(90)}`);
  console.log(`📊 ${category}`);
  console.log('='.repeat(90));
  console.log('| ORM          | Median (ms) | IQR (ms) | StdDev (ms) | Min (ms) | Max (ms) |');
  console.log('|--------------|-------------|----------|-------------|----------|----------|');
  
  // Sort by median time
  results.sort((a, b) => a.median - b.median);
  
  const fastest = results[0];
  
  for (const r of results) {
    const isFastest = r === fastest;
    const name = (isFastest ? `${r.name} 🏆` : r.name).padEnd(12);
    const median = r.median.toFixed(2).padStart(11);
    const iqr = r.iqr.toFixed(2).padStart(8);
    const stdDev = r.stdDev.toFixed(2).padStart(11);
    const min = r.min.toFixed(2).padStart(8);
    const max = r.max.toFixed(2).padStart(8);
    console.log(`| ${name} | ${median} | ${iqr} | ${stdDev} | ${min} | ${max} |`);
  }
  
  // Show relative performance
  console.log('\nRelative performance (vs fastest):');
  for (const r of results) {
    const relative = (r.median / fastest.median).toFixed(2);
    console.log(`  ${r.name}: ${relative}x`);
  }
}

// ============================================
// Test Definitions
// ============================================

interface TestDefinition {
  name: string;
  tests: {
    orm: OrmSeries;
    fn: () => Promise<unknown>;
  }[];
}

// ============================================
// Main Benchmark
// ============================================

async function main() {
  console.log('🚀 ORM Benchmark: litedbmodel vs Prisma vs Kysely vs Drizzle vs TypeORM');
  console.log(`   Based on Prisma orm-benchmarks methodology`);
  console.log(`   Rounds: ${ROUNDS}`);
  console.log(`   Iterations per ORM per round: ${ITERATIONS}`);
  console.log(`   Total iterations per ORM: ${ROUNDS * ITERATIONS}`);
  console.log(`   Warmup iterations: ${WARMUP_ITERATIONS}`);
  console.log(`   Database: PostgreSQL @ ${config.host}:${config.port}/${config.database}`);
  
  // Initialize ORMs
  console.log('\n⏳ Initializing ORMs...');
  
  // litedbmodel
  DBModel.setConfig(config);
  
  // Prisma
  const prisma = new PrismaClient();
  await prisma.$connect();
  
  // Fixture-reset pool — bench infrastructure, not an ORM under test. Drives resetGeneralGraph()
  // (TRUNCATE … RESTART IDENTITY + re-seed + ANALYZE) once per (op, ORM) so every measurement runs
  // on the identical seeded graph, mirroring the crosslang cells' per-op cell.seed().
  const resetPool = new pg.Pool(config);

  // Kysely
  const kyselyPool = new pg.Pool(config);
  const kysely = new Kysely<KyselyDB>({
    dialect: new PostgresDialect({ pool: kyselyPool }),
  });
  
  // Drizzle (with schema for query API / relation loading)
  const drizzlePool = new pg.Pool(config);
  const drizzleDb = drizzle(drizzlePool, { schema: drizzleSchema });
  
  // TypeORM
  const typeormDS = new DataSource({
    type: 'postgres',
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: config.password,
    entities: [TypeORMUser, TypeORMPost, TypeORMComment, TypeORMTenantUser, TypeORMTenantPost, TypeORMTenantComment],
    synchronize: false,
    logging: false,
  });
  await typeormDS.initialize();
  const typeormUserRepo = typeormDS.getRepository(TypeORMUser);
  const typeormPostRepo = typeormDS.getRepository(TypeORMPost);
  
  console.log('✅ All ORMs initialized\n');
  
  // Counters for INSERT/UPDATE tests
  let createCounter = 10000;
  let upsertCounter = 20000;

  // ── litedbmodel (codegen): bind the bc-generated module to its OWN pg pool. The read-path de-box type
  // parsers the library owns (#59: int → BigInt, timestamp → string) are applied POOL-SCOPED here, so the
  // other ORMs' `pg` pools keep the driver's default parsing untouched.
  const codegenDeboxParsers = new Map<number, (v: string) => unknown>();
  configurePgDeboxTypeParsers({ setTypeParser: (oid: number, fn: (v: string) => unknown) => codegenDeboxParsers.set(oid, fn) } as never);
  const codegenPool = new pg.Pool({
    ...config,
    max: 4,
    types: { getTypeParser: (oid: number, fmt?: unknown) => codegenDeboxParsers.get(oid) ?? pg.types.getTypeParser(oid, fmt as never) },
  } as never);
  const codegenCtx = new PooledAsyncContext(pgConnectionPool(codegenPool as never));
  const codegenFacade = bindTypedAsync(leafHandlersAsync({ execAsync: codegenCtx, dialect: 'postgres' })) as unknown as Record<string, (input?: Record<string, unknown>) => Promise<unknown>>;
  let codegenWriteCounter = 1_000_000; // distinct email/id namespace from the runtime cell's counters
  const codegenFn = (op: string) => async (): Promise<unknown> => {
    const input = inputFor(op, codegenWriteCounter++);
    const result = TX_OPS.has(op)
      ? await transaction(codegenCtx, () => codegenFacade[op](input) as Promise<unknown>, {}, 'postgres')
      : await codegenFacade[op](input);
    if (op === 'nestedRelations' || op === 'compositeRelations') {
      let c = 0;
      for (const u of result as Array<{ posts: Array<{ comments: unknown[] }> }>) for (const p of u.posts) c += p.comments.length;
      if (c !== 10000) {
        throw new Error(`litedbmodel (codegen) ${op} processed ${c} comments, not 10000 — NOT the same graph as the other cells (#170).`);
      }
    }
    return result;
  };

  // Define all test categories (based on Prisma orm-benchmarks)
  const testCategories: TestDefinition[] = [
    // ============================================
    // Find All
    // ============================================
    {
      name: 'Find all (limit 100)',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: () => LiteUser.find([], { limit: 100 }) 
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.user.findMany({ take: 100 }) 
        },
        { 
          orm: KYSELY, 
          fn: () => kysely.selectFrom('benchmark_users').selectAll().limit(100).execute() 
        },
        { 
          orm: DRIZZLE, 
          fn: () => drizzleDb.select().from(drizzleUsers).limit(100) 
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormUserRepo.find({ take: 100 }) 
        },
      ],
    },
    
    // ============================================
    // Filter, paginate & sort
    // ============================================
    {
      name: 'Filter, paginate & sort',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: () => LitePost.find([[LitePost.published, 1]], {
            order: LitePost.created_at.desc(), 
            limit: 20, 
            offset: 10 
          }) 
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.post.findMany({
            where: { published: 1 },
            orderBy: { createdAt: 'desc' },
            skip: 10,
            take: 20,
          }) 
        },
        { 
          orm: KYSELY, 
          fn: () => kysely.selectFrom('benchmark_posts')
            .where('published', '=', 1)
            .orderBy('created_at', 'desc')
            .offset(10)
            .limit(20)
            .selectAll()
            .execute() 
        },
        { 
          orm: DRIZZLE, 
          fn: () => drizzleDb.select().from(drizzlePosts)
            .where(eq(drizzlePosts.published, 1))
            .orderBy(desc(drizzlePosts.created_at))
            .offset(10)
            .limit(20) 
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormPostRepo.find({
            where: { published: 1 },
            order: { created_at: 'DESC' },
            skip: 10,
            take: 20,
          }) 
        },
      ],
    },
    
    // ============================================
    // Nested find all (1-level nesting) - Auto batch loading
    // ============================================
    {
      name: 'Nested find all (include posts)',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: async () => {
            // Auto batch loading via relation
            const users = await LiteUser.find([], { limit: 100 });
            // First access triggers batch load for ALL users' posts
            for (const user of users) {
              await user.posts;
            }
            return users;
          }
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.user.findMany({
            take: 100,
            include: { posts: true },
          }) 
        },
        { 
          orm: KYSELY, 
          fn: async () => {
            // Two queries approach
            const users = await kysely.selectFrom('benchmark_users').selectAll().limit(100).execute();
            if (users.length > 0) {
              const userIds = users.map(u => u.id);
              await kysely.selectFrom('benchmark_posts')
                .where('author_id', 'in', userIds)
                .selectAll()
                .execute();
            }
            return users;
          }
        },
        { 
          orm: DRIZZLE, 
          fn: async () => {
            // Two queries approach
            const users = await drizzleDb.select().from(drizzleUsers).limit(100);
            if (users.length > 0) {
              const userIds = users.map(u => u.id);
              await drizzleDb.select().from(drizzlePosts)
                .where(drizzleSql`${drizzlePosts.author_id} IN ${userIds}`);
            }
            return users;
          }
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormUserRepo.find({
            take: 100,
            relations: ['posts'],
          }) 
        },
      ],
    },
    
    // ============================================
    // Find first
    // ============================================
    {
      name: 'Find first',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: () => LiteUser.findOne([[`${LiteUser.name} LIKE ?`, 'User%']]) 
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.user.findFirst({
            where: { name: { startsWith: 'User' } },
          }) 
        },
        { 
          orm: KYSELY, 
          fn: () => kysely.selectFrom('benchmark_users')
            .where('name', 'like', 'User%')
            .selectAll()
            .limit(1)
            .executeTakeFirst() 
        },
        { 
          orm: DRIZZLE, 
          fn: () => drizzleDb.select().from(drizzleUsers)
            .where(drizzleSql`${drizzleUsers.name} LIKE 'User%'`)
            .limit(1) 
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormUserRepo.createQueryBuilder('user')
            .where('user.name LIKE :name', { name: 'User%' })
            .limit(1)
            .getOne() 
        },
      ],
    },
    
    // ============================================
    // Nested find first
    // ============================================
    {
      name: 'Nested find first (include posts)',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: async () => {
            const user = await LiteUser.findOne([[`${LiteUser.name} LIKE ?`, 'User%']]);
            if (user) {
              await user.posts;
            }
            return user;
          }
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.user.findFirst({
            where: { name: { startsWith: 'User' } },
            include: { posts: true },
          }) 
        },
        { 
          orm: KYSELY, 
          fn: async () => {
            const user = await kysely.selectFrom('benchmark_users')
              .where('name', 'like', 'User%')
              .selectAll()
              .limit(1)
              .executeTakeFirst();
            if (user) {
              await kysely.selectFrom('benchmark_posts')
                .where('author_id', '=', user.id)
                .selectAll()
                .execute();
            }
            return user;
          }
        },
        { 
          orm: DRIZZLE, 
          fn: async () => {
            const users = await drizzleDb.select().from(drizzleUsers)
              .where(drizzleSql`${drizzleUsers.name} LIKE 'User%'`)
              .limit(1);
            if (users.length > 0) {
              await drizzleDb.select().from(drizzlePosts)
                .where(eq(drizzlePosts.author_id, users[0].id));
            }
            return users[0];
          }
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormUserRepo.createQueryBuilder('user')
            .leftJoinAndSelect('user.posts', 'posts')
            .where('user.name LIKE :name', { name: 'User%' })
            .limit(1)
            .getOne() 
        },
      ],
    },
    
    // ============================================
    // Find unique
    // ============================================
    {
      name: 'Find unique (by email)',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: () => LiteUser.findOne([[LiteUser.email, 'user500@example.com']]) 
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.user.findUnique({
            where: { email: 'user500@example.com' },
          }) 
        },
        { 
          orm: KYSELY, 
          fn: () => kysely.selectFrom('benchmark_users')
            .where('email', '=', 'user500@example.com')
            .selectAll()
            .executeTakeFirst() 
        },
        { 
          orm: DRIZZLE, 
          fn: () => drizzleDb.select().from(drizzleUsers)
            .where(eq(drizzleUsers.email, 'user500@example.com'))
            .limit(1) 
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormUserRepo.findOneBy({ email: 'user500@example.com' }) 
        },
      ],
    },
    
    // ============================================
    // Nested find unique
    // ============================================
    {
      name: 'Nested find unique (include posts)',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: async () => {
            const user = await LiteUser.findOne([[LiteUser.email, 'user500@example.com']]);
            if (user) {
              await user.posts;
            }
            return user;
          }
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.user.findUnique({
            where: { email: 'user500@example.com' },
            include: { posts: true },
          }) 
        },
        { 
          orm: KYSELY, 
          fn: async () => {
            const user = await kysely.selectFrom('benchmark_users')
              .where('email', '=', 'user500@example.com')
              .selectAll()
              .executeTakeFirst();
            if (user) {
              await kysely.selectFrom('benchmark_posts')
                .where('author_id', '=', user.id)
                .selectAll()
                .execute();
            }
            return user;
          }
        },
        { 
          orm: DRIZZLE, 
          fn: async () => {
            const users = await drizzleDb.select().from(drizzleUsers)
              .where(eq(drizzleUsers.email, 'user500@example.com'))
              .limit(1);
            if (users.length > 0) {
              await drizzleDb.select().from(drizzlePosts)
                .where(eq(drizzlePosts.author_id, users[0].id));
            }
            return users[0];
          }
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormUserRepo.findOne({
            where: { email: 'user500@example.com' },
            relations: ['posts'],
          }) 
        },
      ],
    },
    
    // ============================================
    // Create (all ORMs use transaction for fair comparison)
    // ============================================
    {
      name: 'Create',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: () => LiteUser.transaction(async () => LiteUser.create([
            [LiteUser.email, `bench${createCounter++}@example.com`],
            [LiteUser.name, `Benchmark User`],
          ])) 
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.$transaction(async (tx) => tx.user.create({
            data: {
              email: `bench${createCounter++}@example.com`,
              name: 'Benchmark User',
            },
          }))
        },
        { 
          orm: KYSELY, 
          fn: () => kysely.transaction().execute(async (trx) => 
            trx.insertInto('benchmark_users')
              .values({
                email: `bench${createCounter++}@example.com`,
                name: 'Benchmark User',
              })
              .returningAll()
              .executeTakeFirst()
          )
        },
        { 
          orm: DRIZZLE, 
          fn: () => drizzleDb.transaction(async (tx) =>
            tx.insert(drizzleUsers)
              .values({
                email: `bench${createCounter++}@example.com`,
                name: 'Benchmark User',
              })
              .returning()
          )
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormDS.transaction(async (em) => {
            const user = em.create(TypeORMUser, {
              email: `bench${createCounter++}@example.com`,
              name: 'Benchmark User',
            });
            return em.save(user);
          })
        },
      ],
    },
    
    // ============================================
    // Nested create (all ORMs use transaction)
    // ============================================
    {
      name: 'Nested create (with post)',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: () => LiteUser.transaction(async () => {
            const result = await LiteUser.create([
              [LiteUser.email, `nested${createCounter++}@example.com`],
              [LiteUser.name, `Nested User`],
            ], { returning: true });
            await LitePost.create([
              [LitePost.title, 'Nested Post'],
              [LitePost.content, 'Content'],
              [LitePost.author_id, result!.values[0][0] as number],
            ]);
            return result;
          })
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.$transaction(async (tx) => tx.user.create({
            data: {
              email: `nested${createCounter++}@example.com`,
              name: 'Nested User',
              posts: {
                create: { title: 'Nested Post', content: 'Content' },
              },
            },
          }))
        },
        { 
          orm: KYSELY, 
          fn: () => kysely.transaction().execute(async (trx) => {
            const user = await trx.insertInto('benchmark_users')
              .values({
                email: `nested${createCounter++}@example.com`,
                name: 'Nested User',
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            await trx.insertInto('benchmark_posts')
              .values({
                title: 'Nested Post',
                content: 'Content',
                author_id: user.id,
              })
              .execute();
            return user;
          })
        },
        { 
          orm: DRIZZLE, 
          fn: () => drizzleDb.transaction(async (tx) => {
            const [user] = await tx.insert(drizzleUsers)
              .values({
                email: `nested${createCounter++}@example.com`,
                name: 'Nested User',
              })
              .returning();
            await tx.insert(drizzlePosts)
              .values({
                title: 'Nested Post',
                content: 'Content',
                author_id: user.id,
              });
            return user;
          })
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormDS.transaction(async (em) => {
            const user = em.create(TypeORMUser, {
              email: `nested${createCounter++}@example.com`,
              name: 'Nested User',
            });
            const savedUser = await em.save(user);
            const post = em.create(TypeORMPost, {
              title: 'Nested Post',
              content: 'Content',
              author_id: savedUser.id,
            });
            await em.save(post);
            return savedUser;
          })
        },
      ],
    },
    
    // ============================================
    // Update (all ORMs use transaction)
    // ============================================
    {
      name: 'Update',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: () => LiteUser.transaction(async () => LiteUser.update([[LiteUser.id, 100]], [[LiteUser.name, 'Updated User']])) 
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.$transaction(async (tx) => tx.user.update({
            where: { id: 100 },
            data: { name: 'Updated User' },
          }))
        },
        { 
          orm: KYSELY, 
          fn: () => kysely.transaction().execute(async (trx) =>
            trx.updateTable('benchmark_users')
              .set({ name: 'Updated User' })
              .where('id', '=', 100)
              .execute()
          )
        },
        { 
          orm: DRIZZLE, 
          fn: () => drizzleDb.transaction(async (tx) =>
            tx.update(drizzleUsers)
              .set({ name: 'Updated User' })
              .where(eq(drizzleUsers.id, 100))
          )
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormDS.transaction(async (em) =>
            em.update(TypeORMUser, { id: 100 }, { name: 'Updated User' })
          )
        },
      ],
    },
    
    // ============================================
    // Nested update (all ORMs use transaction)
    // ============================================
    {
      name: 'Nested update (update user + post)',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: () => LiteUser.transaction(async () => {
            await LiteUser.update([[LiteUser.id, 100]], [[LiteUser.name, 'Nested Updated']]);
            await LitePost.update([[LitePost.author_id, 100]], [[LitePost.title, 'Updated Post']]);
          })
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.$transaction(async (tx) => tx.user.update({
            where: { id: 100 },
            data: {
              name: 'Nested Updated',
              posts: {
                updateMany: {
                  where: {},
                  data: { title: 'Updated Post' },
                },
              },
            },
          }))
        },
        { 
          orm: KYSELY, 
          fn: () => kysely.transaction().execute(async (trx) => {
            await trx.updateTable('benchmark_users')
              .set({ name: 'Nested Updated' })
              .where('id', '=', 100)
              .execute();
            await trx.updateTable('benchmark_posts')
              .set({ title: 'Updated Post' })
              .where('author_id', '=', 100)
              .execute();
          })
        },
        { 
          orm: DRIZZLE, 
          fn: () => drizzleDb.transaction(async (tx) => {
            await tx.update(drizzleUsers)
              .set({ name: 'Nested Updated' })
              .where(eq(drizzleUsers.id, 100));
            await tx.update(drizzlePosts)
              .set({ title: 'Updated Post' })
              .where(eq(drizzlePosts.author_id, 100));
          })
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormDS.transaction(async (em) => {
            await em.update(TypeORMUser, { id: 100 }, { name: 'Nested Updated' });
            await em.update(TypeORMPost, { author_id: 100 }, { title: 'Updated Post' });
          })
        },
      ],
    },
    
    // ============================================
    // Upsert (all ORMs use transaction)
    // ============================================
    {
      name: 'Upsert',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: () => LiteUser.transaction(async () => LiteUser.create(
            [
              [LiteUser.email, `upsert${upsertCounter++}@example.com`],
              [LiteUser.name, 'Upsert User'],
            ],
            { onConflict: LiteUser.email, onConflictUpdate: [LiteUser.name], returning: true }
          )) 
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.$transaction(async (tx) => tx.user.upsert({
            where: { email: `upsert${upsertCounter++}@example.com` },
            update: { name: 'Upsert User' },
            create: { email: `upsert${upsertCounter}@example.com`, name: 'Upsert User' },
          }))
        },
        { 
          orm: KYSELY, 
          fn: () => kysely.transaction().execute(async (trx) =>
            trx.insertInto('benchmark_users')
              .values({
                email: `upsert${upsertCounter++}@example.com`,
                name: 'Upsert User',
              })
              .onConflict(oc => oc.column('email').doUpdateSet({ name: 'Upsert User' }))
              .execute()
          )
        },
        { 
          orm: DRIZZLE, 
          fn: () => drizzleDb.transaction(async (tx) =>
            tx.insert(drizzleUsers)
              .values({
                email: `upsert${upsertCounter++}@example.com`,
                name: 'Upsert User',
              })
              .onConflictDoUpdate({
                target: drizzleUsers.email,
                set: { name: 'Upsert User' },
              })
          )
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormDS.transaction(async (em) =>
            em.upsert(TypeORMUser,
              { email: `upsert${upsertCounter++}@example.com`, name: 'Upsert User' },
              ['email']
            )
          )
        },
      ],
    },
    
    // ============================================
    // Nested upsert (all ORMs use transaction)
    // ============================================
    {
      name: 'Nested upsert (user + post)',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: () => LiteUser.transaction(async () => {
            const result = await LiteUser.create(
              [
                [LiteUser.email, `nupsert${upsertCounter++}@example.com`],
                [LiteUser.name, 'Nested Upsert'],
              ],
              { onConflict: LiteUser.email, onConflictUpdate: [LiteUser.name], returning: true }
            );
            await LitePost.create([
              [LitePost.title, 'Upsert Post'],
              [LitePost.author_id, result!.values[0][0] as number],
            ]);
            return result;
          })
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.$transaction(async (tx) => {
            const user = await tx.user.upsert({
              where: { email: `nupsert${upsertCounter++}@example.com` },
              update: { name: 'Nested Upsert' },
              create: {
                email: `nupsert${upsertCounter}@example.com`,
                name: 'Nested Upsert',
                posts: { create: { title: 'Upsert Post' } },
              },
            });
            return user;
          })
        },
        { 
          orm: KYSELY, 
          fn: () => kysely.transaction().execute(async (trx) => {
            const user = await trx.insertInto('benchmark_users')
              .values({
                email: `nupsert${upsertCounter++}@example.com`,
                name: 'Nested Upsert',
              })
              .onConflict(oc => oc.column('email').doUpdateSet({ name: 'Nested Upsert' }))
              .returningAll()
              .executeTakeFirstOrThrow();
            await trx.insertInto('benchmark_posts')
              .values({ title: 'Upsert Post', author_id: user.id })
              .execute();
            return user;
          })
        },
        { 
          orm: DRIZZLE, 
          fn: () => drizzleDb.transaction(async (tx) => {
            const [user] = await tx.insert(drizzleUsers)
              .values({
                email: `nupsert${upsertCounter++}@example.com`,
                name: 'Nested Upsert',
              })
              .onConflictDoUpdate({
                target: drizzleUsers.email,
                set: { name: 'Nested Upsert' },
              })
              .returning();
            await tx.insert(drizzlePosts)
              .values({ title: 'Upsert Post', author_id: user.id });
            return user;
          })
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormDS.transaction(async (em) => {
            const result = await em.upsert(TypeORMUser,
              { email: `nupsert${upsertCounter++}@example.com`, name: 'Nested Upsert' },
              ['email']
            );
            const user = await em.findOneBy(TypeORMUser, { email: `nupsert${upsertCounter}@example.com` });
            if (user) {
              const post = em.create(TypeORMPost, { title: 'Upsert Post', author_id: user.id });
              await em.save(post);
            }
            return result;
          })
        },
      ],
    },
    
    // ============================================
    // Delete (all ORMs use transaction)
    // ============================================
    {
      name: 'Delete',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: () => LiteUser.transaction(async () => {
            // First create then delete
            const result = await LiteUser.create([
              [LiteUser.email, `del${createCounter++}@example.com`],
              [LiteUser.name, 'Delete User'],
            ], { returning: true });
            return LiteUser.delete([[LiteUser.id, result!.values[0][0] as number]]);
          })
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
              data: { email: `del${createCounter++}@example.com`, name: 'Delete User' },
            });
            return tx.user.delete({ where: { id: user.id } });
          })
        },
        { 
          orm: KYSELY, 
          fn: () => kysely.transaction().execute(async (trx) => {
            const user = await trx.insertInto('benchmark_users')
              .values({ email: `del${createCounter++}@example.com`, name: 'Delete User' })
              .returningAll()
              .executeTakeFirstOrThrow();
            return trx.deleteFrom('benchmark_users').where('id', '=', user.id).execute();
          })
        },
        { 
          orm: DRIZZLE, 
          fn: () => drizzleDb.transaction(async (tx) => {
            const [user] = await tx.insert(drizzleUsers)
              .values({ email: `del${createCounter++}@example.com`, name: 'Delete User' })
              .returning();
            return tx.delete(drizzleUsers).where(eq(drizzleUsers.id, user.id));
          })
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormDS.transaction(async (em) => {
            const user = em.create(TypeORMUser, { email: `del${createCounter++}@example.com`, name: 'Delete User' });
            const saved = await em.save(user);
            return em.delete(TypeORMUser, { id: saved.id });
          })
        },
      ],
    },
    
    // ============================================
    // Create Many (bulk insert)
    // ============================================
    {
      name: 'Create Many (10 records)',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: () => LiteUser.transaction(async () => {
            const records = Array.from({ length: 10 }, (_, i) => [
              [LiteUser.email, `bulk${createCounter++}@example.com`],
              [LiteUser.name, `Bulk User ${i}`],
            ] as [[typeof LiteUser.email, string], [typeof LiteUser.name, string]]);
            return LiteUser.createMany(records);
          })
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.$transaction(async (tx) => {
            return tx.user.createMany({
              data: Array.from({ length: 10 }, (_, i) => ({
                email: `bulk${createCounter++}@example.com`,
                name: `Bulk User ${i}`,
              })),
            });
          })
        },
        { 
          orm: KYSELY, 
          fn: () => kysely.transaction().execute(async (trx) => {
            return trx.insertInto('benchmark_users')
              .values(Array.from({ length: 10 }, (_, i) => ({
                email: `bulk${createCounter++}@example.com`,
                name: `Bulk User ${i}`,
              })))
              .execute();
          })
        },
        { 
          orm: DRIZZLE, 
          fn: () => drizzleDb.transaction(async (tx) => {
            return tx.insert(drizzleUsers)
              .values(Array.from({ length: 10 }, (_, i) => ({
                email: `bulk${createCounter++}@example.com`,
                name: `Bulk User ${i}`,
              })));
          })
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormDS.transaction(async (em) => {
            return em.insert(TypeORMUser, Array.from({ length: 10 }, (_, i) => ({
              email: `bulk${createCounter++}@example.com`,
              name: `Bulk User ${i}`,
            })));
          })
        },
      ],
    },
    
    // ============================================
    // Upsert Many (bulk upsert)
    // ============================================
    {
      name: 'Upsert Many (10 records)',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: () => LiteUser.transaction(async () => {
            const records = Array.from({ length: 10 }, (_, i) => [
              [LiteUser.email, `upsertbulk${upsertCounter++}@example.com`],
              [LiteUser.name, `Upsert Bulk ${i}`],
            ] as [[typeof LiteUser.email, string], [typeof LiteUser.name, string]]);
            return LiteUser.createMany(records, { 
              onConflict: LiteUser.email, 
              onConflictUpdate: [LiteUser.name] 
            });
          })
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.$transaction(async (tx) => {
            // Prisma createMany doesn't support onConflict update
            // Must use individual upserts
            return Promise.all(Array.from({ length: 10 }, (_, i) => 
              tx.user.upsert({
                where: { email: `upsertbulk${upsertCounter++}@example.com` },
                update: { name: `Upsert Bulk ${i}` },
                create: { email: `upsertbulk${upsertCounter}@example.com`, name: `Upsert Bulk ${i}` },
              })
            ));
          })
        },
        { 
          orm: KYSELY, 
          fn: () => kysely.transaction().execute(async (trx) => {
            return trx.insertInto('benchmark_users')
              .values(Array.from({ length: 10 }, (_, i) => ({
                email: `upsertbulk${upsertCounter++}@example.com`,
                name: `Upsert Bulk ${i}`,
              })))
              .onConflict(oc => oc.column('email').doUpdateSet({ name: 'Upsert Bulk' }))
              .execute();
          })
        },
        { 
          orm: DRIZZLE, 
          fn: () => drizzleDb.transaction(async (tx) => {
            return tx.insert(drizzleUsers)
              .values(Array.from({ length: 10 }, (_, i) => ({
                email: `upsertbulk${upsertCounter++}@example.com`,
                name: `Upsert Bulk ${i}`,
              })))
              .onConflictDoUpdate({
                target: drizzleUsers.email,
                set: { name: drizzleSql`excluded.name` },
              });
          })
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormDS.transaction(async (em) => {
            return em.upsert(TypeORMUser, 
              Array.from({ length: 10 }, (_, i) => ({
                email: `upsertbulk${upsertCounter++}@example.com`,
                name: `Upsert Bulk ${i}`,
              })),
              ['email']
            );
          })
        },
      ],
    },
    
    // ============================================
    // Update Many (different values per row)
    // Only litedbmodel supports this natively
    // ============================================
    {
      name: 'Update Many (10 different values)',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: () => LiteUser.transaction(async () => {
            // Update 10 users with different names in a single query
            return LiteUser.updateMany(
              Array.from({ length: 10 }, (_, i) => [
                [LiteUser.id, 100 + i],
                [LiteUser.name, `Updated Different ${i}`],
              ] as const),
              { keyColumns: [LiteUser.id] }
            );
          })
        },
        { 
          orm: PRISMA, 
          fn: () => prisma.$transaction(async (tx) => {
            // Prisma requires individual updates - N queries
            return Promise.all(Array.from({ length: 10 }, (_, i) => 
              tx.user.update({
                where: { id: 100 + i },
                data: { name: `Updated Different ${i}` },
              })
            ));
          })
        },
        { 
          orm: KYSELY, 
          fn: () => kysely.transaction().execute(async (trx) => {
            // Kysely requires individual updates - N queries
            return Promise.all(Array.from({ length: 10 }, (_, i) => 
              trx.updateTable('benchmark_users')
                .set({ name: `Updated Different ${i}` })
                .where('id', '=', 100 + i)
                .execute()
            ));
          })
        },
        { 
          orm: DRIZZLE, 
          fn: () => drizzleDb.transaction(async (tx) => {
            // Drizzle requires individual updates - N queries
            return Promise.all(Array.from({ length: 10 }, (_, i) => 
              tx.update(drizzleUsers)
                .set({ name: `Updated Different ${i}` })
                .where(eq(drizzleUsers.id, 100 + i))
            ));
          })
        },
        { 
          orm: TYPEORM, 
          fn: () => typeormDS.transaction(async (em) => {
            // TypeORM requires individual updates - N queries
            return Promise.all(Array.from({ length: 10 }, (_, i) => 
              em.update(TypeORMUser, { id: 100 + i }, { name: `Updated Different ${i}` })
            ));
          })
        },
      ],
    },
    
    // ============================================
    // Nested Relations (100 users → 1000 posts → 10000 comments)
    // Simulates real-world deep relation traversal
    // ============================================
    {
      name: 'Nested relations (100→1000→10000)',
      tests: [
        { 
          orm: RUNTIME_SERIES,
          fn: async () => {
            // Fetch first 100 users by ID (they have 10 posts each = 1000 posts)
            const users = await LiteUser.find([], { limit: 100, order: LiteUser.id.asc() });
            let commentCount = 0;
            // Access all posts via lazy loading (triggers batch load)
            for (const user of users) {
              const posts = await user.posts;
              for (const post of posts) {
                // Access all comments via lazy loading (triggers batch load)
                const comments = await post.comments;
                for (const _comment of comments) {
                  commentCount++;
                }
              }
            }
            // Verify we accessed all 10000 comments
            if (commentCount !== 10000) {
              throw new Error(`litedbmodel nestedRelations processed ${commentCount} comments, not 10000 — this cell is NOT traversing the same graph as the others; a benchmark number from it would be comparing different work (#170).`);
            }
            return users;
          }
        },
        { 
          orm: PRISMA, 
          fn: async () => {
            const users = await prisma.user.findMany({
              take: 100,
              orderBy: { id: 'asc' },
              include: { 
                posts: {
                  include: { comments: true }
                }
              },
            });
            let commentCount = 0;
            for (const user of users) {
              for (const post of user.posts) {
                for (const _comment of post.comments) {
                  commentCount++;
                }
              }
            }
            if (commentCount !== 10000) {
              throw new Error(`Prisma nestedRelations processed ${commentCount} comments, not 10000 — this cell is NOT traversing the same graph as the others; a benchmark number from it would be comparing different work (#170).`);
            }
            return users;
          }
        },
        { 
          orm: KYSELY, 
          fn: async () => {
            // Load users
            const users = await kysely.selectFrom('benchmark_users').selectAll().orderBy('id').limit(100).execute();
            const userIds = users.map(u => u.id);
            
            // Load posts for these users
            const posts = await kysely.selectFrom('benchmark_posts')
              .where('author_id', 'in', userIds)
              .selectAll()
              .execute();
            const postIds = posts.map(p => p.id);
            
            // Load comments for these posts
            const comments = await kysely.selectFrom('benchmark_comments')
              .where('post_id', 'in', postIds)
              .selectAll()
              .execute();
            
            // Group posts by user
            const postsByUser = new Map<number, typeof posts>();
            for (const post of posts) {
              if (!postsByUser.has(post.author_id)) postsByUser.set(post.author_id, []);
              postsByUser.get(post.author_id)!.push(post);
            }
            
            // Group comments by post
            const commentsByPost = new Map<number, typeof comments>();
            for (const comment of comments) {
              if (!commentsByPost.has(comment.post_id)) commentsByPost.set(comment.post_id, []);
              commentsByPost.get(comment.post_id)!.push(comment);
            }
            
            // Iterate through all
            let commentCount = 0;
            for (const user of users) {
              const userPosts = postsByUser.get(user.id) || [];
              for (const post of userPosts) {
                const postComments = commentsByPost.get(post.id) || [];
                for (const _comment of postComments) {
                  commentCount++;
                }
              }
            }
            if (commentCount !== 10000) {
              throw new Error(`Kysely nestedRelations processed ${commentCount} comments, not 10000 — this cell is NOT traversing the same graph as the others; a benchmark number from it would be comparing different work (#170).`);
            }
            return users;
          }
        },
        { 
          orm: DRIZZLE, 
          fn: async () => {
            // Use Drizzle's query API with relations (LATERAL JOIN internally)
            const users = await drizzleDb.query.users.findMany({
              limit: 100,
              orderBy: asc(drizzleUsers.id),
              with: { posts: { with: { comments: true } } }
            });
            let commentCount = 0;
            for (const user of users) {
              for (const post of user.posts) {
                for (const _comment of post.comments) {
                  commentCount++;
                }
              }
            }
            if (commentCount !== 10000) {
              throw new Error(`Drizzle nestedRelations processed ${commentCount} comments, not 10000 — this cell is NOT traversing the same graph as the others; a benchmark number from it would be comparing different work (#170).`);
            }
            return users;
          }
        },
        { 
          orm: TYPEORM, 
          fn: async () => {
            const users = await typeormUserRepo.find({
              take: 100,
              order: { id: 'ASC' },
              relations: ['posts', 'posts.comments'],
            });
            let commentCount = 0;
            for (const user of users) {
              for (const post of user.posts) {
                for (const _comment of post.comments) {
                  commentCount++;
                }
              }
            }
            if (commentCount !== 10000) {
              throw new Error(`TypeORM nestedRelations processed ${commentCount} comments, not 10000 — this cell is NOT traversing the same graph as the others; a benchmark number from it would be comparing different work (#170).`);
            }
            return users;
          }
        },
      ],
    },
    
    // ============================================
    // Nested Relations - Composite Key
    // First 100 tenant_users by user_id → 1000 posts → 10000 comments (every tenant_user has the same
    // 10 posts × 10 comments shape, so any 100 of them traverse exactly 10000 comments).
    // Tests proper multi-tenant batch loading with composite foreign keys. The selection rule is the
    // crosslang composite op's (native-model.ts: `ORDER BY user_id ASC LIMIT 100`, no tenant filter) —
    // NOT a `tenant_id IN (…)` filter, which would assume a fixed tenant layout.
    // ============================================
    {
      name: 'Nested relations (composite key)',
      tests: [
        {
          orm: RUNTIME_SERIES,
          fn: async () => {
            // First 100 tenant_users by user_id (matches the crosslang composite op's selection).
            const users = await LiteTenantUser.find([], { limit: 100, order: LiteTenantUser.user_id.asc() });
            let commentCount = 0;
            for (const user of users) {
              const posts = await user.posts;
              for (const post of posts) {
                const comments = await post.comments;
                for (const _comment of comments) {
                  commentCount++;
                }
              }
            }
            // 100 tenant_users, each with 10 posts × 10 comments = 10000.
            if (commentCount !== 10000) {
              throw new Error(`litedbmodel compositeRelations processed ${commentCount} comments, not 10000 — this cell is NOT traversing the same graph as the others; a benchmark number from it would be comparing different work (#170).`);
            }
            return users;
          }
        },
        { 
          orm: PRISMA, 
          fn: async () => {
            const users = await prisma.tenantUser.findMany({
              take: 100,
              orderBy: { user_id: 'asc' },
              include: {
                posts: {
                  include: { comments: true }
                }
              },
            });
            let commentCount = 0;
            for (const user of users) {
              for (const post of user.posts) {
                for (const _comment of post.comments) {
                  commentCount++;
                }
              }
            }
            if (commentCount !== 10000) {
              throw new Error(`compositeRelations processed ${commentCount} comments, not 10000 — this cell is NOT traversing the same graph as the others; a benchmark number from it would be comparing different work (#170).`);
            }
            return users;
          }
        },
        // Kysely: N/A - Cannot properly batch load composite FK (would need manual tuple matching)
        { 
          orm: DRIZZLE, 
          fn: async () => {
            // Use Drizzle's query API with relations (LATERAL JOIN internally)
            const users = await drizzleDb.query.tenantUsers.findMany({
              limit: 100,
              orderBy: asc(drizzleTenantUsers.user_id),
              with: { posts: { with: { comments: true } } }
            });
            let commentCount = 0;
            for (const user of users) {
              for (const post of user.posts) {
                for (const _comment of post.comments) {
                  commentCount++;
                }
              }
            }
            if (commentCount !== 10000) {
              throw new Error(`compositeRelations processed ${commentCount} comments, not 10000 — this cell is NOT traversing the same graph as the others; a benchmark number from it would be comparing different work (#170).`);
            }
            return users;
          }
        },
        { 
          orm: TYPEORM, 
          fn: async () => {
            const users = await typeormDS.getRepository(TypeORMTenantUser).find({
              take: 100,
              order: { user_id: 'ASC' },
              relations: ['posts', 'posts.comments'],
            });
            let commentCount = 0;
            for (const user of users as any[]) {
              for (const post of user.posts) {
                for (const _comment of post.comments) {
                  commentCount++;
                }
              }
            }
            if (commentCount !== 10000) {
              throw new Error(`compositeRelations processed ${commentCount} comments, not 10000 — this cell is NOT traversing the same graph as the others; a benchmark number from it would be comparing different work (#170).`);
            }
            return users;
          }
        },
      ],
    },
  ];

  // Add the `litedbmodel (codegen)` cell to every category — the SAME op the runtime cell drives, but
  // through the bc-generated module (`codegenFn`) instead of the imperative DBModel path. One map, so the
  // two litedbmodel rows are guaranteed to benchmark identical logical work per op.
  const CATEGORY_TO_OP: Readonly<Record<string, string>> = {
    'Find all (limit 100)': 'findAll',
    'Filter, paginate & sort': 'filterPaginateSort',
    'Nested find all (include posts)': 'nestedFindAll',
    'Find first': 'findFirst',
    'Nested find first (include posts)': 'nestedFindFirst',
    'Find unique (by email)': 'findUnique',
    'Nested find unique (include posts)': 'nestedFindUnique',
    'Create': 'create',
    'Nested create (with post)': 'nestedCreate',
    'Update': 'update',
    'Nested update (update user + post)': 'nestedUpdate',
    'Upsert': 'upsert',
    'Nested upsert (user + post)': 'nestedUpsert',
    'Delete': 'delete',
    'Create Many (10 records)': 'createMany',
    'Upsert Many (10 records)': 'upsertMany',
    'Update Many (10 different values)': 'updateMany',
    'Nested relations (100→1000→10000)': 'nestedRelations',
    'Nested relations (composite key)': 'compositeRelations',
  };
  for (const category of testCategories) {
    const op = CATEGORY_TO_OP[category.name];
    if (!op) throw new Error(`benchmark: category '${category.name}' has no codegen op mapping`);
    category.tests.push({ orm: CODEGEN_SERIES, fn: codegenFn(op) });
  }

  // Store all results
  const allResults: Map<string, Map<OrmSeries, number[]>> = new Map();
  
  // Initialize result storage
  for (const category of testCategories) {
    const categoryMap = new Map<OrmSeries, number[]>();
    for (const test of category.tests) {
      categoryMap.set(test.orm, []);
    }
    allResults.set(category.name, categoryMap);
  }
  
  // Warmup all tests
  console.log('⏳ Warming up...');
  for (const category of testCategories) {
    for (const test of category.tests) {
      await warmup(test.fn, WARMUP_ITERATIONS);
    }
  }
  
  // No warmup teardown needed: the first timed op's resetGeneralGraph() (per-op, below) TRUNCATEs and
  // re-seeds the whole graph before anything is measured, so warmup writes never reach a measurement.
  // Only the id counters must be rewound so timed create/upsert ops start from known, collision-free ids.
  createCounter = 10000;
  upsertCounter = 20000;
  
  console.log('✅ Warmup complete\n');
  
  // Run benchmark rounds
  for (let round = 1; round <= ROUNDS; round++) {
    console.log(`🔄 Round ${round}/${ROUNDS}...`);
    
    for (const category of testCategories) {
      const categoryResults = allResults.get(category.name)!;
      
      // Run each ORM's iterations for this category
      for (const test of category.tests) {
        // Clean general graph per (op, ORM) — the same reset discipline the crosslang cells apply per op.
        // Every ORM measures the op on the identical seeded fixture, so a prior op's/ORM's writes never
        // leak in. (TRUNCATE … RESTART IDENTITY, so `id = 100` targets still resolve; tenant graph is
        // untouched — no op writes it.)
        await resetGeneralGraph(resetPool);
        const times = categoryResults.get(test.orm)!;

        for (let i = 0; i < ITERATIONS; i++) {
          const time = await runIteration(test.fn);
          times.push(time);
        }
      }
    }
  }
  
  console.log('\n✅ All rounds complete!\n');
  
  // Collect all results for CSV export
  const csvRows: string[] = ['Operation,ORM,Median,IQR,StdDev,Min,Max,Iterations'];
  
  // Print results for each category
  for (const category of testCategories) {
    const categoryResults = allResults.get(category.name)!;
    const results: BenchmarkResult[] = [];
    
    for (const [orm, times] of categoryResults) {
      const stats = computeStats(times);
      stats.name = orm;
      results.push(stats);
      
      // Add to CSV
      csvRows.push(`"${category.name}","${orm}",${stats.median.toFixed(4)},${stats.iqr.toFixed(4)},${stats.stdDev.toFixed(4)},${stats.min.toFixed(4)},${stats.max.toFixed(4)},${times.length}`);
    }
    
    printResults(category.name, results);
  }
  
  // Save CSV to file
  const csvPath = path.join(__dirname, 'results', 'benchmark-results.csv');
  await fs.mkdir(path.join(__dirname, 'results'), { recursive: true });
  await fs.writeFile(csvPath, csvRows.join('\n'));
  console.log(`\n📊 Results saved to: ${csvPath}`);
  
  // ============================================
  // Summary Table (Median comparison)
  // ============================================
  
  // One column per series, in ORM_SERIES order — the console table shows the same series in the same
  // order as the generated docs. Width is the only thing this table decides, and it follows from the
  // label: a numeric cell needs 11, a longer series name needs its own length.
  const operationWidth = 31;
  const summaryColumns = ORM_SERIES.map((orm) => [orm, Math.max(orm.length, 11)] as const);
  const columnWidths = [operationWidth, ...summaryColumns.map(([, width]) => width)];

  console.log('\n' + '='.repeat(100));
  console.log('📋 SUMMARY - Median (ms)');
  console.log('='.repeat(100));
  console.log(`| ${['Operation'.padEnd(operationWidth), ...summaryColumns.map(([orm, width]) => orm.padEnd(width))].join(' | ')} |`);
  console.log(`|${columnWidths.map((width) => '-'.repeat(width + 2)).join('|')}|`);

  for (const category of testCategories) {
    const categoryResults = allResults.get(category.name)!;
    const row: string[] = [category.name.padEnd(operationWidth)];

    const medians: { orm: OrmSeries; median: number }[] = [];
    for (const [orm, times] of categoryResults) {
      const stats = computeStats(times);
      medians.push({ orm, median: stats.median });
    }

    const fastest = Math.min(...medians.map(m => m.median));

    for (const [orm, width] of summaryColumns) {
      const entry = medians.find(m => m.orm === orm);
      if (entry) {
        const isFastest = entry.median === fastest;
        const val = isFastest ? `**${entry.median.toFixed(2)}ms**` : `${entry.median.toFixed(2)}ms`;
        row.push(val.padStart(width));
      } else {
        row.push('-'.padStart(width));
      }
    }
    
    console.log(`| ${row.join(' | ')} |`);
  }
  
  // ============================================
  // Cleanup
  // ============================================
  
  console.log('\n⏳ Cleaning up...');
  
  // Delete benchmark-inserted data (keep seed data: 1000 users, 5500 posts)
  await DBModel.execute('DELETE FROM benchmark_posts WHERE id > 5500');
  await DBModel.execute('DELETE FROM benchmark_users WHERE id > 1000');
  
  await closeAllPools();
  await codegenPool.end();
  await resetPool.end();
  await prisma.$disconnect();
  await kyselyPool.end();
  await drizzlePool.end();
  await typeormDS.destroy();
  
  console.log('✅ Benchmark complete!\n');
  
  // Methodology
  console.log('='.repeat(80));
  console.log('📋 METHODOLOGY');
  console.log('='.repeat(80));
  console.log(`
Based on Prisma's official orm-benchmarks:
https://github.com/prisma/orm-benchmarks

Reference article:
https://izanami.dev/post/1e3fa298-252c-4f6e-8bcc-b225d53c95fb

Test Conditions:
- ${ROUNDS} rounds × ${ITERATIONS} iterations = ${ROUNDS * ITERATIONS} total iterations per ORM
- Interleaved execution to reduce environmental variance
- PostgreSQL running locally (Docker) to eliminate network latency
- Warmup: ${WARMUP_ITERATIONS} iterations before measurement
- Metrics: Median, IQR (Interquartile Range), StdDev (Standard Deviation)

Operations tested:
- Find all (limit 100)
- Filter, paginate & sort
- Nested find all (1-level nesting with posts)
- Find first
- Nested find first
- Find unique (by email)
- Nested find unique
- Create
- Nested create (user + post)
- Update
- Nested update
- Upsert
- Nested upsert
- Delete

Lower Median = better performance
Lower IQR/StdDev = more consistent results
`);
}

main().catch(console.error);
