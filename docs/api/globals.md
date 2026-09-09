[**litedbmodel v3.0.0**](README.md)

***

# litedbmodel v3.0.0

litedbmodel - A lightweight TypeScript data access layer

Supports PostgreSQL and SQLite databases.

## Classes

### Core

- [DBModel](classes/DBModel.md)

### Column

- [Values](classes/Values.md)
- [Conditions](classes/Conditions.md)

### Middleware

- [Middleware](classes/Middleware.md)

### Errors

- [LimitExceededError](classes/LimitExceededError.md)
- [WriteOutsideTransactionError](classes/WriteOutsideTransactionError.md)
- [WriteInReadOnlyContextError](classes/WriteInReadOnlyContextError.md)

### Other

- [DBHandler](classes/DBHandler.md)
- [SqlRaw](classes/SqlRaw.md)
- [SqlRef](classes/SqlRef.md)

## Interfaces

### Decorators

- [ColumnDecorator](interfaces/ColumnDecorator.md)
- [RelationDecorator](interfaces/RelationDecorator.md)
- [ModelClassDecorator](interfaces/ModelClassDecorator.md)

### Types

- [PkeyResult](interfaces/PkeyResult.md)
- [ModelOptions](interfaces/ModelOptions.md)
- [DBConfigOptions](interfaces/DBConfigOptions.md)
- [LimitConfig](interfaces/LimitConfig.md)

### Other

- [Column](interfaces/Column.md)
- [DBConfig](interfaces/DBConfig.md)
- [MiddlewareConfig](interfaces/MiddlewareConfig.md)
- [CreatedMiddlewareClass](interfaces/CreatedMiddlewareClass.md)
- [SqlFragment](interfaces/SqlFragment.md)
- [SqlTypedFragment](interfaces/SqlTypedFragment.md)
- [SqlCondition](interfaces/SqlCondition.md)
- [ColumnOptions](interfaces/ColumnOptions.md)
- [SelectOptions](interfaces/SelectOptions.md)
- [InsertOptions](interfaces/InsertOptions.md)
- [UpdateOptions](interfaces/UpdateOptions.md)
- [DeleteOptions](interfaces/DeleteOptions.md)
- [UpdateManyOptions](interfaces/UpdateManyOptions.md)
- [TransactionOptions](interfaces/TransactionOptions.md)

## Type Aliases

### Column

#### WriteValue

```ts
type WriteValue<V> = V | V extends string ? Date | bigint : never;
```

Defined in: [Column.ts:769](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L769)

What a column ACCEPTS on write, given the type it READS BACK.

A `@column.datetime()` / `.date()` / `.bigint()` column reads a string — the column's own textual
form, or a BIGINT's exact decimal — but the write path still takes the JS value that string stands
for: a `Date` goes through the driver's dialect-specific datetime serializer (MySQL wants a local
`YYYY-MM-DD HH:mm:ss`, PostgreSQL an ISO instant, and getting that right is the library's job, not
the caller's), and a `bigint` is written as its exact digits. TypeScript cannot tell those columns
from a plain text one — all of them read `string` — so the widening applies to every string column.

##### Type Parameters

| Type Parameter |
| ------ |
| `V` |

### Other

#### SkipType

```ts
type SkipType = typeof SKIP;
```

Defined in: [Column.ts:794](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L794)

***

#### MiddlewareClass

```ts
type MiddlewareClass = {
  getCurrentContext: object;
};
```

Defined in: [Middleware.ts:310](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L310)

Type for middleware class (not instance) — what [DBModel.use](classes/DBModel.md#use) registers.

The requirement is exactly what the registry's ONE consumer uses: a registered class is only ever
constructed and asked for the current request's instance (`MWClass.getCurrentContext()`), whose hook
is then looked up BY NAME and invoked (`DBModel._applyMiddleware` — the lookup is already a cast,
because which hooks a middleware implements is its own choice).

Naming `typeof Middleware` here instead demanded the whole static side — `_storage` / `getStorage`
included — and a `getCurrentContext()` returning a full `Middleware`. The class produced by
[createMiddleware](functions/createMiddleware.md) advertises neither: its state is its own shape, and a state key may
deliberately SHADOW a hook of the same name (`state: { count: 0 }` vs. the `count` hook — at runtime
the assigned own property wins over the prototype method). So the DOCUMENTED pairing
(`DBModel.use(DBModel.createMiddleware(…))`, README) did not typecheck even though it is the
runtime-correct call, and every stateful middleware in the README was affected.

##### Methods

###### getCurrentContext()

```ts
getCurrentContext(): object;
```

Defined in: [Middleware.ts:310](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L310)

###### Returns

`object`

***

#### SqlInterpolation

```ts
type SqlInterpolation = 
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
  | {
  TABLE_NAME: string;
}
  | {
  getTableName: string;
};
```

Defined in: [SqlFragment.ts:93](https://github.com/foo-ogawa/litedbmodel/blob/main/src/SqlFragment.ts#L93)

Union of all types allowed as interpolated values in `sql` tagged templates.

## Variables

### Decorators

#### column

```ts
const column: (columnNameOrOptions?: string | ColumnOptions) => never & {
  text: (columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<string | null | undefined>;
  boolean: (columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<boolean | null | undefined>;
  number: (columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<number | null | undefined>;
  bigint: (columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<string | null | undefined>;
  datetime: (columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<string | null | undefined>;
  date: (columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<string | null | undefined>;
  stringArray: (columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<string[] | null | undefined>;
  intArray: (columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<number[] | null | undefined>;
  numericArray: (columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<(number | null)[] | null | undefined>;
  booleanArray: (columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<(boolean | null)[] | null | undefined>;
  datetimeArray: (columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<(Date | null)[] | null | undefined>;
  json: <T>(columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<T | null | undefined>;
  uuid: (columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<string | null | undefined>;
  passthrough: (columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<unknown>;
  custom: <T>(castFn: (value: unknown) => T, serializeFn?: SerializeFn, columnNameOrOptions?: string | ColumnOptions) => ColumnDecorator<T | null | undefined>;
};
```

Defined in: [decorators.ts:542](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L542)

Column decorator for defining model properties.

**Auto-inference**: For simple types (boolean, number, Date, bigint),
type conversion is automatically inferred from the TypeScript property type.
No need to use explicit variants like `@column.boolean()`.

Auto-inferred types:
```typescript
@column() id?: number;          // Auto: Number conversion
@column() name?: string;        // No conversion needed
@column() is_active?: boolean;  // Auto: Boolean conversion
@column() created_at?: Date;    // Auto: DateTime conversion
@column() large_id?: bigint;    // Auto: BigInt conversion
@column('custom_name') prop?: string;  // Custom column name
```

Explicit type conversion required (cannot be auto-inferred):
```typescript
@column.stringArray() tags?: string[];           // Array element type unknown
@column.intArray() scores?: number[];            // Array element type unknown
@column.json<MyType>() data?: MyType;            // Generic type unknown
@column.date() birth_date?: string;              // date vs datetime distinction
```

Note: The explicit variants (`@column.boolean()`, `@column.datetime()`, etc.)
still work and can be used when you want to be explicit about the conversion.

##### Type Declaration

| Name | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| `text()` | (`columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<`string` \| `null` \| `undefined`\> | Text type (TEXT / VARCHAR / CHAR / ENUM / citext) — the driver value is already a string, so no cast is applied. The family still DECLARES the column so the typed read types it as `TEXT`. **Examples** `@column.text() name?: string;` `@column.text('user_name') name?: string;` | [decorators.ts:556](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L556) |
| `boolean()` | (`columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<`boolean` \| `null` \| `undefined`\> | Boolean type conversion Converts 't'/'f', 'true'/'false', 1/0 to boolean Preserves null for nullable columns, undefined stays undefined **Example** `@column.boolean() is_active?: boolean;` | [decorators.ts:570](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L570) |
| `number()` | (`columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<`number` \| `null` \| `undefined`\> | Number type conversion (from string) Preserves null for nullable columns, undefined stays undefined **Example** `@column.number() amount?: number;` | [decorators.ts:586](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L586) |
| `bigint()` | (`columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<`string` \| `null` \| `undefined`\> | BigInt type conversion Preserves null for nullable columns, undefined stays undefined **Example** `@column.bigint() large_id?: string; // exact decimal string (JSON-safe)` | [decorators.ts:599](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L599) |
| `datetime()` | (`columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<`string` \| `null` \| `undefined`\> | DateTime type conversion (timestamp, timestamptz) Preserves null for nullable columns, undefined stays undefined Timezone handling: - PostgreSQL: Serializes to ISO 8601 UTC string with 'Z' suffix for explicit timezone - MySQL/SQLite: Passes Date object to driver (driver-dependent timezone handling) **Example** `@column.datetime() created_at?: string; // TZ-attached string, NOT a JS Date` | [decorators.ts:626](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L626) |
| `date()` | (`columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<`string` \| `null` \| `undefined`\> | Date type conversion — returns YYYY-MM-DD string. Preserves null for nullable columns, undefined stays undefined. DB values (Date object or string) are normalized to 'YYYY-MM-DD' string. On write, string values are passed through; Date objects are formatted as 'YYYY-MM-DD'. **Example** `@column.date() birth_date?: string; // 'YYYY-MM-DD'` | [decorators.ts:655](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L655) |
| `stringArray()` | (`columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<`string`[] \| `null` \| `undefined`\> | String array type conversion (text[]) Preserves null for nullable columns, undefined stays undefined **Example** `@column.stringArray() tags?: string[];` | [decorators.ts:693](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L693) |
| `intArray()` | (`columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<`number`[] \| `null` \| `undefined`\> | Integer array type conversion (integer[]) Preserves null for nullable columns, undefined stays undefined **Example** `@column.intArray() scores?: number[];` | [decorators.ts:709](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L709) |
| `numericArray()` | (`columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<(`number` \| `null`)[] \| `null` \| `undefined`\> | Numeric array type conversion (numeric[], allows null elements) Preserves null for nullable columns, undefined stays undefined **Example** `@column.numericArray() values?: (number | null)[];` | [decorators.ts:725](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L725) |
| `booleanArray()` | (`columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<(`boolean` \| `null`)[] \| `null` \| `undefined`\> | Boolean array type conversion (boolean[]) Preserves null for nullable columns, undefined stays undefined **Example** `@column.booleanArray() flags?: (boolean | null)[];` | [decorators.ts:741](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L741) |
| `datetimeArray()` | (`columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<(`Date` \| `null`)[] \| `null` \| `undefined`\> | DateTime array type conversion (timestamp[]) Preserves null for nullable columns, undefined stays undefined **Example** `@column.datetimeArray() event_dates?: (Date | null)[];` | [decorators.ts:757](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L757) |
| `json()` | \<`T`\>(`columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<`T` \| `null` \| `undefined`\> | JSON/JSONB type conversion Preserves null for nullable columns, undefined stays undefined **Examples** `@column.json() metadata?: Record<string, unknown>;` `@column.json<UserSettings>() settings?: UserSettings;` | [decorators.ts:783](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L783) |
| `uuid()` | (`columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<`string` \| `null` \| `undefined`\> | UUID type with automatic casting for PostgreSQL. Automatically adds ::uuid cast to conditions and INSERT/UPDATE values. Preserves null for nullable columns, undefined stays undefined. **Example** `@column.uuid() id?: string; @column.uuid({ primaryKey: true }) id?: string; // Conditions automatically cast to UUID: await User.find([[User.id, 'uuid-string']]); // → WHERE id = ?::uuid // IN clauses also cast: await User.find([[User.id, ['uuid1', 'uuid2']]]); // → WHERE id IN (?::uuid, ?::uuid)` | [decorators.ts:817](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L817) |
| `passthrough()` | (`columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<`unknown`\> | The driver's value, UNCAST — for a column whose type the library has no cast for (`BYTEA` / `BLOB` arrives as a driver Buffer, a vendor type as whatever the driver decodes). It states "this column is passed through", which is a DECLARATION; the removed bare `@column()` was the absence of one, and produced this same passthrough by accident for every unresolvable type. **Example** `@column.passthrough() payload?: unknown;` | [decorators.ts:840](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L840) |
| `custom()` | \<`T`\>(`castFn`: (`value`: `unknown`) => `T`, `serializeFn?`: `SerializeFn`, `columnNameOrOptions?`: `string` \| [`ColumnOptions`](interfaces/ColumnOptions.md)) => [`ColumnDecorator`](interfaces/ColumnDecorator.md)\<`T` \| `null` \| `undefined`\> | Custom type conversion with user-provided function **Examples** `@column.custom((v) => String(v).toUpperCase()) status?: string;` `@column.custom((v) => v, (v) => JSON.stringify(v)) data?: MyType; // with serializer` | [decorators.ts:848](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L848) |

### Other

#### SKIP

```ts
const SKIP: typeof SKIP;
```

Defined in: [Column.ts:793](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Column.ts#L793)

Sentinel value to skip a field in create/update operations.
Use with conditional expressions to keep code as expressions instead of statements.

##### Example

```typescript
// Instead of:
const updates = new Values<User>();
if (body.name !== undefined) updates.add(User.name, body.name);
if (body.email !== undefined) updates.add(User.email, body.email);

// You can write:
await User.update(conds, [
  [User.name, body.name ?? SKIP],
  [User.email, body.email ?? SKIP],
]);
```

## Functions

### Decorators

- [hasMany](functions/hasMany.md)
- [belongsTo](functions/belongsTo.md)
- [hasOne](functions/hasOne.md)

### Middleware

- [createMiddleware](functions/createMiddleware.md)

### Other

- [condsToRecord](functions/condsToRecord.md)
- [initDBHandler](functions/initDBHandler.md)
- [getDBHandler](functions/getDBHandler.md)
- [getDBConfig](functions/getDBConfig.md)
- [closeAllPools](functions/closeAllPools.md)
- [getTransactionContext](functions/getTransactionContext.md)
- [getTransactionConnection](functions/getTransactionConnection.md)
- [dbNull](functions/dbNull.md)
- [dbNotNull](functions/dbNotNull.md)
- [dbTrue](functions/dbTrue.md)
- [dbFalse](functions/dbFalse.md)
- [dbNow](functions/dbNow.md)
- [dbIn](functions/dbIn.md)
- [dbDynamic](functions/dbDynamic.md)
- [dbRaw](functions/dbRaw.md)
- [dbImmediate](functions/dbImmediate.md)
- [dbCast](functions/dbCast.md)
- [dbUuid](functions/dbUuid.md)
- [dbCastIn](functions/dbCastIn.md)
- [dbUuidIn](functions/dbUuidIn.md)
- [parentRef](functions/parentRef.md)
- [isSqlFragment](functions/isSqlFragment.md)
- [isSqlTypedFragment](functions/isSqlTypedFragment.md)
- [isSqlCondition](functions/isSqlCondition.md)
- [isAnySqlFragment](functions/isAnySqlFragment.md)
- [isSqlRaw](functions/isSqlRaw.md)
- [isSqlRef](functions/isSqlRef.md)
- [sql](functions/sql.md)
- [formatLocalDate](functions/formatLocalDate.md)
- [formatUTCDate](functions/formatUTCDate.md)
- [isConnectionError](functions/isConnectionError.md)
- [model](functions/model.md)
- [createPostgresDriver](functions/createPostgresDriver.md)
- [createSqliteDriver](functions/createSqliteDriver.md)

## References

### LazyLoadingDBModel

Renames and re-exports [DBModel](classes/DBModel.md)
