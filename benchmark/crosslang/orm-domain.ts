// ════════════════════════════════════════════════════════════════════════════
// Unified ORM-bench DOMAIN — schema + seed for the 19-op cross-lang bench.
// ════════════════════════════════════════════════════════════════════════════
//
// The tables the ORM-vs-ORM bench measures against (`benchmark/setup.ts`): benchmark_users /
// benchmark_posts / benchmark_comments + the composite-key tenant_* tables. Every language's live leg
// creates these in an ISOLATED per-bench namespace (PG schema `scp_ts_bench` via search_path, MySQL
// database `scp_ts_bench`, sqlite fresh :memory:) so the bench never collides with the
// conformance/integration fixtures.
//
// The seed is deterministic and identical across dialects, and it is sized to `benchmark/setup.ts`
// (`ORM_SEED`) so the 19 ops read the SAME number of rows the ORM-bench litedbmodel column reads —
// rows/op parity is what makes the two columns comparable AND what makes a per-row regression visible
// (#170). `scaleSeed` re-sizes the child fan-outs for the fixed-overhead-vs-per-row-cost sweep.

export type OrmDialect = 'sqlite' | 'mysql' | 'postgres';

/**
 * The fixture shape. Every count an op's row yield depends on is a field here, so the fixture can be
 * re-sized from one place and the SAME ops re-run at several scales (`scaleSeed`).
 */
export interface SeedShape {
  /** Total `benchmark_users` rows. */
  readonly users: number;
  /** Users `1..nestedUsers` carry the deep graph (posts + comments) — the window every relation op reads. */
  readonly nestedUsers: number;
  /** Posts per deep-graph user. */
  readonly nestedPostsPerUser: number;
  /** Comments per deep-graph post. */
  readonly commentsPerPost: number;
  /** Posts per user OUTSIDE the deep-graph window (they carry no comments) — table bulk, as in the ORM bench. */
  readonly shallowPostsPerUser: number;
  readonly tenants: number;
  readonly usersPerTenant: number;
  readonly postsPerTenantUser: number;
  readonly commentsPerTenantPost: number;
}

/**
 * The fixture the ORM-vs-ORM bench measures against (`benchmark/setup.ts`): 1000 users, of which the
 * first 100 carry 10 posts × 10 comments (the `100 → 1000 → 10000` graph its "Nested relations" op
 * traverses), the rest 5 posts each; and the composite-key tenant graph whose LIMIT-100 window is
 * likewise `100 → 1000 → 10000`.
 *
 * The cross-lang bench MUST read the same number of rows per op as that bench, or the two columns are
 * not comparable and the per-row cost of the runtime is not observable: at the previous 110-user
 * fixture `nestedRelations` read 700 rows against the ORM bench's 11,100, so a per-row regression could
 * not show up as anything but noise against the fixed per-call overhead (#170).
 *
 * `tenants` × `usersPerTenant` = 1000 tenant_users, EVERY tenant carrying comments. `compositeRelations`
 * reads a NATURAL `ORDER BY user_id LIMIT 100` (no tenant filter shaped around which tenants happen to
 * have comments) → 100 tenant_users → 1000 posts → 10000 comments, whichever 100 the window lands on.
 *
 * The record counts match the ORM-vs-ORM bench (`benchmark/setup.ts`) EXACTLY: 1000 users, 5500 posts,
 * 10000 comments, 1000 tenant_users, 10000 tenant_posts, 100000 tenant_comments — so the two benches
 * measure identical data (only the table format differs: the ORM bench adds a `benchmark_tenants` parent
 * + FK constraints its Prisma model requires, which the dialect-invariant cross-lang schema omits).
 */
export const ORM_SEED: SeedShape = {
  users: 1000,
  nestedUsers: 100,
  nestedPostsPerUser: 10,
  commentsPerPost: 10,
  shallowPostsPerUser: 5,
  tenants: 10,
  usersPerTenant: 100,
  postsPerTenantUser: 10,
  commentsPerTenantPost: 10,
};

/**
 * The SAME fixture with every per-parent FAN-OUT multiplied by `factor` (each floored at 1). The parent
 * counts — `users`, `nestedUsers`, `tenants`, `usersPerTenant` — are deliberately NOT scaled: every op
 * reads a LIMIT-100 parent window, so holding the parents fixed while the children scale makes the rows
 * an op touches the ONLY thing that moves. Latency regressed on rows then separates the fixed per-call
 * overhead (the intercept) from the per-row cost (the slope).
 */
export function scaleSeed(shape: SeedShape, factor: number): SeedShape {
  const f = (n: number): number => Math.max(1, Math.round(n * factor));
  return {
    ...shape,
    nestedPostsPerUser: f(shape.nestedPostsPerUser),
    commentsPerPost: f(shape.commentsPerPost),
    shallowPostsPerUser: f(shape.shallowPostsPerUser),
    postsPerTenantUser: f(shape.postsPerTenantUser),
    commentsPerTenantPost: f(shape.commentsPerTenantPost),
  };
}

// Child→parent order — a table is dropped/emptied BEFORE the table it references (FK-safe). `tenant_users`
// references `benchmark_tenants`, so `benchmark_tenants` comes after it.
const DROP_ORDER = [
  'benchmark_tenant_comments',
  'benchmark_tenant_posts',
  'benchmark_tenant_users',
  'benchmark_tenants',
  'benchmark_comments',
  'benchmark_posts',
  'benchmark_users',
] as const;

export function dropStatements(dialect: OrmDialect): string[] {
  const cascade = dialect === 'postgres' ? ' CASCADE' : '';
  return DROP_ORDER.map((t) => `DROP TABLE IF EXISTS ${t}${cascade}`);
}

// Empty every table in child→parent order (the same order as DROP) so a per-op re-seed starts from a
// clean fixture WITHOUT dropping/recreating the schema. Derived from the SAME DROP_ORDER SSoT.
export function deleteStatements(_dialect: OrmDialect): string[] {
  return DROP_ORDER.map((t) => `DELETE FROM ${t}`);
}

// Refresh optimizer statistics AFTER the seed. The indexes (BENCH_INDEXES) are created on
// EMPTY tables and then bulk-loaded, so InnoDB's persistent index statistics stay at their empty-table
// state — and a read never triggers a recalc, so they never self-correct across the bench's warmup or
// timed iterations. With stale stats MySQL estimates the composite child table at ~1 row, picks the PK's
// leading column over the relation index, and residual-filters: compositeRelations' comments child read
// measured 2.3s. `ANALYZE TABLE` after the load takes the SAME query to 6ms — proven confound-free (the
// query stayed at 2.24/2.24/2.29s across three repeats with no ANALYZE, then dropped to 6ms right after).
// This is the standard post-bulk-load step (mysqldump / pg_restore both recommend it); the bench just
// never did it. Runs in the untimed seed, so it does not enter any measurement.
//
// PostgreSQL and SQLite were already fast here, but a freshly bulk-loaded table has no current stats on
// either, so analyzing keeps all three dialects on the realistic footing a real deployment has.
export function analyzeStatements(dialect: OrmDialect): string[] {
  if (dialect === 'mysql') return [`ANALYZE TABLE ${DROP_ORDER.join(', ')}`];
  // PostgreSQL and SQLite both spell it `ANALYZE <table>`, one table per statement.
  return DROP_ORDER.map((t) => `ANALYZE ${t}`);
}

// The indexes every relation's batched child read needs — one per relation FK, the column the child
// SELECT filters on. WITHOUT these the child batch scans the whole table (the PK does not cover the FK):
// on MySQL the 50,000-row composite comments table made compositeRelations take 2.3s per iteration, and
// an index took the same query to 6.6ms. A real deployment indexes these; a bench that does not is
// measuring a full scan, not a relation. `CREATE INDEX … ON … (…)` is byte-identical across sqlite /
// mysql / postgres, so this is ONE list, spread into each dialect's DDL — not restated three times.
const BENCH_INDEXES: readonly string[] = [
  `CREATE INDEX ix_posts_author ON benchmark_posts (author_id)`, // User.posts (relation FK)
  `CREATE INDEX ix_comments_post ON benchmark_comments (post_id)`, // Post.comments (relation FK)
  `CREATE INDEX ix_tposts_tenant_user ON benchmark_tenant_posts (tenant_id, user_id)`, // TenantUser.posts (relation FK)
  `CREATE INDEX ix_tcomments_tenant_post ON benchmark_tenant_comments (tenant_id, post_id)`, // TenantPost.comments (relation FK)
  `CREATE INDEX ix_posts_published ON benchmark_posts (published)`, // filterPaginateSort predicate — matches the ORM bench's idx_posts_published
];

export function ddl(dialect: OrmDialect): string[] {
  if (dialect === 'sqlite') {
    return [
      // SQLite does NOT enforce foreign keys unless the connection opts in — and it is a per-connection
      // setting, off by default. Every cell applies this schema on the SAME connection it runs the ops
      // on (:memory:), so enabling it here, as the first statement, makes the FK constraints below
      // actually enforced — matching PostgreSQL/MySQL (which enforce by default). Without it the FK
      // clauses would be declared-but-inert, and a write op would skip the referential check the other
      // two dialects pay. It runs after the child-first DROPs (no FK check needed there).
      `PRAGMA foreign_keys = ON`,
      `CREATE TABLE benchmark_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE benchmark_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT,
        published INTEGER DEFAULT 0,
        author_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (author_id) REFERENCES benchmark_users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE benchmark_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        body TEXT NOT NULL,
        post_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (post_id) REFERENCES benchmark_posts(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE benchmark_tenants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL
      )`,
      `CREATE TABLE benchmark_tenant_users (
        tenant_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        name TEXT,
        PRIMARY KEY (tenant_id, user_id),
        FOREIGN KEY (tenant_id) REFERENCES benchmark_tenants(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE benchmark_tenant_posts (
        tenant_id INTEGER NOT NULL,
        post_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        PRIMARY KEY (tenant_id, post_id),
        FOREIGN KEY (tenant_id, user_id) REFERENCES benchmark_tenant_users(tenant_id, user_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE benchmark_tenant_comments (
        tenant_id INTEGER NOT NULL,
        comment_id INTEGER NOT NULL,
        post_id INTEGER NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (tenant_id, comment_id),
        FOREIGN KEY (tenant_id, post_id) REFERENCES benchmark_tenant_posts(tenant_id, post_id) ON DELETE CASCADE
      )`,
      ...BENCH_INDEXES,
    ];
  }
  if (dialect === 'mysql') {
    return [
      `CREATE TABLE benchmark_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE benchmark_posts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT,
        published TINYINT(1) DEFAULT 0,
        author_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (author_id) REFERENCES benchmark_users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE benchmark_comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        body TEXT NOT NULL,
        post_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (post_id) REFERENCES benchmark_posts(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE benchmark_tenants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL
      )`,
      `CREATE TABLE benchmark_tenant_users (
        tenant_id INT NOT NULL,
        user_id INT NOT NULL,
        name VARCHAR(255),
        PRIMARY KEY (tenant_id, user_id),
        FOREIGN KEY (tenant_id) REFERENCES benchmark_tenants(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE benchmark_tenant_posts (
        tenant_id INT NOT NULL,
        post_id INT NOT NULL,
        user_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        PRIMARY KEY (tenant_id, post_id),
        FOREIGN KEY (tenant_id, user_id) REFERENCES benchmark_tenant_users(tenant_id, user_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE benchmark_tenant_comments (
        tenant_id INT NOT NULL,
        comment_id INT NOT NULL,
        post_id INT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (tenant_id, comment_id),
        FOREIGN KEY (tenant_id, post_id) REFERENCES benchmark_tenant_posts(tenant_id, post_id) ON DELETE CASCADE
      )`,
      ...BENCH_INDEXES,
    ];
  }
  // postgres
  return [
    `CREATE TABLE benchmark_users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`,
    `CREATE TABLE benchmark_posts (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      content TEXT,
      -- SMALLINT, not BOOLEAN: a BOOLEAN column does not decode dialect-invariantly through the
      -- leaf (PostgreSQL hands over a JS boolean while MySQL's TINYINT(1) and SQLite's INTEGER hand
      -- over 1/0), so the three legs could not share one declared row type. Same resolution as the
      -- conformance corpus's conf_typed.flag column.
      published SMALLINT DEFAULT 0,
      author_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (author_id) REFERENCES benchmark_users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE benchmark_comments (
      id SERIAL PRIMARY KEY,
      body TEXT NOT NULL,
      post_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (post_id) REFERENCES benchmark_posts(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE benchmark_tenants (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL
    )`,
    `CREATE TABLE benchmark_tenant_users (
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      name VARCHAR(255),
      PRIMARY KEY (tenant_id, user_id),
      FOREIGN KEY (tenant_id) REFERENCES benchmark_tenants(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE benchmark_tenant_posts (
      tenant_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      title VARCHAR(255) NOT NULL,
      PRIMARY KEY (tenant_id, post_id),
      FOREIGN KEY (tenant_id, user_id) REFERENCES benchmark_tenant_users(tenant_id, user_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE benchmark_tenant_comments (
      tenant_id INTEGER NOT NULL,
      comment_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (tenant_id, comment_id),
      FOREIGN KEY (tenant_id, post_id) REFERENCES benchmark_tenant_posts(tenant_id, post_id) ON DELETE CASCADE
    )`,
    ...BENCH_INDEXES,
  ];
}

/**
 * One table's seed rows. Row-oriented rather than statement-oriented because the fixture is now large
 * enough (tens of thousands of rows, re-applied per op) that it MUST go in as multi-row INSERTs — the
 * emitter batches these rows into `VALUES (…),(…),…` exactly as `benchmark/setup.ts` does. Deterministic
 * and identical across dialects (`published` is SMALLINT everywhere, so booleans go in as 1/0).
 */
export interface SeedTable {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

/**
 * A DETERMINISTIC, distinct, monotonic-with-`seq` `created_at` string. `filterPaginateSort` does
 * `ORDER BY created_at DESC` + projects `created_at`, so the seed MUST pin it (the old
 * `DEFAULT NOW()`/`datetime('now')` made every row ~equal → the sort was an all-ties tie-break, stable
 * only within one shared db, and the format differed by dialect). Base `2020-01-01 00:00:00` + `seq`
 * seconds, formatted `YYYY-MM-DD HH:MM:SS` — a literal every dialect stores + reads back identically
 * (sqlite TEXT / pg + mysql TIMESTAMP; the read path canonicalizes the TIMESTAMP back to this string).
 */
export function seedCreatedAt(seq: number): string {
  const d = new Date(Date.UTC(2020, 0, 1, 0, 0, 0) + seq * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * The whole fixture, one entry per table in parent→child order (the order it must be INSERTed in).
 *
 * The graph mirrors `benchmark/setup.ts`: users `1..nestedUsers` carry `nestedPostsPerUser` posts each,
 * every one of those posts carries `commentsPerPost` comments, and the remaining users carry
 * `shallowPostsPerUser` commentless posts (table bulk). Ids are explicit and deterministic so the ops'
 * fixed inputs (`id = 1`, `user500@example.com`, ids 1..10 for `updateMany`) always resolve.
 */
export function seedTables(shape: SeedShape = ORM_SEED): SeedTable[] {
  // `published` is SMALLINT on every dialect (see `ddl`), so the seed writes 1/0 everywhere — a JS
  // boolean would only fit a PostgreSQL BOOLEAN column, which is the divergence that DDL removed.
  const bool = (b: boolean) => (b ? 1 : 0);

  const users: unknown[][] = [];
  for (let id = 1; id <= shape.users; id++) {
    users.push([id, `user${id}@example.com`, `User ${id}`]);
  }

  // The deep-graph posts come FIRST (ids 1..nestedUsers*nestedPostsPerUser) so the comment ids that
  // hang off them are a contiguous prefix too — `nestedRelations` reads users 1..100 by LIMIT, and its
  // posts/comments levels are then exactly the seeded deep graph.
  const posts: unknown[][] = [];
  let postId = 1;
  const deepPostIds: number[] = [];
  for (let uid = 1; uid <= shape.nestedUsers; uid++) {
    for (let p = 0; p < shape.nestedPostsPerUser; p++) {
      posts.push([postId, `Post ${postId}`, `Content ${postId}`, bool(postId % 3 === 0), uid, seedCreatedAt(postId)]);
      deepPostIds.push(postId);
      postId++;
    }
  }
  for (let uid = shape.nestedUsers + 1; uid <= shape.users; uid++) {
    for (let p = 0; p < shape.shallowPostsPerUser; p++) {
      posts.push([postId, `Post ${postId}`, `Content ${postId}`, bool(postId % 3 === 0), uid, seedCreatedAt(postId)]);
      postId++;
    }
  }

  const comments: unknown[][] = [];
  let commentId = 1;
  for (const pid of deepPostIds) {
    for (let c = 0; c < shape.commentsPerPost; c++) {
      comments.push([commentId, `Comment ${commentId} for post ${pid}`, pid]);
      commentId++;
    }
  }

  // The composite-key graph. `post_id` / `comment_id` RESTART per tenant, so a query that forgets the
  // tenant key matches rows from every tenant — the property `compositeRelations` exists to exercise.
  const tenants: unknown[][] = []; // the FK parent of tenant_users (matches the ORM bench's benchmark_tenants)
  for (let t = 1; t <= shape.tenants; t++) tenants.push([t, `Tenant ${t}`]);
  const tenantUsers: unknown[][] = [];
  const tenantPosts: unknown[][] = [];
  const tenantComments: unknown[][] = [];
  for (let t = 1; t <= shape.tenants; t++) {
    for (let u = 1; u <= shape.usersPerTenant; u++) {
      tenantUsers.push([t, u, `Tenant${t} User${u}`]);
    }
    let localPostId = 1;
    for (let u = 1; u <= shape.usersPerTenant; u++) {
      for (let p = 0; p < shape.postsPerTenantUser; p++) {
        tenantPosts.push([t, localPostId, u, `T${t}Post ${localPostId}`]);
        localPostId++;
      }
    }
    let localCommentId = 1;
    for (let lp = 1; lp < localPostId; lp++) {
      for (let c = 0; c < shape.commentsPerTenantPost; c++) {
        tenantComments.push([t, localCommentId, lp, `T${t}Comment ${localCommentId}`]);
        localCommentId++;
      }
    }
  }

  return [
    { table: 'benchmark_users', columns: ['id', 'email', 'name'], rows: users },
    { table: 'benchmark_posts', columns: ['id', 'title', 'content', 'published', 'author_id', 'created_at'], rows: posts },
    { table: 'benchmark_comments', columns: ['id', 'body', 'post_id'], rows: comments },
    { table: 'benchmark_tenants', columns: ['id', 'name'], rows: tenants },
    { table: 'benchmark_tenant_users', columns: ['tenant_id', 'user_id', 'name'], rows: tenantUsers },
    { table: 'benchmark_tenant_posts', columns: ['tenant_id', 'post_id', 'user_id', 'title'], rows: tenantPosts },
    { table: 'benchmark_tenant_comments', columns: ['tenant_id', 'comment_id', 'post_id', 'body'], rows: tenantComments },
  ];
}

// After the explicit-id seed, advance the PG SERIAL sequences past MAX(id) so the first Create
// (INSERT without id) does not collide. sqlite AUTOINCREMENT + mysql AUTO_INCREMENT derive next
// id from MAX(id) automatically (no fixup).
export function pgSeqResetStatements(): string[] {
  return [
    `SELECT setval(pg_get_serial_sequence('benchmark_users', 'id'), (SELECT MAX(id) FROM benchmark_users))`,
    `SELECT setval(pg_get_serial_sequence('benchmark_posts', 'id'), (SELECT MAX(id) FROM benchmark_posts))`,
    `SELECT setval(pg_get_serial_sequence('benchmark_comments', 'id'), (SELECT MAX(id) FROM benchmark_comments))`,
  ];
}
