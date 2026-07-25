/**
 * litedbmodel v2 SCP — the DECLARED-ENDPOINT vocabulary (the ORM user's abstract API).
 *
 * This is the surface an application declares its statically-known queries on. It contains NO SQL:
 * a predicate names a MODEL COLUMN and a PARAMETER, a relation names a `@hasMany`/`@belongsTo`/
 * `@hasOne` property, a write names the columns it binds. The dialect SQL is produced by the
 * emitter ({@link import('./emitter').emitBehaviorModule}) from the surviving `makesql` builders,
 * and the parameter TYPES are resolved from the model's `@column` metadata — never hand-written.
 *
 * ```
 * models + endpoints  →  emitBehaviorModule  →  SCP-restricted TS (@behavior static methods)
 *                                            →  bc generate --from  →  go / rust / py / php / ts
 * ```
 *
 * Only a STATICALLY declared endpoint lowers to codegen. A query whose SHAPE is only known per
 * request (an ad-hoc `find({ where })`) has no static SQL and runs the v1 imperative path.
 */

import type { ModelClassLike } from '../decorator-adapter';

// ── predicates (a WHERE member, declared over a model column) ──────────────────────────────────

/** The comparison operators a declared predicate may use (the v1 `DBConditions` comparison set). */
export type ComparisonOp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'like';

/**
 * `<column> <op> <param>`. The parameter's TS type is resolved from the column's declared SQL type.
 *
 * `optional: true` makes the predicate a SKIP member: the parameter is nullable and the fragment is
 * DROPPED when it is null. The emitter lowers that to a conditional over the two STATIC SQL texts
 * (bc's `?:` → a Conditional node), so every branch is still fully static SQL.
 */
export interface ComparePredicate {
  readonly kind?: 'compare';
  readonly column: string;
  readonly op: ComparisonOp;
  readonly param: string;
  readonly optional?: boolean;
}

/**
 * `<column> IN <param>` — a whole key set bound as ONE parameter. The emitted text is the dialect's
 * value-length-INDEPENDENT membership form (PG `= ANY(?)` with no element cast — issue #46; MySQL /
 * SQLite the single-JSON `JSON_TABLE` / `json_each` subquery), so the SQL stays static regardless of
 * how many keys are passed.
 */
export interface InPredicate {
  readonly kind: 'in';
  readonly column: string;
  readonly param: string;
  readonly optional?: boolean;
}

/**
 * `(<columns>) IN <param>` — a COMPOSITE key set bound with a CONSTANT number of parameters,
 * whatever the tuple count. The emitted text is the dialect's static composite membership form
 * (`tupleInPredicate`): PostgreSQL `(t.k1, t.k2) IN (SELECT * FROM UNNEST(?::T1, ?::T2))`, MySQL /
 * SQLite ONE JSON array-of-tuples param.
 *
 * The bind SHAPE is the dialect's, as the builder defines it: PostgreSQL takes ONE ARRAY PARAMETER
 * PER KEY COLUMN, named `<param>_<column>`; MySQL / SQLite take the single `<param>` array of tuples.
 * The emitter reports the parameter list it produced, so a caller never guesses.
 */
export interface TupleInPredicate {
  readonly kind: 'tupleIn';
  readonly columns: readonly string[];
  readonly param: string;
}

/** `<column> IS [NOT] NULL` — no parameter. */
export interface NullPredicate {
  readonly kind: 'isNull' | 'isNotNull';
  readonly column: string;
}

/**
 * ONE correlation term of a subquery / EXISTS predicate: the subquery column is matched either
 * against an OUTER-query column (the `parentRef` sugar — a correlated subquery) or against a bound
 * parameter.
 */
export type CorrelationTerm =
  | { readonly column: string; readonly parentColumn: string; readonly param?: undefined }
  | { readonly column: string; readonly param: string; readonly parentColumn?: undefined };

/** `[NOT] EXISTS (SELECT 1 FROM <model> WHERE …)` — correlated via {@link CorrelationTerm}. */
export interface ExistsPredicate {
  readonly kind: 'exists';
  readonly not?: boolean;
  /** The subquery's model (its table + column types). */
  readonly model: ModelClassLike;
  readonly match: readonly CorrelationTerm[];
}

/** `(<columns>) [NOT] IN (SELECT <select> FROM <model> WHERE …)` — the typed subquery predicate. */
export interface SubqueryPredicate {
  readonly kind: 'subquery';
  readonly not?: boolean;
  /** The OUTER columns matched against the subquery projection (single or composite). */
  readonly columns: readonly string[];
  readonly model: ModelClassLike;
  /** The subquery projection — same arity as {@link columns}. */
  readonly select: readonly string[];
  readonly match: readonly CorrelationTerm[];
}

/** A declared WHERE member. */
export type Predicate = ComparePredicate | InPredicate | TupleInPredicate | NullPredicate | ExistsPredicate | SubqueryPredicate;

// ── relations (eager selection over the model's declared relations) ────────────────────────────

/**
 * An eagerly-selected relation: the `@hasMany` / `@belongsTo` / `@hasOne` property name, optionally
 * with its OWN nested selections (users → posts → comments). Each level is ONE batched child query
 * (`pluck` → `executeSQL` → `group`), never one query per parent.
 */
export type RelationSelection = string | { readonly name: string; readonly with?: readonly RelationSelection[] };

// ── QUERY view-model (#98) ────────────────────────────────────────────────────────────────────

/**
 * A v1 QUERY view-model: the read selects FROM a derived CTE built from `query` instead of from the
 * model's base table (`WITH <alias> AS (<query>) SELECT … FROM <alias>`), and the QUERY's own params
 * bind FIRST (v1's param-prepend order). `columns` types the derived projection; the model supplies
 * the column types under the CTE alias.
 */
export interface QueryView {
  /** The derived query — raw SQL text, or a fragment carrying its own bound params. */
  readonly query: string | { readonly sql: string; readonly params: readonly unknown[] };
  /** The CTE alias the read selects from (v1 `getCTEAlias` default `derived`). */
  readonly alias?: string;
}

// ── paging ────────────────────────────────────────────────────────────────────────────────────

/**
 * A declared page position (a `LIMIT` or an `OFFSET`).
 *
 * A plain `number` is STATIC: the count is baked into the SQL as a literal (v1's inline form), so the
 * statement carries no extra parameter. `{ param }` makes the position an INPUT — the endpoint gains
 * an `Int` parameter and the SQL binds it (`LIMIT ?`), which is how a runtime-paged read
 * (`page(limit, offset)`) reaches the codegen path at all: a per-call page cannot be a literal.
 */
export type PageBound = number | { readonly param: string };

// ── endpoints ─────────────────────────────────────────────────────────────────────────────────

/** A statically declared READ. */
export interface ReadEndpoint {
  readonly kind: 'read';
  /** The model whose table is read and whose `@column` metadata types the projection + params. */
  readonly model: ModelClassLike;
  /** The projected columns (default: every declared `@column`). */
  readonly select?: readonly string[];
  readonly where?: readonly Predicate[];
  readonly order?: string;
  /** A static row cap (inlined), or `{ param }` for a bound one — see {@link PageBound}. */
  readonly limit?: PageBound;
  /** A static start offset (inlined), or `{ param }` for a bound one — see {@link PageBound}. */
  readonly offset?: PageBound;
  /**
   * Take a ROW LOCK on the selected rows (the SELECT's locking clause): `'update'` ⇒ ` FOR UPDATE`
   * (exclusive — the read-modify-write pattern), `'share'` ⇒ ` FOR SHARE` (shared — concurrent
   * readers coexist, writers block). Rendered by the ONE {@link import('../makesql/compile-select').lockTail}
   * tail the v1 imperative builder also uses, so the declared read and an ad-hoc one lock identically.
   *
   * A locking read only has meaning inside a transaction, and only PostgreSQL / MySQL parse the
   * clause — SQLite has no per-statement row lock (it serializes writers on the connection).
   */
  readonly lock?: 'update' | 'share';
  /** Eagerly-selected relations (batched, N+1-free). */
  readonly with?: readonly RelationSelection[];
  /** #98 — read from a derived CTE (a QUERY view-model) instead of the base table. */
  readonly view?: QueryView;
  /**
   * Read the row set in EXACT-integer mode (`bigint` port). Set when the projection carries a
   * 64-bit column so the driver hands over exact values rather than rounded doubles.
   */
  readonly bigint?: boolean;
}

/** `column ← param` for a write's VALUES / SET list. */
export interface ValueBinding {
  readonly column: string;
  readonly param: string;
}

/** A statically declared single-row INSERT (optionally an upsert). */
export interface CreateEndpoint {
  readonly kind: 'create';
  readonly model: ModelClassLike;
  readonly values: readonly ValueBinding[];
  /** RETURNING projection (the emitted method's row type). */
  readonly returning?: readonly string[];
  /** Upsert conflict target columns. */
  readonly onConflict?: readonly string[];
  readonly onConflictAction?: 'update' | 'ignore';
}

/** A statically declared UPDATE. */
export interface UpdateEndpoint {
  readonly kind: 'update';
  readonly model: ModelClassLike;
  readonly set: readonly ValueBinding[];
  readonly where: readonly Predicate[];
  readonly returning?: readonly string[];
}

/** A statically declared DELETE. */
export interface DeleteEndpoint {
  readonly kind: 'delete';
  readonly model: ModelClassLike;
  readonly where: readonly Predicate[];
  readonly returning?: readonly string[];
}

/**
 * A statically declared BATCH write — ONE statement for N records.
 *
 * The bind SHAPE is the dialect's, exactly as the surviving batch builders define it (there is no
 * second builder): MySQL / SQLite expand ONE JSON param server-side (`JSON_TABLE` / `json_each`), so
 * the endpoint takes ONE record-array parameter; PostgreSQL uses `UNNEST(?::t1[], ?::t2[], …)`, which
 * binds ONE ARRAY PER COLUMN, so the endpoint takes one array parameter per column. The emitter
 * reports the parameter list it produced, so a caller never guesses.
 */
export interface CreateManyEndpoint {
  readonly kind: 'createMany';
  readonly model: ModelClassLike;
  /** The inserted columns. */
  readonly columns: readonly string[];
  /** The record-array parameter name (MySQL/SQLite). PG derives one array param per column. */
  readonly param: string;
  readonly onConflict?: readonly string[];
  readonly onConflictAction?: 'update' | 'ignore';
}

/** A statically declared batch UPDATE (`updateMany`) — see {@link CreateManyEndpoint} for the bind shape. */
export interface UpdateManyEndpoint {
  readonly kind: 'updateMany';
  readonly model: ModelClassLike;
  /** The match key columns. */
  readonly keyColumns: readonly string[];
  /** The columns each record sets. */
  readonly columns: readonly string[];
  readonly param: string;
}

/** A statically declared batch DELETE (`deleteMany`) — a key-set DELETE bound as ONE key array. */
export interface DeleteManyEndpoint {
  readonly kind: 'deleteMany';
  readonly model: ModelClassLike;
  /** The key column whose value set is deleted. */
  readonly keyColumn: string;
  readonly param: string;
}

/** Every declared endpoint kind. */
export type Endpoint =
  | ReadEndpoint
  | CreateEndpoint
  | UpdateEndpoint
  | DeleteEndpoint
  | CreateManyEndpoint
  | UpdateManyEndpoint
  | DeleteManyEndpoint;

/** A named set of declared endpoints — one emitted `@behavior` class. */
export type EndpointSet = Readonly<Record<string, Endpoint>>;
