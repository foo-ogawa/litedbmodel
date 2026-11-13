# litedbmodel API Reference

The public API of the `litedbmodel` package, generated from the sources by `npm run docs`. For how to
use it, start with the [API Guide](../api-guide.md).

<!--@embedoc:api_index-->
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
- [TransactionClosedError](classes/TransactionClosedError.md)
- [WriteInReadOnlyContextError](classes/WriteInReadOnlyContextError.md)

### Other

- [DBHandler](classes/DBHandler.md)
- [SqlRaw](classes/SqlRaw.md)
- [SqlRef](classes/SqlRef.md)

## Interfaces

### Types

- [PkeyResult](interfaces/PkeyResult.md)
- [ModelOptions](interfaces/ModelOptions.md)
- [DBConfigOptions](interfaces/DBConfigOptions.md)
- [LimitConfig](interfaces/LimitConfig.md)

### Other

- [Column](interfaces/Column.md)
- [MiddlewareConfig](interfaces/MiddlewareConfig.md)
- [CreatedMiddlewareClass](interfaces/CreatedMiddlewareClass.md)
- [SqlFragment](interfaces/SqlFragment.md)
- [SqlTypedFragment](interfaces/SqlTypedFragment.md)
- [SqlCondition](interfaces/SqlCondition.md)
- [ColumnOptions](interfaces/ColumnOptions.md)
- [DBConfig](interfaces/DBConfig.md)
- [SelectOptions](interfaces/SelectOptions.md)
- [InsertOptions](interfaces/InsertOptions.md)
- [UpdateOptions](interfaces/UpdateOptions.md)
- [DeleteOptions](interfaces/DeleteOptions.md)
- [UpdateManyOptions](interfaces/UpdateManyOptions.md)
- [TransactionOptions](interfaces/TransactionOptions.md)

## Type Aliases

### SkipType

```ts
type SkipType = typeof SKIP;
```

Defined in: [Column.ts:791](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Column.ts#L791)

***

### MiddlewareClass

```ts
type MiddlewareClass = { getCurrentContext(): object };
```

Defined in: [Middleware.ts:296](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L296)

Type for middleware class (not instance): what `DBModel.use` needs from it — the current request's
instance (`getCurrentContext()`), whose hooks are looked up by name. A class made by
[`createMiddleware`](functions/createMiddleware.md) has its own state shape, so this does not ask for the full `Middleware`.

#### Methods

##### getCurrentContext()

```ts
getCurrentContext(): object;
```

Defined in: [Middleware.ts:296](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L296)

###### Returns

`object`

***

### SqlInterpolation

```ts
type SqlInterpolation = | Column<any, any>
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
```

Defined in: [SqlFragment.ts:93](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/SqlFragment.ts#L93)

Union of all types allowed as interpolated values in `sql` tagged templates.

## Variables

### Decorators

#### column

```ts
const column: ((columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator) & { boolean: (columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator; number: (columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator; bigint: (columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator; datetime: (columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator; date: (columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator; stringArray: (columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator; intArray: (columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator; numericArray: (columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator; booleanArray: (columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator; datetimeArray: (columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator; json: <T = Record<string, unknown>>(columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator; decimal: (columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator; uuid: (columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator; custom: <T>(castFn: (value: unknown) => T, serializeFn?: SerializeFn | undefined, columnNameOrOptions?: string | ColumnOptions | undefined) => PropertyDecorator; };
```

Defined in: [decorators.ts:429](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L429)

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
@column.decimal() price?: string;               // NUMERIC / DECIMAL — exact decimal string
```

Note: The explicit variants (`@column.boolean()`, `@column.datetime()`, etc.)
still work and can be used when you want to be explicit about the conversion.

##### Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="boolean"></a> `boolean` | `(columnNameOrOptions?: string \|`[`ColumnOptions`](interfaces/ColumnOptions.md)`\| undefined) => PropertyDecorator` | Boolean type conversion Converts 't'/'f', 'true'/'false', 1/0 to boolean Preserves null for nullable columns, undefined stays undefined<br><br>**Column** .boolean() is_active?: boolean;<br><br>**Example** | [decorators.ts:443](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L443) |
| <a id="number"></a> `number` | `(columnNameOrOptions?: string \|`[`ColumnOptions`](interfaces/ColumnOptions.md)`\| undefined) => PropertyDecorator` | Number type conversion (from string) Preserves null for nullable columns, undefined stays undefined<br><br>**Column** .number() amount?: number;<br><br>**Example** | [decorators.ts:459](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L459) |
| <a id="bigint"></a> `bigint` | `(columnNameOrOptions?: string \|`[`ColumnOptions`](interfaces/ColumnOptions.md)`\| undefined) => PropertyDecorator` | BigInt type conversion Preserves null for nullable columns, undefined stays undefined<br><br>**Column** .bigint() large_id?: bigint;<br><br>**Example** | [decorators.ts:472](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L472) |
| <a id="datetime"></a> `datetime` | `(columnNameOrOptions?: string \|`[`ColumnOptions`](interfaces/ColumnOptions.md)`\| undefined) => PropertyDecorator` | DateTime type conversion (timestamp, timestamptz) Preserves null for nullable columns, undefined stays undefined<br><br>Timezone handling: - PostgreSQL: Serializes to ISO 8601 UTC string with 'Z' suffix for explicit timezone - MySQL/SQLite: Passes Date object to driver (driver-dependent timezone handling)<br><br>**Column** .datetime() created_at?: Date;<br><br>**Example** | [decorators.ts:502](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L502) |
| <a id="date"></a> `date` | `(columnNameOrOptions?: string \|`[`ColumnOptions`](interfaces/ColumnOptions.md)`\| undefined) => PropertyDecorator` | Date type conversion — returns YYYY-MM-DD string. Preserves null for nullable columns, undefined stays undefined.<br><br>DB values (Date object or string) are normalized to 'YYYY-MM-DD' string. On write, string values are passed through; Date objects are formatted as 'YYYY-MM-DD'.<br><br>**Column** .date() birth_date?: string;<br><br>**Example** | [decorators.ts:529](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L529) |
| <a id="stringarray"></a> `stringArray` | `(columnNameOrOptions?: string \|`[`ColumnOptions`](interfaces/ColumnOptions.md)`\| undefined) => PropertyDecorator` | String array type conversion (text[]) Preserves null for nullable columns, undefined stays undefined<br><br>**Column** .stringArray() tags?: string[];<br><br>**Example** | [decorators.ts:568](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L568) |
| <a id="intarray"></a> `intArray` | `(columnNameOrOptions?: string \|`[`ColumnOptions`](interfaces/ColumnOptions.md)`\| undefined) => PropertyDecorator` | Integer array type conversion (integer[]) Preserves null for nullable columns, undefined stays undefined<br><br>**Column** .intArray() scores?: number[];<br><br>**Example** | [decorators.ts:585](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L585) |
| <a id="numericarray"></a> `numericArray` | `(columnNameOrOptions?: string \|`[`ColumnOptions`](interfaces/ColumnOptions.md)`\| undefined) => PropertyDecorator` | Numeric array type conversion (numeric[], allows null elements) Preserves null for nullable columns, undefined stays undefined<br><br>**Column** .numericArray() values?: (number \| null)[];<br><br>**Example** | [decorators.ts:602](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L602) |
| <a id="booleanarray"></a> `booleanArray` | `(columnNameOrOptions?: string \|`[`ColumnOptions`](interfaces/ColumnOptions.md)`\| undefined) => PropertyDecorator` | Boolean array type conversion (boolean[]) Preserves null for nullable columns, undefined stays undefined<br><br>**Column** .booleanArray() flags?: (boolean \| null)[];<br><br>**Example** | [decorators.ts:619](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L619) |
| <a id="datetimearray"></a> `datetimeArray` | `(columnNameOrOptions?: string \|`[`ColumnOptions`](interfaces/ColumnOptions.md)`\| undefined) => PropertyDecorator` | DateTime array type conversion (timestamp[]) Preserves null for nullable columns, undefined stays undefined<br><br>**Column** .datetimeArray() event_dates?: (Date \| null)[];<br><br>**Example** | [decorators.ts:636](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L636) |
| <a id="json"></a> `json` | `<T = Record<string, unknown>>(columnNameOrOptions?: string \|`[`ColumnOptions`](interfaces/ColumnOptions.md)`\| undefined) => PropertyDecorator` | JSON/JSONB type conversion Preserves null for nullable columns, undefined stays undefined<br><br>**Column** .json() metadata?: Record<string, unknown>;<br><br>**Column** .json<UserSettings>() settings?: UserSettings;<br><br>**Examples** | [decorators.ts:662](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L662) |
| <a id="decimal"></a> `decimal` | `(columnNameOrOptions?: string \|`[`ColumnOptions`](interfaces/ColumnOptions.md)`\| undefined) => PropertyDecorator` | Exact decimal type (NUMERIC / DECIMAL) — read back as its exact decimal STRING (a JS number rounds past 2^53). The family states the column is `numeric`, so a write binds the string as a numeric — a batch write (`createMany` / `updateMany`) included.<br><br>**Column** .decimal() price?: string;<br><br>**Example** | [decorators.ts:703](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L703) |
| <a id="uuid"></a> `uuid` | `(columnNameOrOptions?: string \|`[`ColumnOptions`](interfaces/ColumnOptions.md)`\| undefined) => PropertyDecorator` |  | [decorators.ts:715](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L715) |
| <a id="custom"></a> `custom` | `<T>(castFn: (value: unknown) => T, serializeFn?: SerializeFn \| undefined, columnNameOrOptions?: string \|`[`ColumnOptions`](interfaces/ColumnOptions.md)`\| undefined) => PropertyDecorator` | Custom type conversion with user-provided function<br><br>**Column** .custom((v) => String(v).toUpperCase()) status?: string;<br><br>**Column** .custom((v) => v, (v) => JSON.stringify(v)) data?: MyType; // with serializer<br><br>**Examples** | [decorators.ts:737](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L737) |

### Other

#### SKIP

```ts
const SKIP: typeof SKIP;
```

Defined in: [Column.ts:790](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Column.ts#L790)

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
- [model](functions/model.md)

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
- [createPostgresDriver](functions/createPostgresDriver.md)
- [createSqliteDriver](functions/createSqliteDriver.md)

## References

### LazyLoadingDBModel

Renames and re-exports [DBModel](classes/DBModel.md)

<!--@embedoc:end-->
