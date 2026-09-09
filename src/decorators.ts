/**
 * litedbmodel - Decorators for Model Definition
 *
 * Provides decorators to simplify model definition by automatically:
 * - Setting TABLE_NAME from @model('table_name') decorator
 * - Creating static Column properties for type-safe column references
 * - Generating typeCastFromDB() for automatic type conversion
 * - Creating relation getters from @hasMany, @belongsTo, @hasOne decorators
 */

import 'reflect-metadata';
import { type Column, type OrderSpec, createColumn, orderToString, type Conds, condsToRecord } from './Column';
import type { DriverTypeCast } from './drivers/types';
import {
  castToIntegerArray,
  castToNumericArray,
  castToStringArray,
  castToBooleanArray,
  castToDatetimeArray,
  castToJson,
  formatLocalDate,
} from './TypeCast';
import { materializeCell } from './scp/coltype';
import type { ModelOptions } from './types';

// ── v1 read type contract (issue #9), aligned to the v2 SCP read de-box ────────
// The legacy v1 `DBModel` decorator read path historically materialized `@column.bigint()` to a JS
// `bigint` (not JSON-safe) and `@column.datetime()` / an auto-inferred `Date` to a JS `Date`
// (TZ-shifted). Both carry the SAME i64-rounding / date-corruption hazards the v2 SCP read path
// already closed. Per the owner (2026-07-15), v1 is realigned to the v2 read TYPE CONTRACT — and it
// does so by REUSING the v2 materializer (`materializeCell`, `src/scp/coltype.ts`), NOT a divergent
// v1 coercion. The v1 decorator IS the static type source (unlike v2, whose SoT is the SQL DDL), so
// each read-affected decorator variant pins its v2 `MaterializeClass` and routes the raw driver cell
// through `materializeCell`:
//   - `@column.bigint()` / auto `BigInt`  → `int64` → EXACT decimal STRING (no i64 rounding, JSON-safe)
//   - `@column.datetime()` / auto `Date`  → `date`  → TZ-attached STRING (NOT a TZ-shifted JS Date)
//   - `@column.boolean()`  / auto `Boolean` → `bool` → JS boolean
// `null`/`undefined` pass through (nullable columns) exactly as `materializeCell` and the prior v1
// casts did. Fail-closed like v2: a driver cell that cannot be coerced to the declared class throws
// (a declared BIGINT column returning a non-integer string is a driver-contract violation, not a
// silent `null`). `@column.date()` already yields a YYYY-MM-DD string (never a Date), `@column.number()`
// stays a JS `number` (int32/float range is exact), and DECIMAL/NUMERIC ride `@column.number()` or a
// string column — all already contract-correct, so they are unchanged.

// ============================================
// Metadata Keys
// ============================================

const COLUMNS_KEY = Symbol('litedbmodel:columns');
const RELATIONS_KEY = Symbol('litedbmodel:relations');

// ============================================
// Types
// ============================================

/** Type cast function signature */
type TypeCastFn = (value: unknown) => unknown;

/** Serialize function signature (converts JS value to DB value) */
type SerializeFn = (value: unknown, typeCast?: DriverTypeCast) => unknown;

/** 
 * Column metadata stored by decorators 
 * @internal
 */
export interface ColumnMeta {
  columnName: string;
  typeCast?: TypeCastFn;
  serialize?: SerializeFn;
  primaryKey?: boolean;
  /**
   * The column's value is assigned by the SERVER (`AUTO_INCREMENT` / `SERIAL` / `IDENTITY`), so a
   * write does not supply it and cannot know it until the statement has run.
   *
   * This is a schema fact the model must STATE, not one the library can infer: "absent from the
   * INSERT column list" also describes a column with a server-side DEFAULT, and the two recover
   * their written rows differently. On MySQL — which parses no `RETURNING` — an auto-increment PK
   * is recovered by the id range `[LAST_INSERT_ID, +affected)` while any other PK is recovered by
   * the values the write itself bound.
   */
  autoIncrement?: boolean;
  /** SQL type for automatic casting in conditions (e.g., 'uuid') */
  sqlCast?: string;
  /**
   * The §4.1 SQL-type token derived from the field's TS `design:type` for a column with NO explicit
   * `sqlCast` (Phase F-2 / #105 option B). `String → TEXT`, `Number → INTEGER`, `Boolean → BOOLEAN`,
   * `Date → TIMESTAMP`, `BigInt → BIGINT`. This types the SCP typed-read de-box for a bare `@column()`
   * (the README shape) so it is byte-safe (`materializeCell` never mis-reads a string as int32), and
   * preserves the v1 read contract exactly (string→TEXT→string, int→INTEGER→number). A column WITH an
   * explicit `sqlCast` family (`@column.boolean()` / `.bigint()` / `.uuid()` / …) does not set this —
   * its family already maps to the SQL type. `REAL`/`DECIMAL` (a `Number` that is not INT) stays pinned
   * via the adapter's `columnTypes` escape hatch. @internal
   */
  baseSqlType?: string;
}

// ============================================
// Relation Types
// ============================================

/** 
 * Relation type 
 * @internal
 */
export type RelationType = 'hasMany' | 'belongsTo' | 'hasOne';

/** 
 * Key pair: [sourceKey, targetKey] 
 * @internal
 */
export type KeyPair = readonly [Column<unknown, unknown>, Column<unknown, unknown>];

/** 
 * Composite key pairs: [[sourceKey1, targetKey1], [sourceKey2, targetKey2], ...] 
 * @internal
 */
export type CompositeKeyPairs = readonly KeyPair[];

/** 
 * Factory function that returns key pair(s) 
 * @internal
 */
export type KeysFactory = () => KeyPair | CompositeKeyPairs;

/** 
 * Relation options (order, where, limit) 
 * @internal
 */
export interface RelationDecoratorOptions {
  /** Order by specification */
  order?: () => OrderSpec;
  /** Additional filter conditions */
  where?: () => Conds;
  /**
   * SQL LIMIT for hasMany relations.
   * Limits the number of records returned per parent key.
   * Uses LATERAL JOIN (PostgreSQL) or ROW_NUMBER (MySQL/SQLite) for efficient batch loading.
   * @example
   * ```typescript
   * @hasMany(() => [User.id, Post.author_id], {
   *   limit: 10,  // Only load 10 posts per user
   *   order: () => Post.created_at.desc(),
   * })
   * declare recentPosts: Promise<Post[]>;
   * ```
   */
  limit?: number;
  /**
   * Hard limit for hasMany relations (throws exception if exceeded).
   * Overrides the global hasManyHardLimit setting.
   * Set to null to disable the limit check for this relation.
   * @example
   * ```typescript
   * @hasMany(() => [User.id, Post.author_id], {
   *   hardLimit: 500,  // Throw if user has > 500 posts
   * })
   * declare posts: Promise<Post[]>;
   * 
   * @hasMany(() => [User.id, Log.user_id], {
   *   hardLimit: null,  // Allow unlimited logs
   * })
   * declare logs: Promise<Log[]>;
   * ```
   */
  hardLimit?: number | null;
}

/** 
 * Relation metadata stored by decorators 
 * @internal
 */
export interface RelationMeta {
  propertyKey: string;
  type: RelationType;
  keysFactory: KeysFactory;
  options?: RelationDecoratorOptions;
}

// ============================================
// Decorator Protocol Adapter (legacy + TC39 standard)
// ============================================

/**
 * TC39 (standard) decorators carry NO `design:type`: `emitDecoratorMetadata` is a legacy-decorator
 * feature, and esbuild — which powers `tsx`, `vite` and `vitest` — does not implement it even for
 * legacy decorators. A column's type is therefore declared by its `@column.*` FAMILY, which is the
 * single source of truth on every toolchain (`.text()` / `.number()` / `.datetime()` / …). The bare
 * `@column()` carries no type and is rejected at decoration time — see {@link requireColumnFamily}.
 *
 * Standard decorators reach the class through `context.metadata`: the SAME object is handed to every
 * member decorator of a class and then to the class decorator, in that order. TypeScript only creates
 * it when `Symbol.metadata` exists (esbuild always creates it), so the polyfill below — the one the
 * TC39 proposal prescribes — makes the two emits behave identically.
 */
if (typeof Symbol === 'function' && !(Symbol as { metadata?: symbol }).metadata) {
  Object.defineProperty(Symbol, 'metadata', {
    value: Symbol.for('Symbol.metadata'),
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

/** The TC39 metadata bag, keyed by our own symbols. @internal */
type MetadataBag = Record<PropertyKey, unknown>;

/**
 * The subset of a TC39 `ClassFieldDecoratorContext` / `ClassDecoratorContext` this module reads.
 * `metadata` is optional in the type only to keep the runtime guard honest — a missing bag THROWS
 * ({@link classMetadataBag}) rather than registering a column nowhere.
 * @internal
 */
export interface StandardDecoratorContext {
  readonly kind: string;
  readonly name?: string | symbol;
  readonly metadata?: MetadataBag;
  addInitializer?(initializer: (this: unknown) => void): void;
}

/**
 * Which decorator protocol a decorator was invoked under. Legacy passes `(prototype, propertyKey)`;
 * standard passes `(value, context)` where `context.kind` names the member being decorated. The
 * `kind` probe is the discriminator both emits guarantee.
 * @internal
 */
function isStandardContext(second: unknown): second is StandardDecoratorContext {
  return typeof second === 'object' && second !== null && typeof (second as { kind?: unknown }).kind === 'string';
}

/**
 * The TC39 metadata bag of the class currently being defined. Fail-closed: a toolchain that hands a
 * decorator no bag cannot register a column at all, and silently dropping it is exactly the class of
 * defect this file is being repaired for (issue #287) — so it throws, naming the cause.
 */
function classMetadataBag(context: StandardDecoratorContext, propertyKey: string): MetadataBag {
  const bag = context.metadata;
  if (bag === undefined) {
    throw new Error(
      `litedbmodel: the standard-decorator context for '${propertyKey}' carries no \`context.metadata\`. ` +
        `litedbmodel defines \`Symbol.metadata\` on import, which every current emit needs to create the ` +
        `bag — import litedbmodel (or 'litedbmodel/decorators') BEFORE the module that defines the model.`,
    );
  }
  return bag;
}

/**
 * The COLUMN map a decorator registers into, per protocol.
 *
 * A subclass must NOT write into the map it INHERITS: `Reflect.getMetadata` walks the prototype chain
 * (and a TC39 metadata bag prototype-chains by construction), so mutating the value it returns leaks a
 * subclass's columns into its base — and from there into every SIBLING subclass that extends the same
 * decorated base. Both resolvers therefore COPY the inherited map on first write and own the copy.
 */
function legacyColumnMap(constructor: object): Map<string, ColumnMeta> {
  const own = Reflect.getOwnMetadata(COLUMNS_KEY, constructor) as Map<string, ColumnMeta> | undefined;
  if (own !== undefined) return own;
  const inherited = Reflect.getMetadata(COLUMNS_KEY, constructor) as Map<string, ColumnMeta> | undefined;
  const map = new Map(inherited);
  Reflect.defineMetadata(COLUMNS_KEY, map, constructor);
  return map;
}

/** @see legacyColumnMap */
function standardColumnMap(bag: MetadataBag): Map<string, ColumnMeta> {
  if (!Object.prototype.hasOwnProperty.call(bag, COLUMNS_KEY)) {
    bag[COLUMNS_KEY] = new Map(bag[COLUMNS_KEY] as Map<string, ColumnMeta> | undefined);
  }
  return bag[COLUMNS_KEY] as Map<string, ColumnMeta>;
}

/** The RELATION list a decorator registers into. Copy-on-inherit, exactly as the column map. */
function legacyRelationList(constructor: object): RelationMeta[] {
  const own = Reflect.getOwnMetadata(RELATIONS_KEY, constructor) as RelationMeta[] | undefined;
  if (own !== undefined) return own;
  const inherited = Reflect.getMetadata(RELATIONS_KEY, constructor) as RelationMeta[] | undefined;
  const list = inherited !== undefined ? [...inherited] : [];
  Reflect.defineMetadata(RELATIONS_KEY, list, constructor);
  return list;
}

/** @see legacyRelationList */
function standardRelationList(bag: MetadataBag): RelationMeta[] {
  if (!Object.prototype.hasOwnProperty.call(bag, RELATIONS_KEY)) {
    const inherited = bag[RELATIONS_KEY] as RelationMeta[] | undefined;
    bag[RELATIONS_KEY] = inherited !== undefined ? [...inherited] : [];
  }
  return bag[RELATIONS_KEY] as RelationMeta[];
}

/** Options for {@link registerColumn} — the family's own declaration of the column's type. */
interface RegisterColumnOptions {
  columnName: string;
  typeCast?: TypeCastFn;
  serialize?: SerializeFn;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  /** SQL type for automatic casting in conditions (e.g., 'uuid') */
  sqlCast?: string;
  /** §4.1 SQL-type token for a family that needs no cast but still types the SCP read (`TEXT`). */
  baseSqlType?: string;
}

/**
 * Record one column on the class being defined. The ONE place a `@column.*` family lands, for both
 * decorator protocols — the protocol only decides WHICH map is handed in ({@link legacyColumnMap} /
 * {@link standardColumnMap}).
 */
function registerColumn(
  columns: Map<string, ColumnMeta>,
  propertyKey: string,
  options: RegisterColumnOptions
): void {
  columns.set(propertyKey, {
    columnName: options.columnName,
    typeCast: options.typeCast,
    serialize: options.serialize,
    primaryKey: options.primaryKey,
    autoIncrement: options.autoIncrement,
    sqlCast: options.sqlCast,
    ...(options.baseSqlType !== undefined ? { baseSqlType: options.baseSqlType } : {}),
  });
}

/** Options that can be passed to any `@column.*` decorator */
export interface ColumnOptions {
  /** Custom column name (defaults to property name) */
  columnName?: string;
  /** Mark this column as part of the primary key */
  primaryKey?: boolean;
  /**
   * The SERVER assigns this column's value (`AUTO_INCREMENT` / `SERIAL` / `IDENTITY`) — a write does
   * not supply it. Declare it on an auto-increment primary key so a `RETURNING` write can recover
   * the rows it wrote on a dialect that has no native `RETURNING`. See {@link ColumnMeta.autoIncrement}.
   */
  autoIncrement?: boolean;
}

/**
 * What a `@column.*` decorator may be applied to, under EITHER protocol.
 *
 * The standard-decorator overload is typed: `Value` is the decorated field's declared TS type, so a
 * family whose read contract yields a `string` (`@column.datetime()`, `@column.bigint()`, …) will not
 * compile onto a field declared `Date` / `bigint`. That is the compile-time half of the fix for the
 * "declared type ≠ value `find()` returns" defect (issue #286); the legacy protocol hands decorators
 * no type information at all, so there it can only be documented.
 *
 * @category Decorators
 */
export interface ColumnDecorator<Value> {
  /** Legacy (`experimentalDecorators`) property decorator. */
  (target: object, propertyKey: string | symbol): void;
  /** TC39 standard class-field decorator. */
  <This>(value: undefined, context: ClassFieldDecoratorContext<This, Value>): void;
}

/** What a relation decorator may be applied to, under either protocol. @category Decorators */
export interface RelationDecorator<Value> {
  (target: object, propertyKey: string | symbol): void;
  <This>(value: undefined, context: ClassFieldDecoratorContext<This, Value>): void;
}

/** Parse the `columnName | ColumnOptions` argument every family accepts. */
function parseColumnOptions(
  columnNameOrOptions: string | ColumnOptions | undefined,
  propKey: string
): { columnName: string; primaryKey?: boolean; autoIncrement?: boolean } {
  if (typeof columnNameOrOptions === 'string') return { columnName: columnNameOrOptions };
  if (columnNameOrOptions) {
    return {
      columnName: columnNameOrOptions.columnName || propKey,
      primaryKey: columnNameOrOptions.primaryKey,
      autoIncrement: columnNameOrOptions.autoIncrement,
    };
  }
  return { columnName: propKey };
}

/**
 * Build one `@column.*` family decorator. The returned decorator accepts BOTH protocols: legacy hands
 * it `(prototype, propertyKey)`, TC39 standard hands it `(undefined, context)`. Everything that
 * describes the COLUMN (cast, serializer, SQL family) is fixed here by the family itself — nothing is
 * read back from the compiler, so every toolchain produces the same model.
 *
 * @param typeCast - Function to convert DB value to JS value (read)
 * @param serialize - Function to convert JS value to DB value (write)
 * @param sqlCast - SQL type family for casting in conditions / typed reads (e.g. `'uuid'`)
 * @param baseSqlType - §4.1 SQL-type token for a family that applies no cast (`@column.text()`)
 */
function createColumnDecorator<Value = unknown>(
  typeCast?: TypeCastFn,
  serialize?: SerializeFn,
  sqlCast?: string,
  baseSqlType?: string
) {
  return function (columnNameOrOptions?: string | ColumnOptions): ColumnDecorator<Value> {
    return function (targetOrValue: unknown, keyOrContext: unknown): void {
      if (isStandardContext(keyOrContext)) {
        const propKey = String(keyOrContext.name);
        const parsed = parseColumnOptions(columnNameOrOptions, propKey);
        registerColumn(standardColumnMap(classMetadataBag(keyOrContext, propKey)), propKey, {
          ...parsed, typeCast, serialize, sqlCast, baseSqlType,
        });
        return;
      }
      const propKey = String(keyOrContext as string | symbol);
      const parsed = parseColumnOptions(columnNameOrOptions, propKey);
      registerColumn(legacyColumnMap((targetOrValue as object).constructor), propKey, {
        ...parsed, typeCast, serialize, sqlCast, baseSqlType,
      });
    } as ColumnDecorator<Value>;
  };
}

/**
 * The bare `@column()` — REMOVED. It declared no type: it relied on `design:type`, which only exists
 * under legacy decorators AND `emitDecoratorMetadata`, which esbuild (tsx / vite / vitest) does not
 * implement and TC39 standard decorators do not have. Where that metadata was absent the column
 * silently got NO cast and the raw driver value reached the caller — an `integer` read back as a
 * `bigint`, a `numeric` as a `string` (issue #286). A column states its own type instead.
 */
function requireColumnFamily(): never {
  throw new Error(
    'litedbmodel: `@column()` no longer declares a column — a column must state its type with a ' +
      'family: @column.text() / .number() / .boolean() / .bigint() / .datetime() / .date() / .uuid() / ' +
      '.json() / .stringArray() / .intArray() / .numericArray() / .booleanArray() / .datetimeArray() / ' +
      '.custom(). Every family takes the same argument as `@column()` did ' +
      "(`@column.text('db_name')`, `@column.number({ primaryKey: true })`). The bare form inferred the " +
      'type from `emitDecoratorMetadata`, which esbuild (tsx/vite/vitest) never emits and standard ' +
      'decorators do not have, so it silently produced untyped reads.',
  );
}

// ============================================
// Serialize Functions (JS -> DB)
// ============================================

/**
 * Serialize function type that optionally accepts driver type cast helper.
 * @internal
 */
export type SerializeFunction = (val: unknown, typeCast?: DriverTypeCast) => unknown;

/**
 * Serialize array using driver's type cast if available.
 * Falls back to PostgreSQL format for backward compatibility.
 */
function serializeArray(val: unknown, typeCast?: DriverTypeCast): unknown {
  if (val === null || val === undefined) return null;
  if (!Array.isArray(val)) return val;
  
  // Use driver's serialize if available
  if (typeCast?.serializeArray) {
    return typeCast.serializeArray(val);
  }
  
  // Fallback: PostgreSQL array format {val1,val2,val3}
  const escaped = val.map(v => {
    if (v === null) return 'NULL';
    if (typeof v === 'string') {
      // Escape backslashes and quotes
      const esc = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      // Quote if contains special chars
      if (v.includes(',') || v.includes('{') || v.includes('}') || v.includes('"') || v.includes(' ')) {
        return `"${esc}"`;
      }
      return esc;
    }
    return String(v);
  });
  return `{${escaped.join(',')}}`;
}

/**
 * Serialize boolean array using driver's type cast if available.
 * Falls back to PostgreSQL format for backward compatibility.
 */
function serializeBooleanArray(val: unknown, typeCast?: DriverTypeCast): unknown {
  if (val === null || val === undefined) return null;
  if (!Array.isArray(val)) return val;
  
  // Use driver's serialize if available
  if (typeCast?.serializeBooleanArray) {
    return typeCast.serializeBooleanArray(val as (boolean | null)[]);
  }
  
  // Fallback: PostgreSQL format
  const mapped = val.map(v => v === null ? 'NULL' : (v ? 't' : 'f'));
  return `{${mapped.join(',')}}`;
}

/**
 * Serialize JSON using driver's type cast if available.
 */
function serializeJson(val: unknown, typeCast?: DriverTypeCast): unknown {
  if (val === null || val === undefined) return null;
  
  // Use driver's serialize if available
  if (typeCast?.serializeJson) {
    return typeCast.serializeJson(val);
  }
  
  // Fallback: JSON.stringify
  if (typeof val === 'string') return val; // Already serialized
  return JSON.stringify(val);
}

// ============================================
// @column Decorator and Variants
// ============================================

/**
 * Column decorator for defining model properties.
 *
 * **Auto-inference**: For simple types (boolean, number, Date, bigint),
 * type conversion is automatically inferred from the TypeScript property type.
 * No need to use explicit variants like `@column.boolean()`.
 *
 * Auto-inferred types:
 * ```typescript
 * @column() id?: number;          // Auto: Number conversion
 * @column() name?: string;        // No conversion needed
 * @column() is_active?: boolean;  // Auto: Boolean conversion
 * @column() created_at?: Date;    // Auto: DateTime conversion
 * @column() large_id?: bigint;    // Auto: BigInt conversion
 * @column('custom_name') prop?: string;  // Custom column name
 * ```
 *
 * Explicit type conversion required (cannot be auto-inferred):
 * ```typescript
 * @column.stringArray() tags?: string[];           // Array element type unknown
 * @column.intArray() scores?: number[];            // Array element type unknown
 * @column.json<MyType>() data?: MyType;            // Generic type unknown
 * @column.date() birth_date?: string;              // date vs datetime distinction
 * ```
 *
 * Note: The explicit variants (`@column.boolean()`, `@column.datetime()`, etc.)
 * still work and can be used when you want to be explicit about the conversion.
 * 
 * @category Decorators
 */
export const column = Object.assign(
  // The bare `@column()` declared no type — it is rejected, with the migration in the message.
  (_columnNameOrOptions?: string | ColumnOptions): never => requireColumnFamily(),
  {
    // ============================================
    // Primitive Types
    // ============================================

    /**
     * Text type (TEXT / VARCHAR / CHAR / ENUM / citext) — the driver value is already a string, so no
     * cast is applied. The family still DECLARES the column so the typed read types it as `TEXT`.
     * @example @column.text() name?: string;
     * @example @column.text('user_name') name?: string;
     */
    text: (columnNameOrOptions?: string | ColumnOptions) =>
      createColumnDecorator<string | null | undefined>(
        undefined,  // no cast — a TEXT column arrives as a string on every driver
        undefined,  // no custom serialize
        undefined,  // no sqlCast family (a text literal needs no SQL cast)
        'TEXT'      // §4.1 token: types the SCP typed read (what design:type = String used to give)
      )(columnNameOrOptions),

    /**
     * Boolean type conversion
     * Converts 't'/'f', 'true'/'false', 1/0 to boolean
     * Preserves null for nullable columns, undefined stays undefined
     * @example @column.boolean() is_active?: boolean;
     */
    boolean: (columnNameOrOptions?: string | ColumnOptions) =>
      createColumnDecorator<boolean | null | undefined>(
        // v2 read contract: BOOLEAN → boolean, via the shared materializer (issue #9).
        (v) => {
          if (v === undefined) return undefined;
          return materializeCell(v, 'bool');
        },
        undefined,  // no custom serialize
        'boolean'   // sqlCast for updateMany type inference
      )(columnNameOrOptions),

    /**
     * Number type conversion (from string)
     * Preserves null for nullable columns, undefined stays undefined
     * @example @column.number() amount?: number;
     */
    number: (columnNameOrOptions?: string | ColumnOptions) =>
      createColumnDecorator<number | null | undefined>((v) => {
        if (v === undefined) return undefined;
        if (v === null) return null;
        const n = Number(v);
        return isNaN(n) ? null : n;
      })(columnNameOrOptions),

    /**
     * BigInt type conversion
     * Preserves null for nullable columns, undefined stays undefined
     * @example @column.bigint() large_id?: string;   // exact decimal string (JSON-safe)
     */
    bigint: (columnNameOrOptions?: string | ColumnOptions) =>
      createColumnDecorator<string | null | undefined>(
        // v2 read contract: BIGINT/INT8 → EXACT decimal STRING (no i64 rounding, JSON-safe), via the
        // shared materializer (issue #9). The declared TS field type may still be `bigint` in existing
        // models, but the runtime value is now the exact string — that IS the realignment.
        (v) => {
          if (v === undefined) return undefined;
          return materializeCell(v, 'int64');
        },
        undefined,  // no custom serialize
        'bigint'    // sqlCast for WHERE/INSERT type casting
      )(columnNameOrOptions),

    // ============================================
    // Date/Time Types
    // ============================================

    /**
     * DateTime type conversion (timestamp, timestamptz)
     * Preserves null for nullable columns, undefined stays undefined
     * 
     * Timezone handling:
     * - PostgreSQL: Serializes to ISO 8601 UTC string with 'Z' suffix for explicit timezone
     * - MySQL/SQLite: Passes Date object to driver (driver-dependent timezone handling)
     * 
     * @example @column.datetime() created_at?: string;  // TZ-attached string, NOT a JS Date
     */
    datetime: (columnNameOrOptions?: string | ColumnOptions) =>
      createColumnDecorator<string | null | undefined>(
        // v2 read contract: DATE/TIMESTAMP/TIMESTAMPTZ/DATETIME/TIME → TZ-attached STRING (NOT a
        // TZ-shifted JS Date), via the shared materializer (issue #9). A driver already returning the
        // native textual form passes through; a JS Date is rendered to its lossless ISO instant.
        (v) => {
          if (v === undefined) return undefined;
          return materializeCell(v, 'date');
        },
        // Delegate to driver-specific serializeDatetime
        (val, typeCast) => {
          if (val === null || val === undefined) return null;
          if (val instanceof Date) {
            return typeCast?.serializeDatetime(val) ?? val;
          }
          return val;
        },
        'timestamp' // sqlCast for updateMany type inference
      )(columnNameOrOptions),

    /**
     * Date type conversion — returns YYYY-MM-DD string.
     * Preserves null for nullable columns, undefined stays undefined.
     * 
     * DB values (Date object or string) are normalized to 'YYYY-MM-DD' string.
     * On write, string values are passed through; Date objects are formatted as 'YYYY-MM-DD'.
     * 
     * @example @column.date() birth_date?: string;      // 'YYYY-MM-DD'
     */
    date: (columnNameOrOptions?: string | ColumnOptions) =>
      createColumnDecorator<string | null | undefined>(
        (v) => {
          if (v === undefined) return undefined;
          if (v === null) return null;
          if (typeof v === 'string') {
            const match = v.match(/^(\d{4}-\d{2}-\d{2})/);
            return match ? match[1] : null;
          }
          if (v instanceof Date) {
            return isNaN(v.getTime()) ? null : formatLocalDate(v);
          }
          if (typeof v === 'number') {
            const dt = new Date(v);
            return isNaN(dt.getTime()) ? null : formatLocalDate(dt);
          }
          return null;
        },
        (val) => {
          if (val === null || val === undefined) return null;
          if (typeof val === 'string') return val;
          if (val instanceof Date) {
            return isNaN(val.getTime()) ? null : formatLocalDate(val);
          }
          return val;
        },
        'date'      // sqlCast for updateMany type inference
      )(columnNameOrOptions),

    // ============================================
    // Array Types
    // ============================================

    /**
     * String array type conversion (text[])
     * Preserves null for nullable columns, undefined stays undefined
     * @example @column.stringArray() tags?: string[];
     */
    stringArray: (columnNameOrOptions?: string | ColumnOptions) =>
      createColumnDecorator<string[] | null | undefined>(
        (v) => {
          if (v === undefined) return undefined;
          if (v === null) return null;
          return castToStringArray(v);
        },
        serializeArray,
        'text[]'
      )(columnNameOrOptions),

    /**
     * Integer array type conversion (integer[])
     * Preserves null for nullable columns, undefined stays undefined
     * @example @column.intArray() scores?: number[];
     */
    intArray: (columnNameOrOptions?: string | ColumnOptions) =>
      createColumnDecorator<number[] | null | undefined>(
        (v) => {
          if (v === undefined) return undefined;
          if (v === null) return null;
          return castToIntegerArray(v);
        },
        serializeArray,
        'int[]'
      )(columnNameOrOptions),

    /**
     * Numeric array type conversion (numeric[], allows null elements)
     * Preserves null for nullable columns, undefined stays undefined
     * @example @column.numericArray() values?: (number | null)[];
     */
    numericArray: (columnNameOrOptions?: string | ColumnOptions) =>
      createColumnDecorator<(number | null)[] | null | undefined>(
        (v) => {
          if (v === undefined) return undefined;
          if (v === null) return null;
          return castToNumericArray(v);
        },
        serializeArray,
        'numeric[]'
      )(columnNameOrOptions),

    /**
     * Boolean array type conversion (boolean[])
     * Preserves null for nullable columns, undefined stays undefined
     * @example @column.booleanArray() flags?: (boolean | null)[];
     */
    booleanArray: (columnNameOrOptions?: string | ColumnOptions) =>
      createColumnDecorator<(boolean | null)[] | null | undefined>(
        (v) => {
          if (v === undefined) return undefined;
          if (v === null) return null;
          return castToBooleanArray(v);
        },
        serializeBooleanArray,
        'boolean[]'
      )(columnNameOrOptions),

    /**
     * DateTime array type conversion (timestamp[])
     * Preserves null for nullable columns, undefined stays undefined
     * @example @column.datetimeArray() event_dates?: (Date | null)[];
     */
    datetimeArray: (columnNameOrOptions?: string | ColumnOptions) =>
      createColumnDecorator<(Date | null)[] | null | undefined>(
        (v) => {
          if (v === undefined) return undefined;
          if (v === null) return null;
          return castToDatetimeArray(v);
        },
        // DateTime arrays serialize each Date to ISO string
        (val) => {
          if (val === null || val === undefined) return null;
          if (!Array.isArray(val)) return val;
          const mapped = val.map(v => v === null ? 'NULL' : (v instanceof Date ? v.toISOString() : String(v)));
          return `{${mapped.join(',')}}`;
        }
      )(columnNameOrOptions),

    // ============================================
    // JSON Types
    // ============================================

    /**
     * JSON/JSONB type conversion
     * Preserves null for nullable columns, undefined stays undefined
     * @example @column.json() metadata?: Record<string, unknown>;
     * @example @column.json<UserSettings>() settings?: UserSettings;
     */
    json: <T = Record<string, unknown>>(columnNameOrOptions?: string | ColumnOptions) =>
      createColumnDecorator<T | null | undefined>(
        (v) => {
          if (v === undefined) return undefined;
          if (v === null) return null;
          return castToJson(v) as T;
        },
        serializeJson,
        'jsonb'
      )(columnNameOrOptions),

    // ============================================
    // UUID Type (PostgreSQL)
    // ============================================

    /**
     * UUID type with automatic casting for PostgreSQL.
     * Automatically adds ::uuid cast to conditions and INSERT/UPDATE values.
     * Preserves null for nullable columns, undefined stays undefined.
     * 
     * @example 
     * ```typescript
     * @column.uuid() id?: string;
     * @column.uuid({ primaryKey: true }) id?: string;
     * 
     * // Conditions automatically cast to UUID:
     * await User.find([[User.id, 'uuid-string']]);
     * // → WHERE id = ?::uuid
     * 
     * // IN clauses also cast:
     * await User.find([[User.id, ['uuid1', 'uuid2']]]);
     * // → WHERE id IN (?::uuid, ?::uuid)
     * ```
     */
    uuid: (columnNameOrOptions?: string | ColumnOptions) =>
      createColumnDecorator<string | null | undefined>(
        (v) => {
          if (v === undefined) return undefined;
          if (v === null) return null;
          // UUID values from DB are typically already strings
          return String(v);
        },
        undefined,  // No serialization needed - handled by sqlCast
        'uuid'      // SQL type for casting
      )(columnNameOrOptions),

    // ============================================
    // Custom Type Conversion
    // ============================================

    /**
     * The driver's value, UNCAST — for a column whose type the library has no cast for (`BYTEA` /
     * `BLOB` arrives as a driver Buffer, a vendor type as whatever the driver decodes). It states
     * "this column is passed through", which is a DECLARATION; the removed bare `@column()` was the
     * absence of one, and produced this same passthrough by accident for every unresolvable type.
     * @example @column.passthrough() payload?: unknown;
     */
    passthrough: (columnNameOrOptions?: string | ColumnOptions) =>
      createColumnDecorator<unknown>()(columnNameOrOptions),

    /**
     * Custom type conversion with user-provided function
     * @example @column.custom((v) => String(v).toUpperCase()) status?: string;
     * @example @column.custom((v) => v, (v) => JSON.stringify(v)) data?: MyType; // with serializer
     */
    custom: <T>(
      castFn: (value: unknown) => T,
      serializeFn?: SerializeFn,
      columnNameOrOptions?: string | ColumnOptions
    ) =>
      createColumnDecorator<T | null | undefined>(castFn, serializeFn)(columnNameOrOptions),
  }
);

// ============================================
// Relation Decorators
// ============================================

/**
 * Record one relation on the class being defined — the ONE place `@hasMany` / `@belongsTo` / `@hasOne`
 * land, for both decorator protocols. The getter itself is installed once, on the prototype, by
 * {@link applyModelDecorator}; see {@link createRelationDecorator} for why the standard protocol needs
 * one extra step to let that getter through.
 */
function registerRelation(
  relations: RelationMeta[],
  propertyKey: string,
  type: RelationType,
  keysFactory: KeysFactory,
  options?: RelationDecoratorOptions
): void {
  relations.push({ propertyKey, type, keysFactory, options });
}

/**
 * Build a relation decorator that accepts BOTH protocols.
 *
 * Under legacy decorators a relation is declared `declare posts: Promise<Post[]>` — `declare` emits no
 * field, so the prototype getter `@model` installs is what the instance sees. TC39 standard decorators
 * REJECT a decorated `declare` field (TS1206), so the relation is declared `posts!: Promise<Post[]>`
 * instead — and a class field IS defined on the instance (as `undefined`), which would SHADOW that
 * prototype getter. The initializer below deletes the shadowing own property, so both protocols end up
 * reading the exact same getter; the getter is not duplicated for the standard path.
 */
function createRelationDecorator<Value>(
  type: RelationType,
  keys: KeysFactory,
  options?: RelationDecoratorOptions
): RelationDecorator<Value> {
  return function (targetOrValue: unknown, keyOrContext: unknown): void {
    if (isStandardContext(keyOrContext)) {
      const propKey = String(keyOrContext.name);
      registerRelation(standardRelationList(classMetadataBag(keyOrContext, propKey)), propKey, type, keys, options);
      keyOrContext.addInitializer?.(function (this: unknown) {
        delete (this as Record<string, unknown>)[propKey];
      });
      return;
    }
    const propKey = String(keyOrContext as string | symbol);
    registerRelation(legacyRelationList((targetOrValue as object).constructor), propKey, type, keys, options);
  } as RelationDecorator<Value>;
}

/**
 * HasMany relation decorator (1:N).
 * Defines a one-to-many relationship where this model has many related records.
 *
 * @param keys - Factory function returning [sourceKey, targetKey] or composite key pairs
 * @param options - Optional order and where clauses
 *
 * @example
 * ```typescript
 * // Single key relation (legacy decorators: `declare`; standard decorators: `posts!: …`)
 * @hasMany(() => [User.id, Post.author_id])
 * declare posts: Promise<Post[]>;
 *
 * // With options
 * @hasMany(() => [User.id, Post.author_id], {
 *   order: () => Post.created_at.desc(),
 *   where: () => [[Post.is_deleted, false]],
 * })
 * declare activePosts: Promise<Post[]>;
 *
 * // Composite key relation
 * @hasMany(() => [
 *   [TenantUser.tenant_id, TenantPost.tenant_id],
 *   [TenantUser.id, TenantPost.author_id],
 * ])
 * declare posts: Promise<TenantPost[]>;
 * ```
 *
 * @category Decorators
 */
export function hasMany<Value = unknown>(
  keys: KeysFactory,
  options?: RelationDecoratorOptions
): RelationDecorator<Value> {
  return createRelationDecorator<Value>('hasMany', keys, options);
}

/**
 * BelongsTo relation decorator (N:1).
 * Defines a many-to-one relationship where this model belongs to a parent record.
 *
 * @param keys - Factory function returning [sourceKey, targetKey] or composite key pairs
 * @param options - Optional order and where clauses
 *
 * @example
 * ```typescript
 * // Single key relation
 * @belongsTo(() => [Post.author_id, User.id])
 * declare author: Promise<User | null>;
 *
 * // Composite key relation
 * @belongsTo(() => [
 *   [TenantPost.tenant_id, TenantUser.tenant_id],
 *   [TenantPost.author_id, TenantUser.id],
 * ])
 * declare author: Promise<TenantUser | null>;
 * ```
 *
 * @category Decorators
 */
export function belongsTo<Value = unknown>(
  keys: KeysFactory,
  options?: RelationDecoratorOptions
): RelationDecorator<Value> {
  return createRelationDecorator<Value>('belongsTo', keys, options);
}

/**
 * HasOne relation decorator (1:1).
 * Defines a one-to-one relationship where this model has one related record.
 *
 * @param keys - Factory function returning [sourceKey, targetKey] or composite key pairs
 * @param options - Optional order and where clauses
 *
 * @example
 * ```typescript
 * // Single key relation
 * @hasOne(() => [User.id, UserProfile.user_id])
 * declare profile: Promise<UserProfile | null>;
 *
 * // Composite key relation
 * @hasOne(() => [
 *   [TenantUser.tenant_id, TenantProfile.tenant_id],
 *   [TenantUser.id, TenantProfile.user_id],
 * ])
 * declare profile: Promise<TenantProfile | null>;
 * ```
 *
 * @category Decorators
 */
export function hasOne<Value = unknown>(
  keys: KeysFactory,
  options?: RelationDecoratorOptions
): RelationDecorator<Value> {
  return createRelationDecorator<Value>('hasOne', keys, options);
}

/**
 * Get relation metadata from a model class
 * @internal
 */
export function getRelationMeta(modelClass: object): RelationMeta[] {
  return (
    (modelClass as { _relationMeta?: RelationMeta[] })._relationMeta ||
    Reflect.getMetadata(RELATIONS_KEY, modelClass) ||
    []
  );
}

// ============================================
// @model Class Decorator
// ============================================

/**
 * Model class decorator.
 *
 * Can be used with or without table name:
 * - `@model` - uses class name as table name (via TABLE_NAME)
 * - `@model('users')` - sets TABLE_NAME to 'users'
 *
 * Automatically:
 * 1. Sets static TABLE_NAME property (if table name provided)
 * 2. Creates static Column properties for each @column decorated property
 * 3. Generates typeCastFromDB() method from @column type conversion settings
 * 4. Creates relation getters from @hasMany, @belongsTo, @hasOne decorators
 *
 * @example
 * ```typescript
 * @model('users')
 * class User extends DBModel {
 *   @column() id?: number;
 *   @column() name?: string;
 *   @column.boolean() is_active?: boolean;
 *   @column.datetime() created_at?: string;
 *
 *   @hasMany(() => [User.id, Post.author_id])
 *   declare posts: Promise<Post[]>;
 * }
 *
 * // Usage - call column to get name as string for computed property key
 * await User.findAll({ [User.id()]: 1 });
 *
 * // Or use condition builders with spread
 * await User.findAll({ ...User.is_active.eq(true) });
 *
 * // Access relations
 * const user = await User.findOne([[User.id, 1]]);
 * const posts = await user.posts;  // Batch loads with other users in context
 * ```
 * 
 * @category Decorators
 */
/** A class decorator that works under both protocols. @category Decorators */
export interface ModelClassDecorator {
  <T extends { new (...args: unknown[]): object }>(constructor: T): T;
  <T extends { new (...args: unknown[]): object }>(value: T, context: ClassDecoratorContext): T;
}

// Overload 1: @model (without arguments)
export function model<T extends { new (...args: unknown[]): object }>(
  constructor: T
): T;
// Overload 2: @model('table_name')
export function model(tableName: string): ModelClassDecorator;
// Overload 3: @model('table_name', options)
export function model(tableName: string, options: ModelOptions): ModelClassDecorator;
// Implementation
export function model<T extends { new (...args: unknown[]): object }>(
  tableNameOrConstructor: string | T,
  options?: ModelOptions
): T | ModelClassDecorator {
  // Called as @model('table_name') or @model('table_name', options)
  if (typeof tableNameOrConstructor === 'string') {
    const tableName = tableNameOrConstructor;
    return function <U extends { new (...args: unknown[]): object }>(
      constructor: U,
      context?: unknown
    ): U {
      const members = modelMembers(constructor, context);
      if (isStandardContext(context)) {
        // Under the standard protocol the class is not finished when its decorator runs: a bundler
        // that preserves names (esbuild's `--keep-names`, which `tsx` turns on) re-defines `Class.name`
        // AFTER the decorator returns. Installing the static column accessors here would either be
        // clobbered by that, or — since they are non-configurable — make it throw `Cannot redefine
        // property: name` on any model with a `name` column. A class decorator's extra initializer is
        // the one hook that runs after the class is fully formed, so the model is assembled there.
        (context as StandardDecoratorContext).addInitializer?.(function (this: unknown) {
          applyModelDecorator(this as U, members, tableName, options);
        });
        return constructor;
      }
      return applyModelDecorator(constructor, members, tableName, options);
    } as ModelClassDecorator;
  }

  // Called as @model (without parentheses or arguments) — legacy only; the standard protocol always
  // invokes a class decorator with `(value, context)`, and `@model` bare is `model(Class)` there too.
  return applyModelDecorator(tableNameOrConstructor, modelMembers(tableNameOrConstructor, undefined));
}

/** The columns + relations `@column.*` / `@hasMany` … recorded for this class, per protocol. */
function modelMembers(
  constructor: object,
  context: unknown
): { columns: Map<string, ColumnMeta>; relations: RelationMeta[] } {
  if (isStandardContext(context)) {
    const bag = classMetadataBag(context, String((constructor as { name?: string }).name ?? 'model'));
    return {
      columns: (bag[COLUMNS_KEY] as Map<string, ColumnMeta> | undefined) ?? new Map(),
      relations: (bag[RELATIONS_KEY] as RelationMeta[] | undefined) ?? [],
    };
  }
  return {
    columns: (Reflect.getMetadata(COLUMNS_KEY, constructor) as Map<string, ColumnMeta> | undefined) ?? new Map(),
    relations: (Reflect.getMetadata(RELATIONS_KEY, constructor) as RelationMeta[] | undefined) ?? [],
  };
}

/**
 * Check if keys are composite (array of pairs) or single pair
 * Single pair: [sourceColumn, targetColumn]
 * Composite: [[sourceCol1, targetCol1], [sourceCol2, targetCol2], ...]
 */
function isCompositeKeys(keys: KeyPair | CompositeKeyPairs): keys is CompositeKeyPairs {
  // If first element is an array, it's composite (array of pairs)
  // If first element is a Column (function), it's a single pair
  return Array.isArray(keys[0]);
}

/**
 * Parse key pair(s) into source and target key arrays
 */
function parseKeys(keys: KeyPair | CompositeKeyPairs): {
  sourceKeys: string[];
  targetKeys: string[];
  targetModelName: string;
} {
  if (isCompositeKeys(keys)) {
    // Composite keys: [[sourceKey1, targetKey1], [sourceKey2, targetKey2], ...]
    const sourceKeys = keys.map(pair => pair[0].columnName);
    const targetKeys = keys.map(pair => pair[1].columnName);
    const targetModelName = keys[0][1].modelName;
    return { sourceKeys, targetKeys, targetModelName };
  } else {
    // Single key pair: [sourceKey, targetKey]
    const [sourceKey, targetKey] = keys;
    return {
      sourceKeys: [sourceKey.columnName],
      targetKeys: [targetKey.columnName],
      targetModelName: targetKey.modelName,
    };
  }
}

/**
 * Internal function to apply the model decorator
 */
function applyModelDecorator<T extends { new (...args: unknown[]): object }>(
  constructor: T,
  members: { columns: Map<string, ColumnMeta>; relations: RelationMeta[] },
  tableName?: string,
  options?: ModelOptions
): T {
  const { columns, relations } = members;
  const modelName = constructor.name;

  // 0. Set TABLE_NAME if provided
  if (tableName) {
    Object.defineProperty(constructor, 'TABLE_NAME', {
      value: tableName,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }

  // 0.1 Apply model options (order, filter, select, updateTable, group)
  if (options) {
    if (options.order) {
      const orderFn = options.order;
      Object.defineProperty(constructor, 'DEFAULT_ORDER', {
        get: () => orderFn(),
        enumerable: true,
        configurable: false,
      });
    }
    if (options.filter) {
      const filterFn = options.filter;
      Object.defineProperty(constructor, 'FIND_FILTER', {
        get: () => filterFn(),
        enumerable: true,
        configurable: false,
      });
    }
    if (options.select !== undefined) {
      Object.defineProperty(constructor, 'SELECT_COLUMN', {
        value: options.select,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
    if (options.updateTable !== undefined) {
      Object.defineProperty(constructor, 'UPDATE_TABLE_NAME', {
        value: options.updateTable,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
    if (options.group) {
      const groupFn = options.group;
      Object.defineProperty(constructor, 'DEFAULT_GROUP', {
        get: () => groupFn(),
        enumerable: true,
        configurable: false,
      });
    }
    if (options.connection !== undefined) {
      Object.defineProperty(constructor, 'CONNECTION', {
        value: options.connection,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
  }

  // 1. Add static Column properties (callable functions)
  // Use tableName if provided, otherwise derive from model name (lowercase)
  const effectiveTableName = tableName ?? modelName.toLowerCase();
  for (const [propKey, meta] of columns) {
    Object.defineProperty(constructor, propKey, {
      value: createColumn(meta.columnName, effectiveTableName, modelName, propKey, meta.sqlCast),
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }

  // 2. Pre-filter columns with typeCast for faster DB reads (optimization)
  const typeCastColumns: Array<[string, TypeCastFn]> = [];
  for (const [propKey, meta] of columns) {
    if (meta.typeCast) {
      typeCastColumns.push([propKey, meta.typeCast]);
    }
  }

  // 3. Generate typeCastFromDB() method
  const originalTypeCast = constructor.prototype.typeCastFromDB;

  // Fast path: if no columns need type casting and no original method
  if (typeCastColumns.length === 0 && !originalTypeCast) {
    constructor.prototype.typeCastFromDB = function () {
      // no-op
    };
  } else {
    constructor.prototype.typeCastFromDB = function () {
      // Call original typeCastFromDB if exists
      if (originalTypeCast) {
        originalTypeCast.call(this);
      }

      // Apply decorator-defined type casts (pre-filtered, no condition check)
      for (const [propKey, typeCast] of typeCastColumns) {
        const currentValue = (this as Record<string, unknown>)[propKey];
        (this as Record<string, unknown>)[propKey] = typeCast(currentValue);
      }
    };
  }

  // 4. Store column metadata for introspection (ESLint plugin, etc.)
  Object.defineProperty(constructor, '_columnMeta', {
    value: columns,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  // 5. Create relation getters from @hasMany, @belongsTo, @hasOne decorators
  for (const relation of relations) {
    const { propertyKey, type, keysFactory, options } = relation;
    // Pre-compute cache key for fast lookup (relationType:propertyKey)
    const cacheKey = `${type}:${propertyKey}`;

    Object.defineProperty(constructor.prototype, propertyKey, {
      get: function () {
        // Fast path: return cached value directly (no Promise overhead)
        if (this._relationCache && this._relationCache.has(cacheKey)) {
          return this._relationCache.get(cacheKey);
        }

        // Slow path: load relation and cache result
        // Call the factory to get keys (lazy resolution for circular references)
        const keys = keysFactory();
        const { sourceKeys, targetKeys, targetModelName } = parseKeys(keys);

        // Build relation config
        const order = options?.order ? orderToString(options.order()) : null;
        const conditions = options?.where ? condsToRecord(options.where()) : undefined;

        // Call internal relation method
        return this._loadRelation(type, targetModelName, {
          sourceKeys,
          targetKeys,
          order,
          conditions,
          limit: options?.limit,
          hardLimit: options?.hardLimit,
          relationName: propertyKey,
        });
      },
      enumerable: true,
      configurable: false,
    });
  }

  // 6. Store relation metadata for introspection
  Object.defineProperty(constructor, '_relationMeta', {
    value: relations,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  // 7. Register model in the registry for relation resolution
  // This is done lazily to support circular references
  // The DBModel._registerModel method is called with the constructor
  const ctor = constructor as unknown as { _registerModel?: (name: string, cls: unknown) => void };
  if (typeof ctor._registerModel === 'function') {
    ctor._registerModel(modelName, constructor);
  }

  return constructor;
}

// ============================================
// Utility Functions
// ============================================

/**
 * Get column metadata from a model class
 * Useful for building tools and plugins
 * Uses cached _columnMeta property (faster than Reflect.getMetadata)
 * @internal
 */
export function getColumnMeta(
  modelClass: object
): Map<string, ColumnMeta> | undefined {
  // Fast path: use cached _columnMeta property (set by @model decorator)
  const cached = (modelClass as { _columnMeta?: Map<string, ColumnMeta> })._columnMeta;
  if (cached) {
    return cached;
  }
  // Fallback to Reflect.getMetadata for classes without @model decorator
  return Reflect.getMetadata(COLUMNS_KEY, modelClass);
}

/**
 * Get all column names from a model class
 * @internal
 */
export function getModelColumnNames(modelClass: object): string[] {
  const meta = getColumnMeta(modelClass);
  if (!meta) return [];
  return Array.from(meta.values()).map((m) => m.columnName);
}

/** A model's primary key, as {@link getPrimaryKey} resolves it. */
export interface ModelPrimaryKey {
  /** The PK PROPERTY keys (field names) — what a `Column` static is looked up by. */
  readonly propKeys: readonly string[];
  /** The PK COLUMN names, in declaration order — what SQL is written against. */
  readonly columns: readonly string[];
  /** The single server-assigned column ({@link ColumnMeta.autoIncrement}), or null. */
  readonly autoInc: string | null;
  /** False when nothing was declared and the legacy `id` default applied. */
  readonly declared: boolean;
}

/**
 * Resolve a model's primary key — the ONE derivation, in the layer that owns column metadata.
 *
 * Priority: the explicit `PKEY_COLUMNS` static, then `@column({ primaryKey: true })`, then the
 * legacy default. The legacy default is an AUTO_INCREMENT `id`: that is what a model which declares
 * nothing has always meant here, and stating it once — where the model's defaults belong — is what
 * keeps it out of the layers that consume the answer (the MySQL `RETURNING` recovery used to
 * hard-code `WHERE id >= …` for want of it, which silently returned no rows for every model whose
 * key was a UUID, a client-supplied int, or a composite).
 *
 * `declared: false` marks that default, so a caller that must not guess can reject it.
 */
export function getPrimaryKey(modelClass: object): ModelPrimaryKey {
  const meta = getColumnMeta(modelClass);
  const autoIncOf = (columns: readonly string[]): string | null => {
    if (meta === undefined) return null;
    for (const m of meta.values()) {
      if (m.autoIncrement === true && columns.includes(m.columnName)) return m.columnName;
    }
    return null;
  };

  const explicit = (modelClass as { PKEY_COLUMNS?: ReadonlyArray<{ columnName: string }> | null }).PKEY_COLUMNS;
  if (explicit !== undefined && explicit !== null && explicit.length > 0) {
    const columns = explicit.map((c) => c.columnName);
    return { propKeys: columns, columns, autoInc: autoIncOf(columns), declared: true };
  }

  if (meta !== undefined) {
    const propKeys: string[] = [];
    const columns: string[] = [];
    for (const [propKey, m] of meta) {
      if (m.primaryKey === true) {
        propKeys.push(propKey);
        columns.push(m.columnName);
      }
    }
    if (columns.length > 0) return { propKeys, columns, autoInc: autoIncOf(columns), declared: true };
  }

  return { propKeys: ['id'], columns: ['id'], autoInc: 'id', declared: false };
}

/**
 * Get all property names with @column decorator from a model class
 * @internal
 */
export function getModelPropertyNames(modelClass: object): string[] {
  const meta = getColumnMeta(modelClass);
  if (!meta) return [];
  return Array.from(meta.keys());
}

// ============================================
// Serialize Cache (Performance Optimization)
// ============================================

/** Cache for serialize function lookup maps (key: propName or columnName -> serialize fn) */
const serializeMapCache = new WeakMap<object, Map<string, SerializeFn>>();

/**
 * Get or build serialize function lookup map for a model class.
 * Cached for O(1) lookup per key instead of O(n) iteration.
 * @internal
 */
function getSerializeMap(modelClass: object): Map<string, SerializeFn> {
  let map = serializeMapCache.get(modelClass);
  if (!map) {
    map = new Map();
    // Use _columnMeta directly (faster than Reflect.getMetadata)
    const meta = (modelClass as { _columnMeta?: Map<string, ColumnMeta> })._columnMeta;
    if (meta) {
      for (const [propKey, m] of meta) {
        if (m.serialize) {
          map.set(propKey, m.serialize);
          if (m.columnName !== propKey) {
            map.set(m.columnName, m.serialize);
          }
        }
      }
    }
    serializeMapCache.set(modelClass, map);
  }
  return map;
}

// ============================================
// SQL Cast Cache (Performance Optimization)
// ============================================

/** Cache for sqlCast lookup maps (key: propName or columnName -> sqlCast string) */
const sqlCastMapCache = new WeakMap<object, Map<string, string>>();

/**
 * Get or build sqlCast lookup map for a model class.
 * Returns a map of column/property names to their SQL cast types.
 * Cached for O(1) lookup per key.
 * @internal
 */
export function getSqlCastMap(modelClass: object): Map<string, string> {
  let map = sqlCastMapCache.get(modelClass);
  if (!map) {
    map = new Map();
    const meta = (modelClass as { _columnMeta?: Map<string, ColumnMeta> })._columnMeta;
    if (meta) {
      for (const [propKey, m] of meta) {
        if (m.sqlCast) {
          map.set(propKey, m.sqlCast);
          if (m.columnName !== propKey) {
            map.set(m.columnName, m.sqlCast);
          }
        }
      }
    }
    sqlCastMapCache.set(modelClass, map);
  }
  return map;
}

/**
 * Serialize a record's values for database insertion/update.
 * Applies the serialize function defined in column decorators.
 * Uses cached lookup map for O(1) per-key performance.
 * @param modelClass - The model class with column metadata
 * @param record - The record to serialize
 * @param typeCast - Optional driver type cast helper for driver-specific serialization
 * @returns Serialized record
 */
export function serializeRecord(
  modelClass: object,
  record: Record<string, unknown>,
  typeCast?: DriverTypeCast
): Record<string, unknown> {
  const serializeMap = getSerializeMap(modelClass);
  
  // Fast path: no serializers defined
  if (serializeMap.size === 0) {
    return record;
  }

  // Mutate in-place: callers (create/createMany/update) build a fresh record object
  // from user input before calling serializeRecord, so the original user data is not affected.
  for (const key of Object.keys(record)) {
    const serialize = serializeMap.get(key);
    if (serialize) {
      record[key] = serialize(record[key], typeCast);
    }
  }

  return record;
}
