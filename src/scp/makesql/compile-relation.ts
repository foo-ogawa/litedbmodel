/**
 * litedbmodel v2 SCP — RELATION batch-load compile → `makeSQL`, reproducing the
 * ORIGINAL `LazyRelation` SQL text byte-for-byte across all shapes and dialects:
 *
 *   single-key, unlimited:
 *     PG           `SELECT … FROM t WHERE t.key = ANY(?::type[])[ AND <filters>][ ORDER BY …]`
 *     MySQL/SQLite `SELECT … FROM t WHERE t.key IN (?, …)[ AND <filters>][ ORDER BY …]`
 *   single-key, per-parent limit:
 *     PG           `SELECT t.* FROM unnest(?::type[]) AS _keys(key) CROSS JOIN LATERAL
 *                    (SELECT * FROM t WHERE t.key = _keys.key[ AND <filters>] ORDER BY … LIMIT n) t`
 *     MySQL/SQLite `WITH ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY key ORDER BY …) AS _rn
 *                    FROM t WHERE key IN (?, …)[ AND <filters>]) SELECT * FROM ranked WHERE _rn <= n`
 *   composite-key, unlimited:
 *     PG           `SELECT … FROM t JOIN unnest(?::t1[], ?::t2[]) AS _u(a1, a2) ON t.k1=_u.a1 AND …`
 *     MySQL/SQLite `SELECT … FROM t WHERE (k1, k2) IN ((?, ?), …)`
 *   composite-key, per-parent limit: PG LATERAL composite / others ROW_NUMBER composite.
 *
 * The STATIC composite forms ({@link compileCompositeKeyStaticUnlimited} /
 * {@link compileCompositeKeyStaticLimited}) deviate from those v1 texts on EVERY dialect: they bind
 * the key set as ONE array-of-tuples param (RESULT parity, not byte-identity) so a composite batch
 * rides the same three-leaf transport as everything else. The v1 texts stay proven by the
 * value-expanding builders below.
 *
 * The PG type text (`?::type[]`) comes from the ORIGINAL `inferPgArrayType` (sqlCast
 * wins, else element-type inference). The .rs regressions are NOT reproduced: PG
 * per-parent-limit is LATERAL (not ROW_NUMBER), and PG types are sqlCast-driven (not
 * text-folded).
 *
 * Inner SELECTs reuse {@link compileSelect} — the same text `buildSelectSQL` yields —
 * so the whole shape is byte-faithful to the original relation builder.
 */

import { DBConditions, type ConditionObject } from '../../DBConditions';
import { tupleInPredicate } from './json-array';
import type { MakeSQL } from './makesql';
import { compileSelect } from './compile-select';
import type { Dialect } from './handler';

/**
 * The PG ELEMENT type of a value set — the ONE type inference every PG cast in this module is built
 * on ({@link inferPgArrayType} appends `[]`; the composite key-row expansion casts each key column
 * with it). Reproduces the ORIGINAL `LazyRelation.inferPgArrayType`'s element decision (the PG
 * anchor — NOT the .rs coarse text-folding).
 */
export function inferPgElementType(values: unknown[]): string {
  if (values.length === 0) return 'text';
  const sample = values[0];
  if (typeof sample === 'number') {
    if (values.every((v) => Number.isInteger(v))) return 'int';
    return 'numeric';
  }
  if (typeof sample === 'bigint') return 'bigint';
  if (typeof sample === 'boolean') return 'boolean';
  if (sample instanceof Date) return 'timestamp';
  return 'text';
}

/**
 * Reproduce the ORIGINAL `LazyRelation.inferPgArrayType`: sqlCast wins (`<cast>[]`);
 * otherwise infer the element type from the sample values. Byte-identical to the
 * original (which is the PG anchor — NOT the .rs coarse text-folding).
 */
export function inferPgArrayType(values: unknown[], sqlCast?: string): string {
  if (sqlCast) return `${sqlCast}[]`;
  return `${inferPgElementType(values)}[]`;
}

/**
 * The DEFERRED PG array-cast token (#46): a placeholder emitted in the STATIC SQL text where
 * the `= ANY(?::<T>[])` / `UNNEST(?::<T>[])` element type `<T>` cannot be known at symbolic
 * compile time (a schema-less `whereIn`, or a relation batch compiled without concrete keys).
 * The render/handler layer resolves it from the BOUND values via {@link inferPgArrayType} — a
 * mechanical dialect-render step, the same category as the `?`→`$N` placeholder render. This
 * reproduces v1's live-PG-correct cast (`::int[]` for int keys, etc.), which v1 got because
 * `inferPgArrayType` saw the real values at runtime.
 *
 * A byte sequence no legitimate SQL identifier/type text contains, so the resolve is a safe
 * literal substring replace (never a regex over user text).
 */
export const PG_ARRAY_CAST_TOKEN = '@@PG_ARRAY_CAST@@';

/**
 * Resolve the FIRST unresolved {@link PG_ARRAY_CAST_TOKEN} in a PG SQL fragment to the element
 * type inferred from the bound `values` (v1 `inferPgArrayType`). Called at render time, once per
 * array param, left-to-right — so each deferred array cast binds the type of its own value set.
 * SQL with no token is returned unchanged (every non-deferred cast is already concrete).
 */
export function resolvePgArrayCast(sql: string, values: unknown[]): string {
  const at = sql.indexOf(PG_ARRAY_CAST_TOKEN);
  if (at < 0) return sql;
  return sql.slice(0, at) + inferPgArrayType(values) + sql.slice(at + PG_ARRAY_CAST_TOKEN.length);
}

export interface RelationCompileBase {
  dialect: Dialect;
  tableName: string;
  /** SELECT column list (default `*`). */
  select?: string;
  /** Optional relation `where`-filter conditions (`config.conditions`), merged in. */
  conditions?: ConditionObject;
  /** ORDER BY clause (raw text), or undefined. */
  order?: string;
  /** Per-column sqlCast map (drives PG `?::type[]`). */
  sqlCastMap?: Map<string, string>;
  /**
   * Emit the {@link PG_ARRAY_CAST_TOKEN} for the PG `?::<T>[]` element type instead of inferring
   * it from `values` NOW (#46). Set when the SQL text is compiled SYMBOLICALLY (placeholder keys),
   * so the element type is resolved at render from the REAL bound keys — never baked to `text[]`.
   * A `sqlCast` (concrete column type) still wins over the token.
   */
  deferPgArrayCast?: boolean;
}

/**
 * The PG array-cast element type for a batch cast, honoring `sqlCast` (concrete column type) →
 * the deferred {@link PG_ARRAY_CAST_TOKEN} (resolve at render from bound values) → inference from
 * the compile-time sample `values`. Centralizes the #43/#46 precedence for every relation shape.
 */
function pgArrayCastType(values: unknown[], sqlCast?: string, defer?: boolean): string {
  if (sqlCast) return `${sqlCast}[]`;
  if (defer) return PG_ARRAY_CAST_TOKEN;
  return inferPgArrayType(values);
}

/** The alias the PG composite key rows carry (`_keys.key0`, `_keys.key1`, … — one per key column). */
const PG_KEYS_ALIAS = '_keys';

/**
 * The compile-time stand-in for the ONE array-of-tuples key param: the STATIC composite text is
 * value-length-independent, so a single one-cell tuple fixes the param ARITY (1) and nothing else.
 * The real deduped key tuples are bound at execute time against the same text.
 */
const PLACEHOLDER_TUPLES: unknown[][] = [[null]];

/** The STATIC composite-key builders' options: {@link RelationCompileBase} + the PG key-column types. */
export interface CompositeStaticBase extends RelationCompileBase {
  /**
   * PostgreSQL only: the PG ELEMENT type of each key column, positional with `targetKeys`, derived
   * from the model's DECLARED column type (the schema SoT — never from the values, which are unknown
   * at compile and empty at call time often enough to matter; the SAME rule the composite `tupleIn`
   * predicate follows, `json-array.ts` `pgElementTypes`). The key rows carry these types so the JOIN
   * compares `int = int` / `bigint = bigint` against the child key columns instead of `… = text`.
   */
  readonly pgKeyTypes?: readonly string[];
}

/**
 * The PG composite key-set DERIVED TABLE: the ONE JSON array-of-tuples param (exactly what the
 * `pluck` leaf yields, and exactly what MySQL/SQLite already bind) expanded SERVER-side into one
 * typed row per key tuple — `key0 … keyN-1`, in `targetKeys` order.
 *
 * ONE `?`, fixed text, no per-column params: that is what lets a COMPOSITE relation ride the same
 * three-leaf transport as every other statement (`pluck` → `executeSQL` → `group`) — the per-column
 * `unnest(?::t1[], ?::t2[])` form needed a key-tuple TRANSPOSE that no composition of the three
 * leaves can express (#159). `->>` yields text and the declared per-column cast normalizes it, so a
 * key bound as a JSON number and one bound as a JSON string (a BIGINT read arrives as a string) both
 * compare equal to the child column.
 *
 * The SINGLE spelling of the expansion — both static composite forms (unlimited JOIN + per-parent
 * LATERAL) consume it, so their key rows cannot drift apart.
 */
function pgCompositeKeyRows(opts: { tableName: string; targetKeys: readonly string[]; pgKeyTypes?: readonly string[] }): string {
  const cols = opts.targetKeys.map((key, i) => {
    const type = opts.pgKeyTypes?.[i];
    if (type === undefined || type === '') {
      throw new Error(
        `relation batch on postgres: the composite key column '${opts.tableName}.${key}' has no declared type — ` +
          `the key rows must be cast to the child column's type (pass the model's ColumnTypeResolver to compileRelationOp)`,
      );
    }
    return `(_t->>${i})::${type} AS key${i}`;
  });
  return `(SELECT ${cols.join(', ')} FROM json_array_elements(?::json) AS _t) AS ${PG_KEYS_ALIAS}`;
}

/**
 * The STATIC composite-key batch forms (#47 item 1) — length-INDEPENDENT so the compiled `op.sql`
 * is fixed (ONE JSON array-of-tuples param on EVERY dialect), the SAME static-op property the
 * single-key relation forms have. Every dialect now consumes the SAME single key param the relation
 * key set is produced as (`pluck` — one array of key TUPLES): MySQL/SQLite expand it with
 * `JSON_TABLE`/`json_each`, PostgreSQL with {@link pgCompositeKeyRows} (#159). This is the
 * owner-approved deviation the single-key IN-list and the batch UPDATE composite already use —
 * RESULT parity, NOT byte-identity with v1; the v1 literal `(k1,k2) IN ((?,?),…)` /
 * `unnest(?::t1[], ?::t2[])` byte-forms stay proven by the goldens
 * {@link compileCompositeKeyUnlimited} / {@link compileCompositeKeyLimited}.
 *
 * The JSON tuple param is `[[k1a,k2a],[k1b,k2b],…]` (positional element arrays), read back by
 * ordinal path (`$[0]`, `$[1]`, …) so no per-column JSON key names are needed.
 */
export function compileCompositeKeyStaticUnlimited(
  opts: CompositeStaticBase & { targetKeys: string[] },
): MakeSQL {
  const { tableName, targetKeys } = opts;
  if (opts.dialect === 'postgres') {
    // PG: JOIN the child table to the typed key rows the ONE JSON tuple param expands to.
    const joinConditions = targetKeys.map((key, i) => `${tableName}.${key} = ${PG_KEYS_ALIAS}.key${i}`).join(' AND ');
    const joinClause = `JOIN ${pgCompositeKeyRows(opts)} ON ${joinConditions}`;
    return compileSelect({
      dialect: opts.dialect,
      tableName,
      select: opts.select,
      join: joinClause,
      joinParams: [PLACEHOLDER_TUPLES],
      conditions: opts.conditions,
      order: opts.order,
    });
  }
  // MySQL/SQLite: composite membership via ONE JSON array-of-tuples param, read by ORDINAL path.
  const jsonSubquery = compositeJsonMembership(opts.dialect, tableName, targetKeys);
  const conditions: ConditionObject = { ...opts.conditions, __raw__: [jsonSubquery, PLACEHOLDER_TUPLES] };
  return compileSelect({
    dialect: opts.dialect,
    tableName,
    select: opts.select,
    conditions,
    order: opts.order,
  });
}

/**
 * The MySQL/SQLite composite-membership predicate over ONE JSON array-of-tuples param — the SAME text
 * a declared composite `tupleIn` WHERE emits, so it lives with the other static membership predicates
 * ({@link import('./json-array').tupleInPredicate}) and is consumed here, never re-spelled.
 */
function compositeJsonMembership(dialect: Dialect, tableName: string, targetKeys: string[]): string {
  return tupleInPredicate(dialect, tableName, targetKeys);
}

// ============================================================================
// Single-key, unlimited.
// ============================================================================

/**
 * `= ANY(?::type[])` (PG) / `IN (?, …)` (MySQL/SQLite) single-key unlimited batch load.
 * Reproduces `batchLoadWithAnyArray` (PG) and `batchLoadWithIn` (others).
 *
 * The key array binds as ONE param on PG (`values` is a single array param); on
 * MySQL/SQLite the original passes the array to `DBConditions` which expands it to
 * `IN (?, ?, …)` with one param per element — reproduced here verbatim.
 */
export function compileSingleKeyUnlimited(
  opts: RelationCompileBase & { targetKey: string; values: unknown[] }
): MakeSQL {
  if (opts.dialect === 'postgres') {
    const sqlCast = opts.sqlCastMap?.get(opts.targetKey);
    const pgType = pgArrayCastType(opts.values, sqlCast, opts.deferPgArrayCast);
    const conditions: ConditionObject = {
      __raw__: [`${opts.tableName}.${opts.targetKey} = ANY(?::${pgType})`, [opts.values]],
      ...opts.conditions,
    };
    return compileSelect({
      dialect: opts.dialect,
      tableName: opts.tableName,
      select: opts.select,
      conditions,
      order: opts.order,
    });
  }
  // MySQL/SQLite: `{ ...conditions, [targetKey]: values }` → `IN (?, …)` (array expand).
  const conditions: ConditionObject = { ...opts.conditions, [opts.targetKey]: opts.values };
  return compileSelect({
    dialect: opts.dialect,
    tableName: opts.tableName,
    select: opts.select,
    conditions,
    order: opts.order,
  });
}

// ============================================================================
// Single-key, per-parent limit.
// ============================================================================

/**
 * Per-parent-limit single-key batch load: PG `CROSS JOIN LATERAL` (the v1 anchor —
 * NOT the .rs ROW_NUMBER regression); MySQL/SQLite `ROW_NUMBER() OVER (PARTITION BY …)`.
 * Reproduces `batchLoadWithLateral` / `batchLoadWithRowNumber`.
 */
export function compileSingleKeyLimited(
  opts: RelationCompileBase & { targetKey: string; values: unknown[]; limit: number }
): MakeSQL {
  if (opts.dialect === 'postgres') {
    const sqlCast = opts.sqlCastMap?.get(opts.targetKey);
    const pgType = pgArrayCastType(opts.values, sqlCast, opts.deferPgArrayCast);
    const lateralConditions: ConditionObject = {
      __raw__: `${opts.tableName}.${opts.targetKey} = _keys.key`,
      ...opts.conditions,
    };
    const inner = compileSelect({
      dialect: opts.dialect,
      tableName: opts.tableName,
      conditions: lateralConditions,
      order: opts.order,
      limit: opts.limit,
    });
    const sql =
      `SELECT ${opts.tableName}.* FROM unnest(?::${pgType}) AS _keys(key) ` +
      `CROSS JOIN LATERAL (${inner.sql}) ${opts.tableName}`;
    return { sql, params: [opts.values, ...inner.params] };
  }

  // MySQL/SQLite: ROW_NUMBER() CTE.
  const orderBy = opts.order || opts.targetKey;
  const cteConditions: ConditionObject = { [opts.targetKey]: opts.values, ...opts.conditions };
  const cte = compileSelect({
    dialect: opts.dialect,
    tableName: opts.tableName,
    select: `*, ROW_NUMBER() OVER (PARTITION BY ${opts.targetKey} ORDER BY ${orderBy}) AS _rn`,
    conditions: cteConditions,
  });
  return compileSelect({
    dialect: opts.dialect,
    tableName: 'ranked',
    conditions: { __raw__: `_rn <= ${opts.limit}` },
    cte: { name: 'ranked', sql: cte.sql, params: cte.params },
  });
}

// ============================================================================
// Composite-key, unlimited.
// ============================================================================

/** Transpose tuples to per-column arrays: `[[1,a],[2,b]] → [[1,2],[a,b]]`. */
function transpose(targetKeys: string[], tuples: unknown[][]): unknown[][] {
  return targetKeys.map((_, colIndex) => tuples.map((t) => t[colIndex]));
}

/**
 * Composite-key unlimited batch load: PG `JOIN unnest(?::t1[], ?::t2[]) AS _u(a,b) ON …`
 * (reproduces `batchLoadWithUnnestJoin`); MySQL/SQLite `(k1, k2) IN ((?, ?), …)`
 * (reproduces `batchLoadWithCompositeIn` via `DBTupleIn`).
 */
export function compileCompositeKeyUnlimited(
  opts: RelationCompileBase & { targetKeys: string[]; tuples: unknown[][] }
): MakeSQL {
  const { tableName, targetKeys, tuples } = opts;
  if (opts.dialect === 'postgres') {
    const columnArrays = transpose(targetKeys, tuples);
    const unnestParams = columnArrays
      .map((arr, i) => `?::${inferPgArrayType(arr, opts.sqlCastMap?.get(targetKeys[i]))}`)
      .join(', ');
    const unnestAlias = `_unnest_${tableName}`;
    const columnAliases = targetKeys.map((k) => `_unnest_${tableName}_${k}`).join(', ');
    const joinConditions = targetKeys
      .map((key) => `${tableName}.${key} = ${unnestAlias}._unnest_${tableName}_${key}`)
      .join(' AND ');
    const joinClause = `JOIN unnest(${unnestParams}) AS ${unnestAlias}(${columnAliases}) ON ${joinConditions}`;
    return compileSelect({
      dialect: opts.dialect,
      tableName,
      select: opts.select,
      join: joinClause,
      joinParams: columnArrays,
      conditions: opts.conditions,
      order: opts.order,
    });
  }

  // MySQL/SQLite: (k1, k2) IN ((?, ?), …) built exactly as `batchLoadWithCompositeIn`.
  const tuplePlaceholders = tuples
    .map(() => `(${targetKeys.map(() => '?').join(', ')})`)
    .join(', ');
  const inClause = `(${targetKeys.join(', ')}) IN (${tuplePlaceholders})`;
  // The original builds base conditions FIRST then the composite IN last; DBConditions
  // preserves object key insertion order, so replicate that order.
  const conditions: ConditionObject = { ...opts.conditions, __raw__: [inClause, tuples.flat()] };
  return compileSelect({
    dialect: opts.dialect,
    tableName,
    select: opts.select,
    conditions,
    order: opts.order,
  });
}

// ============================================================================
// Composite-key, per-parent limit.
// ============================================================================

/**
 * Composite-key per-parent-limit: PG LATERAL composite (reproduces
 * `batchLoadWithLateralComposite`); MySQL/SQLite ROW_NUMBER composite (reproduces
 * `batchLoadWithRowNumberComposite`).
 */
export function compileCompositeKeyLimited(
  opts: RelationCompileBase & { targetKeys: string[]; tuples: unknown[][]; limit: number }
): MakeSQL {
  const { tableName, targetKeys, tuples, limit } = opts;

  if (opts.dialect === 'postgres') {
    const columnArrays = transpose(targetKeys, tuples);
    const unnestParams = columnArrays
      .map((arr, i) => `?::${inferPgArrayType(arr, opts.sqlCastMap?.get(targetKeys[i]))}`)
      .join(', ');
    const keyAliases = targetKeys.map((_, i) => `key${i}`).join(', ');
    const keyConditions = targetKeys
      .map((key, i) => `${tableName}.${key} = _keys.key${i}`)
      .join(' AND ');
    const lateralConditions: ConditionObject = { __raw__: keyConditions, ...opts.conditions };
    const inner = compileSelect({
      dialect: opts.dialect,
      tableName,
      conditions: lateralConditions,
      order: opts.order,
      limit,
    });
    const sql =
      `SELECT ${tableName}.* FROM unnest(${unnestParams}) AS _keys(${keyAliases}) ` +
      `CROSS JOIN LATERAL (${inner.sql}) ${tableName}`;
    return { sql, params: [...columnArrays, ...inner.params] };
  }

  // MySQL/SQLite ROW_NUMBER composite.
  const orderBy = opts.order || targetKeys.join(', ');
  const partitionBy = targetKeys.join(', ');
  const tuplePlaceholders = tuples
    .map(() => `(${targetKeys.map(() => '?').join(', ')})`)
    .join(', ');
  const inClause = `(${targetKeys.join(', ')}) IN (${tuplePlaceholders})`;
  const cteParams = tuples.flat();
  const cteConditions: ConditionObject = { __raw__: [inClause, cteParams], ...opts.conditions };
  const cte = compileSelect({
    dialect: opts.dialect,
    tableName,
    select: `*, ROW_NUMBER() OVER (PARTITION BY ${partitionBy} ORDER BY ${orderBy}) AS _rn`,
    conditions: cteConditions,
  });
  return compileSelect({
    dialect: opts.dialect,
    tableName: 'ranked',
    conditions: { __raw__: `_rn <= ${limit}` },
    cte: { name: 'ranked', sql: cte.sql, params: cte.params },
  });
}

// ============================================================================
// Composite-key, per-parent limit — STATIC (length-independent) form (#47 last gap).
// ============================================================================

/**
 * The STATIC composite-key per-parent-LIMIT batch form (#47 last completeness gap) — the
 * length-INDEPENDENT sibling of {@link compileCompositeKeyLimited}, so the compiled `op.sql` is
 * FIXED (ONE JSON array-of-tuples param on every dialect) and can be a STATIC bundle op — exactly
 * the property {@link compileSingleKeyLimited} and {@link compileCompositeKeyStaticUnlimited}
 * already have.
 *
 * The per-parent window is IDENTICAL to the single-key-limited path, over the SAME single key param:
 *   - **PG**: `CROSS JOIN LATERAL` over the typed key rows of {@link pgCompositeKeyRows} — v1's
 *     `batchLoadWithLateralComposite` window verbatim, with its per-column `unnest(?::t1[], ?::t2[])`
 *     key source replaced by the single-JSON-tuple expansion (#159), so the key set binds as the ONE
 *     array `pluck` yields.
 *   - **MySQL/SQLite**: the SAME `ROW_NUMBER() OVER (PARTITION BY <keys> ORDER BY <order>)` CTE +
 *     `_rn <= limit` filter v1's `batchLoadWithRowNumberComposite` emits — but the CTE membership
 *     WHERE is the STATIC JSON-tuple predicate ({@link compositeJsonMembership}) instead of v1's
 *     value-dependent `(k1,k2) IN ((?,?),…)`.
 *
 * Both are the owner-sanctioned static deviation the composite UNLIMITED form
 * ({@link compileCompositeKeyStaticUnlimited}) and the single-key IN-list already use: the key rows
 * select the SAME child rows the value-expanded form would and the window partitions/orders
 * identically, so it is RESULT-parity to v1 (proven live). The v1 byte-forms stay proven by the
 * golden {@link compileCompositeKeyLimited}.
 */
export function compileCompositeKeyStaticLimited(
  opts: CompositeStaticBase & { targetKeys: string[]; limit: number },
): MakeSQL {
  const { tableName, targetKeys, limit } = opts;
  if (opts.dialect === 'postgres') {
    // PG LATERAL composite — the per-parent window over the ONE JSON tuple param's typed key rows.
    const keyConditions = targetKeys
      .map((key, i) => `${tableName}.${key} = ${PG_KEYS_ALIAS}.key${i}`)
      .join(' AND ');
    const lateralConditions: ConditionObject = { __raw__: keyConditions, ...opts.conditions };
    const inner = compileSelect({
      dialect: opts.dialect,
      tableName,
      conditions: lateralConditions,
      order: opts.order,
      limit,
    });
    const sql =
      `SELECT ${tableName}.* FROM ${pgCompositeKeyRows(opts)} ` +
      `CROSS JOIN LATERAL (${inner.sql}) ${tableName}`;
    return { sql, params: [PLACEHOLDER_TUPLES, ...inner.params] };
  }

  // MySQL/SQLite: the SAME ROW_NUMBER composite CTE + `_rn <= limit` as v1, but with the STATIC
  // JSON-membership WHERE (one JSON array-of-tuples param) in place of v1's `(k1,k2) IN ((?,?),…)`.
  const orderBy = opts.order || targetKeys.join(', ');
  const partitionBy = targetKeys.join(', ');
  const jsonSubquery = compositeJsonMembership(opts.dialect, tableName, targetKeys);
  const cteConditions: ConditionObject = { __raw__: [jsonSubquery, PLACEHOLDER_TUPLES], ...opts.conditions };
  const cte = compileSelect({
    dialect: opts.dialect,
    tableName,
    select: `*, ROW_NUMBER() OVER (PARTITION BY ${partitionBy} ORDER BY ${orderBy}) AS _rn`,
    conditions: cteConditions,
  });
  return compileSelect({
    dialect: opts.dialect,
    tableName: 'ranked',
    conditions: { __raw__: `_rn <= ${limit}` },
    cte: { name: 'ranked', sql: cte.sql, params: cte.params },
  });
}

// Silence unused import in builds where DBConditions is only referenced via ConditionObject.
void DBConditions;
