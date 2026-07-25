/**
 * litedbmodel v2 SCP — SELECT compile → `makeSQL`, reproducing the ORIGINAL
 * `DBModel._buildSelectSQL` text byte-for-byte (the internal builder `find()` uses):
 *
 *   [WITH <cte> AS (…) ]SELECT <cols> FROM <t>[ <join>][ WHERE <cond>]
 *     [ GROUP BY <group>][ ORDER BY <order>][ LIMIT <n>][ OFFSET <n>][ <row lock>][ <append>]
 *
 * A STATIC LIMIT/OFFSET is an INLINE literal (`LIMIT 10`), NOT a parameter — the original
 * inlines it (`sql += \` LIMIT ${options.limit}\``); reproduced here byte-for-byte. A page
 * whose POSITION is a runtime value binds instead ({@link BoundCount} → `LIMIT ?`), which is
 * the same `{sql, params}` bundle with one more `?`. The row-lock tail ({@link lockTail} —
 * ` FOR UPDATE` / ` FOR SHARE`), GROUP BY and the raw `append` tail are the original's exact
 * text. HAVING is carried through `append` (v1 core has no dedicated HAVING; the .rs-only
 * HAVING is not the PG anchor).
 *
 * Param order matches the original exactly: CTE params → JOIN params → WHERE params, then
 * the tail's own bound counts (LIMIT then OFFSET) — the order their `?`s occupy in the text.
 */

import type { ConditionObject } from '../../DBConditions';
import { orderToString } from '../../Column';
import type { OrderSpec } from '../../Column';
import type { MakeSQL } from './makesql';
import { formatterFor } from './compile';
import { conditionsFor } from './json-array';
import type { Dialect } from './handler';

/**
 * A LIMIT / OFFSET count BOUND as a parameter (` LIMIT ?`) instead of inlined (` LIMIT 10`).
 *
 * `bind` is the value that fills the placeholder — it joins the bundle's own `params` list at the
 * slot its `?` occupies, exactly like every WHERE value, so the tail needs no vocabulary of its own.
 * A caller that has no VALUE yet (the emitter, which binds a method PARAMETER) passes its parameter
 * sentinel here and reads it back out of `params`.
 */
export interface BoundCount {
  bind: unknown;
}

/** Structural guard: a bound count is the `{bind}` wrapper; a static one is a plain number. */
function isBoundCount(c: number | BoundCount): c is BoundCount {
  return typeof c === 'object' && c !== null && 'bind' in c;
}

/** The row-lock request a SELECT carries: an EXCLUSIVE (`FOR UPDATE`) or a SHARED (`FOR SHARE`) lock. */
export interface RowLockOptions {
  /** Lock the selected rows EXCLUSIVELY — no other tx may read-for-update or write them. */
  forUpdate?: boolean;
  /** Lock the selected rows for SHARE — concurrent readers may share the lock, writers block. */
  forShare?: boolean;
}

/**
 * The row-lock tail (` FOR UPDATE` / ` FOR SHARE`, or `''`) — the SINGLE aggregation point both the
 * v1 imperative builder (`DBModel._buildSelectSQL`) and {@link compileSelect} render their locking
 * clause from, so the two texts cannot drift.
 *
 * The two modes are MUTUALLY EXCLUSIVE: SQL has no "lock the same rows both exclusively and shared"
 * form, so requesting both is a hard error rather than a silent precedence (fail-closed — a caller
 * that asked for a share lock must never silently get an exclusive one, or vice versa).
 *
 * SQLite parses NEITHER clause (they are the PG / MySQL locking clauses; SQLite serializes writers
 * at the connection level instead), so a locking read is a PG / MySQL feature — the same split the
 * ` FOR UPDATE` tail has always had, and the reason the SQLite conformance twin omits it.
 */
export function lockTail(opts: RowLockOptions): string {
  if (opts.forUpdate && opts.forShare) {
    throw new Error(
      `scp select: 'forUpdate' and 'forShare' are mutually exclusive row locks — a SELECT locks its ` +
        `rows either EXCLUSIVELY (FOR UPDATE) or SHARED (FOR SHARE), never both. Pick one.`,
    );
  }
  if (opts.forUpdate) return ' FOR UPDATE';
  if (opts.forShare) return ' FOR SHARE';
  return '';
}

/** SELECT descriptor — mirrors the fields `_buildSelectSQL` reads from `SelectOptions`. */
export interface SelectDesc extends RowLockOptions {
  dialect: Dialect;
  tableName: string;
  /** SELECT column list (an explicit `options.select`). Empty/absent → falls back to {@link selectColumn}. */
  select?: string;
  /**
   * The model's `SELECT_COLUMN` (v1 `DBModel.SELECT_COLUMN`) — the fallback projection when no explicit
   * `select` is given. v1 derives the SELECT list as `options.select || this.SELECT_COLUMN`
   * (`DBModel._buildSelectSQL`:572), so a subclass that overrides `SELECT_COLUMN` must flow through here
   * rather than being hardcoded to `'*'`. Absent → the base-class default `'*'` (`DBModel.SELECT_COLUMN`).
   */
  selectColumn?: string;
  conditions?: ConditionObject;
  join?: string;
  joinParams?: unknown[];
  cte?: { name: string; sql: string; params: unknown[] };
  group?: string;
  order?: OrderSpec | string;
  limit?: number | BoundCount;
  offset?: number | BoundCount;
  append?: string;
}

/**
 * Compile a SELECT to a `makeSQL` bundle, byte-identical to `_buildSelectSQL`.
 * Empty WHERE ⇒ no ` WHERE` (matches the original's `if (whereClause)` guard).
 */
export function compileSelect(desc: SelectDesc): MakeSQL {
  const params: unknown[] = [];
  const selectCols = desc.select || (desc.selectColumn ?? '*');
  const formatter = formatterFor(desc.dialect);

  // Param order (matches SQL order): CTE params → JOIN params → WHERE params.
  if (desc.cte?.params && desc.cte.params.length > 0) params.push(...desc.cte.params);
  if (desc.joinParams && desc.joinParams.length > 0) params.push(...desc.joinParams);

  const whereClause = conditionsFor(desc.conditions ?? {}, desc.dialect).compile(params, formatter);

  let sql = '';
  if (desc.cte) sql = `WITH ${desc.cte.name} AS (${desc.cte.sql}) `;

  sql += `SELECT ${selectCols} FROM ${desc.tableName}`;
  if (desc.join) sql += ` ${desc.join}`;
  if (whereClause) sql += ` WHERE ${whereClause}`;
  if (desc.group) sql += ` GROUP BY ${desc.group}`;

  const orderClause =
    typeof desc.order === 'string' ? desc.order : orderToString(desc.order);
  if (orderClause) sql += ` ORDER BY ${orderClause}`;

  // The page tail: a static count is the original's inline literal; a bound one emits `?` and joins
  // the value list HERE, after the WHERE params — the order the `?`s occupy in the finished text.
  const count = (c: number | BoundCount): string => {
    if (!isBoundCount(c)) return String(c);
    params.push(c.bind);
    return '?';
  };
  if (desc.limit !== undefined) sql += ` LIMIT ${count(desc.limit)}`;
  if (desc.offset !== undefined) sql += ` OFFSET ${count(desc.offset)}`;
  sql += lockTail(desc);
  if (desc.append) sql += ` ${desc.append}`;

  return { sql, params };
}
