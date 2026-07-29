/**
 * litedbmodel v2 SCP — the decorator METADATA adapter (Phase F-1, epic #74, issue #104).
 *
 * litedbmodel's decorators are metadata-only COLLECTORS: `@column` / `@hasMany` / … record
 * `ColumnMeta` / `RelationMeta` / `TABLE_NAME` on the class (`src/decorators.ts`, via `reflect-metadata`
 * + `_columnMeta` / `_relationMeta`). This module READS that registry and translates it into the SCP-level
 * facts the rest of the stack consumes, plus the write bundles a decorated model compiles to. It builds
 * NO SQL structure of its own and holds NO authoring vocabulary — the decorator never emits IR, and the
 * adapter never re-implements composition.
 *
 * ## What the adapter translates
 *
 *  1. **Columns** (the one real translation): `@column.*` `ColumnMeta` (the decorator already knows the
 *     type family — bigint / date / boolean / uuid / json / array / …) → the SCP column SoT
 *     ({@link ModelColumns}: the SQL-type token per column, validated by `coltype.ts`). See
 *     {@link deriveModelColumns} + {@link COLUMN_FAMILY_SQL_TYPE}. The typed-read `outType` and the
 *     relation key-array element type both resolve against exactly this SoT.
 *  2. **Relations**: `@hasMany` / `@belongsTo` / `@hasOne` `RelationMeta` → {@link RelationDecl} →
 *     `compileRelationOp` (single + composite keys, per-parent `limit` window + `hardLimit`).
 *  3. **Write bundles**: `createMany` (and a `create` WITH `onConflict`) / `updateMany` / `deleteMany` →
 *     `compileCreateManyBundle` / `compileUpdateManyBundle` / `compileDeleteManyBundle`, with the
 *     model's column SoT threaded as the write de-box resolver.
 *
 * READS are NOT compiled here. A read endpoint is DECLARED on the `@behavior` / `@leaf` authoring
 * surface and lowered by `bc generate`; an ad-hoc runtime-shaped query runs the v1 imperative path.
 */

import {
  compileCreateManyBundle,
  compileUpdateManyBundle,
  compileDeleteManyBundle,
  type SqlBundle,
} from './write-bundle';
import { compileRelationOp, type RelationDecl, type RelationKind, type RelationOp } from './relation';
import { sqlTypeToMaterializeClass, keyArrayElemScalar, columnTypeResolverFromColumnMap, type BcScalar, type ColumnTypeResolver } from './coltype';
import type { DialectName } from './dialect';
import type { InsertManyBuildOptions } from './makesql/compile-crud';
import type { UpdateManyBuildOptions } from '../drivers/types';
import { getColumnMeta, getRelationMeta, type ColumnMeta, type RelationMeta } from '../decorators';
import { orderToString, type OrderSpec } from '../Column';

/**
 * The model's inline typed-column declaration: `table → (column → SQL type token)` — the consumer-inline
 * column-type SoT (bc never infers types; the author annotates them). SQL type tokens are the §4.1
 * vocabulary (`INTEGER`/`INT`/`BIGINT`/`REAL`/`DOUBLE`/`DECIMAL(…)`/`TEXT`/`VARCHAR(…)`/`BOOLEAN`/
 * `DATE`/`TIMESTAMP`/`JSON`/`JSONB`/`UUID`/…).
 */
export type ModelColumns = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Resolve the de-box bc element scalar of a relation's parent-key column ((table, column) → bc scalar),
 * so a relation key array carries the type the READ-materialized key value actually holds
 * (INT→`float` / BIGINT→`string` / text/uuid→`string`) — see {@link keyArrayElemScalar}.
 */
export type KeyTypeResolver = (table: string, column: string) => BcScalar;

// ── 1. Column-type mapping (decorator ColumnMeta → the SCP column SQL type) ─────────────────────

/**
 * The decorator's `ColumnMeta.sqlCast` type-family token → the canonical §4.1 SQL-type token the SCP
 * `static columns` SoT carries (validated by `coltype.ts`). The decorator ALREADY knows the family
 * (it set `sqlCast` from the `@column.*` variant / the `design:type` inference — `src/decorators.ts`),
 * so this is a pure token normalization, no inference. `coltype.ts` accepts every RHS here:
 * BOOLEAN/BIGINT/TIMESTAMP/DATE/UUID/JSONB are scalar; the array tokens de-box as `passthrough`
 * (`sqlTypeToMaterializeClass`).
 *
 * The RHS matches the decorator families 1:1:
 *  - `boolean`    → `BOOLEAN`     (`@column.boolean()` / auto `Boolean`)
 *  - `bigint`     → `BIGINT`      (`@column.bigint()` / auto `BigInt` — read de-box: exact string)
 *  - `timestamp`  → `TIMESTAMP`   (`@column.datetime()` / auto `Date` — read de-box: TZ string)
 *  - `date`       → `DATE`        (`@column.date()` — read de-box: YYYY-MM-DD string)
 *  - `uuid`       → `UUID`        (`@column.uuid()`)
 *  - `jsonb`      → `JSONB`       (`@column.json()`)
 *  - `text[]` / `int[]` / `numeric[]` / `boolean[]` → the array token (`@column.*Array()`)
 */
export const COLUMN_FAMILY_SQL_TYPE: Readonly<Record<string, string>> = {
  boolean: 'BOOLEAN',
  bigint: 'BIGINT',
  timestamp: 'TIMESTAMP',
  date: 'DATE',
  uuid: 'UUID',
  jsonb: 'JSONB',
  'text[]': 'TEXT[]',
  'int[]': 'INT[]',
  'numeric[]': 'NUMERIC[]',
  'boolean[]': 'BOOLEAN[]',
};

/**
 * The LAST-RESORT SQL type for a column that carries NO `sqlCast` family, NO `baseSqlType` (its
 * `design:type` is absent — no `emitDecoratorMetadata` — or is an Array/Object family), and NO
 * `columnTypes` override. Phase F-2 (#105 option B) made {@link columnSqlType} consult the decorator's
 * `baseSqlType` (derived from the field's TS `design:type`: String→TEXT / Number→INTEGER / Boolean→
 * BOOLEAN / Date→TIMESTAMP / BigInt→BIGINT) BEFORE this default, so a bare `@column() name: string`
 * types as `TEXT` (not `INTEGER`) — the fix for F1's blanket-INTEGER read-de-box defect (it threw
 * `materialize int32` on a live string column). This default now only applies when `design:type` is
 * genuinely unavailable; a REAL/DECIMAL column (a `Number` that is not INT) is pinned via
 * {@link DeriveColumnsOptions.columnTypes} (the escape hatch, unchanged from F1).
 */
export const DEFAULT_UNCAST_SQL_TYPE = 'INTEGER';

/** Options for {@link deriveModelColumns}. */
export interface DeriveColumnsOptions {
  /**
   * Per-column SQL-type OVERRIDES (property name → §4.1 SQL type token), for columns whose decorator
   * family is ambiguous (a bare `Number` that is actually REAL/DECIMAL) or that need a non-default
   * width. Takes precedence over the family-derived token. The escape hatch for the no-INT-vs-REAL
   * decorator gap — no assumption is baked into the engine.
   */
  readonly columnTypes?: Readonly<Record<string, string>>;
}

/**
 * Translate ONE column's {@link ColumnMeta} to its §4.1 SQL-type token. Precedence (Phase F-2 / #105
 * option B):
 *   1. an explicit `columnTypes` override (the REAL/DECIMAL/width escape hatch) wins;
 *   2. else the family token from {@link COLUMN_FAMILY_SQL_TYPE} (an explicit `@column.*` `sqlCast`);
 *   3. else the decorator's `baseSqlType` — derived from the field's TS `design:type` (String→TEXT /
 *      Number→INTEGER / Boolean→BOOLEAN / Date→TIMESTAMP / BigInt→BIGINT), so a bare `@column()` types
 *      correctly for the SCP typed-read de-box (the fix for F1's blanket-INTEGER default);
 *   4. else {@link DEFAULT_UNCAST_SQL_TYPE} (only when `design:type` is unavailable).
 * Fail-closed: a family token the mapping does not know, or a produced token `coltype.ts` rejects,
 * THROWS (naming the column) — never a silent skip (no-assume, no-fallback).
 */
export function columnSqlType(propKey: string, meta: ColumnMeta, override?: string): string {
  const sqlType =
    override ??
    (meta.sqlCast !== undefined ? COLUMN_FAMILY_SQL_TYPE[meta.sqlCast] : undefined) ??
    meta.baseSqlType ??
    DEFAULT_UNCAST_SQL_TYPE;
  if (meta.sqlCast !== undefined && override === undefined && COLUMN_FAMILY_SQL_TYPE[meta.sqlCast] === undefined) {
    throw new Error(
      `decorator-adapter: column '${propKey}' has decorator sqlCast family '${meta.sqlCast}' with no ` +
        `SCP SQL-type mapping. Add it to COLUMN_FAMILY_SQL_TYPE or pin the column via ` +
        `options.columnTypes['${propKey}']. No-assume, no-fallback.`,
    );
  }
  // Validate the produced token is in the §4.1 vocabulary (throws for an unknown/ambiguous type).
  sqlTypeToMaterializeClass(sqlType);
  return sqlType;
}

/**
 * Derive the SCP `static columns` ({@link ModelColumns}) for a decorated model class from its
 * `@column` `ColumnMeta` registry (the decorator IS the type SoT for v1/v2's decorator surface). The
 * table is the model's `TABLE_NAME` (or the model-name lowercased, matching the decorator's
 * `effectiveTableName`). Each column keys by its DB `columnName` (what a SELECT projects), mapping to
 * its §4.1 SQL type. A model with no `@column` declarations yields no table entry.
 *
 * This is the ONE real translation in the adapter — the read-path de-box (INT→number / BIGINT→string /
 * DATE→string / BOOLEAN→boolean) and the codegen `outType` both consult exactly this SoT.
 */
export function deriveModelColumns(modelClass: ModelClassLike, options: DeriveColumnsOptions = {}): ModelColumns {
  const meta = getColumnMeta(modelClass);
  if (meta === undefined || meta.size === 0) return {};
  const table = tableNameOf(modelClass);
  const cols: Record<string, string> = {};
  for (const [propKey, m] of meta) {
    cols[m.columnName] = columnSqlType(propKey, m, options.columnTypes?.[propKey]);
  }
  return { [table]: cols };
}

/** The decorated model class shape the adapter reads (a `@model`-decorated `DBModel` subclass). */
export interface ModelClassLike {
  readonly name: string;
  readonly TABLE_NAME?: string;
  /**
   * The NAME of the connection (database) this model lives in — `@model(table, { connection })`
   * (`src/decorators.ts`). Absent ⇒ the default connection. See {@link connectionOf}.
   */
  readonly CONNECTION?: string;
}

/** The effective table name (v1 `@model` rule): explicit `TABLE_NAME`, else the model name lowercased. */
export function tableNameOf(modelClass: ModelClassLike): string {
  return modelClass.TABLE_NAME ?? modelClass.name.toLowerCase();
}

/**
 * The NAME of the connection a model's statements run on — the multi-DB routing key, and the ONE
 * reader of the model's `CONNECTION` static (the twin of {@link tableNameOf}). `undefined` ⇒ the
 * DEFAULT connection, which is what a single-DB deployment always is.
 *
 * The MODEL is the authority, exactly as in v1: a v1 model selects its database by extending a
 * `DBModel.createDBBase(config)` base class whose handler owns the connection, and every statement a
 * model issues goes through THAT handler (`DBModel.getHandler()` → `getDriverType()`). Both codegen
 * consumers derive from here and neither re-derives it:
 *
 *  - an ENDPOINT's statements take their own model's connection (`emit/emitter.ts`);
 *  - a RELATION's batch child fetch takes the TARGET model's ({@link relationDeclOf} →
 *    {@link RelationDecl.connection}), which is v1 `LazyRelation.ts:236`'s
 *    "Use target model's driver type (important for multi-DB scenarios)" — the target's connection
 *    regardless of the parent's, because the child rows live in the target's database.
 */
export function connectionOf(modelClass: ModelClassLike): string | undefined {
  return modelClass.CONNECTION;
}

// ── 2. Write bundles (createMany / updateMany / deleteMany) ─────────────────────────────────────
/**
 * Compile a decorated model's `createMany` — and a `create` WITH `onConflict` (upsert) — into a batch
 * write {@link SqlBundle} via `compileCreateManyBundle`. This is the UPSERT carry: `onConflict` /
 * `onConflictUpdate` / `onConflictIgnore` are `compileInsertMany` BUILD options (not authored ports),
 * so they carry end-to-end here with NO SCP authoring addition — exactly as v1's `create` and
 * `createMany` share the ONE `DBModel._insert` grouping path (`buildInsert` handles ON CONFLICT for
 * both a single record and a batch). A single-record `records` array is a one-group createMany that
 * emits the SAME statement `_insert` does for a single upsert.
 *
 * Parity scope (the v1/v2 SQL-parity rule, per dialect — NOT a blanket "byte-identical to v1"): on
 * **Postgres** the emitted upsert INSERT is byte-identical to v1 (`compileInsertMany` copies the v1
 * `buildInsert` verbatim; PG stays base-class tuple/placeholder form). On **MySQL / SQLite** the v2
 * form is the JSON-array single-param shape (`json_each` / `JSON_TABLE`), which is DELIBERATELY NOT
 * byte-identical to v1's per-row placeholder expansion — it is the established v2 shape the conformance
 * corpus freezes (#64/#65), executing to the same rows. So: pg = v1-byte-identical; mysql/sqlite = the
 * v2 JSON-array form (equivalent result, distinct text).
 *
 * @param options the `compileCreateManyBundle` options (records / rawRecords / sqlCastMap / onConflict /
 *   onConflictUpdate / onConflictIgnore / returning / pk) — already serialized as `DBModel._insert`
 *   holds them.
 */
export function compileCreateBundle(
  modelClass: ModelClassLike,
  name: string,
  options: InsertManyBuildOptions & { pk?: { columns: readonly string[]; autoInc: string | null } },
  dialect: DialectName = 'sqlite',
  columnsOptions?: DeriveColumnsOptions,
): SqlBundle {
  const resolveColumnType = modelColumnResolver(modelClass, columnsOptions);
  return compileCreateManyBundle(name, options, dialect, resolveColumnType);
}

/** Compile a decorated model's `updateMany` into a batch write {@link SqlBundle} (`compileUpdateManyBundle`). */
export function compileUpdateBundle(
  name: string,
  options: UpdateManyBuildOptions,
  dialect: DialectName = 'sqlite',
): SqlBundle {
  return compileUpdateManyBundle(name, options, dialect);
}

/**
 * Compile a decorated model's `deleteMany` into a batch write {@link SqlBundle} (`compileDeleteManyBundle`):
 * a PK-set IN-list DELETE (single key) or one DELETE per composite-key group. `keyColumns` +
 * `returning` carry straight through.
 */
export function compileDeleteBundle(
  name: string,
  options: { tableName: string; keyColumns: string[]; keys: Record<string, unknown>[]; returning?: string },
  dialect: DialectName = 'sqlite',
): SqlBundle {
  return compileDeleteManyBundle(name, options, dialect);
}

/**
 * Build a {@link KeyTypeResolver} from a decorated model's `static columns` SoT — `(table, column) →`
 * the de-box bc scalar of that key column ({@link import('./coltype').keyArrayElemScalar}). Threaded into
 * {@link relationReadAuthoring} so each relation's `pluck` key array is stamped with the type its
 * READ-materialized key value carries. Returns `undefined` when the model declares no columns.
 */
export function relationKeyTypeResolver(
  modelClass: ModelClassLike,
  columnsOptions?: DeriveColumnsOptions,
): KeyTypeResolver | undefined {
  const columns = deriveModelColumns(modelClass, columnsOptions);
  if (Object.keys(columns).length === 0) return undefined;
  return (table: string, column: string) => {
    const sqlType = columns[table]?.[column];
    if (sqlType === undefined) {
      throw new Error(
        `decorator-adapter: relation key column '${table}.${column}' has no declared type in the model's ` +
          `static columns — cannot stamp the key array's de-box element type (no-assume, no-fallback).`,
      );
    }
    return keyArrayElemScalar(sqlType);
  };
}

/** The fail-closed column-type resolver for a decorated model (its `static columns` SoT), or `undefined` if it has no columns. */
export function modelColumnResolver(
  modelClass: ModelClassLike,
  columnsOptions?: DeriveColumnsOptions,
): ColumnTypeResolver | undefined {
  const columns = deriveModelColumns(modelClass, columnsOptions);
  const tables = Object.keys(columns);
  if (tables.length === 0) return undefined;
  const map = new Map<string, Map<string, string>>();
  for (const [t, cols] of Object.entries(columns)) map.set(t, new Map(Object.entries(cols)));
  return columnTypeResolverFromColumnMap(map);
}

// ── 4. Relation authoring generation (@hasMany / @belongsTo / @hasOne → RelationDecl → RelationOp) ──

/**
 * Translate a decorated model's `@hasMany` / `@belongsTo` / `@hasOne` {@link RelationMeta} registry
 * into SCP {@link RelationDecl}s. Single AND composite keys are supported: the decorator's
 * `keysFactory` resolves lazily (forward refs) to `[srcCol, tgtCol]` (single) or `[[…],[…]]`
 * (composite); the target table + projection come from the target model's `@column` metadata (the
 * relation projects the child's OWN columns). Per-parent `order` / `limit` (hasMany window) and
 * `hardLimit` carry from the decorator `options`.
 *
 * @param modelClass the parent (source) `@model` class.
 * @param resolveTargetModel model NAME → the target `@model` class (the decorator records the target
 *   model NAME on the key column; the caller supplies the registry — same lazy-resolution shape v1's
 *   `_loadRelation` uses).
 */
export function deriveRelationDecls(
  modelClass: ModelClassLike,
  resolveTargetModel: (modelName: string) => ModelClassLike,
  dialect: DialectName = 'sqlite',
): RelationDecl[] {
  return getRelationMeta(modelClass).map((rel) => relationDeclOf(rel, resolveTargetModel, dialect).decl);
}

/**
 * Translate ONE {@link RelationMeta} → a {@link RelationDecl} (single or composite key) AND the
 * resolved target model (so a caller can bake the child's de-box materializers from the TARGET
 * model's `static columns` — the relation projects the child's own columns).
 */
export function relationDeclOf(
  rel: RelationMeta,
  resolveTargetModel: (modelName: string) => ModelClassLike,
  dialect: DialectName = 'sqlite',
): { decl: RelationDecl; targetModel: ModelClassLike } {
  const parsed = parseKeys(rel.keysFactory());
  const targetModel = resolveTargetModel(parsed.targetModelName);
  const targetTable = tableNameOf(targetModel);
  const select = targetProjection(targetModel);
  const order = rel.options?.order ? orderToString(rel.options.order() as OrderSpec) : undefined;

  // CROSS-DB (V0 R1): the batch child SELECT runs on the TARGET model's connection — v1
  // `LazyRelation.ts:236` loads a relation on `TargetClass.getDriverType()`'s driver, so the target's
  // database is the authority whatever the parent's is. Absent ⇒ the default connection (untagged, the
  // same-DB case every single-DB deployment is).
  const connection = connectionOf(targetModel);
  const base = {
    name: rel.propertyKey,
    kind: rel.type as RelationKind,
    targetTable,
    select,
    dialect,
    ...(connection !== undefined ? { connection } : {}),
    ...(order !== undefined ? { order } : {}),
    ...(rel.options?.limit !== undefined ? { limit: rel.options.limit } : {}),
    ...(rel.options?.hardLimit !== undefined ? { hardLimit: rel.options.hardLimit } : {}),
  };
  const decl: RelationDecl = parsed.composite
    ? { ...base, parentKeys: parsed.sourceKeys, targetKeys: parsed.targetKeys }
    : { ...base, parentKey: parsed.sourceKeys[0], targetKey: parsed.targetKeys[0] };
  return { decl, targetModel };
}

/**
 * Compile a decorated model's relation registry into ready {@link RelationOp}s (one per relation). Each
 * op's child-column de-box materializers are baked from the TARGET model's `static columns` (the same
 * resolution the primary read uses) — ZERO per-read introspection.
 */
export function compileRelationOps(
  modelClass: ModelClassLike,
  resolveTargetModel: (modelName: string) => ModelClassLike,
  dialect: DialectName = 'sqlite',
  columnsOptions?: DeriveColumnsOptions,
): Record<string, RelationOp> {
  const ops: Record<string, RelationOp> = {};
  for (const rel of getRelationMeta(modelClass)) {
    const { decl, targetModel } = relationDeclOf(rel, resolveTargetModel, dialect);
    ops[decl.name] = compileRelationOp(decl, modelColumnResolver(targetModel, columnsOptions));
  }
  return ops;
}

// ── internal helpers ───────────────────────────────────────────────────────────────────────────

/** A relation Column marker as the decorator records it (`{ columnName, modelName }`, `src/Column.ts`). */
interface RelColumn {
  readonly columnName: string;
  readonly modelName: string;
}
type RelKeyPair = readonly [RelColumn, RelColumn];

/** Parse the decorator `keysFactory()` result (single pair or composite) into src/target column lists. */
function parseKeys(keys: unknown): {
  composite: boolean;
  sourceKeys: string[];
  targetKeys: string[];
  targetModelName: string;
} {
  const arr = keys as readonly unknown[];
  const composite = Array.isArray(arr[0]);
  if (composite) {
    const pairs = arr as readonly RelKeyPair[];
    return {
      composite: true,
      sourceKeys: pairs.map((p) => p[0].columnName),
      targetKeys: pairs.map((p) => p[1].columnName),
      targetModelName: pairs[0][1].modelName,
    };
  }
  const [src, tgt] = arr as unknown as RelKeyPair;
  return { composite: false, sourceKeys: [src.columnName], targetKeys: [tgt.columnName], targetModelName: tgt.modelName };
}

/** The target model's projected columns (its own `@column` DB column names — the relation child props). */
function targetProjection(targetModel: ModelClassLike): string[] {
  const meta = getColumnMeta(targetModel);
  if (meta === undefined) return [];
  return Array.from(meta.values()).map((m) => m.columnName);
}
