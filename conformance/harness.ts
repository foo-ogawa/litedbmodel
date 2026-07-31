/**
 * litedbmodel v2 SCP — the conformance harness (WS7a, #30; emitter cutover #154).
 *
 * The SINGLE source of the conformance vector corpus and the TS reference runner. Every vector is
 * captured from, and replayed through, the ONE settled pipeline (CLAUDE.md §1):
 *
 * ```
 * decorated models + DECLARED endpoints (no SQL — the fixtures below)
 *   → emitBehaviorModule                       the library's lowering (src/scp/emit)
 *   → tsc --strict over the emitted source     bc's authoring requirement
 *   → bc generate --lang typescript-native     the real CLI; no litedbmodel code in the path
 *   → bindTyped(leafHandlers(ctx))             the ONLY hand-wiring: calling the generated method
 *   → SQLite / live PostgreSQL / live MySQL
 * ```
 *
 * There is no second generator and no programmatic compile: the corpus is a contract on the
 * ARTIFACT the other language runtimes run, not on a TS-only build.
 *
 * ## What a vector is
 *
 *   - `exec`         — the endpoint executed end-to-end against a real database for its dialect.
 *                      ONE execution pins BOTH axes: the ORDERED `{sql, params}` the transport
 *                      handed the driver (the render golden — in the driver-bound form, with the
 *                      SKIP fragments already assembled, `?`→`$N` already rendered and the array
 *                      params already encoded), and the FULL materialized result (nested relation
 *                      children included) plus, for a write, the resulting DB state. A render
 *                      golden is therefore always a statement a real database answered.
 *   - `expect-error` — a read whose baked `findHardLimit` cap is exceeded: the read boundary throws
 *                      {@link LimitExceededError} with the exact fields.
 *   - `dialect`      — the `orderByNulls` dialect primitive.
 *
 * ## Dialect invariance (§10) is enforced at CAPTURE
 *
 * A read case is generated for all three dialects from the SAME declaration + input, and
 * {@link generateCorpus} FAILS LOUDLY if the three results are not identical; a write case is
 * cross-checked on its `changes` count and its resulting DB state. So "同一宣言+入力 → 同一結果"
 * is not a claim in a comment, it is a generation-time invariant, re-assertable from the frozen
 * corpus (see `test/scp/conformance-vectors.test.ts`).
 *
 * ## Content, never counts (#150)
 *
 * A relation-bearing vector carries a `relationFields` contract, and {@link checkRelationContent}
 * asserts every nested child's EXACT field set plus that each declared field is actually populated
 * in at least one child. The #150 defect (relation children returned as empty structs) passed every
 * row-count check; it cannot pass this one.
 */

import 'reflect-metadata';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool as PgPool, types as pgTypes } from 'pg';
import mysql from 'mysql2/promise';
import type { Column } from '../src/Column';
import { belongsTo, column, hasMany, model } from '../src/decorators';
import {
  assertFindHardLimit,
  configurePgDeboxTypeParsers,
  connectionForDriver,
  contextForConnection,
  dialectFor,
  emitBehaviorModule,
  executeAsync,
  executeSafe,
  leafHandlers,
  leafHandlersAsync,
  LimitExceededError,
  mysqlConnectionPool,
  mysqlDeboxPoolOptions,
  pgConnectionPool,
  PooledAsyncContext,
  resetLimitConfig,
  runAsync,
  setLimitConfig,
  type AsyncConnection,
  type AsyncConnectionPool,
  type DeriveColumnsOptions,
  type DialectName,
  type EmittedEndpoint,
  type EmitSpec,
  type EndpointSet,
  type ModelClassLike,
  type SyncConnection,
} from '../src/scp/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ── Corpus versioning (SSoT — bumped on any refreeze, PROTOCOL-style) ─────────

/**
 * The conformance corpus schema version. A consumer runner fail-closes on a mismatch. Bumped to 5
 * for the emitter cutover (#154): a vector names a DECLARED ENDPOINT and carries the statements /
 * results the GENERATED module produced; the recorder-era `readGraph` / read-`bundle` artifacts and
 * the separate `write-render` kind are gone (a write is an emitted endpoint like any other).
 */
export const CORPUS_VERSION = 5 as const;

const ALL_DIALECTS: readonly DialectName[] = ['sqlite', 'postgres', 'mysql'] as const;

// ── Canonical JSON value encoding (bigint-safe) ───────────────────────────────

/** A JSON-safe encoding of a runtime value (bigint → tagged decimal string). */
export type EncodedValue =
  | null
  | boolean
  | number
  | string
  | { $bigint: string }
  | EncodedValue[]
  | { [k: string]: EncodedValue };

/** Encode a runtime value (possibly containing bigint) to pure JSON. */
export function encodeValue(v: unknown): EncodedValue {
  if (typeof v === 'bigint') return { $bigint: v.toString() };
  if (v === null || typeof v !== 'object') return v as EncodedValue;
  if (Array.isArray(v)) return v.map(encodeValue);
  const out: Record<string, EncodedValue> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = encodeValue(val);
  return out;
}

/** Decode a canonical value back to a runtime value (bigint tag → bigint). */
function decodeValue(v: EncodedValue): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decodeValue);
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === '$bigint') return BigInt((v as { $bigint: string }).$bigint);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = decodeValue(val as EncodedValue);
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// FIXTURES — the ORM user's whole input: decorated models + declared endpoints.
// There is no SQL here and no SCP here.
// ══════════════════════════════════════════════════════════════════════════════

// `@model` installs one static {@link Column} token per `@column` at runtime (decorators.ts:1123).
// The `declare static` lines below are the TYPE-ONLY view of the tokens a relation key pair names
// (`() => [ConfUser.id, ConfPost.author_id]`), so the fixtures type-check with no untyped escape.
// Only the key columns are declared: a token named `name` would shadow the class's own `Function.name`,
// which `ModelClassLike` reads.

@model('conf_users')
class ConfUser {
  declare static id: Column<number, ConfUser>;

  @column() id?: number;
  @column() name?: string;
  @column() post_count?: number;

  @hasMany(() => [ConfUser.id, ConfPost.author_id], { order: () => ConfPost.id.asc() })
  declare posts: Promise<ConfPost[]>;

  // The three relation hard-limit shapes, declared on the SAME key pair so a guard vector differs from
  // the plain `posts` in NOTHING but its cap (v1 `@hasMany({hardLimit})` precedence, `decorators.ts`):
  //   - a per-relation override wins over the global `hasManyHardLimit`;
  //   - `hardLimit: null` DISABLES the check for this relation even when the global is set;
  //   - an intrinsic per-parent `limit` window SKIPS the batch-total check (its fanout is bounded).

  @hasMany(() => [ConfUser.id, ConfPost.author_id], { order: () => ConfPost.id.asc(), hardLimit: 2 })
  declare cappedPosts: Promise<ConfPost[]>;

  @hasMany(() => [ConfUser.id, ConfPost.author_id], { order: () => ConfPost.id.asc(), hardLimit: null })
  declare uncappedPosts: Promise<ConfPost[]>;

  @hasMany(() => [ConfUser.id, ConfPost.author_id], { order: () => ConfPost.id.asc(), limit: 1 })
  declare topPosts: Promise<ConfPost[]>;
}

@model('conf_posts')
class ConfPost {
  declare static id: Column<number, ConfPost>;
  declare static author_id: Column<number, ConfPost>;

  // The schema is `id INT PRIMARY KEY` — CLIENT-supplied, no AUTO_INCREMENT. Declaring it is what
  // lets a `… RETURNING` write recover its rows by the value it bound (#130).
  @column({ primaryKey: true }) id?: number;
  @column() author_id?: number;
  @column() title?: string;
  @column() status?: string;
  @column() created_at?: string;

  @hasMany(() => [ConfPost.id, ConfTag.post_id], { order: () => ConfTag.id.asc() })
  declare tags: Promise<ConfTag[]>;

  @belongsTo(() => [ConfPost.author_id, ConfUser.id])
  declare author: Promise<ConfUser | null>;
}

@model('conf_tags')
class ConfTag {
  declare static id: Column<number, ConfTag>;
  declare static post_id: Column<number, ConfTag>;

  // `id INT PRIMARY KEY` — CLIENT-supplied, as `conf_posts` (#130).
  @column({ primaryKey: true }) id?: number;
  @column() post_id?: number;
  @column() label?: string;
}

/**
 * The READ-DECODE fixture (#137). Every other model projects only INTEGER / TEXT columns, so the
 * date and boolean arms of the read decode — the ones each runtime resolves through its DRIVER, not
 * through the SQL — were never executed by a vector. This model exists to PROJECT them:
 *
 *   - `ts`   TIMESTAMP → the canonical `'YYYY-MM-DD HH:MM:SS'` STRING (spec §4.1: bc has no date
 *            scalar, so a date round-trips as text). Reaching that requires the driver knobs the
 *            library owns — `configurePgDeboxTypeParsers` (pg hands over a JS Date otherwise) and
 *            `mysqlDeboxPoolOptions.dateStrings` — which is exactly what this vector guards.
 *   - `flag` a boolean-valued column, decoded as an Int (#137's canonical: `bool→Int`). Its SQL type
 *            is SMALLINT rather than BOOLEAN because the schema below is ONE portable DDL and a
 *            BOOLEAN column does NOT decode dialect-invariantly through the leaf: PostgreSQL hands
 *            over a JS boolean while MySQL (TINYINT(1)) and SQLite hand over 1/0, and only the pg
 *            side matches a bc `bool` outType (`node 'n0': result[0].flag: expected bool, got float`
 *            on the other two). The leaf read path takes the driver's value as-is — `materializeCell`
 *            sits on the imperative path — so there is no dialect-invariant BOOLEAN projection to
 *            capture today.
 */
@model('conf_typed')
class ConfTyped {
  declare static id: Column<number, ConfTyped>;

  @column() id?: number;
  @column() ts?: string;
  @column() flag?: number;
  @column() label?: string;
}

/**
 * The STRING-PK write fixture. `conf_posts` already covers a client-supplied INT key, but a key whose
 * bound value is a STRING (a UUID) is a different arm of the same recovery: MySQL re-selects the
 * written row by the value the INSERT itself bound, so the predicate has to carry a string, and the
 * declared column type is what makes it one. `VARCHAR(36)` rather than `TEXT`/`UUID` because the DDL
 * below is ONE portable schema and MySQL rejects a `TEXT` primary key without a key length.
 */
@model('conf_docs')
class ConfDoc {
  declare static doc_id: Column<string, ConfDoc>;

  @column({ primaryKey: true }) doc_id?: string;
  @column() title?: string;
}

/**
 * The COMPOSITE-PK write fixture — the only model here whose key is two columns. A single-column key
 * cannot tell whether the recovery predicate carries the WHOLE key: the seed below shares `order_id`
 * across two lines on purpose, so a recovery keyed on `order_id` alone describes the wrong row set.
 */
@model('conf_lines')
class ConfLine {
  declare static order_id: Column<number, ConfLine>;
  declare static line_no: Column<number, ConfLine>;

  @column({ primaryKey: true }) order_id?: number;
  @column({ primaryKey: true }) line_no?: number;
  @column() sku?: string;
}

const MODEL_REGISTRY: Record<string, unknown> = { ConfUser, ConfPost, ConfTag, ConfTyped, ConfDoc, ConfLine };

/** Model NAME → class, as `relationDeclOf` resolves a relation's target model. */
const conformanceModels = (name: string): ModelClassLike => MODEL_REGISTRY[name] as ModelClassLike;

/**
 * The TEXT columns, pinned. vitest (esbuild) has no `emitDecoratorMetadata`, so a bare `@column()`
 * carries no `design:type` and takes the documented `DEFAULT_UNCAST_SQL_TYPE` (INTEGER); the text
 * columns go through the adapter's documented `columnTypes` escape hatch.
 */
const COLUMN_OPTIONS: DeriveColumnsOptions = {
  // `ts`/`flag` (#137) are pinned for the same reason: the read-decode class is the COLUMN's SQL
  // type, so TIMESTAMP → the canonical date string and SMALLINT → Int come from here, not a guess.
  // `doc_id` is the STRING primary key of `conf_docs` and `sku` a plain text column of `conf_lines`.
  columnTypes: { name: 'TEXT', title: 'TEXT', status: 'TEXT', created_at: 'TEXT', label: 'TEXT', ts: 'TIMESTAMP', flag: 'SMALLINT', doc_id: 'VARCHAR', sku: 'TEXT' },
};

/** The emitted `@behavior` class name (the `bc generate --behavior` argument). */
const BEHAVIOR = 'Conformance';

/**
 * The DECLARED endpoints. Read / SKIP / IN-list / two relation levels / belongsTo / single writes /
 * batch writes — declared without one character of SQL, and expressible on ALL THREE dialects (no
 * RETURNING write, which MySQL loud-rejects; no composite-key relation, which PostgreSQL
 * loud-rejects — both rejections are pinned by `test/scp/emitter.test.ts`).
 */
const ENDPOINTS: EndpointSet = {
  /** A plain author page — the find hard-limit guard TARGET (it declares no limit of its own). */
  posts: {
    kind: 'read',
    model: ConfPost,
    where: [{ column: 'author_id', op: 'eq', param: 'authorId' }],
    order: 'id ASC',
  },
  /** The SAME page with an EXPLICIT limit — an authored LIMIT governs, so no cap is baked. */
  postsTop: { kind: 'read', model: ConfPost, order: 'id ASC', limit: 2 },
  /**
   * #161 — PAGING: the page POSITION is an INPUT, so the counts BIND (`LIMIT ? OFFSET ?`) instead of
   * inlining. One statement serves every window, and the placeholders render per dialect (PG `$N`).
   */
  page: {
    kind: 'read',
    model: ConfPost,
    select: ['id', 'title'],
    order: 'id ASC',
    limit: { param: 'limit' },
    offset: { param: 'offset' },
  },
  /** #46 — a whole key set bound as ONE param (PG `= ANY(?)`, MySQL/SQLite single-JSON). */
  postsByIds: {
    kind: 'read',
    model: ConfPost,
    select: ['id', 'title'],
    where: [{ kind: 'in', column: 'id', param: 'ids' }],
    order: 'id ASC',
  },
  /** SKIP — `authorId` is fixed; `status` and `since` are present-or-absent PER CALL. */
  feed: {
    kind: 'read',
    model: ConfPost,
    select: ['id', 'author_id', 'title', 'status'],
    where: [
      { column: 'author_id', op: 'eq', param: 'authorId' },
      { column: 'status', op: 'eq', param: 'status', optional: true },
      { column: 'created_at', op: 'ge', param: 'since', optional: true },
    ],
    order: 'id ASC',
  },
  /**
   * SKIP **×** a BOUND page — the combination that puts base params on BOTH sides of the dynamic
   * clause (#200). The bounded `author_id` binds before it and the page counts bind after it, so the
   * leaf must splice the surviving fragments' params into the MIDDLE of the base params
   * (`assembleDynamicWhere`), not at either end. `minId` is an INT cursor on purpose: it is
   * type-compatible with the three base params, so a mis-placed slot produces a different ROW SET
   * rather than a bind error — the only shape that catches this on every dialect (PostgreSQL renders
   * `?`→`$N` AFTER assembly, so a swapped binding still LOOKS like correct SQL).
   */
  pagedFeed: {
    kind: 'read',
    model: ConfPost,
    select: ['id', 'author_id', 'title', 'status'],
    where: [
      { column: 'author_id', op: 'eq', param: 'authorId' },
      { column: 'id', op: 'ge', param: 'minId', optional: true },
      { column: 'status', op: 'eq', param: 'status', optional: true },
    ],
    order: 'id ASC',
    limit: { param: 'limit' },
    offset: { param: 'offset' },
  },
  /**
   * SKIP with NO bounded predicate — the statement's HEAD ends with no WHERE at all, so the first
   * surviving fragment must OPEN one (`lead: 'WHERE'`) instead of continuing one. The three arms (all
   * skipped / one surviving / both surviving) are the whole `lead` contract on this side; `feed` and
   * `pagedFeed` above are the other side (a head that ends IN a WHERE ⇒ `lead: 'AND'`).
   */
  optionalOnlyFeed: {
    kind: 'read',
    model: ConfPost,
    select: ['id', 'author_id', 'status'],
    where: [
      { column: 'author_id', op: 'eq', param: 'authorId', optional: true },
      { column: 'status', op: 'eq', param: 'status', optional: true },
    ],
    order: 'id ASC',
  },
  /**
   * #202 — a QUOTED `?` in the ORDER BY. `order` is a free string on the PUBLIC `ReadEndpoint` type and
   * reaches the statement's tail verbatim, so a `?` inside a string literal is TEXT that binds nothing.
   * The tail here holds that quoted `?` AND a real bound `LIMIT ?`, with base params on BOTH sides of
   * the dynamic clause — every value is an INT, so a mis-bound slot returns a DIFFERENT ROW SET rather
   * than a type error (PostgreSQL renumbers `?`→`$N` after assembly, so the text looks right either way).
   */
  quotedOrderFeed: {
    kind: 'read',
    model: ConfPost,
    select: ['id', 'author_id', 'status', 'title'],
    where: [
      { column: 'author_id', op: 'eq', param: 'authorId' },
      { column: 'id', op: 'ge', param: 'minId', optional: true },
    ],
    order: "CASE WHEN status = '?' THEN 0 ELSE 1 END, id ASC",
    limit: { param: 'limit' },
  },
  /**
   * #202 — a QUOTED ` WHERE ` in the ORDER BY, on a read whose head carries NO WHERE: the clause still
   * has to OPEN one. The tail is text the transport appends, never text it interprets.
   */
  quotedWhereOrderFeed: {
    kind: 'read',
    model: ConfPost,
    select: ['id', 'status', 'title'],
    where: [{ column: 'status', op: 'eq', param: 'status', optional: true }],
    order: "CASE WHEN title = ' WHERE ' THEN 0 ELSE 1 END, id ASC",
  },
  /**
   * #198 — SKIP × a QUERY view (#98). The CTE is a statement of its OWN: it carries its own tail
   * (` ORDER BY … LIMIT 2`), its own WHERE and a QUOTED ` WHERE `. All of it is part of the HEAD, whose
   * end is the OUTER statement's WHERE region — so the clause lands after `FROM derived` and OPENS a
   * WHERE. The CTE's `LIMIT 2` is what makes the placement OBSERVABLE: filtering inside the CTE picks
   * the first 2 MATCHING rows, filtering outside it picks the matching rows among the first 2.
   */
  viewFeed: {
    kind: 'read',
    model: ConfPost,
    select: ['id', 'author_id', 'status', 'title'],
    view: {
      query:
        "SELECT id, author_id, title, status, created_at FROM conf_posts WHERE title <> ' WHERE ' ORDER BY id ASC LIMIT 2",
    },
    where: [{ column: 'status', op: 'eq', param: 'status', optional: true }],
    order: 'id ASC',
  },
  /** Two relation levels off ONE parent read: users → posts → tags (3 queries, N+1-free). */
  usersWithPosts: {
    kind: 'read',
    model: ConfUser,
    select: ['id', 'name'],
    order: 'id ASC',
    with: [{ name: 'posts', with: ['tags'] }],
  },
  /** A belongsTo relation — the single-child nesting shape. */
  postsWithAuthor: { kind: 'read', model: ConfPost, order: 'id ASC', with: ['author'] },
  // The relation hard-limit guard TARGETS: the same user page over the three capped relation shapes.
  // The cap is resolved at EMIT (compileRelationOp) and baked onto the child fetch's `guard` port, so
  // which of these throws is decided entirely by the declaration + the config the vector carries.
  /** A per-relation `hardLimit: 2` override — throws whatever the global says. */
  usersWithCappedPosts: { kind: 'read', model: ConfUser, select: ['id', 'name'], order: 'id ASC', with: ['cappedPosts'] },
  /** A per-relation `hardLimit: null` — the check is DISABLED even under a global cap. */
  usersWithUncappedPosts: { kind: 'read', model: ConfUser, select: ['id', 'name'], order: 'id ASC', with: ['uncappedPosts'] },
  /** An intrinsic per-parent `limit` window — the batch-total check is SKIPPED (fanout bounded). */
  usersWithTopPosts: { kind: 'read', model: ConfUser, select: ['id', 'name'], order: 'id ASC', with: ['topPosts'] },
  createPost: {
    kind: 'create',
    model: ConfPost,
    values: [
      { column: 'id', param: 'id' },
      { column: 'author_id', param: 'authorId' },
      { column: 'title', param: 'title' },
      { column: 'status', param: 'status' },
      { column: 'created_at', param: 'createdAt' },
    ],
  },
  renamePost: {
    kind: 'update',
    model: ConfPost,
    set: [{ column: 'title', param: 'title' }],
    where: [{ column: 'id', op: 'eq', param: 'id' }],
  },
  removePost: { kind: 'delete', model: ConfPost, where: [{ column: 'id', op: 'eq', param: 'id' }] },
  /**
   * #130 — the WRITTEN-ROW guard. `renamePost` / `removePost` above declare no RETURNING, so the
   * corpus could not tell whether a write DESCRIBES its rows; MySQL, which parses no RETURNING,
   * used to answer `[]` for both. These twins declare one, so each runtime must recover the written
   * rows — the UPDATE by re-running its own WHERE after the write, the DELETE by that WHERE BEFORE
   * it — and the §10 cross-check makes the three dialects agree rather than each pinning its own
   * golden.
   */
  /**
   * The CLIENT-SUPPLIED PK arm: `conf_posts.id` is a plain `INT PRIMARY KEY`, not AUTO_INCREMENT, so
   * the written row can only be recovered by the PK VALUE the INSERT itself bound. MySQL used to
   * answer this with an id range off `LAST_INSERT_ID()` — which is 0 for such a write — and returned
   * no rows at all while the row was in the table.
   */
  createPostReturning: {
    kind: 'create',
    model: ConfPost,
    values: [
      { column: 'id', param: 'id' },
      { column: 'author_id', param: 'authorId' },
      { column: 'title', param: 'title' },
      { column: 'status', param: 'status' },
      { column: 'created_at', param: 'createdAt' },
    ],
    returning: ['id', 'title'],
  },
  renamePostReturning: {
    kind: 'update',
    model: ConfPost,
    set: [{ column: 'title', param: 'title' }],
    where: [{ column: 'id', op: 'eq', param: 'id' }],
    returning: ['id', 'title'],
  },
  removePostReturning: {
    kind: 'delete',
    model: ConfPost,
    where: [{ column: 'id', op: 'eq', param: 'id' }],
    returning: ['id', 'title'],
  },
  /**
   * #166 — the MULTI-ROW arm. A single-row RETURNING cannot tell whether the dialects agree on row
   * ORDER; these match two seed rows each. PostgreSQL returns them in its own write order and MySQL
   * re-selects them, so the two only line up because the recovery is ordered by the declared key.
   */
  restatusPostsReturning: {
    kind: 'update',
    model: ConfPost,
    set: [{ column: 'status', param: 'status' }],
    where: [{ column: 'author_id', op: 'eq', param: 'authorId' }],
    returning: ['id', 'status'],
  },
  removePostsByAuthorReturning: {
    kind: 'delete',
    model: ConfPost,
    where: [{ column: 'author_id', op: 'eq', param: 'authorId' }],
    returning: ['id', 'title'],
  },
  /**
   * #137 — the READ-DECODE guard: a TIMESTAMP and a boolean-valued column are PROJECTED (not merely
   * bound in a WHERE), so the date → canonical-string and bool → Int decode runs in every runtime,
   * on every dialect, and is asserted dialect-invariant at capture.
   */
  typedRows: { kind: 'read', model: ConfTyped, select: ['id', 'ts', 'flag', 'label'], order: 'id ASC' },
  createTags: { kind: 'createMany', model: ConfTag, columns: ['id', 'post_id', 'label'], param: 'rows' },
  removeTags: { kind: 'deleteMany', model: ConfTag, keyColumn: 'id', param: 'ids' },
  /**
   * #167 — the BATCH RETURNING arm, one per batch kind. A batch write is where MySQL's missing
   * RETURNING is hardest: `createMany` spans N consecutive ids, `updateMany` must re-bind the SAME
   * JSON payload to find its rows again, and `deleteMany` has to be described before it runs. The
   * derivation covered all three from the start; until now nothing could DECLARE them, so none was
   * gated. The non-RETURNING twins above stay byte-unchanged.
   */
  /**
   * The two remaining PRIMARY-KEY shapes a RETURNING create has to recover its row by. `conf_posts`
   * covers a client-supplied INT; these cover the ones whose recovery predicate differs in kind:
   *
   *   - `createDoc`  — a STRING key. The recovery binds the VARCHAR value the INSERT bound, so the
   *                    emitted pk hint must name `doc_id` with an EMPTY `ai=` (no AUTO_INCREMENT);
   *                    a hint that claims one sends MySQL to the `LAST_INSERT_ID()` range instead,
   *                    which for such a write is 0 and describes nothing.
   *   - `createLine` — a COMPOSITE key. `conf_lines` seeds two lines sharing `order_id`, so a
   *                    recovery keyed on the first column alone answers with BOTH rows and the §10
   *                    cross-check against PostgreSQL's native RETURNING fails.
   */
  createDoc: {
    kind: 'create',
    model: ConfDoc,
    values: [
      { column: 'doc_id', param: 'docId' },
      { column: 'title', param: 'title' },
    ],
    returning: ['doc_id', 'title'],
  },
  createLine: {
    kind: 'create',
    model: ConfLine,
    values: [
      { column: 'order_id', param: 'orderId' },
      { column: 'line_no', param: 'lineNo' },
      { column: 'sku', param: 'sku' },
    ],
    returning: ['order_id', 'line_no', 'sku'],
  },
  createTagsReturning: { kind: 'createMany', model: ConfTag, columns: ['id', 'post_id', 'label'], param: 'rows', returning: ['id', 'label'] },
  relabelTagsReturning: { kind: 'updateMany', model: ConfTag, keyColumns: ['id'], columns: ['label'], param: 'rows', returning: ['id', 'label'] },
  removeTagsReturning: { kind: 'deleteMany', model: ConfTag, keyColumn: 'id', param: 'ids', returning: ['id', 'label'] },
};

/**
 * The schema + seed, IDENTICAL for all three dialects (portable DDL). One schema is itself part of
 * the evidence that a divergent result is the dialect SQL diverging, never the fixture.
 */
export const SCHEMA: readonly string[] = [
  'DROP TABLE IF EXISTS conf_lines',
  'DROP TABLE IF EXISTS conf_docs',
  'DROP TABLE IF EXISTS conf_typed',
  'DROP TABLE IF EXISTS conf_tags',
  'DROP TABLE IF EXISTS conf_posts',
  'DROP TABLE IF EXISTS conf_users',
  'CREATE TABLE conf_users (id INT PRIMARY KEY, name TEXT, post_count INT NOT NULL DEFAULT 0)',
  'CREATE TABLE conf_posts (id INT PRIMARY KEY, author_id INT NOT NULL, title TEXT NOT NULL, status TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE conf_tags (id INT PRIMARY KEY, post_id INT NOT NULL, label TEXT)',
  "INSERT INTO conf_users (id, name, post_count) VALUES (1, 'Ada', 2)",
  "INSERT INTO conf_users (id, name, post_count) VALUES (2, 'Bob', 1)",
  "INSERT INTO conf_users (id, name, post_count) VALUES (3, 'Cy', 0)",
  "INSERT INTO conf_posts (id, author_id, title, status, created_at) VALUES (10, 1, 'a1', 'live', '2026-02-01')",
  "INSERT INTO conf_posts (id, author_id, title, status, created_at) VALUES (11, 1, 'a2', 'draft', '2026-03-01')",
  "INSERT INTO conf_posts (id, author_id, title, status, created_at) VALUES (12, 2, 'b1', 'live', '2026-01-15')",
  "INSERT INTO conf_tags (id, post_id, label) VALUES (100, 10, 'greeting')",
  "INSERT INTO conf_tags (id, post_id, label) VALUES (101, 10, 'first')",
  "INSERT INTO conf_tags (id, post_id, label) VALUES (102, 12, 'world')",
  // #137 — the read-decode row set. TIMESTAMP + SMALLINT are portable DDL on all three servers, and
  // `'YYYY-MM-DD HH:MM:SS'` is the literal form all three round-trip unchanged.
  'CREATE TABLE conf_typed (id INT PRIMARY KEY, ts TIMESTAMP NOT NULL, flag SMALLINT NOT NULL, label TEXT)',
  "INSERT INTO conf_typed (id, ts, flag, label) VALUES (1, '2026-01-01 00:00:00', 1, 'alpha')",
  "INSERT INTO conf_typed (id, ts, flag, label) VALUES (2, '2026-02-01 12:34:56', 0, 'beta')",
  "INSERT INTO conf_typed (id, ts, flag, label) VALUES (3, '2026-03-15 23:59:59', 1, 'gamma')",
  // The two RETURNING-create key shapes. `VARCHAR(36)` (not TEXT/UUID) is the portable spelling of a
  // string primary key: MySQL rejects a TEXT key without a length, PostgreSQL has no MySQL `CHAR(36)`
  // padding surprise on VARCHAR, and SQLite takes either.
  'CREATE TABLE conf_docs (doc_id VARCHAR(36) PRIMARY KEY, title TEXT NOT NULL)',
  "INSERT INTO conf_docs (doc_id, title) VALUES ('11111111-1111-1111-1111-111111111111', 'seeded doc')",
  // BOTH seeded lines share `order_id = 10`: that is what makes a recovery keyed on the first PK
  // column alone observable (it would answer with the seeded line too).
  'CREATE TABLE conf_lines (order_id INT NOT NULL, line_no INT NOT NULL, sku TEXT NOT NULL, PRIMARY KEY (order_id, line_no))',
  "INSERT INTO conf_lines (order_id, line_no, sku) VALUES (10, 1, 'SKU-1')",
];

// ══════════════════════════════════════════════════════════════════════════════
// THE PIPELINE — declarations → emitted source → bc generate → a bound module.
// ══════════════════════════════════════════════════════════════════════════════

/** Where the emitted + generated modules land (gitignored; inside the repo so imports resolve). */
const GEN_DIR = join(HERE, '.generated');

/**
 * The ONE lowering input of this corpus: the fixtures above, as the emitter's {@link EmitSpec} for
 * one dialect. {@link build} lowers with it for the TS leg, and `gen-livedb.ts` lowers with the SAME
 * spec to generate the python / php / go modules the other language runners execute — so every leg
 * runs the SAME declaration, never a re-declared copy.
 */
export function emitSpecFor(dialect: DialectName): EmitSpec {
  return {
    behavior: BEHAVIOR,
    dialect,
    // The emitted module imports the library's ONE leaf catalog; the specifier must resolve from
    // the emitted file's own location (bc type-checks the source it reads).
    leafImport: join(ROOT, 'src/scp/leaf-transport.js'),
    endpoints: ENDPOINTS,
    models: conformanceModels,
    columnOptions: COLUMN_OPTIONS,
  };
}

/** The typed facade a generated `typescript-native` module binds (methods keyed by endpoint name). */
type SyncFacade = Record<string, (input?: Record<string, unknown>) => unknown>;
type AsyncFacade = Record<string, (input?: Record<string, unknown>) => Promise<unknown>>;

interface GeneratedModule {
  bindTyped(handlers: ReturnType<typeof leafHandlers>): SyncFacade;
  bindTypedAsync(handlers: ReturnType<typeof leafHandlersAsync>): AsyncFacade;
}

/** One built artifact: the emitted source, the per-endpoint call contracts, the generated module. */
interface Built {
  readonly source: string;
  readonly contracts: readonly EmittedEndpoint[];
  readonly module: GeneratedModule;
}

/**
 * The hard-limit config a vector re-applies before EMITTING. BOTH caps bake at emit time — the find cap
 * into the read's `LIMIT cap + 1` ({@link import('../src/scp/limit-config').resolveFindHardLimit}) and
 * the relation cap into the child fetch's `guard` port
 * ({@link import('../src/scp/limit-config').resolveHasManyHardLimit}, resolved by `compileRelationOp`)
 * — so the vector CARRIES them and a runner reproduces the artifact by re-emitting under them.
 */
export interface LimitConfigSpec {
  readonly findHardLimit?: number | null;
  readonly hasManyHardLimit?: number | null;
}

/** The cache key: only what actually changes the EMITTED artifact (the two baked caps). */
function builtKey(dialect: DialectName, config?: LimitConfigSpec): string {
  return `${dialect}:${String(config?.findHardLimit ?? null)}:${String(config?.hasManyHardLimit ?? null)}`;
}

const builtCache = new Map<string, Promise<Built>>();
let genDirPrepared = false;

/** Build (or reuse) the generated module for one dialect under one limit config. */
function built(dialect: DialectName, config?: LimitConfigSpec): Promise<Built> {
  const key = builtKey(dialect, config);
  let p = builtCache.get(key);
  if (p === undefined) {
    p = build(dialect, config);
    builtCache.set(key, p);
  }
  return p;
}

async function build(dialect: DialectName, config?: LimitConfigSpec): Promise<Built> {
  if (!genDirPrepared) {
    rmSync(GEN_DIR, { recursive: true, force: true });
    mkdirSync(GEN_DIR, { recursive: true });
    genDirPrepared = true;
  }

  // 1. LOWER. The find cap is read from the config SSoT at EMIT time, so it is applied around the
  //    emit and restored immediately (the config is global — never leak it into another vector).
  resetLimitConfig();
  if (config !== undefined) setLimitConfig(config);
  let emitted;
  try {
    emitted = emitBehaviorModule(emitSpecFor(dialect));
  } finally {
    resetLimitConfig();
  }

  // The artifact is content-addressed, so a changed emitter is a NEW module path — never a stale
  // ESM import-cache hit for a source that changed underneath the same name.
  const stamp = createHash('sha1').update(emitted.source).digest('hex').slice(0, 12);
  const authored = join(GEN_DIR, `${dialect}-${stamp}.authored.ts`);
  const generated = join(GEN_DIR, `${dialect}-${stamp}.generated.ts`);
  if (!existsSync(generated)) {
    writeFileSync(authored, emitted.source, 'utf8');
    // 2. The emitted source must be ORDINARY strict TypeScript — bc's authoring requirement.
    execFileSync(
      join(ROOT, 'node_modules/.bin/tsc'),
      ['--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler',
       '--experimentalDecorators', authored],
      { cwd: ROOT, stdio: 'pipe' },
    );
    // 3. GENERATE with bc's own CLI — no litedbmodel code in the generation path.
    execFileSync(
      join(ROOT, 'node_modules/.bin/bc'),
      ['generate', '--lang', 'typescript-native', '--from', authored, '--behavior', BEHAVIOR, '--out', generated],
      { cwd: ROOT, stdio: 'pipe' },
    );
  }
  const module = (await import(generated)) as GeneratedModule;
  return { source: emitted.source, contracts: emitted.endpoints, module };
}

/** The `findHardLimit` cap the emitter baked into one endpoint (absent ⇒ no cap). */
function bakedCap(b: Built, entry: string): number | undefined {
  const c = b.contracts.find((e) => e.name === entry);
  if (c === undefined) throw new Error(`conformance: no emitted endpoint '${entry}'`);
  return c.findHardLimit;
}

// ── the driver TAP: what the leaf transport actually handed the database ──────────────────────

/** One statement observed at the driver contact point, canonically encoded. */
export interface EncodedStatement {
  readonly sql: string;
  readonly params: readonly EncodedValue[];
}

/** The mutable statement log a seam's tap writes into. */
type StatementLog = { sql: string; params: unknown[] }[];

/**
 * Wrap the ONE sync driver contact point ({@link SyncConnection}) so every statement is logged AND
 * still executed. What the log holds is therefore the exact driver-bound form of a statement that
 * REALLY RAN: the dynamic (SKIP) WHERE already assembled, `?`→`$N` already rendered, the array
 * params already encoded and their PG casts resolved against the real key set. There is no second
 * renderer anywhere — a render golden is a statement the database answered.
 */
function tapSync(conn: SyncConnection, log: StatementLog): SyncConnection {
  return {
    execute(sql, params) {
      log.push({ sql, params: [...params] });
      return conn.execute(sql, params);
    },
    executeSafeIntegers(sql, params) {
      log.push({ sql, params: [...params] });
      return conn.executeSafeIntegers(sql, params);
    },
    run(sql, params) {
      log.push({ sql, params: [...params] });
      return conn.run(sql, params);
    },
  };
}

/** The async twin of {@link tapSync}: tap each pooled connection as it is handed out. */
function tapAsyncPool(pool: AsyncConnectionPool, log: StatementLog): AsyncConnectionPool {
  const originals = new WeakMap<AsyncConnection, AsyncConnection>();
  return {
    async acquire() {
      const real = await pool.acquire();
      const tapped: AsyncConnection = {
        async execute(sql, params) {
          log.push({ sql, params: [...params] });
          return real.execute(sql, params);
        },
        async run(sql, params) {
          log.push({ sql, params: [...params] });
          return real.run(sql, params);
        },
      };
      originals.set(tapped, real);
      return tapped;
    },
    release(conn, destroy) {
      return pool.release(originals.get(conn) ?? conn, destroy);
    },
  };
}

// ── the EXEC seam: one live database per dialect ──────────────────────────────────────────────

const PG_CONFIG = {
  host: process.env.TEST_DB_HOST || 'localhost',
  port: parseInt(process.env.TEST_DB_PORT || '5433', 10),
  database: process.env.TEST_DB_NAME || 'testdb',
  user: process.env.TEST_DB_USER || 'testuser',
  password: process.env.TEST_DB_PASSWORD || 'testpass',
};
const MYSQL_CONFIG = {
  host: process.env.TEST_MYSQL_HOST || 'localhost',
  port: parseInt(process.env.TEST_MYSQL_PORT || '3307', 10),
  database: process.env.TEST_MYSQL_DB || 'testdb',
  user: process.env.TEST_MYSQL_USER || 'testuser',
  password: process.env.TEST_MYSQL_PASSWORD || 'testpass',
};

let pgPool: PgPool | undefined;
let myPool: mysql.Pool | undefined;

/** Release the live PG / MySQL pools (a runner MUST call this, or the process keeps their sockets). */
export async function closeLiveConnections(): Promise<void> {
  if (pgPool !== undefined) {
    const p = pgPool;
    pgPool = undefined;
    await p.end();
  }
  if (myPool !== undefined) {
    const p = myPool;
    myPool = undefined;
    await p.end();
  }
}

/** Build a fresh in-memory SQLite from a schema/seed statement list. */
function seedDb(schema: readonly string[]): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const stmt of schema) db.exec(stmt);
  return db;
}

/**
 * ONE call through the pipeline: what the module returned (or THREW) plus every statement the
 * transport handed the driver during it. The throw is DATA, not control flow, because a guard vector's
 * evidence is precisely "these statements ran, then it threw this" — a relation cap trips INSIDE the
 * generated call (the `executeSQL` leaf), so an exception that unwound past the tap would take the
 * statement log with it. Both vector kinds read this one shape.
 */
interface CallOutcome {
  readonly result: unknown;
  readonly statements: EncodedStatement[];
  /** The error the call raised, or `undefined` when it returned normally. */
  readonly thrown?: unknown;
}

/** A freshly seeded database for ONE dialect, with the generated module bound to it. */
interface Seam {
  /** Call an emitted endpoint. Never throws — see {@link CallOutcome}. */
  call(entry: string, input: Record<string, unknown>): Promise<CallOutcome>;
  /** Run an assertion query straight through the same execution seam. */
  query(sql: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** Build the seam over an already-built module + a tapped execution context. */
function seamOver(
  log: StatementLog,
  invoke: (entry: string, input: Record<string, unknown>) => unknown,
  query: (sql: string) => Promise<Record<string, unknown>[]>,
  close: () => Promise<void>,
): Seam {
  return {
    async call(entry, input) {
      // The tap logs the seed/DDL and the assertion queries too, so a call's statements are the
      // slice it appended — never a guess about which log entries belong to it.
      const from = log.length;
      let result: unknown;
      let thrown: unknown;
      try {
        result = await invoke(entry, input);
      } catch (e) {
        thrown = e;
      }
      const statements = log.slice(from).map((s) => ({ sql: s.sql, params: s.params.map(encodeValue) }));
      return { result, statements, ...(thrown !== undefined ? { thrown } : {}) };
    },
    query,
    close,
  };
}

async function seamFor(dialect: DialectName, config?: LimitConfigSpec): Promise<Seam> {
  const b = await built(dialect, config);
  const log: StatementLog = [];
  if (dialect === 'sqlite') {
    const db = seedDb(SCHEMA);
    const ctx = contextForConnection(tapSync(connectionForDriver(db as never), log));
    const facade = b.module.bindTyped(leafHandlers({ exec: ctx, dialect }));
    return seamOver(
      log,
      (entry, input) => facade[entry](input),
      // `executeSafe`, not `execute`: the runtime's read path reads INTEGER columns in bc's `int` model
      // on every dialect, so a state-assertion query must too or §10 sees a dialect difference that the
      // behaviour does not have.
      (sql) => Promise.resolve(executeSafe(ctx, sql, [])),
      () => {
        db.close();
        return Promise.resolve();
      },
    );
  }
  // The read-path de-box knobs the LIBRARY owns (#59), applied exactly as a production consumer
  // applies them: without them `pg` hands over a JS Date and `mysql2` a JS Date for a TIMESTAMP
  // column, and the `date → 'YYYY-MM-DD HH:MM:SS'` contract of the typedRows projection (#137)
  // cannot hold. They are part of the artifact under test, not harness convenience.
  const pool =
    dialect === 'postgres'
      ? pgConnectionPool((pgPool ??= (configurePgDeboxTypeParsers(pgTypes), new PgPool(PG_CONFIG))) as never)
      : mysqlConnectionPool((myPool ??= mysql.createPool({ ...MYSQL_CONFIG, ...mysqlDeboxPoolOptions, connectionLimit: 4 })) as never);
  const ctx = new PooledAsyncContext(tapAsyncPool(pool, log));
  for (const stmt of SCHEMA) await runAsync(ctx, stmt, []);
  const facade = b.module.bindTypedAsync(leafHandlersAsync({ execAsync: ctx, dialect }));
  return seamOver(log, (entry, input) => facade[entry](input), (sql) => executeAsync(ctx, sql, []), () => Promise.resolve());
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTENT-LEVEL relation assertions (#150 — a count-only check is not a check).
// ══════════════════════════════════════════════════════════════════════════════

/**
 * The relation CONTENT contract of a vector: `relation path → the exact field names every child at
 * that path must carry`. A path is dot-separated from the root row (`posts.tags` = the tags of each
 * post of each root user).
 */
export type RelationFields = Readonly<Record<string, readonly string[]>>;

/** Collect every child object at `path` (arrays flattened, `null`/absent skipped). */
function childrenAt(rows: unknown, path: readonly string[]): Record<string, unknown>[] {
  let level = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  for (const seg of path) {
    const next: Record<string, unknown>[] = [];
    for (const row of level) {
      const v = row === null || typeof row !== 'object' ? undefined : row[seg];
      if (Array.isArray(v)) next.push(...(v as Record<string, unknown>[]).filter((c) => c !== null && typeof c === 'object'));
      else if (v !== null && typeof v === 'object') next.push(v as Record<string, unknown>);
    }
    level = next;
  }
  return level;
}

/**
 * Assert the CONTENT of a materialized relation graph. Returns the violations (empty ⇒ conformant).
 *
 * Three checks, each of which the #150 defect fails:
 *  1. the path must materialize at least ONE child object (an all-empty graph is not evidence);
 *  2. every child's field set must be EXACTLY the declared one (an empty struct `{}` fails);
 *  3. every declared field must be non-null in at least one child (a struct of nulls fails).
 *
 * A row-count assertion satisfies none of them, which is the point.
 */
export function checkRelationContent(rows: unknown, spec: RelationFields): string[] {
  const problems: string[] = [];
  for (const [path, fields] of Object.entries(spec)) {
    const children = childrenAt(rows, path.split('.'));
    if (children.length === 0) {
      problems.push(`relation '${path}': no child object materialized — a row-count assertion would still pass`);
      continue;
    }
    const want = [...fields].sort();
    children.forEach((child, i) => {
      const got = Object.keys(child).sort();
      if (got.join(',') !== want.join(',')) {
        problems.push(`relation '${path}'[${i}]: fields {${got.join(', ')}} != declared {${want.join(', ')}}`);
      }
    });
    for (const f of want) {
      if (!children.some((c) => c[f] !== undefined && c[f] !== null)) {
        problems.push(`relation '${path}': field '${f}' is absent/null in EVERY child (an empty struct)`);
      }
    }
  }
  return problems;
}

// ══════════════════════════════════════════════════════════════════════════════
// Vector shapes
// ══════════════════════════════════════════════════════════════════════════════

/**
 * An exec vector: the endpoint executed end-to-end against a real database. It carries BOTH axes,
 * because they are one execution: the statements the transport handed the driver (the render
 * golden) and what came back (the result / DB state).
 */
export interface ExecVector {
  readonly name: string;
  readonly kind: 'exec';
  readonly dialect: DialectName;
  readonly entry: string;
  readonly input: EncodedValue;
  readonly config?: LimitConfigSpec;
  /** The logical case — the SAME id across dialects (§10 cross-check anchor). */
  readonly case: string;
  /** Every statement the call issued, in order, in the driver-bound form. */
  readonly expectedStatements: readonly EncodedStatement[];
  /** The FULL materialized result (nested relation children included). */
  readonly expectedResult: EncodedValue;
  /** The relation CONTENT contract (#150) — asserted, never just counted. */
  readonly relationFields?: RelationFields;
  /** DB state after a write, queried through the same execution seam. */
  readonly expectedDbState?: readonly { readonly query: string; readonly rows: EncodedValue }[];
  /** The `findHardLimit` cap the emitter baked (null ⇒ none — an explicit/absent cap). */
  readonly expectedCap: number | null;
}

/**
 * An EXPECT-ERROR vector: a read whose baked runaway cap is exceeded. The two contexts trip in
 * DIFFERENT places, and the vector pins which:
 *
 *   - `find`     — the emitter bakes `LIMIT cap + 1` and the READ BOUNDARY enforces it post-fetch with
 *                  {@link import('../src/scp/limit-config').assertFindHardLimit}, because a bounded
 *                  fetch's overrun is visible in the rows the caller already holds.
 *   - `relation` — the cap rides ON the generated relation child fetch (`executeSQL`'s `guard` port)
 *                  and the TRANSPORT raises, because the raw child rows exist nowhere else: at the
 *                  boundary the graph is already grouped. So the throw comes from INSIDE the generated
 *                  call, and `expectedStatements` ends at the child fetch that overran — a downstream
 *                  relation level never runs.
 *
 * SCP has no throw either way; what differs is which side of the generated call owns the enforcement.
 */
export interface ExpectErrorVector {
  readonly name: string;
  readonly kind: 'expect-error';
  readonly dialect: DialectName;
  readonly entry: string;
  readonly input: EncodedValue;
  readonly config: LimitConfigSpec;
  readonly case: string;
  /** The `findHardLimit` cap the emitter baked (null ⇒ none — a relation-guard vector bakes none). */
  readonly expectedCap: number | null;
  /** Every statement the read issued before it raised (the `LIMIT cap + 1` bounded fetch, or the
   * over-cap relation child fetch — whichever this vector's context is). */
  readonly expectedStatements: readonly EncodedStatement[];
  readonly expectedError: {
    readonly name: 'LimitExceededError';
    readonly limit: number;
    readonly count: number;
    readonly context: 'find' | 'relation';
    readonly model?: string;
    /** The relation NAME — `relation` context only. */
    readonly relation?: string;
  };
}

/** A dialect-primitive vector: the `orderByNulls` NULLS-ordering emulation. */
export interface DialectVector {
  readonly name: string;
  readonly kind: 'dialect';
  readonly dialect: DialectName;
  readonly primitive: 'orderByNulls';
  readonly args: { readonly expr: string; readonly dir: 'ASC' | 'DESC'; readonly nulls: 'FIRST' | 'LAST' };
  readonly expected: string;
}

export type Vector = ExecVector | ExpectErrorVector | DialectVector;

/** A named suite file of vectors (one JSON per file). */
export interface Suite {
  readonly suite: string;
  readonly corpusVersion: number;
  readonly note: string;
  readonly vectors: readonly Vector[];
}

// ══════════════════════════════════════════════════════════════════════════════
// The CASES — declared once, generated for every dialect.
// ══════════════════════════════════════════════════════════════════════════════

/** A per-dialect input (a PG batch write binds one array PER COLUMN; MySQL/SQLite one record array). */
type InputFor = Record<string, unknown> | ((dialect: DialectName) => Record<string, unknown>);

function inputOf(i: InputFor, dialect: DialectName): Record<string, unknown> {
  return typeof i === 'function' ? i(dialect) : i;
}

interface ExecCase {
  readonly id: string;
  readonly entry: string;
  readonly input: InputFor;
  /** A write case mutates: its result carries per-dialect driver counters, its DB STATE is the invariant. */
  readonly writes?: boolean;
  readonly relationFields?: RelationFields;
  readonly dbState?: readonly string[];
  readonly config?: LimitConfigSpec;
}

const POSTS_STATE = 'SELECT id, author_id, title, status, created_at FROM conf_posts ORDER BY id';
const TAGS_STATE = 'SELECT id, post_id, label FROM conf_tags ORDER BY id';
const DOCS_STATE = 'SELECT doc_id, title FROM conf_docs ORDER BY doc_id';
const LINES_STATE = 'SELECT order_id, line_no, sku FROM conf_lines ORDER BY order_id, line_no';

const EXEC_CASES: readonly ExecCase[] = [
  { id: 'posts: author page', entry: 'posts', input: { authorId: 1 } },
  { id: 'postsTop: explicit LIMIT 2', entry: 'postsTop', input: {} },
  // #161 — the SAME emitted statement, two different windows: a baked count could not produce both.
  { id: 'page: bound LIMIT/OFFSET (first window)', entry: 'page', input: { limit: 2, offset: 0 } },
  { id: 'page: bound LIMIT/OFFSET (second window, same statement)', entry: 'page', input: { limit: 2, offset: 1 } },
  { id: 'postsByIds: IN-list (non-empty)', entry: 'postsByIds', input: { ids: [10, 12] } },
  { id: 'postsByIds: IN-list (EMPTY key set is legal)', entry: 'postsByIds', input: { ids: [] } },
  { id: 'feed: both optional predicates absent (SKIP drop)', entry: 'feed', input: { authorId: 1 } },
  { id: 'feed: status present, since absent', entry: 'feed', input: { authorId: 1, status: 'draft' } },
  { id: 'feed: since present, status absent', entry: 'feed', input: { authorId: 1, since: '2026-03-01' } },
  { id: 'feed: both present', entry: 'feed', input: { authorId: 1, status: 'live', since: '2026-01-01' } },
  // #200 — SKIP × a BOUND page: the survivors' params splice into the MIDDLE of the base params
  // (`author_id` binds before the clause, `LIMIT`/`OFFSET` after it). `minId` is an INT, so every
  // mis-placement stays type-valid and shows up as a DIFFERENT ROW SET — the only thing that catches
  // it, since PostgreSQL renumbers `?`→`$N` after assembly and the statement TEXT looks right either
  // way. With authorId=1, minId=2, limit=1, offset=0 the correct binding yields post 10, while
  // binding the fragment first yields post 12 (author 2), binding it last yields nothing (LIMIT 0
  // OFFSET 2), and counting one page param instead of two yields both posts.
  { id: 'pagedFeed: bound page, both optional predicates absent (SKIP drop)', entry: 'pagedFeed', input: { authorId: 1, limit: 1, offset: 1 } },
  { id: 'pagedFeed: bound page + an INT optional cursor (params splice mid-list)', entry: 'pagedFeed', input: { authorId: 1, minId: 2, limit: 1, offset: 0 } },
  { id: 'pagedFeed: same statement, second window (the page still moves under a surviving fragment)', entry: 'pagedFeed', input: { authorId: 1, minId: 2, limit: 1, offset: 1 } },
  { id: 'pagedFeed: bound page + both optional predicates', entry: 'pagedFeed', input: { authorId: 1, minId: 2, status: 'draft', limit: 1, offset: 0 } },
  // #198 / #202 — the statement's HEAD / TAIL split is DECLARED by the builder that emitted it, so the
  // transport concatenates instead of scanning the finished text for the WHERE boundary. These four
  // endpoints are the shapes a scan got wrong, and none of them could be DECLARED before: `order` never
  // carried a quoted `?` or ` WHERE ` in this corpus, a read with only optional predicates never existed,
  // and SKIP × a QUERY view was a hard emitter REJECT (its CTE's own tail took the splice position).
  //
  // `optionalOnlyFeed` — a head with NO WHERE: the first survivor OPENS one. All three arms.
  { id: 'optionalOnlyFeed: BOTH optional predicates absent (no WHERE at all)', entry: 'optionalOnlyFeed', input: {} },
  { id: 'optionalOnlyFeed: one surviving fragment OPENS the WHERE', entry: 'optionalOnlyFeed', input: { authorId: 1 } },
  { id: 'optionalOnlyFeed: two surviving fragments — the second joins with AND', entry: 'optionalOnlyFeed', input: { authorId: 1, status: 'live' } },
  // `quotedOrderFeed` — a quoted `?` in the tail beside a real bound `LIMIT ?`, base params on BOTH
  // sides of the clause. With authorId=1, minId=11, limit=2 the correct binding yields post 11; counting
  // the tail's `?`s (2 of them, one of which binds nothing) bound `minId` into `author_id` and returned
  // NOTHING, in the three languages that did not panic on the negative index instead (#199 / #202).
  { id: 'quotedOrderFeed: quoted `?` in ORDER BY, optional cursor absent', entry: 'quotedOrderFeed', input: { authorId: 1, limit: 2 } },
  { id: 'quotedOrderFeed: quoted `?` in ORDER BY + a surviving INT cursor', entry: 'quotedOrderFeed', input: { authorId: 1, minId: 11, limit: 2 } },
  { id: 'quotedOrderFeed: same statement, LIMIT 1 (the page still binds LAST)', entry: 'quotedOrderFeed', input: { authorId: 1, minId: 10, limit: 1 } },
  // `quotedWhereOrderFeed` — a quoted ` WHERE ` in the tail: still an OPENED WHERE, never a continued one.
  { id: 'quotedWhereOrderFeed: quoted ` WHERE ` in ORDER BY, fragment skipped', entry: 'quotedWhereOrderFeed', input: {} },
  { id: 'quotedWhereOrderFeed: quoted ` WHERE ` in ORDER BY, fragment surviving', entry: 'quotedWhereOrderFeed', input: { status: 'live' } },
  // `viewFeed` — the CTE (own WHERE, own quoted ` WHERE `, own ORDER BY + LIMIT 2) is inside the HEAD.
  // The CTE yields posts 10 and 11; the clause filters them AFTER it, so `status: 'live'` yields post 10
  // alone. Splicing inside the CTE would have filtered FIRST and yielded posts 10 and 12.
  { id: 'viewFeed: SKIP × QUERY view, fragment skipped', entry: 'viewFeed', input: {} },
  { id: 'viewFeed: SKIP × QUERY view, fragment surviving AFTER the CTE (not inside it)', entry: 'viewFeed', input: { status: 'live' } },
  { id: 'viewFeed: SKIP × QUERY view, the other status', entry: 'viewFeed', input: { status: 'draft' } },
  {
    id: 'usersWithPosts: two relation levels materialize WITH THEIR FIELDS',
    entry: 'usersWithPosts',
    input: {},
    relationFields: {
      posts: ['id', 'author_id', 'title', 'status', 'created_at', 'tags'],
      'posts.tags': ['id', 'post_id', 'label'],
    },
  },
  {
    id: 'postsWithAuthor: belongsTo nests ONE child WITH ITS FIELDS',
    entry: 'postsWithAuthor',
    input: {},
    relationFields: { author: ['id', 'name', 'post_count'] },
  },
  {
    id: 'createPost: INSERT persists',
    entry: 'createPost',
    input: { id: 13, authorId: 1, title: 'c1', status: 'live', createdAt: '2026-04-01' },
    writes: true,
    dbState: [POSTS_STATE],
  },
  { id: 'renamePost: UPDATE persists', entry: 'renamePost', input: { title: 'a1-renamed', id: 10 }, writes: true, dbState: [POSTS_STATE] },
  { id: 'removePost: DELETE persists', entry: 'removePost', input: { id: 12 }, writes: true, dbState: [POSTS_STATE] },
  {
    id: 'createTags: batch INSERT persists (one statement for N records)',
    entry: 'createTags',
    input: (d) =>
      d === 'postgres'
        ? { rows_id: [103, 104], rows_post_id: [11, 11], rows_label: ['x', 'y'] }
        : { rows: [{ id: 103, post_id: 11, label: 'x' }, { id: 104, post_id: 11, label: 'y' }] },
    writes: true,
    dbState: [TAGS_STATE],
  },
  { id: 'removeTags: batch DELETE by key set persists', entry: 'removeTags', input: { ids: [100, 101] }, writes: true, dbState: [TAGS_STATE] },
  // #167 — each batch kind hands back every row it wrote, identically on all three dialects.
  {
    id: 'createTagsReturning: batch INSERT … RETURNING returns every created row',
    entry: 'createTagsReturning',
    input: (d) =>
      d === 'postgres'
        ? { rows_id: [105, 106], rows_post_id: [11, 12], rows_label: ['p', 'q'] }
        : { rows: [{ id: 105, post_id: 11, label: 'p' }, { id: 106, post_id: 12, label: 'q' }] },
    writes: true,
    dbState: [TAGS_STATE],
  },
  {
    id: 'relabelTagsReturning: batch UPDATE … RETURNING returns every updated row',
    entry: 'relabelTagsReturning',
    input: (d) =>
      d === 'postgres'
        ? { rows_id: [100, 102], rows_label: ['re-100', 're-102'] }
        : { rows: [{ id: 100, label: 're-100' }, { id: 102, label: 're-102' }] },
    writes: true,
    dbState: [TAGS_STATE],
  },
  { id: 'removeTagsReturning: batch DELETE … RETURNING returns every removed row', entry: 'removeTagsReturning', input: { ids: [100, 101] }, writes: true, dbState: [TAGS_STATE] },
  // #130 — a write that DECLARES a RETURNING hands back the rows it wrote, on every dialect. The
  // UPDATE's row carries its NEW title (it is described after the write); the DELETE's is the
  // pre-image (described before it), and `dbState` proves the delete still happened.
  { id: 'createPostReturning: INSERT … RETURNING returns the written row (client-supplied PK)', entry: 'createPostReturning', input: { id: 14, authorId: 2, title: 'c2', status: 'live', createdAt: '2026-05-01' }, writes: true, dbState: [POSTS_STATE] },
  { id: 'renamePostReturning: UPDATE … RETURNING returns the written row', entry: 'renamePostReturning', input: { title: 'a1-returned', id: 10 }, writes: true, dbState: [POSTS_STATE] },
  { id: 'removePostReturning: DELETE … RETURNING returns the removed row', entry: 'removePostReturning', input: { id: 11 }, writes: true, dbState: [POSTS_STATE] },
  // The remaining two PRIMARY-KEY shapes a RETURNING create is recovered by (see `createDoc` /
  // `createLine` above): a STRING key and a COMPOSITE key. Both persist ONE new row next to a seeded
  // one, so the result and the DB state disagree if the recovery describes the wrong row set.
  { id: 'createDoc: INSERT … RETURNING on a STRING primary key returns the written row', entry: 'createDoc', input: { docId: '22222222-2222-2222-2222-222222222222', title: 'Doc' }, writes: true, dbState: [DOCS_STATE] },
  { id: 'createLine: INSERT … RETURNING on a COMPOSITE primary key returns the written row', entry: 'createLine', input: { orderId: 10, lineNo: 2, sku: 'SKU-2' }, writes: true, dbState: [LINES_STATE] },
  // #166 — MULTI-ROW: author 1 owns posts 10 and 11. The §10 cross-check compares the three dialects
  // row-for-row IN ORDER, so it is the ordering assertion a single-row vector cannot make.
  { id: 'restatusPostsReturning: multi-row UPDATE … RETURNING returns every written row, in key order', entry: 'restatusPostsReturning', input: { status: 'archived', authorId: 1 }, writes: true, dbState: [POSTS_STATE] },
  { id: 'removePostsByAuthorReturning: multi-row DELETE … RETURNING returns every removed row, in key order', entry: 'removePostsByAuthorReturning', input: { authorId: 1 }, writes: true, dbState: [POSTS_STATE] },
  // #137 — the read decode: a TIMESTAMP column comes back as the canonical string and a
  // boolean-valued column as an Int, IDENTICALLY on SQLite / live PostgreSQL / live MySQL. The
  // §10 cross-check below is what makes it a decoder assertion rather than three separate goldens.
  { id: 'typedRows: date + bool columns are PROJECTED and decode identically', entry: 'typedRows', input: {} },
  // The find hard-limit SKIP cases: `null` disables the cap, and an endpoint that declares its own
  // LIMIT is never capped — both must run normally (no throw), on every dialect.
  { id: 'guard: findHardLimit null → no cap baked', entry: 'posts', input: { authorId: 1 }, config: { findHardLimit: null } },
  { id: 'guard: an explicit endpoint LIMIT governs → no cap baked', entry: 'postsTop', input: {}, config: { findHardLimit: 1 } },
  // The RELATION hard-limit SKIP cases, both run under a global cap of 1 that the batch WOULD overrun
  // (3 child rows): they prove the declaration — not the global — decides, and that a relation whose
  // check is disabled or skipped still MATERIALIZES its children (a swallowed guard would show up as a
  // missing or empty relation, which the content contract rejects).
  {
    id: 'guard: a per-relation hardLimit null disables the check → no throw',
    entry: 'usersWithUncappedPosts',
    input: {},
    config: { hasManyHardLimit: 1 },
    relationFields: { uncappedPosts: ['id', 'author_id', 'title', 'status', 'created_at'] },
  },
  {
    id: 'guard: an intrinsic per-parent LIMIT window skips the batch check → no throw',
    entry: 'usersWithTopPosts',
    input: {},
    config: { hasManyHardLimit: 1 },
  },
];

/**
 * The GUARD cases: a read that OVERRUNS a resolved runaway cap and must raise
 * {@link LimitExceededError} with exact fields, on every dialect. One list for both contexts — the
 * find cap and the relation cap are the same policy differing only in where it is enforced, and the
 * captured vector records which fired.
 */
interface GuardCase {
  readonly id: string;
  readonly entry: string;
  readonly input: Record<string, unknown>;
  readonly config: LimitConfigSpec;
}

const GUARD_CASES: readonly GuardCase[] = [
  {
    // FIND: the emitter bakes `LIMIT cap + 1`, the read boundary asserts the fetch.
    id: 'guard: the read overruns findHardLimit → throw',
    entry: 'posts',
    input: { authorId: 1 },
    config: { findHardLimit: 1 },
  },
  {
    // RELATION: the 3 posts overrun the global cap of 2 — and the tags level below never runs, which
    // the vector's statement list shows.
    id: 'guard: the hasMany batch overruns hasManyHardLimit → throw (exact count)',
    entry: 'usersWithPosts',
    input: {},
    config: { hasManyHardLimit: 2 },
  },
  {
    // RELATION: no global cap at all — the relation's OWN `hardLimit: 2` is what trips.
    id: 'guard: a per-relation hardLimit override → throw',
    entry: 'usersWithCappedPosts',
    input: {},
    config: {},
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// Corpus generation — every expected field is CAPTURED from the pipeline.
// ══════════════════════════════════════════════════════════════════════════════

/** Run one exec case on one dialect and capture everything the vector asserts. */
async function execVector(c: ExecCase, dialect: DialectName): Promise<ExecVector> {
  const input = inputOf(c.input, dialect);
  const seam = await seamFor(dialect, c.config);
  try {
    const { result, statements, thrown } = await seam.call(c.entry, input);
    // An exec case must RUN. A guard that fired here is the defect the case exists to disprove, so it
    // surfaces as a capture failure rather than a silently absent vector.
    if (thrown !== undefined) throw thrown;
    const dbState = c.dbState === undefined
      ? undefined
      : await Promise.all(c.dbState.map(async (query) => ({ query, rows: encodeValue(await seam.query(query)) })));
    if (c.relationFields !== undefined) {
      const problems = checkRelationContent(result, c.relationFields);
      if (problems.length > 0) {
        throw new Error(`conformance: case '${c.id}' [${dialect}] violates its relation CONTENT contract:\n  ${problems.join('\n  ')}`);
      }
    }
    return {
      name: `${c.id} [${dialect}]`,
      kind: 'exec',
      dialect,
      entry: c.entry,
      input: encodeValue(input),
      case: c.id,
      ...(c.config !== undefined ? { config: c.config } : {}),
      expectedStatements: statements,
      expectedResult: encodeValue(result),
      ...(c.relationFields !== undefined ? { relationFields: c.relationFields } : {}),
      ...(dbState !== undefined ? { expectedDbState: dbState } : {}),
      expectedCap: bakedCap(await built(dialect, c.config), c.entry) ?? null,
    };
  } finally {
    await seam.close();
  }
}

/**
 * The §10 cross-dialect invariant, enforced at CAPTURE. A read case must produce the IDENTICAL
 * result on all three dialects; a write case's driver counters are dialect-specific
 * (`lastInsertRowid`), so its invariant is the `changes` count plus the resulting DB STATE.
 */
function assertDialectInvariant(c: ExecCase, vectors: readonly ExecVector[]): void {
  const compare = (v: ExecVector): string =>
    JSON.stringify(
      c.writes === true
        ? { changes: (v.expectedResult as { changes?: EncodedValue }[])[0]?.changes ?? null, state: v.expectedDbState }
        : v.expectedResult,
    );
  const [head, ...rest] = vectors;
  for (const v of rest) {
    if (compare(v) !== compare(head)) {
      throw new Error(
        `conformance: case '${c.id}' is NOT dialect-invariant (§10) — ${head.dialect} produced ` +
          `${compare(head)} but ${v.dialect} produced ${compare(v)}`,
      );
    }
  }
}

/**
 * Drive ONE guard case to its throw. This is the single capture path for BOTH runaway contexts,
 * because the only thing that differs is where the throw comes from and the harness must not assume:
 * a RELATION cap trips inside the generated call (the `executeSQL` transport, on the raw child rows)
 * and arrives as {@link CallOutcome.thrown}; a FIND cap is enforced after it, at the read boundary
 * ({@link assertFindHardLimit}) off the cap the emitter baked into the endpoint. Whichever fires, the
 * statements the call issued are captured either way.
 */
async function runGuard(
  entry: string,
  input: Record<string, unknown>,
  cap: number | undefined,
  seam: Seam,
): Promise<{ thrown: unknown; statements: EncodedStatement[] }> {
  const called = await seam.call(entry, input);
  if (called.thrown !== undefined) return { thrown: called.thrown, statements: called.statements };
  try {
    assertFindHardLimit(called.result as unknown[], cap, entry);
  } catch (e) {
    return { thrown: e, statements: called.statements };
  }
  return { thrown: undefined, statements: called.statements };
}

/** Build ONE guard EXPECT-ERROR vector: the read overruns a baked cap and raises with exact fields. */
async function guardVector(c: GuardCase, dialect: DialectName): Promise<ExpectErrorVector> {
  const cap = bakedCap(await built(dialect, c.config), c.entry);
  const seam = await seamFor(dialect, c.config);
  let outcome;
  try {
    outcome = await runGuard(c.entry, c.input, cap, seam);
  } finally {
    await seam.close();
  }
  const thrown = outcome.thrown;
  if (!(thrown instanceof LimitExceededError)) {
    throw new Error(
      `conformance: guard case '${c.id}' did NOT throw on ${dialect} ` +
        `(got ${thrown === undefined ? 'no throw' : String(thrown)})`,
    );
  }
  return {
    name: `${c.id} [${dialect}]`,
    kind: 'expect-error',
    dialect,
    entry: c.entry,
    input: encodeValue(c.input),
    config: c.config,
    case: c.id,
    expectedCap: cap ?? null,
    expectedStatements: outcome.statements,
    expectedError: {
      name: 'LimitExceededError',
      limit: thrown.limit,
      count: thrown.count,
      context: thrown.context,
      ...(thrown.model !== undefined ? { model: thrown.model } : {}),
      ...(thrown.relation !== undefined ? { relation: thrown.relation } : {}),
    },
  };
}

/**
 * A state-assertion query's rows, read in the SAME integer model the runtime reads in: `safeIntegers`, so
 * an INTEGER column comes back a BigInt. Without it the SQLite leg reported a JS number where the
 * PostgreSQL and MySQL legs report bc's `int` (their integer type parsers are unconditional), and §10
 * rejected the vector as dialect-variant — the assertion, not the behaviour, was the thing that differed.
 */
/** Build a dialect-primitive vector capturing the reference `orderByNulls` output. */
function orderByNullsVector(dialect: DialectName, dir: 'ASC' | 'DESC', nulls: 'FIRST' | 'LAST'): DialectVector {
  const expr = 'created_at';
  return {
    name: `orderByNulls ${dialect} ${dir} NULLS ${nulls}`,
    kind: 'dialect',
    dialect,
    primitive: 'orderByNulls',
    args: { expr, dir, nulls },
    expected: dialectFor(dialect).orderByNulls(expr, dir, nulls),
  };
}

/** Generate the full corpus (list of suites). Every expected field is captured, not authored. */
export async function generateCorpus(): Promise<Suite[]> {
  // ── exec: the same declaration executed on SQLite + live PostgreSQL + live MySQL ───────────
  const exec: ExecVector[] = [];
  for (const c of EXEC_CASES) {
    const vectors: ExecVector[] = [];
    for (const dialect of ALL_DIALECTS) vectors.push(await execVector(c, dialect));
    assertDialectInvariant(c, vectors);
    exec.push(...vectors);
  }

  // ── guard: the baked runaway caps — the find one at the read boundary, the relation one inside
  //    the generated call (the `executeSQL` transport, on the raw child rows) ─────────────────────
  const guard: ExpectErrorVector[] = [];
  for (const c of GUARD_CASES) {
    for (const dialect of ALL_DIALECTS) guard.push(await guardVector(c, dialect));
  }

  // ── dialect: orderByNulls ──────────────────────────────────────────────────────────────────
  const dialect: DialectVector[] = [];
  for (const d of ALL_DIALECTS) {
    for (const dir of ['ASC', 'DESC'] as const) {
      for (const nulls of ['FIRST', 'LAST'] as const) dialect.push(orderByNullsVector(d, dir, nulls));
    }
  }

  return [
    { suite: 'exec', corpusVersion: CORPUS_VERSION, note: 'The declared endpoints executed end-to-end on SQLite + live PostgreSQL + live MySQL. Each vector pins the statements the transport handed the driver AND what came back: reads are asserted dialect-invariant (§10); writes are asserted on their changes count + resulting DB state; relation vectors carry a field-level content contract (#150).', vectors: exec },
    { suite: 'guard', corpusVersion: CORPUS_VERSION, note: 'The find hard-limit: the emitter bakes LIMIT cap + 1 (visible in the vector statements) and the read boundary throws LimitExceededError post-fetch (assertFindHardLimit). The null-disable and explicit-LIMIT SKIP paths are exec vectors that must NOT throw.', vectors: guard },
    { suite: 'dialect', corpusVersion: CORPUS_VERSION, note: 'Dialect primitive orderByNulls: PG/SQLite native NULLS, MySQL IS NULL emulation.', vectors: dialect },
  ];
}

// ══════════════════════════════════════════════════════════════════════════════
// Runner: re-derive the reference and assert it equals the frozen corpus.
// ══════════════════════════════════════════════════════════════════════════════

export interface VectorResult {
  readonly name: string;
  readonly suite: string;
  readonly ok: boolean;
  readonly detail?: string;
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Re-execute ONE vector through the live pipeline and compare it to its frozen expected fields.
 * This is the conformance assertion; a language runner mirrors it against its own runtime.
 */
export async function runVector(v: Vector): Promise<VectorResult> {
  const base = { name: v.name, suite: v.kind === 'expect-error' ? 'guard' : v.kind };
  try {
    if (v.kind === 'exec') {
      const seam = await seamFor(v.dialect, v.config);
      let result: unknown;
      let statements: EncodedStatement[] = [];
      let thrown: unknown;
      let dbState: { query: string; rows: EncodedValue }[] = [];
      try {
        const called = await seam.call(v.entry, decodeValue(v.input) as Record<string, unknown>);
        result = called.result;
        statements = called.statements;
        thrown = called.thrown;
        dbState = await Promise.all((v.expectedDbState ?? []).map(async (s) => ({ query: s.query, rows: encodeValue(await seam.query(s.query)) })));
      } finally {
        await seam.close();
      }
      const problems: string[] = [];
      // An exec vector asserts the call RUNS. A guard that fired here (a cap that should have been
      // disabled or skipped) is reported as itself, not as a downstream result mismatch.
      if (thrown !== undefined) problems.push(`unexpected throw: ${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)}`);
      if (!eq(statements, v.expectedStatements)) problems.push(`statements ${JSON.stringify(statements)} != ${JSON.stringify(v.expectedStatements)}`);
      if (!eq(encodeValue(result), v.expectedResult)) problems.push(`result ${JSON.stringify(encodeValue(result))} != ${JSON.stringify(v.expectedResult)}`);
      if (!eq(dbState, v.expectedDbState ?? [])) problems.push(`db state ${JSON.stringify(dbState)} != ${JSON.stringify(v.expectedDbState)}`);
      if (v.relationFields !== undefined) problems.push(...checkRelationContent(result, v.relationFields));
      const cap = bakedCap(await built(v.dialect, v.config), v.entry) ?? null;
      if (cap !== v.expectedCap) problems.push(`baked find cap ${String(cap)} != ${String(v.expectedCap)}`);
      return { ...base, ok: problems.length === 0, detail: problems.length === 0 ? undefined : problems.join('; ') };
    }
    if (v.kind === 'expect-error') {
      const cap = bakedCap(await built(v.dialect, v.config), v.entry);
      const seam = await seamFor(v.dialect, v.config);
      let outcome;
      try {
        outcome = await runGuard(v.entry, decodeValue(v.input) as Record<string, unknown>, cap, seam);
      } finally {
        await seam.close();
      }
      const { thrown, statements } = outcome;
      if (!(thrown instanceof LimitExceededError)) {
        return { ...base, ok: false, detail: `expected LimitExceededError, got ${thrown === undefined ? 'no throw' : thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)}` };
      }
      const got = {
        name: thrown.name,
        limit: thrown.limit,
        count: thrown.count,
        context: thrown.context,
        ...(thrown.model !== undefined ? { model: thrown.model } : {}),
        ...(thrown.relation !== undefined ? { relation: thrown.relation } : {}),
      };
      const problems: string[] = [];
      if (!eq(got, v.expectedError)) problems.push(`error ${JSON.stringify(got)} != ${JSON.stringify(v.expectedError)}`);
      if (!eq(statements, v.expectedStatements)) problems.push(`statements ${JSON.stringify(statements)} != ${JSON.stringify(v.expectedStatements)}`);
      if ((cap ?? null) !== v.expectedCap) problems.push(`baked find cap ${String(cap ?? null)} != ${String(v.expectedCap)}`);
      return { ...base, ok: problems.length === 0, detail: problems.length === 0 ? undefined : problems.join('; ') };
    }
    const got = dialectFor(v.dialect).orderByNulls(v.args.expr, v.args.dir, v.args.nulls);
    const ok = got === v.expected;
    return { ...base, ok, detail: ok ? undefined : `${JSON.stringify(got)} != ${JSON.stringify(v.expected)}` };
  } catch (e) {
    return { ...base, ok: false, detail: `threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}
