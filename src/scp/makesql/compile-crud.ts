/**
 * litedbmodel v2 SCP — CRUD compile → `makeSQL` bundles, by driving the ORIGINAL
 * dialect SQL builders (`postgresSqlBuilder` / `mysqlSqlBuilder` / `sqliteSqlBuilder`)
 * and the original single-row UPDATE/DELETE text. The produced `{ sql, params }` is
 * byte-identical to what the original library sends, for every dialect and every
 * shape:
 *
 *   INSERT single (+per-col `?::sqlCast` on PG) & batch (PG UNNEST + type inference /
 *   MySQL·SQLite multi-VALUES) + ON CONFLICT (DO NOTHING / DO UPDATE incl. `= 'all'`
 *   → all columns) + RETURNING (bare / `t.col` alias / `table.col` / MySQL simulate);
 *   UPDATE single (`SET c = ?::sqlCast`) & batch (PG UNNEST / MySQL JOIN-VALUES /
 *   SQLite CASE-WHEN) + SKIP-column; DELETE; and the SELECT tail (LIMIT/OFFSET inline,
 *   FOR UPDATE, GROUP BY/HAVING) via `buildSelectSQL`.
 *
 * These delegate to the SAME builders the runtime uses, so parity is by construction.
 */

import { postgresSqlBuilder } from '../../drivers/PostgresSqlBuilder';
import { mysqlSqlBuilder } from '../../drivers/MysqlSqlBuilder';
import { sqliteSqlBuilder } from '../../drivers/SqliteSqlBuilder';
import type {
  SqlBuilder,
  InsertBuildOptions,
  UpdateManyBuildOptions,
} from '../../drivers/types';
import type { ConditionObject } from '../../DBConditions';
import { DBToken, DBImmediateValue, type SqlCastFormatter } from '../../DBValues';
import type { MakeSQL } from './makesql';
import { formatterFor } from './compile';
import { conditionsFor, encodeJsonArrayParam, tupleInPredicate, type ColumnTypes } from './json-array';
import { resolvePgArrayCast } from './compile-relation';
import {
  mysqlInsertJson,
  sqliteInsertJson,
  mysqlUpdateManyJson,
  sqliteUpdateManyJson,
  rowsHaveDbToken,
} from './json-batch';
import type { Dialect } from './handler';

/** The original dialect builder for a dialect (the exact object the runtime uses). */
export function builderFor(dialect: Dialect): SqlBuilder {
  switch (dialect) {
    case 'postgres':
      return postgresSqlBuilder;
    case 'mysql':
      return mysqlSqlBuilder;
    case 'sqlite':
      return sqliteSqlBuilder;
  }
}

// ============================================================================
// INSERT (single & batch) — driven by the original `buildInsert`.
// ============================================================================

/**
 * Compile INSERT (single or batch) to a `makeSQL` bundle via the original
 * `buildInsert`. Single-row on PG carries per-col `?::sqlCast`; batch on PG uses UNNEST
 * with type inference; MySQL/SQLite use multi-VALUES. ON CONFLICT / RETURNING are the
 * original's exact verbs. `onConflictUpdate: 'all'` expands to every column (the
 * builder's fallback), so an empty DO-UPDATE never breaks.
 */
export function compileInsert(dialect: Dialect, options: InsertBuildOptions): MakeSQL {
  const { sql, params } = builderFor(dialect).buildInsert(options);
  return { sql, params };
}

/**
 * Options for a heterogeneous `createMany`, mirroring the inputs `DBModel._insert` has
 * AFTER serialization: the serialized `records`, their paired `rawRecords`, the shared
 * `sqlCastMap` / ON CONFLICT / RETURNING. The per-group `columns` are DERIVED here (not
 * supplied) — this is the whole point of the grouping.
 */
export interface InsertManyBuildOptions {
  tableName: string;
  /** Serialized records (as `DBModel._insert` holds them after `serializeRecord`). */
  records: Record<string, unknown>[];
  /** Raw records before serialization, paired 1:1 with `records` (PG UNNEST path). */
  rawRecords?: Record<string, unknown>[];
  sqlCastMap?: Map<string, string>;
  onConflict?: string[];
  onConflictIgnore?: boolean;
  onConflictUpdate?: 'all' | string[];
  returning?: string;
}

/**
 * Compile a (possibly heterogeneous) `createMany` into a COMPOSITION of `makeSQL`
 * INSERT components — one per column-set group, exactly as `DBModel._insert`
 * (`src/DBModel.ts:928-1020`) groups records and emits one `buildInsert` per group.
 *
 * A `createMany` whose rows carry DIFFERENT column subsets is not one INSERT: the
 * production write path groups rows by their sorted-column-set pattern
 * (`patternKey = recordColumns.sort().join(',')`) so each batch INSERT is homogeneous
 * (no DEFAULT keyword), and emits ONE statement per group. In the `makeSQL` model that
 * is precisely a composition of several INSERT components — no new vocabulary. This
 * function reproduces that grouping byte-for-byte:
 *
 *  - column detection per row drops `undefined` and DEFAULT immediates, exactly as
 *    `_insert:940-946 / 958-964`;
 *  - columns are CANONICAL sorted (`recordColumns.sort()`), the pattern key is the
 *    joined sorted columns, group order is first-seen insertion order (`Map`), and each
 *    group carries its serialized + raw records paired — mirroring `_insert:955-975`;
 *  - each group's SQL text comes from the SAME original `buildInsert` (`compileInsert`),
 *    so every component is byte-identical to the statement `_insert` sends for that
 *    group.
 *
 * The composition of the returned components (via `composeMakeSQL`) is the full
 * multi-statement `createMany` the production path executes.
 */
export function compileInsertMany(dialect: Dialect, options: InsertManyBuildOptions): MakeSQL[] {
  const { records, rawRecords, tableName, sqlCastMap, onConflict, onConflictIgnore, onConflictUpdate, returning } = options;

  // Group records by their sorted-column-set pattern — mirrors DBModel._insert:928-975
  // exactly (fast single-record path + multi-record Map grouping, same DEFAULT/undefined
  // filtering, same canonical sort, same first-seen group order, same raw/serialized pair).
  const grouped = new Map<string, {
    columns: string[];
    records: Record<string, unknown>[];
    rawRecords: Record<string, unknown>[];
  }>();

  if (records.length === 1) {
    const record = records[0];
    const recordColumns: string[] = [];
    for (const key of Object.keys(record)) {
      const val = record[key];
      if (val !== undefined && !(val instanceof DBImmediateValue && val.value === 'DEFAULT')) {
        recordColumns.push(key);
      }
    }
    recordColumns.sort();
    grouped.set('_', { columns: recordColumns, records: [record], rawRecords: [rawRecords ? rawRecords[0] : record] });
  } else {
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const recordColumns: string[] = [];
      for (const key of Object.keys(record)) {
        const val = record[key];
        if (val !== undefined && !(val instanceof DBImmediateValue && val.value === 'DEFAULT')) {
          recordColumns.push(key);
        }
      }
      recordColumns.sort();
      const patternKey = recordColumns.join(',');
      if (!grouped.has(patternKey)) {
        grouped.set(patternKey, { columns: recordColumns, records: [], rawRecords: [] });
      }
      const group = grouped.get(patternKey)!;
      group.records.push(record);
      group.rawRecords.push(rawRecords ? rawRecords[i] : record);
    }
  }

  // One makeSQL INSERT component per group.
  //
  //  - PostgreSQL: UNCHANGED — the original `buildInsert` (UNNEST batch, byte-identical).
  //  - MySQL/SQLite: the single-JSON-param form (JSON_TABLE / json_each), UNLESS the
  //    group carries a DBToken value (e.g. `NOW()`) which can't be JSON-encoded — then it
  //    falls back to the original `buildInsert` multi-VALUES for that group (correctness).
  const components: MakeSQL[] = [];
  for (const { columns, records: groupRecords, rawRecords: groupRawRecords } of grouped.values()) {
    if (dialect !== 'postgres' && !rowsHaveDbToken(groupRecords, columns)) {
      const jsonOpts = { tableName, columns, records: groupRecords, onConflict, onConflictIgnore, onConflictUpdate, returning };
      components.push(dialect === 'mysql' ? mysqlInsertJson(jsonOpts) : sqliteInsertJson(jsonOpts));
      continue;
    }
    components.push(
      compileInsert(dialect, {
        tableName,
        columns,
        records: groupRecords,
        rawRecords: groupRawRecords,
        sqlCastMap,
        onConflict,
        onConflictIgnore,
        onConflictUpdate,
        returning,
      })
    );
  }
  return components;
}

// ============================================================================
// UPDATE batch — driven by the original `buildUpdateMany`.
// ============================================================================

/**
 * Compile batch UPDATE to a `makeSQL` bundle via the original `buildUpdateMany`: PG
 * UNNEST (`SET c = v.c FROM UNNEST(?::t[],…) AS v(cols) WHERE t.k = v.k`), MySQL
 * JOIN-VALUES (`JOIN (VALUES ROW(…)) AS v(…) ON … SET …`), SQLite CASE-WHEN
 * (`SET c = CASE WHEN k = ? THEN ? … END … WHERE k IN (…)`), with SKIP-column handling
 * (PG `CASE WHEN v._skip_c` / MySQL `IF(v._skip_c,…)` / SQLite `WHEN … THEN t.col`).
 */
export function compileUpdateMany(dialect: Dialect, options: UpdateManyBuildOptions): MakeSQL {
  // PostgreSQL: UNCHANGED (UNNEST). MySQL/SQLite: single-JSON-param form (JSON_TABLE
  // join / CASE-over-json_each) with SKIP preserved — unless a DBToken value is present
  // (can't be JSON-encoded), in which case fall back to the original builder.
  if (dialect !== 'postgres') {
    const allCols = [...options.keyColumns, ...options.updateColumns];
    if (!rowsHaveDbToken(options.records, allCols)) {
      const jsonOpts = {
        tableName: options.tableName,
        keyColumns: options.keyColumns,
        updateColumns: options.updateColumns,
        records: options.records,
        skipMap: options.skipMap,
        returning: options.returning,
      };
      return dialect === 'mysql' ? mysqlUpdateManyJson(jsonOpts) : sqliteUpdateManyJson(jsonOpts);
    }
  }
  const { sql, params } = builderFor(dialect).buildUpdateMany(options);
  return { sql, params };
}

// ============================================================================
// UPDATE single — reproduces the ORIGINAL `_update` SET-clause + WHERE text exactly.
// ============================================================================

/**
 * Compile a single-row UPDATE to a `makeSQL` bundle, reproducing the original
 * `DBModel._update` text byte-for-byte: `UPDATE <t> SET <c = ?[::cast] | token>, … WHERE
 * <cond>[ RETURNING …]`. `serializedValues` is the already-serialized value map
 * (DBToken values compile via their own `.compile`, matching the original), and
 * `sqlCastMap` drives the per-column `?::sqlCast` on PG (skipping timestamp/date, as
 * the original does). Throws `UPDATE requires conditions` when the WHERE is empty
 * (v1 anchor: WHERE mandatory).
 */
export function compileUpdateSingle(opts: {
  dialect: Dialect;
  tableName: string;
  serializedValues: Record<string, unknown>;
  conditions: ConditionObject;
  /** The DECLARED types of the columns `conditions` names — types a MySQL IN-list element (#376). */
  columnTypes?: ColumnTypes;
  sqlCastMap?: Map<string, string>;
  returning?: string;
}): MakeSQL {
  const params: unknown[] = [];
  const formatter: SqlCastFormatter | undefined =
    opts.dialect === 'postgres' ? formatterFor(opts.dialect) : undefined;
  const sqlCastMap = opts.sqlCastMap ?? new Map<string, string>();

  const setClauses: string[] = [];
  for (const [col, val] of Object.entries(opts.serializedValues)) {
    if (val instanceof DBToken) {
      setClauses.push(`${col} = ${val.compile(params, undefined, formatter)}`);
    } else {
      params.push(val);
      const sqlCast = sqlCastMap.get(col);
      if (sqlCast && formatter && sqlCast !== 'timestamp' && sqlCast !== 'date') {
        setClauses.push(`${col} = ${formatter('?', sqlCast)}`);
      } else {
        setClauses.push(`${col} = ?`);
      }
    }
  }

  const whereClause = conditionsFor(opts.conditions, opts.dialect, opts.columnTypes).compile(params, formatter);
  if (!whereClause) throw new Error('UPDATE requires conditions');

  let sql = `UPDATE ${opts.tableName} SET ${setClauses.join(', ')} WHERE ${whereClause}`;
  if (opts.returning) sql += ` RETURNING ${opts.returning}`;
  return { sql, params };
}

// ============================================================================
// DELETE single — reproduces the ORIGINAL `_delete` text exactly.
// ============================================================================

/**
 * Compile DELETE to a `makeSQL` bundle, reproducing the original `DBModel._delete`
 * text: `DELETE FROM <t> WHERE <cond>[ RETURNING …]`. Throws `DELETE requires
 * conditions` when the WHERE is empty (v1 anchor: WHERE mandatory — the .rs "delete
 * everything" behavior is NOT reproduced).
 */
export function compileDelete(opts: {
  dialect: Dialect;
  tableName: string;
  conditions: ConditionObject;
  /** The DECLARED types of the columns `conditions` names — types a MySQL IN-list element (#376). */
  columnTypes?: ColumnTypes;
  returning?: string;
}): MakeSQL {
  const params: unknown[] = [];
  const formatter = opts.dialect === 'postgres' ? formatterFor(opts.dialect) : undefined;
  const whereClause = conditionsFor(opts.conditions, opts.dialect, opts.columnTypes).compile(params, formatter);
  if (!whereClause) throw new Error('DELETE requires conditions');

  let sql = `DELETE FROM ${opts.tableName} WHERE ${whereClause}`;
  if (opts.returning) sql += ` RETURNING ${opts.returning}`;
  return { sql, params };
}

// ============================================================================
// DELETE batch (deleteMany) — a single DELETE keyed by the PK set: a single-column PK by the v1 IN-list
// (compileDelete → DBConditions/conditionsFor), a composite PK by the composite membership predicate.
// ============================================================================

/**
 * Compile a `deleteMany` — delete the rows whose primary key is in a given SET of keys — as ONE
 * `makeSQL` DELETE component ({@link compileDelete}):
 *
 *  - a single-column PK: the v1 IN-list condition (`{ pk: [values] }` → PG `= ANY` / MySQL·SQLite
 *    JSON-subquery via `conditionsFor`);
 *  - a COMPOSITE PK: the key TUPLES matched as tuples, by the ONE composite membership predicate
 *    ({@link tupleInPredicate} — the text relations and declared `tupleIn` endpoints use). Matching each
 *    column on its own (`k1 IN (…) AND k2 IN (…)`) would delete the CROSS PRODUCT of the columns' values:
 *    (1,1) and (2,2) would also take (1,2) and (2,1) (#377).
 *
 * Every key must carry EVERY PK column: a key missing one throws, because dropping that column from the
 * WHERE would widen the DELETE to every row sharing the other columns — another tenant's rows (#377).
 * `columnTypes` are the PK columns' declared types (the MySQL key elements are read as them, #376).
 *
 * Returned as a list so the batch tx plan composes it like the other batch writes. An empty key set
 * yields NO components (nothing to delete).
 */
export function compileDeleteMany(opts: {
  dialect: Dialect;
  tableName: string;
  /** The PK column names (single or composite). */
  keyColumns: string[];
  /** The key-tuples to delete: each row maps every PK column → its value. */
  keys: Record<string, unknown>[];
  /** The DECLARED types of the PK columns — types a MySQL key element (#376). */
  columnTypes?: ColumnTypes;
  returning?: string;
}): MakeSQL[] {
  const { dialect, tableName, keyColumns, keys, columnTypes, returning } = opts;
  if (keyColumns.length === 0) throw new Error('compileDeleteMany: keyColumns must be non-empty');
  if (keys.length === 0) return [];
  keys.forEach((key, i) => {
    for (const c of keyColumns) {
      if (key[c] === undefined) {
        throw new Error(
          `compileDeleteMany: key #${i} has no value for PK column '${c}' — every key must name every PK column ` +
            `(${keyColumns.join(', ')}); without it the DELETE would match every row sharing the other columns`,
        );
      }
    }
  });

  if (keyColumns.length === 1) {
    // Single PK → ONE DELETE with a v1 IN-list condition (`{ pk: [values] }`).
    const col = keyColumns[0];
    const values = keys.map((k) => k[col]);
    const conditions: ConditionObject = { [col]: values };
    return [compileDelete({ dialect, tableName, conditions, columnTypes, returning })];
  }

  // Composite PK → ONE DELETE matching the key TUPLES. PostgreSQL binds one array per key column
  // (`UNNEST(?::T1, ?::T2)`); its casts come from the declared types, else from these concrete keys
  // (the deferred cast token resolved right here, as the render step would). MySQL/SQLite bind the
  // tuples as ONE JSON array-of-tuples param.
  const tuples = keys.map((k) => keyColumns.map((c) => k[c]));
  let membership = tupleInPredicate(dialect, tableName, keyColumns, keyColumns.map((c) => columnTypes?.[c]));
  let params: unknown[];
  if (dialect === 'postgres') {
    params = keyColumns.map((_, i) => tuples.map((t) => t[i]));
    for (const column of params) membership = resolvePgArrayCast(membership, column as unknown[]);
  } else {
    params = [encodeJsonArrayParam(dialect, tuples)];
  }
  return [compileDelete({ dialect, tableName, conditions: { __raw__: [membership, params] }, returning })];
}
