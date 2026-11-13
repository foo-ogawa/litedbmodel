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
 * `MEMBER OF`, which compares by strict JSON type); on MySQL the element is read as the
 * key column's declared type, so the comparison is same-typed and exact (#376).
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
import { normalizeSqlTypeToken, sqlTypeToBcScalar } from '../coltype';
import { PG_ARRAY_CAST_TOKEN, inferPgArrayType } from './compile-relation';
import { pgTypeSpecimen } from './tx';
import type { Dialect } from './handler';

/** Dialects that use the single-JSON-param array forms (everything except PostgreSQL). */
export type JsonArrayDialect = 'mysql' | 'sqlite';

/**
 * The DECLARED SQL type of each column a condition object names (`column → 'BIGINT'`), from the model's
 * schema. A column absent here has no known type and takes the untyped form ({@link mysqlKeyRead}).
 */
export type ColumnTypes = Readonly<Record<string, string>>;

/**
 * How MySQL reads ONE key element out of the JSON param — the `JSON_TABLE` column and the expression the
 * membership subquery projects ({@link mysqlKeyRead} applied to one element). */
function mysqlKeyElement(name: string, path: string, sqlType: string | undefined): { column: string; select: string } {
  const read = mysqlKeyRead(sqlType);
  return { column: `${name} ${read.type} PATH '${path}'`, select: read.text ? `JSON_UNQUOTE(${name})` : name };
}

/**
 * How MySQL reads a KEY element that is compared with a column — the ONE key rule of every MySQL
 * single-JSON-param form: the membership predicates ({@link inListPredicate} / {@link tupleInPredicate})
 * and the batch UPDATE's JOIN key (`json-batch.ts` `mysqlUpdateManyJson`). Chosen from the key column's
 * DECLARED type so the comparison against the column is SAME-TYPED and exact (#376):
 *
 *  - integer / boolean / DECIMAL / NUMERIC → `DECIMAL(65,30)`: an integer or decimal column compares to a
 *    decimal EXACTLY, and the element is read exactly whether it arrives as a JSON number (a bc `int`,
 *    {@link encodeJsonParam}) or as a digit string (a decimal is a bc `string`). A `JSON_UNQUOTE`d string
 *    would instead be compared as DOUBLE, which put every key past 2^53 — and every long-digit decimal —
 *    onto its double neighbours (`1234567890123456789` matched `…700`, `…701`, `…800`).
 *  - FLOAT / DOUBLE / REAL → `DOUBLE`.
 *  - every other type (text, uuid, date/time, json) → the element as text (`JSON_UNQUOTE`), so the
 *    column's own collation / temporal conversion applies, and arbitrary-length text survives (a
 *    `CHAR`-typed column would truncate at 255).
 *  - NO declared type → the JSON value itself: MySQL compares the column converted to JSON with the
 *    element under JSON rules, which is exact for a number key and for a string key alike and never
 *    widens to DOUBLE. It is strict on the JSON type — a digit string does not match an integer or
 *    decimal column — so the schema-carrying paths (emitter, relation, write node, decorator adapter)
 *    pass the declared type.
 *
 * An undeclared/unknown SQL type is a hard error ({@link sqlTypeToBcScalar}), never a silent text read.
 */
export function mysqlKeyRead(sqlType: string | undefined): { type: string; text: boolean } {
  return sqlType === undefined ? { type: 'JSON', text: false } : mysqlJsonRead(sqlType);
}

/**
 * How MySQL reads a JSON element for a column of the DECLARED SQL type `sqlType`: the `JSON_TABLE`
 * column type, and whether the read is the element's unquoted text. The ONE rule every MySQL
 * single-JSON-param form types a column by when the schema is known — the keys ({@link mysqlKeyRead})
 * and the batch write rows (`json-batch.ts` `mysqlJsonTableColumn`, #381):
 * integer / boolean / DECIMAL / NUMERIC → `DECIMAL(65,30)`, FLOAT / DOUBLE → `DOUBLE`, everything else
 * → `JSON` read as text. An unknown SQL type is a hard error ({@link sqlTypeToBcScalar}).
 */
export function mysqlJsonRead(sqlType: string): { type: string; text: boolean } {
  const scalar = sqlTypeToBcScalar(sqlType);
  const base = normalizeSqlTypeToken(sqlType);
  if (scalar === 'int' || scalar === 'bool' || base === 'DECIMAL' || base === 'NUMERIC') return { type: 'DECIMAL(65,30)', text: false };
  if (scalar === 'float') return { type: 'DOUBLE', text: false };
  return { type: 'JSON', text: true };
}

/**
 * The MySQL/SQLite IN-list JSON form for a plain `col IN [values]` condition — a SUBQUERY over the ONE
 * JSON param ({@link inListPredicate}), so the key set binds as a single param with static text.
 *
 * - MySQL: `col IN (SELECT <elem> FROM JSON_TABLE(?, '$[*]' COLUMNS(v <T> PATH '$')) jt)`, the element
 *   read by the column's declared type ({@link mysqlKeyElement}). NOT `MEMBER OF`, which compares by
 *   strict JSON type even when the column type is known.
 * - SQLite: `col IN (SELECT value FROM json_each(?))` — `json_each` yields each element
 *   with its natural (dynamic) type and the IN-subquery inherits SQLite's affinity
 *   comparison, matching v1 (incl. cross-type int-col × string values).
 *
 * The single param is the JSON-encoded array string (`[1,2,3]`). Empty arrays are NOT
 * routed here — the caller keeps v1's `1 = 0` for the empty case (no param, exact v1
 * empty semantics). Parity vs v1 and the exact BIGINT / DECIMAL comparison are proven on real
 * MySQL 8 + SQLite in `test/scp/json-array-parity.test.ts`.
 */
export function inListJson(dialect: JsonArrayDialect, col: string, values: unknown[], columnType?: string): { sql: string; param: string } {
  return { sql: inListPredicate(dialect, col, columnType), param: encodeJsonArrayParam(dialect, values) };
}

/**
 * The STATIC, value-length-INDEPENDENT membership predicate for `col` — the ONE place each dialect's
 * single-param IN-list TEXT lives, so a caller never re-spells it. `columnType` is the column's DECLARED
 * SQL type when the caller has the schema:
 *
 *  - **PostgreSQL**: `col = ANY(?)` with NO element-type cast (#46). A value-inferred cast is wrong for
 *    every column whose type is not recoverable from the values (`inferPgArrayType([])` = `text[]` →
 *    `integer = text` on an EMPTY int list; a uuid list is indistinguishable from text) — no-cast lets
 *    PG infer the array type FROM THE COLUMN, which is correct for int / uuid / bigint / bool /
 *    timestamp / numeric alike. This is the form a GENERATED module needs: one param, fixed text.
 *  - **MySQL**: the `JSON_TABLE` subquery, the element typed from `columnType` ({@link mysqlKeyElement}).
 *  - **SQLite**: the `json_each` subquery (SQLite compares a stored integer and a JSON integer exactly).
 *
 * The IMPERATIVE v1 path is untouched: {@link conditionsFor} still hands PostgreSQL the base
 * `DBConditions`, whose `IN (?, ?, …)` stays byte-identical to v1 (its placeholder count is free to
 * depend on the values because it is built per request).
 */
export function inListPredicate(dialect: Dialect, col: string, columnType?: string): string {
  if (dialect === 'postgres') return `${col} = ANY(?)`;
  if (dialect === 'mysql') {
    const e = mysqlKeyElement('v', '$', columnType);
    return `${col} IN (SELECT ${e.select} FROM JSON_TABLE(?, '$[*]' COLUMNS(${e.column})) jt)`;
  }
  return `${col} IN (SELECT value FROM json_each(?))`;
}

/**
 * The STATIC composite-key membership predicate — the multi-column sibling of
 * {@link inListPredicate}, with the SAME property: a FIXED number of `?`, independent of how many key
 * tuples are bound. `columnTypes` are the key columns' DECLARED SQL types (positional with `columns`;
 * `undefined` where unknown), from the SCHEMA — never from the values, which are unknown at compile and
 * empty often enough to matter:
 *
 *  - **PostgreSQL**: `(t.k1, t.k2) IN (SELECT * FROM UNNEST(?::<T1>, ?::<T2>))` — ONE array param PER
 *    key column (the constant-param form; v1's `dbTupleIn` binds 2×N params instead, which is the
 *    degradation this replaces). `UNNEST` needs its argument types, derived here from the declared type
 *    (`pgTypeSpecimen` → `inferPgArrayType`). Deriving them from the VALUES is not an option: an EMPTY
 *    key set infers `text[]` and the statement fails `operator does not exist: integer = text` at plan
 *    time — the same trap #46 hit on the single-key IN-list, which could drop the cast entirely because
 *    `= ANY` infers from the column while `UNNEST` cannot. Without `columnTypes` the cast is the deferred
 *    {@link import('./compile-relation').PG_ARRAY_CAST_TOKEN} (resolved from the bound values).
 *  - **MySQL**: ONE JSON array-of-tuples param read back by ORDINAL path in a `JSON_TABLE` IN-subquery,
 *    each element typed from its column ({@link mysqlKeyElement}).
 *  - **SQLite**: a `json_each` IN-subquery projecting the tuple's ordinal paths.
 *
 * Every dialect's form is an IN over a subquery the planner evaluates ONCE — the whole point of binding
 * the key set as a single param. A CORRELATED predicate over the same param (an `EXISTS` whose body
 * compares against the outer row) re-expands the key set for every outer row and leaves the key columns
 * unusable as an index lookup, so the batch load degrades as rows × keys.
 *
 * This is the ONE text for composite membership: the relation batch builders
 * ({@link import('./compile-relation').compileCompositeKeyStaticUnlimited}) consume the same function.
 */
export function tupleInPredicate(dialect: Dialect, table: string, columns: readonly string[], columnTypes?: readonly (string | undefined)[]): string {
  const qualified = columns.map((k) => `${table}.${k}`);
  if (dialect === 'postgres') {
    const unnest = columns
      .map((_, i) => {
        const declared = columnTypes?.[i];
        return `?::${declared === undefined ? PG_ARRAY_CAST_TOKEN : inferPgArrayType([pgTypeSpecimen(declared)])}`;
      })
      .join(', ');
    return `(${qualified.join(', ')}) IN (SELECT * FROM UNNEST(${unnest}))`;
  }
  if (dialect === 'mysql') {
    const elements = columns.map((_, i) => mysqlKeyElement(`c${i}`, `$[${i}]`, columnTypes?.[i]));
    const jtCols = elements.map((e) => e.column).join(', ');
    const selectCols = elements.map((e) => e.select).join(', ');
    return `(${qualified.join(', ')}) IN (SELECT ${selectCols} FROM JSON_TABLE(?, '$[*]' COLUMNS(${jtCols})) jt)`;
  }
  const projected = columns.map((_, i) => `json_extract(value, '$[${i}]')`).join(', ');
  return `(${qualified.join(', ')}) IN (SELECT ${projected} FROM json_each(?))`;
}

/**
 * Encode an array as the ONE JSON param a server-side form expands — the SINGLE array encoder, shared
 * by {@link inListJson} (the imperative path) and the leaf transport's `encodeParams` (the generated
 * path), so the two can never diverge. MySQL/SQLite bind every array this way; PostgreSQL binds its
 * scalar arrays natively and only its composite key TUPLE sets here ({@link tupleInPredicate} /
 * the composite relation batch):
 *
 *  - a bc `int` arrives as a `BigInt`, which `JSON.stringify` cannot emit → coerced to a JSON number
 *    (`json_each` / `JSON_TABLE` compare numerically);
 *  - a BOOLEAN element serializes to `1`/`0` on MySQL, NOT JSON `true`/`false`: `JSON_UNQUOTE(v)` on
 *    JSON `true` yields the STRING `'true'`, which MySQL coerces to `0` against a TINYINT(1) — silently
 *    mismatching. `1`/`0` is exactly what v1's `col IN (?)` bound (mysql2 sends a JS bool as `1`/`0`).
 *    SQLite's `json_each` coerces JSON booleans natively, so it keeps them as-is.
 */
export function encodeJsonArrayParam(dialect: Dialect, values: readonly unknown[]): string {
  return encodeJsonParam(dialect, values);
}

/**
 * Marks a bc `int` while it passes through `JSON.stringify`, which refuses a BigInt outright. The
 * sentinel is spliced back out as a bare JSON number token below, so the digits survive.
 */
const BIGINT_SENTINEL = '\u0000int:';

/**
 * The ONE JSON-param serializer every single-JSON-param form goes through — the array/tuple sets here and
 * the batch record sets in {@link import('./json-batch')} alike. Both bind values that came OFF a read, so
 * both meet the same two cases (a bc `int` is a `BigInt`, which `JSON.stringify` refuses; a MySQL boolean
 * must ride as 1/0), and a second bare `JSON.stringify` would silently diverge on either.
 *
 * A bc `int` is written as a JSON NUMBER TOKEN carrying every digit — `JSON.stringify` cannot emit one
 * (it throws on a BigInt), and routing it through `Number` LOSES the value: an id past 2^53 was rounded
 * inside the JSON text and the rounded id is what MySQL/SQLite stored, silently. JSON numbers are
 * arbitrary-precision by grammar, and both `JSON_TABLE` (MySQL) and `json_each` (SQLite) read an
 * integer literal within i64 exactly — which is the whole range bc's `int` admits.
 */
export function encodeJsonParam(dialect: Dialect, payload: unknown): string {
  const tagged = JSON.stringify(payload, (_key, v: unknown) => {
    if (typeof v === 'bigint') return `${BIGINT_SENTINEL}${v.toString()}`;
    if (dialect === 'mysql' && typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
  // Unquote the tagged values back into bare number tokens. The sentinel starts with a NUL, which
  // `JSON.stringify` escapes as `\u0000` inside any string a caller could supply, so a payload cannot
  // forge one.
  return tagged.replace(/"\\u0000int:(-?\d+)"/g, '$1');
}

/**
 * A dialect-aware `DBConditions` for MySQL/SQLite that replaces the v1 N-placeholder
 * IN-list (`col IN (?, ?, …)`) with the single-JSON-param form (see {@link inListJson}).
 * Every OTHER construct — eq/ne/cmp, custom-op, IS NULL, boolean literal, raw, subquery,
 * EXISTS, cast, tuple-IN, nested AND/OR — is delegated UNCHANGED to the base
 * `DBConditions`, so only the plain-array membership case deviates from v1.
 *
 * The empty-array case is left to the base class (`1 = 0`), matching v1 exactly. `columnTypes` carries
 * the DECLARED type of each column the conditions name, which types the MySQL element (#376).
 */
export class JsonArrayConditions extends DBConditions {
  private readonly _dialect: JsonArrayDialect;
  private readonly _columnTypes: ColumnTypes;

  constructor(conditions: ConditionObject, dialect: JsonArrayDialect, operator: 'AND' | 'OR' = 'AND', columnTypes: ColumnTypes = {}) {
    super(conditions, operator);
    this._dialect = dialect;
    this._columnTypes = columnTypes;
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
      const { sql, param } = inListJson(this._dialect, key, value, this._columnTypes[key]);
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
 * MySQL/SQLite take the JSON form — which is the surface v1 expanded. `columnTypes` (the declared
 * column types, when the caller has the schema) types the MySQL IN-list element ({@link inListPredicate}).
 */
export function conditionsFor(conditions: ConditionObject, dialect: Dialect, columnTypes?: ColumnTypes): DBConditions {
  if (dialect === 'postgres') return new DBConditions(conditions);
  return new JsonArrayConditions(conditions, dialect, 'AND', columnTypes);
}
