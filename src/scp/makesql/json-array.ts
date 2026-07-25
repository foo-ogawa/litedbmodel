/**
 * litedbmodel v2 SCP — the single-JSON-param array forms for MySQL 8 + SQLite
 * (epic #43 / #45).
 *
 * ## Why this exists — the intentional deviation from v1 text
 *
 * v1's MySQL/SQLite builders expand an array into N placeholders — `col IN (?, ?, …)`
 * for an IN-list, `VALUES (?,?),(?,?),…` for a batch INSERT, `VALUES ROW(…)` /
 * `CASE WHEN` for a batch UPDATE — binding ONE param per element. PostgreSQL already
 * avoids that explosion (`= ANY(?::t[])` / `UNNEST(?::t[])` binds the whole array as a
 * SINGLE param). This module gives MySQL/SQLite the same one-param property by moving
 * the expansion SERVER-side: the array (or the batch rows) is encoded as ONE JSON
 * string param and expanded inside the engine with a `JSON_TABLE` subquery
 * (MySQL 8.0.4+) and `json_each` / `json_extract` (SQLite json1, always present via
 * better-sqlite3). The IN-list uses a `col IN (SELECT … JSON_TABLE …)` SUBQUERY (NOT
 * `MEMBER OF`) precisely so it inherits v1's `col IN (list)` type coercion — `MEMBER OF`
 * does strict JSON-type comparison and DIVERGES from v1 on cross-type IN-lists.
 *
 * This is an owner-approved improvement OVER v1 — so the emitted SQL TEXT for
 * MySQL/SQLite array/batch surfaces intentionally differs from v1. The correctness bar
 * is RESULT PARITY (same rows / same post-write state on a real MySQL 8 + SQLite),
 * proven by `test/scp/json-array-parity.test.ts`. **PostgreSQL is untouched** — it keeps
 * `= ANY` / `UNNEST` / LATERAL and stays byte-identical to v1.
 *
 * Everything here is still just TEXT inside a `makeSQL` `sql` port plus ONE JSON param —
 * no new IR kind, no new catalog leaf. The driver-side placeholder-count-expansion that
 * v1 relied on for MySQL/SQLite arrays is GONE: every dialect now binds an array as one
 * param with static SQL text.
 */

import { DBConditions, type ConditionObject, type ConditionValue } from '../../DBConditions';
import { DBToken } from '../../DBValues';
import type { SqlCastFormatter } from '../../DBValues';
import { PG_ARRAY_CAST_TOKEN } from './compile-relation';
import type { Dialect } from './handler';

/** Dialects that use the single-JSON-param array forms (everything except PostgreSQL). */
export type JsonArrayDialect = 'mysql' | 'sqlite';

/**
 * The MySQL/SQLite IN-list JSON form for a plain `col IN [values]` condition — a
 * SUBQUERY form so it inherits the SAME comparison rules as v1's `col IN (list)`
 * (crucially, MySQL's/SQLite's implicit type coercion), guaranteeing RESULT PARITY.
 *
 * - MySQL: `col IN (SELECT JSON_UNQUOTE(v) FROM JSON_TABLE(?, '$[*]' COLUMNS(v JSON PATH
 *   '$')) jt)`. `col IN (subquery)` uses the SAME type-coercion rules as `col IN (list)`
 *   — so e.g. an int column compared against JSON string values `["1","10"]` matches v1
 *   exactly (whereas `MEMBER OF` does STRICT JSON-type comparison and DIVERGES — proven
 *   on real MySQL 8). The `v JSON PATH '$'` + `JSON_UNQUOTE` extraction preserves
 *   arbitrary-length text (avoiding CHAR's 255 truncation-to-NULL) and full bigint /
 *   decimal precision, while yielding a value MySQL then coerces to the column type just
 *   like a literal in the IN-list. NO column type is required (right, since the IN
 *   condition path `DBConditions` carries none).
 * - SQLite: `col IN (SELECT value FROM json_each(?))` — `json_each` yields each element
 *   with its natural (dynamic) type and the IN-subquery inherits SQLite's affinity
 *   comparison, matching v1 (incl. cross-type int-col × string values).
 *
 * The single param is the JSON-encoded array string (`[1,2,3]`). Empty arrays are NOT
 * routed here — the caller keeps v1's `1 = 0` for the empty case (no param, exact v1
 * empty semantics). Cross-type / bigint / decimal parity vs v1 is proven on real
 * MySQL 8 + SQLite in `test/scp/json-array-parity.test.ts`.
 */
export function inListJson(dialect: JsonArrayDialect, col: string, values: unknown[]): { sql: string; param: string } {
  return { sql: inListPredicate(dialect, col), param: encodeJsonArrayParam(dialect, values) };
}

/**
 * The STATIC, value-length-INDEPENDENT membership predicate for `col` — the ONE place each dialect's
 * single-param IN-list TEXT lives, so a caller never re-spells it:
 *
 *  - **PostgreSQL**: `col = ANY(?)` with NO element-type cast (#46). A value-inferred cast is wrong for
 *    every column whose type is not recoverable from the values (`inferPgArrayType([])` = `text[]` →
 *    `integer = text` on an EMPTY int list; a uuid list is indistinguishable from text) — no-cast lets
 *    PG infer the array type FROM THE COLUMN, which is correct for int / uuid / bigint / bool /
 *    timestamp / numeric alike. This is the form a GENERATED module needs: one param, fixed text.
 *  - **MySQL / SQLite**: the single-JSON `JSON_TABLE` / `json_each` SUBQUERY described above.
 *
 * The IMPERATIVE v1 path is untouched: {@link conditionsFor} still hands PostgreSQL the base
 * `DBConditions`, whose `IN (?, ?, …)` stays byte-identical to v1 (its placeholder count is free to
 * depend on the values because it is built per request).
 */
export function inListPredicate(dialect: Dialect, col: string): string {
  if (dialect === 'postgres') return `${col} = ANY(?)`;
  if (dialect === 'mysql') return `${col} IN (SELECT JSON_UNQUOTE(v) FROM JSON_TABLE(?, '$[*]' COLUMNS(v JSON PATH '$')) jt)`;
  return `${col} IN (SELECT value FROM json_each(?))`;
}

/**
 * The STATIC composite-key membership predicate — the multi-column sibling of
 * {@link inListPredicate}, with the SAME property: a FIXED number of `?`, independent of how many key
 * tuples are bound.
 *
 *  - **PostgreSQL**: `(t.k1, t.k2) IN (SELECT * FROM UNNEST(?::<T1>, ?::<T2>))` — ONE array param PER
 *    key column (the constant-param form; v1's `dbTupleIn` binds 2×N params instead, which is the
 *    degradation this replaces). `UNNEST` needs its argument types, so `pgElementTypes` supplies one
 *    per key column, derived from the SCHEMA (the declared column type). Deriving them from the VALUES
 *    is not an option here: an EMPTY key set infers `text[]` and the statement fails
 *    `operator does not exist: integer = text` at plan time — the same trap #46 hit on the single-key
 *    IN-list, which could drop the cast entirely because `= ANY` infers from the column while `UNNEST`
 *    cannot. Omitting them falls back to the deferred
 *    {@link import('./compile-relation').PG_ARRAY_CAST_TOKEN} (resolved from the bound values).
 *  - **MySQL / SQLite**: ONE JSON array-of-tuples param read back by ORDINAL path — MySQL a
 *    `JSON_TABLE` IN-subquery (so it inherits `(k1,k2) IN ((?,?),…)`'s per-column coercion), SQLite an
 *    `EXISTS` over `json_each`.
 *
 * This is the ONE text for composite membership: the relation batch builders
 * ({@link import('./compile-relation').compileCompositeKeyStaticUnlimited}) consume the same function.
 */
export function tupleInPredicate(dialect: Dialect, table: string, columns: readonly string[], pgElementTypes?: readonly string[]): string {
  const qualified = columns.map((k) => `${table}.${k}`);
  if (dialect === 'postgres') {
    const unnest = columns.map((_, i) => `?::${pgElementTypes?.[i] ?? PG_ARRAY_CAST_TOKEN}`).join(', ');
    return `(${qualified.join(', ')}) IN (SELECT * FROM UNNEST(${unnest}))`;
  }
  if (dialect === 'mysql') {
    const cols = columns.map((_, i) => `c${i}`);
    const jtCols = cols.map((c, i) => `${c} JSON PATH '$[${i}]'`).join(', ');
    const selectCols = cols.map((c) => `JSON_UNQUOTE(${c})`).join(', ');
    return `(${qualified.join(', ')}) IN (SELECT ${selectCols} FROM JSON_TABLE(?, '$[*]' COLUMNS(${jtCols})) jt)`;
  }
  const match = columns.map((k, i) => `json_extract(je.value, '$[${i}]') = ${table}.${k}`).join(' AND ');
  return `EXISTS (SELECT 1 FROM json_each(?) je WHERE ${match})`;
}

/**
 * Encode an array as the ONE JSON param the MySQL/SQLite server-side forms expand — the SINGLE array
 * encoder, shared by {@link inListJson} (the imperative path) and the leaf transport's `encodeParams`
 * (the generated path), so the two can never diverge:
 *
 *  - a bc `int` arrives as a `BigInt`, which `JSON.stringify` cannot emit → coerced to a JSON number
 *    (`json_each` / `JSON_TABLE` compare numerically);
 *  - a BOOLEAN element serializes to `1`/`0` on MySQL, NOT JSON `true`/`false`: `JSON_UNQUOTE(v)` on
 *    JSON `true` yields the STRING `'true'`, which MySQL coerces to `0` against a TINYINT(1) — silently
 *    mismatching. `1`/`0` is exactly what v1's `col IN (?)` bound (mysql2 sends a JS bool as `1`/`0`).
 *    SQLite's `json_each` coerces JSON booleans natively, so it keeps them as-is.
 */
export function encodeJsonArrayParam(dialect: JsonArrayDialect, values: readonly unknown[]): string {
  return JSON.stringify(values, (_key, v: unknown) => {
    if (typeof v === 'bigint') return Number(v);
    if (dialect === 'mysql' && typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
}

/**
 * A dialect-aware `DBConditions` for MySQL/SQLite that replaces the v1 N-placeholder
 * IN-list (`col IN (?, ?, …)`) with the single-JSON-param form (see {@link inListJson}).
 * Every OTHER construct — eq/ne/cmp, custom-op, IS NULL, boolean literal, raw, subquery,
 * EXISTS, cast, tuple-IN, nested AND/OR — is delegated UNCHANGED to the base
 * `DBConditions`, so only the plain-array membership case deviates from v1.
 *
 * The empty-array case is left to the base class (`1 = 0`), matching v1 exactly.
 */
export class JsonArrayConditions extends DBConditions {
  private readonly _dialect: JsonArrayDialect;

  constructor(conditions: ConditionObject, dialect: JsonArrayDialect, operator: 'AND' | 'OR' = 'AND') {
    super(conditions, operator);
    this._dialect = dialect;
  }

  protected compileCondition(
    key: string,
    value: ConditionValue,
    params: unknown[],
    formatter?: SqlCastFormatter
  ): string {
    // Intercept ONLY the plain-array IN-list case (non-empty, no custom-op `?` in key,
    // not a DBToken). Everything else — including empty array (`1 = 0`), custom-op
    // arrays, tuple-IN, raw — falls through to the base class untouched.
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      !key.includes('?') &&
      !key.startsWith('__') &&
      !(value instanceof DBToken)
    ) {
      const { sql, param } = inListJson(this._dialect, key, value);
      params.push(param);
      return sql;
    }
    return super.compileCondition(key, value, params, formatter);
  }
}

/**
 * Build a `DBConditions` appropriate for the dialect: PostgreSQL gets the base class
 * (v1 byte-identical IN-list), MySQL/SQLite get {@link JsonArrayConditions} (single-JSON
 * IN-list). Nested `DBConditions` inside a condition object stay base-class (they are
 * authored by callers via `new DBConditions`), so only TOP-LEVEL plain-array IN-lists on
 * MySQL/SQLite take the JSON form — which is the surface v1 expanded.
 */
export function conditionsFor(conditions: ConditionObject, dialect: Dialect): DBConditions {
  if (dialect === 'postgres') return new DBConditions(conditions);
  return new JsonArrayConditions(conditions, dialect);
}
