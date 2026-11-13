/**
 * litedbmodel - SQL Tagged Template Literal
 *
 * Provides a `sql` tagged template function for type-safe SQL fragments.
 * Supports condition tuples (Pattern A/B), withQuery, QUERY, and execute.
 *
 * @packageDocumentation
 */

import { type Column, isColumn } from './Column';
import { DBParentRef } from './DBValues';

// ============================================
// Types
// ============================================

/**
 * A general SQL fragment with parameterized values.
 * Used for withQuery, QUERY, and execute.
 */
export interface SqlFragment {
  readonly _tag: 'SqlFragment';
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * A typed SQL fragment that preserves the Column's value type.
 * Used as the first element of a condition tuple (Pattern A).
 *
 * @typeParam V - The value type of the referenced Column
 * @typeParam M - The model type the Column belongs to
 */
export interface SqlTypedFragment<V = unknown, M = unknown> {
  readonly _tag: 'SqlTypedFragment';
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly __valueType?: V;
  readonly __modelType?: M;
}

/**
 * A SQL condition with embedded parameter values.
 * Used for Pattern B (value-embedded) conditions and value-free conditions (IS NULL).
 *
 * @typeParam M - The model type the Column belongs to
 */
export interface SqlCondition<M = unknown> {
  readonly _tag: 'SqlCondition';
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly __modelType?: M;
}

/**
 * Raw SQL string that bypasses parameterization.
 * Created via `sql.raw()`. Only usable inside `sql` tagged templates.
 */
export class SqlRaw {
  readonly _tag = 'SqlRaw' as const;
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/**
 * Table-qualified column reference (e.g., `users.id`).
 * Created via `sql.ref()`. Only usable inside `sql` tagged templates.
 */
export class SqlRef {
  readonly _tag = 'SqlRef' as const;
  readonly tableName: string;
  readonly columnName: string;

  constructor(column: { tableName: string; columnName: string }) {
    this.tableName = column.tableName;
    this.columnName = column.columnName;
  }

  toString(): string {
    return `${this.tableName}.${this.columnName}`;
  }
}

// ============================================
// SqlInterpolation - Allowed interpolation value types
// ============================================

/**
 * Union of all types allowed as interpolated values in `sql` tagged templates.
 */
export type SqlInterpolation =
  | Column<any, any>
  | SqlRaw
  | SqlRef
  | DBParentRef
  | SqlFragment
  | SqlCondition<any>
  | SqlTypedFragment<any, any>
  | number
  | string
  | boolean
  | Date
  | bigint
  | null
  | undefined
  | readonly number[]
  | readonly string[]
  | readonly boolean[]
  | readonly Date[]
  | { TABLE_NAME: string }
  | { getTableName(): string };

// ============================================
// Type Guards
// ============================================

/**
 * The mark every fragment `sql()` creates carries. A fragment's `sql` text is spliced into the
 * statement verbatim, so "is this a fragment?" decides whether a value becomes SQL text or a bound
 * parameter. It must not be answerable by the value's SHAPE: `JSON.parse` produces any shape,
 * including `{ _tag: 'SqlFragment', sql, params }`, and a request value interpolated into `sql`
 * would then run as SQL (#344). A module-private Symbol is the one property no JSON value and no
 * caller outside this module can carry, so only fragments `sql()` built are fragments.
 */
const SQL_FRAGMENT_MARK: unique symbol = Symbol('litedbmodel.sqlFragment');

/** Mark a fragment `sql()` built. Non-enumerable: it does not show in spreads, JSON or equality. */
function marked<T extends SqlFragment | SqlTypedFragment | SqlCondition>(fragment: T): T {
  Object.defineProperty(fragment, SQL_FRAGMENT_MARK, { value: true });
  return fragment;
}

function isMarkedFragment(value: unknown, tag: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [SQL_FRAGMENT_MARK]?: unknown })[SQL_FRAGMENT_MARK] === true &&
    (value as { _tag?: unknown })._tag === tag
  );
}

export function isSqlFragment(value: unknown): value is SqlFragment {
  return isMarkedFragment(value, 'SqlFragment');
}

export function isSqlTypedFragment(value: unknown): value is SqlTypedFragment {
  return isMarkedFragment(value, 'SqlTypedFragment');
}

export function isSqlCondition(value: unknown): value is SqlCondition {
  return isMarkedFragment(value, 'SqlCondition');
}

/**
 * Matches any of SqlFragment, SqlTypedFragment, or SqlCondition.
 */
export function isAnySqlFragment(
  value: unknown
): value is SqlFragment | SqlTypedFragment | SqlCondition {
  return isSqlFragment(value) || isSqlTypedFragment(value) || isSqlCondition(value);
}

export function isSqlRaw(value: unknown): value is SqlRaw {
  return value instanceof SqlRaw;
}

export function isSqlRef(value: unknown): value is SqlRef {
  return value instanceof SqlRef;
}

// ============================================
// Internal helpers
// ============================================

/**
 * A model class interpolated as its table name. Only a class (a function) qualifies: a plain object
 * with a `TABLE_NAME` string is what `JSON.parse` returns for `{"TABLE_NAME": "..."}`, and accepting
 * it would splice a request value into the statement as SQL text (#344).
 */
function hasTableName(value: unknown): value is { TABLE_NAME: string } {
  return (
    typeof value === 'function' &&
    'TABLE_NAME' in value &&
    typeof (value as { TABLE_NAME: unknown }).TABLE_NAME === 'string' &&
    !isColumn(value)
  );
}

function isIdentifierLike(val: unknown): boolean {
  return (
    isColumn(val) ||
    hasTableName(val) ||
    isSqlRaw(val) ||
    isSqlRef(val) ||
    val instanceof DBParentRef
  );
}

/**
 * Process a single interpolation value: append SQL part and collect params.
 */
function processInterpolation(
  val: unknown,
  sqlParts: string[],
  params: unknown[]
): void {
  if (isColumn(val)) {
    sqlParts.push(val.columnName);
  } else if (hasTableName(val)) {
    sqlParts.push((val as { TABLE_NAME: string }).TABLE_NAME);
  } else if (isSqlRaw(val)) {
    sqlParts.push(val.value);
  } else if (isSqlRef(val)) {
    sqlParts.push(`${val.tableName}.${val.columnName}`);
  } else if (val instanceof DBParentRef) {
    sqlParts.push(`${val.tableName}.${val.columnName}`);
  } else if (isAnySqlFragment(val)) {
    sqlParts.push(val.sql);
    if ('params' in val && Array.isArray(val.params)) {
      params.push(...val.params);
    }
  } else if (Array.isArray(val)) {
    if (val.length === 0) {
      sqlParts.push('NULL');
    } else {
      const placeholders = val.map(() => '?');
      for (const v of val) {
        params.push(v);
      }
      sqlParts.push(placeholders.join(', '));
    }
  } else if (val === null || val === undefined) {
    sqlParts.push('NULL');
  } else {
    params.push(val);
    sqlParts.push('?');
  }
}

// ============================================
// sql tagged template function (overloads)
// ============================================

/**
 * Single Column interpolation → SqlTypedFragment (for Pattern A tuples or IS NULL conditions).
 */
export function sql<V, M>(
  strings: TemplateStringsArray,
  col: Column<V, M>
): SqlTypedFragment<V, M>;

/**
 * Single Column + 1 value → SqlCondition (Pattern B: `sql\`${Col} > ${value}\``).
 */
export function sql<V, M>(
  strings: TemplateStringsArray,
  col: Column<V, M>,
  value: V
): SqlCondition<M>;

/**
 * Single Column + 2 values → SqlCondition (Pattern B: BETWEEN).
 */
export function sql<V, M>(
  strings: TemplateStringsArray,
  col: Column<V, M>,
  v1: V,
  v2: V
): SqlCondition<M>;

/**
 * Single Column + array → SqlCondition (Pattern B: IN).
 */
export function sql<V, M>(
  strings: TemplateStringsArray,
  col: Column<V, M>,
  values: readonly V[]
): SqlCondition<M>;

/**
 * Multiple Columns / TABLE_NAME only → SqlFragment (for QUERY).
 */
export function sql(
  strings: TemplateStringsArray,
  ...values: (Column<any, any> | { TABLE_NAME: string } | SqlRaw | SqlRef | DBParentRef)[]
): SqlFragment;

/**
 * General: mixed interpolation → SqlFragment (for withQuery / execute).
 */
export function sql(
  strings: TemplateStringsArray,
  ...values: SqlInterpolation[]
): SqlFragment;

// Implementation
export function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SqlFragment | SqlTypedFragment | SqlCondition {
  // Analyze interpolated values
  let firstColumn: Column<any, any> | null = null;
  let columnCount = 0;
  let valueCount = 0;
  let otherIdentifierCount = 0;

  for (const val of values) {
    if (isColumn(val)) {
      columnCount++;
      if (!firstColumn) firstColumn = val;
    } else if (isIdentifierLike(val)) {
      otherIdentifierCount++;
    } else if (isAnySqlFragment(val)) {
      otherIdentifierCount++;
    } else {
      valueCount++;
    }
  }

  // Condition patterns: exactly 1 Column, no other identifiers, first interpolation is the Column
  const isConditionPattern =
    columnCount === 1 && otherIdentifierCount === 0 && isColumn(values[0]);

  // Single Column, no values → SqlTypedFragment (Pattern A / IS NULL)
  if (isConditionPattern && valueCount === 0 && values.length === 1) {
    const col = values[0] as Column;
    const sqlStr = strings[0] + col.columnName + strings[1];
    return marked({
      _tag: 'SqlTypedFragment',
      sql: sqlStr,
      params: [],
    } as SqlTypedFragment);
  }

  // Build SQL and params
  const sqlParts: string[] = [];
  const params: unknown[] = [];

  for (let i = 0; i < strings.length; i++) {
    sqlParts.push(strings[i]);
    if (i < values.length) {
      processInterpolation(values[i], sqlParts, params);
    }
  }

  const sqlString = sqlParts.join('');

  // Single Column + value(s) only → SqlCondition (Pattern B)
  if (isConditionPattern && valueCount > 0) {
    return marked({
      _tag: 'SqlCondition',
      sql: sqlString,
      params,
    } as SqlCondition);
  }

  // Default: SqlFragment
  return marked({
    _tag: 'SqlFragment' as const,
    sql: sqlString,
    params,
  });
}

// ============================================
// Helper methods on sql
// ============================================

/**
 * Create a raw SQL string that is embedded directly (not parameterized).
 * Use for dynamic SQL keywords like ORDER direction, DISTINCT, etc.
 *
 * **SECURITY WARNING: Never pass user input to sql.raw().
 * Values from request parameters, headers, query strings, body fields,
 * or unvalidated LLM output must use parameterized queries instead.**
 *
 * @example
 * ```typescript
 * // ✅ Safe: hardcoded trusted values
 * const direction = sql.raw(isAsc ? 'ASC' : 'DESC');
 * sql`SELECT * FROM users ORDER BY name ${direction}`
 *
 * // ❌ UNSAFE: user input
 * sql.raw(req.query.sort) // SQL INJECTION RISK
 * ```
 */
sql.raw = function (value: string): SqlRaw {
  return new SqlRaw(value);
};

/**
 * Create a table-qualified column reference (e.g., `users.id`).
 * Use for JOINs where table disambiguation is needed.
 *
 * @example
 * ```typescript
 * sql`SELECT ${sql.ref(User.id)}, ${sql.ref(Post.title)}
 *     FROM users JOIN posts ON ${sql.ref(User.id)} = ${sql.ref(Post.user_id)}`
 * ```
 */
sql.ref = function (column: { tableName: string; columnName: string }): SqlRef {
  return new SqlRef(column);
};
