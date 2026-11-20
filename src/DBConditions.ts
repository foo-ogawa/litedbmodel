/**
 * litedbmodel - Condition Builder
 */

import { DBToken, DBSubquery, DBExists, type SqlCastFormatter } from './DBValues';

// ============================================
// Types
// ============================================

/** @internal */
export type ConditionValue =
  | string
  | number
  | boolean
  | null
  | Date
  | unknown[]
  | DBToken
  | DBConditions;

/** @internal */
export type ConditionObject = Record<string, ConditionValue>;

// ============================================
// DBConditions - Condition Builder Class
// ============================================

/** @internal */
export class DBConditions {
  protected conditions: ConditionObject;
  protected operator: 'AND' | 'OR';
  protected nested: Array<{ conditions: DBConditions; operator: 'AND' | 'OR' }>;

  constructor(conditions: ConditionObject = {}, operator: 'AND' | 'OR' = 'AND') {
    this.conditions = conditions;
    this.operator = operator;
    this.nested = [];
  }

  /**
   * Add conditions with specified operator
   */
  add(
    conditions: DBConditions | ConditionObject,
    operator: 'AND' | 'OR' = 'AND'
  ): DBConditions {
    if (conditions instanceof DBConditions) {
      this.nested.push({ conditions, operator });
    } else {
      const cond = new DBConditions(conditions, operator);
      this.nested.push({ conditions: cond, operator });
    }
    return this;
  }

  /**
   * Compile conditions to SQL WHERE clause
   * @param params - Parameter array to append values
   * @param formatter - Optional SQL cast formatter (for driver-specific casting)
   * @returns SQL WHERE clause (without 'WHERE' keyword)
   */
  compile(params: unknown[], formatter?: SqlCastFormatter): string {
    const parts: string[] = [];

    // Compile main conditions
    for (const [key, value] of Object.entries(this.conditions)) {
      const sql = this.compileCondition(key, value, params, formatter);
      if (sql) {
        parts.push(sql);
      }
    }

    // Compile nested conditions
    for (const nested of this.nested) {
      const nestedSql = nested.conditions.compile(params, formatter);
      if (nestedSql) {
        // Don't add operator here - it will be added by the join
        parts.push(`(${nestedSql})`);
      }
    }

    if (parts.length === 0) {
      return '';
    }

    // Join with operator
    return parts.join(` ${this.operator} `);
  }

  /**
   * Compile a single condition
   */
  protected compileCondition(
    key: string,
    value: ConditionValue,
    params: unknown[],
    formatter?: SqlCastFormatter
  ): string {
    // Handle __or__ special key for OR conditions
    if (key === '__or__' && Array.isArray(value)) {
      const orParts: string[] = [];
      for (const group of value as ConditionObject[]) {
        const groupCond = new DBConditions(group, 'AND');
        const groupSql = groupCond.compile(params, formatter);
        if (groupSql) {
          orParts.push(`(${groupSql})`);
        }
      }
      if (orParts.length > 0) {
        return `(${orParts.join(' OR ')})`;
      }
      return '';
    }

    // Handle __exists__ special key for EXISTS/NOT EXISTS subquery
    if (key === '__exists__' && value instanceof DBExists) {
      return value.compile(params);
    }

    // Handle __subquery__ special key for IN/NOT IN subquery
    if (key === '__subquery__' && value instanceof DBSubquery) {
      return value.compile(params);
    }

    // Handle __raw__ special key for raw SQL conditions
    if (key === '__raw__') {
      if (typeof value === 'string') {
        return value;
      }
      if (Array.isArray(value)) {
        // Check if it's [sql, params] format (first element is string, second is array)
        if (value.length === 2 && typeof value[0] === 'string' && Array.isArray(value[1])) {
          const [sql, rawParams] = value as [string, unknown[]];
          params.push(...rawParams);
          return sql;
        }
        // Multiple raw conditions - join with AND
        const rawParts = value.filter(v => typeof v === 'string') as string[];
        if (rawParts.length > 0) {
          return rawParts.join(' AND ');
        }
      }
      return '';
    }

    // Handle DBToken instances (must be before __ key skip to handle __tuple__)
    if (value instanceof DBToken) {
      return value.compile(params, key, formatter);
    }

    // Skip other nested conditions (keys starting with __)
    if (key.startsWith('__')) {
      if (value instanceof DBConditions) {
        return `(${value.compile(params, formatter)})`;
      }
      return '';
    }

    // Handle nested DBConditions
    if (value instanceof DBConditions) {
      return `(${value.compile(params, formatter)})`;
    }

    // A key carrying its own `?` placeholders (e.g. "column > ?", sql`${Col} BETWEEN ? AND ?`): the value
    // fills them — whatever its type, `null` and booleans included — so it is bound, never rendered.
    if (key.includes('?')) {
      return this.compileCustomOperator(key, value, params);
    }

    // Handle null
    if (value === null) {
      return `${key} IS NULL`;
    }

    // Handle boolean
    if (typeof value === 'boolean') {
      if (value && key.includes(' ')) {
        // Key is a SQL expression (e.g., "deleted_at IS NULL", "col >= NOW() - INTERVAL '1 day'")
        return key;
      }
      return `${key} = ${value ? 'TRUE' : 'FALSE'}`;
    }

    // Handle array (IN clause)
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return '1 = 0'; // Always false
      }

      const placeholders = value.map((v) => {
        params.push(v);
        return '?';
      });
      return `${key} IN (${placeholders.join(', ')})`;
    }

    // Default: equality
    params.push(value);
    return `${key} = ?`;
  }

  /**
   * Compile custom operator condition
   * Key already contains ? placeholders, just push params in order.
   *
   * The params are bound by POSITION, so the values must fill exactly the key's placeholders: one more or
   * one fewer shifts every later condition's value onto the wrong `?`. A count that does not match throws.
   */
  protected compileCustomOperator(
    key: string,
    value: ConditionValue,
    params: unknown[]
  ): string {
    const placeholderCount = (key.match(/\?/g) || []).length;
    const valueCount = Array.isArray(value) ? value.length : 1;
    // A single `?` receiving an array is the `IN (?)` list idiom (any length); otherwise one value per `?`.
    if (!(Array.isArray(value) && placeholderCount === 1) && valueCount !== placeholderCount) {
      throw new Error(
        `condition '${key}' has ${placeholderCount} placeholder(s) but ${valueCount} value(s)`
      );
    }
    if (Array.isArray(value)) {
      // A single `?` receiving an array is the `IN (?)` list idiom
      // (e.g. sql`${Col} IN (?)` or `col.notIn([...])`): expand the lone
      // placeholder to match the array arity, so the one `?` becomes
      // `?, ?, …`. When the key already has as many `?` as values (e.g.
      // `col BETWEEN ? AND ?`), it is a positional match — leave it as-is.
      if (placeholderCount === 1 && value.length === 0) {
        // Empty `IN (?)` list — expand to `IN (NULL)` (a valid, matches-nothing membership test)
        // rather than the invalid `IN ()` or a `?` with no bound param. No params pushed.
        return key.replace('?', 'NULL');
      }
      // Push all values regardless of expansion (positional binding order).
      for (const v of value) {
        params.push(v);
      }
      if (placeholderCount === 1 && value.length !== 1) {
        const expanded = value.map(() => '?').join(', ');
        return key.replace('?', expanded);
      }
    } else {
      // Single placeholder
      params.push(value);
    }
    // Return key as-is (already contains ? placeholders)
    return key;
  }

  /**
   * Check if conditions are empty
   */
  isEmpty(): boolean {
    return (
      Object.keys(this.conditions).length === 0 && this.nested.length === 0
    );
  }

  /**
   * Get the raw conditions object
   */
  getConditions(): ConditionObject {
    return this.conditions;
  }
}

// ============================================
// DBOrConditions - OR condition builder
// ============================================

/** @internal */
export class DBOrConditions extends DBConditions {
  constructor(conditions: ConditionObject = {}) {
    super(conditions, 'OR');
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Create AND conditions
 * @internal
 */
export function and(conditions: ConditionObject): DBConditions {
  return new DBConditions(conditions, 'AND');
}

/**
 * Create OR conditions
 * @internal
 */
export function or(conditions: ConditionObject): DBOrConditions {
  return new DBOrConditions(conditions);
}

/**
 * Normalize conditions - convert plain object to DBConditions if needed
 * @internal
 */
export function normalizeConditions(
  conditions: DBConditions | ConditionObject
): DBConditions {
  if (conditions instanceof DBConditions) {
    return conditions;
  }
  return new DBConditions(conditions);
}


/**
 * Add ONE condition to a {@link ConditionObject} as one more AND member. The object is keyed by the
 * column / SQL fragment / special key (`__or__`, `__exists__`, `__subquery__`, `__tuple__`, `__raw__`),
 * so a second member under a key already present would REPLACE the first and its predicate would vanish
 * from the WHERE. A repeat is nested as its own AND group under a fresh `__and_<n>__` key instead — the
 * nested-`DBConditions` member {@link DBConditions.compile} already renders as `(…)`.
 *
 * The one rule every builder of a condition object adds a member by.
 * @internal
 */
export function putCondition(target: ConditionObject, key: string, value: ConditionValue): void {
  if (!Object.prototype.hasOwnProperty.call(target, key)) {
    target[key] = value;
    return;
  }
  let n = 0;
  let nestedKey: string;
  do {
    nestedKey = `__and_${++n}__`;
  } while (Object.prototype.hasOwnProperty.call(target, nestedKey));
  target[nestedKey] = new DBConditions({ [key]: value });
}

/**
 * AND the given condition objects into one, member by member through {@link putCondition} (in order, so
 * the bound values keep their positions). `undefined` parts are skipped.
 * @internal
 */
export function mergeConditions(...parts: ReadonlyArray<ConditionObject | undefined>): ConditionObject {
  const out: ConditionObject = {};
  for (const part of parts) {
    if (part === undefined) continue;
    for (const [key, value] of Object.entries(part)) putCondition(out, key, value);
  }
  return out;
}

/**
 * AND a model's default filter (`@model({ filter })` → FIND_FILTER) onto `conditions` as ONE
 * parenthesized group — the `… AND (<filter>)` the select builder renders it as. `undefined` / empty ⇒
 * the conditions unchanged. The one form every read that applies the filter to a condition object uses:
 * a relation batch (v1 window and SCP) and a declared read endpoint.
 * @internal
 */
export function withDefaultFilter(conditions: ConditionObject | undefined, filter: ConditionObject | undefined): ConditionObject {
  const out = mergeConditions(conditions);
  if (filter !== undefined && Object.keys(filter).length > 0) {
    putCondition(out, '__filter__', new DBConditions(filter));
  }
  return out;
}

/**
 * The SAME default-filter group as {@link withDefaultFilter}, compiled to a WHERE fragment — for a
 * statement whose WHERE is assembled as text (a dialect builder's key predicate, the SCP write compiler)
 * rather than from a condition object: `(<filter>)` and its bound values, which the statement ANDs AFTER
 * its own predicate. `undefined` when the model declares no filter.
 * @internal
 */
export function defaultFilterFragment(
  filter: ConditionObject | undefined,
  formatter?: SqlCastFormatter
): { sql: string; params: unknown[] } | undefined {
  const group = withDefaultFilter(undefined, filter);
  if (Object.keys(group).length === 0) return undefined;
  const params: unknown[] = [];
  const sql = new DBConditions(group).compile(params, formatter);
  return { sql, params };
}
