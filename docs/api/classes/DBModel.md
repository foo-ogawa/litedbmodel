[API](../README.md) / DBModel

# Abstract Class: DBModel

Defined in: [DBModel.ts:149](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L149)

Base class for all database models in litedbmodel.
Provides CRUD operations, relations, transactions, and middleware support.

DBModel is designed for explicit SQL control with type-safe operations:
- Condition tuples `[Column, value]` for compile-time validation
- Symbol-based columns for IDE refactoring support
- Transparent N+1 prevention via automatic batch loading
- Reader/writer separation for production deployments

## Example

```typescript
import { DBModel, model, column } from 'litedbmodel';

// 1. Define model
@model('users')
class UserModel extends DBModel {
  @column.number() id?: number;
  @column.text() name?: string;
  @column.text() email?: string;
  @column.boolean() is_active?: boolean;
}
export const User = UserModel.asModel();

// 2. Configure database
DBModel.setConfig({
  host: 'localhost',
  database: 'mydb',
  user: 'user',
  password: 'pass',
});

// 3. CRUD operations (writes require transaction)
await DBModel.transaction(async () => {
  await User.create([
    [User.name, 'John'],
    [User.email, 'john@example.com'],
  ]);
  await User.update([[User.id, 1]], [[User.name, 'Jane']]);
  await User.delete([[User.is_active, false]]);
});

// 4. Read operations
const users = await User.find([[User.is_active, true]]);
const john = await User.findOne([[User.email, 'john@example.com']]);
```

## Constructors

### constructor

```ts
new DBModel(): DBModel;
```

Defined in: [DBModel.ts:1888](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1888)

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="query"></a> `QUERY` (static) | `string \|`[`SqlFragment`](../interfaces/SqlFragment.md)`\|`[`SqlCondition`](../interfaces/SqlCondition.md)`\|`[`SqlTypedFragment`](../interfaces/SqlTypedFragment.md)`\| null` | SQL query for query-based models (view models, aggregations, etc.) When defined, the model uses this query as a CTE instead of TABLE_NAME.<br><br>**Example** `// Static query` `` static QUERY = ` `` `SELECT users.id, COUNT(posts.id) as post_count` `FROM users LEFT JOIN posts ON users.id = posts.user_id` `GROUP BY users.id` `` `; `` | [DBModel.ts:208](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L208) |
| <a id="_dbconfig"></a> `_dbConfig` (static protected) | [`DBConfig`](../interfaces/DBConfig.md)`\| null` | Database config | [DBModel.ts:230](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L230) |
| <a id="_limitconfig"></a> `_limitConfig` (static protected) | [`LimitConfig`](../interfaces/LimitConfig.md) | Limit config for safety guards | [DBModel.ts:233](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L233) |
| <a id="_configoptions"></a> `_configOptions` (static protected) | [`DBConfigOptions`](../interfaces/DBConfigOptions.md) | Configuration options for reader/writer separation | [DBModel.ts:236](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L236) |
| <a id="_writersticky"></a> `_writerSticky` (static protected) | `WriterStickyClock` | Writer-sticky clock of the v1 execution path (the SCP runtime carries its own in its routing). | [DBModel.ts:242](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L242) |
| <a id="true"></a> `true` (static readonly) | `DBBoolValue` | Boolean TRUE value | [DBModel.ts:1475](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1475) |
| <a id="false"></a> `false` (static readonly) | `DBBoolValue` | Boolean FALSE value | [DBModel.ts:1478](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1478) |
| <a id="null"></a> `null` (static readonly) | `DBNullValue` | NULL value | [DBModel.ts:1481](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1481) |
| <a id="notnull"></a> `notNull` (static readonly) | `DBNotNullValue` | NOT NULL value | [DBModel.ts:1484](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1484) |
| <a id="now"></a> `now` (static readonly) | `DBImmediateValue` | NOW() value | [DBModel.ts:1487](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1487) |
| <a id="_modelclass"></a> `_modelClass` (protected) | `typeof DBModel` | Instance reference to the static class | [DBModel.ts:1877](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1877) |
| <a id="_relationcache"></a> `_relationCache` (protected) | `Map<string, unknown> \| null` | Per-instance cache for loaded relations (lazy-initialized) | [DBModel.ts:1880](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1880) |
| <a id="_deferredcontext"></a> `_deferredContext` | `[typeof DBModel, DBModel[]] \| null` | Deferred context info: [sourceClass, records] set by _select, resolved on first relation access | [DBModel.ts:1886](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1886) |

## Methods

### asModel()

```ts
static asModel<T extends typeof DBModel>(this: T): T & ColumnsOf<InstanceType<T>>;
```

Defined in: [DBModel.ts:175](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L175)

Returns the model class with type-safe column properties.
Use this instead of manual casting with `ColumnsOf`.

#### Example

```typescript
@model('users')
class UserModel extends DBModel {
  @column.number() id?: number;
  @column.text() name?: string;
}
export const User = UserModel.asModel();
export type User = UserModel;

// Now you can use User.id, User.name as Column references
await User.find([[User.name, 'John']]);
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `T` |

#### Returns

`T & ColumnsOf<InstanceType<T>>`

***

### setConfig()

```ts
static setConfig(config: DBConfig, options?: DBConfigOptions): void;
```

Defined in: [DBModel.ts:404](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L404)

Initialize DBModel with database config.
Call this once at application startup.

#### Example

```typescript
import { DBModel } from 'litedbmodel';

// Basic configuration
DBModel.setConfig({
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'user',
  password: 'pass',
});

// With reader/writer separation
DBModel.setConfig(
  { host: 'reader.db.example.com', database: 'mydb', ... },
  {
    writerConfig: { host: 'writer.db.example.com', database: 'mydb', ... },
    useWriterAfterTransaction: true,  // Keep using writer after transaction
    writerStickyDuration: 5000,       // Duration in ms
  }
);
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`DBConfig`](../interfaces/DBConfig.md) |
| `options?` | [`DBConfigOptions`](../interfaces/DBConfigOptions.md) |

#### Returns

`void`

***

### getLimitConfig()

```ts
static getLimitConfig(): LimitConfig;
```

Defined in: [DBModel.ts:437](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L437)

Get current limit configuration.

#### Returns

[`LimitConfig`](../interfaces/LimitConfig.md)

***

### setLimitConfig()

```ts
static setLimitConfig(config: LimitConfig): void;
```

Defined in: [DBModel.ts:452](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L452)

Update limit configuration.

#### Example

```typescript
// Set limits after initial config
DBModel.setLimitConfig({ findHardLimit: 5000, hasManyHardLimit: 500 });

// Disable limits
DBModel.setLimitConfig({ findHardLimit: null, hasManyHardLimit: null });
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`LimitConfig`](../interfaces/LimitConfig.md) |

#### Returns

`void`

***

### getDBConfig()

```ts
static getDBConfig(): DBConfig | null;
```

Defined in: [DBModel.ts:459](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L459)

Get database config

#### Returns

[`DBConfig`](../interfaces/DBConfig.md)`| null`

***

### getDriverType()

```ts
static getDriverType(): 'postgres' | 'mysql' | 'sqlite';
```

Defined in: [DBModel.ts:467](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L467)

Get the database driver type.
Returns 'postgres', 'mysql', or 'sqlite'.

#### Returns

`'postgres' | 'mysql' | 'sqlite'`

***

### getHandler()

```ts
static getHandler(): DBHandler;
```

Defined in: [DBModel.ts:518](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L518)

Get a DBHandler instance for this model: the transaction's handler inside a transaction, else the
default handler (whose reads `execute()` sends to the writer inside `withWriter()` or while
writer-sticky).

#### Returns

[`DBHandler`](../classes/DBHandler.md)

***

### \_shouldUseWriterSticky()

```ts
static _shouldUseWriterSticky(): boolean;
```

Defined in: [DBModel.ts:533](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L533)

Check if this async chain should read from the writer because it committed a transaction within
`writerStickyDuration` (read-your-writes for the request that wrote).

#### Returns

`boolean`

***

### \_getTransactionContext()

```ts
static _getTransactionContext(): AsyncLocalStorage<TransactionContext>;
```

Defined in: [DBModel.ts:541](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L541)

Get transaction context storage.
Override in subclass to use independent transaction context.

#### Returns

`AsyncLocalStorage<TransactionContext>`

***

### \_getWriterContext()

```ts
static _getWriterContext(): AsyncLocalStorage<WriterContext>;
```

Defined in: [DBModel.ts:549](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L549)

Get writer context storage.
Override in subclass to use independent writer context.

#### Returns

`AsyncLocalStorage<WriterContext>`

***

### inWriterContext()

```ts
static inWriterContext(): boolean;
```

Defined in: [DBModel.ts:556](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L556)

Check if currently in a withWriter context.

#### Returns

`boolean`

***

### use()

```ts
static use(MiddlewareClass: MiddlewareClass): () => void;
```

Defined in: [DBModel.ts:602](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L602)

Register a middleware class to intercept DBModel methods.

Each request gets its own middleware instance via AsyncLocalStorage.

#### Example

```typescript
class LoggerMiddleware extends Middleware {
  logs: string[] = [];

  async execute(next: NextExecute, sql: string, params?: unknown[]) {
    this.logs.push(sql);
    const start = Date.now();
    const result = await next(sql, params);
    console.log(`SQL: ${sql} (${Date.now() - start}ms)`);
    return result;
  }

  getLogs() {
    return this.logs;
  }
}

DBModel.use(LoggerMiddleware);

// One request
await Middleware.run(async () => {
  await handleRequest();
  console.log(LoggerMiddleware.getCurrentContext().getLogs());
});
```

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `MiddlewareClass` | [`MiddlewareClass`](../README.md#middlewareclass) | Middleware class to register |

#### Returns

`() => void`

Function to unregister the middleware

***

### createMiddleware()

```ts
static createMiddleware<S extends object = Record<string, never>>(config: MiddlewareConfig<S>): CreatedMiddlewareClass<S>;
```

Defined in: [DBModel.ts:654](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L654)

Create a middleware class from a configuration object.

This is a simpler alternative to extending the Middleware class directly.
Each request gets its own copy of the state object via AsyncLocalStorage.

#### Example

```typescript
// Simple logger (no state)
const LoggerMiddleware = DBModel.createMiddleware({
  execute: async function(next, sql, params) {
    console.log('SQL:', sql);
    return next(sql, params);
  }
});

// With per-request state
const TenantMiddleware = DBModel.createMiddleware({
  state: { tenantId: 0, logs: [] as string[] },

  // Note: hook signature is (model, next, ...args) for method-level hooks
  find: async function(model, next, conditions, options) {
    // `this` is typed as { tenantId: number; logs: string[] }
    this.logs.push(`find on ${model.TABLE_NAME}`);
    if (model.tenant_id) {
      conditions = [[model.tenant_id, this.tenantId], ...conditions];
    }
    return next(conditions, options);
  }
});

// Register
DBModel.use(TenantMiddleware);

// Set tenant for the current request (inside Middleware.run at the request entry, type-safe)
TenantMiddleware.getCurrentContext().tenantId = 123;
```

#### Type Parameters

| Type Parameter |
| ------ |
| `S extends object = Record<string, never>` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `config` | [`MiddlewareConfig`](../interfaces/MiddlewareConfig.md)`<S>` | Middleware configuration with state and hook functions |

#### Returns

[`CreatedMiddlewareClass`](../interfaces/CreatedMiddlewareClass.md)`<S>`

A middleware class that can be passed to DBModel.use()

***

### removeMiddleware()

```ts
static removeMiddleware(MiddlewareClass: MiddlewareClass): boolean;
```

Defined in: [DBModel.ts:665](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L665)

Remove a middleware class

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `MiddlewareClass` | [`MiddlewareClass`](../README.md#middlewareclass) | Middleware class to remove |

#### Returns

`boolean`

true if middleware was found and removed

***

### clearMiddlewares()

```ts
static clearMiddlewares(): void;
```

Defined in: [DBModel.ts:677](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L677)

Clear all middlewares (useful for testing)

#### Returns

`void`

***

### getMiddlewares()

```ts
static getMiddlewares(): readonly MiddlewareClass[];
```

Defined in: [DBModel.ts:684](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L684)

Get registered middleware classes

#### Returns

`readonly`[`MiddlewareClass`](../README.md#middlewareclass)`[]`

***

### buildSelectSQL()

```ts
static buildSelectSQL<T extends typeof DBModel>(this: T, conditions: ConditionObject, options?: SelectOptions, params?: unknown[]): { sql: string; params: unknown[] };
```

Defined in: [DBModel.ts:874](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L874)

Build SELECT SQL without executing.
Useful for constructing CTE/subquery SQL fragments.
Returns SQL with ? placeholders and params array.

#### Example

```typescript
// Build a subquery SQL
const { sql, params } = User.buildSelectSQL(
  { status: 'active' },
  { select: 'id', order: 'created_at DESC', limit: 10 }
);
// sql: "SELECT id FROM users WHERE status = ? ORDER BY created_at DESC LIMIT 10"
// params: ['active']
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `conditions` | `ConditionObject` | WHERE conditions |
| `options?` | [`SelectOptions`](../interfaces/SelectOptions.md) | SELECT options (order, limit, select, etc.) **Default** `{}` |
| `params?` | `unknown[]` | Optional parameter array to append to (for joining with outer query) **Default** `[]` |

#### Returns

`{`[`sql`](../functions/sql.md)`: string; params: unknown[] }`

Object with sql and params

***

### \_mergeFindFilter()

```ts
static _mergeFindFilter(conditions: ConditionObject): ConditionObject;
```

Defined in: [DBModel.ts:961](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L961)

Merge FIND_FILTER (the model's default filter) into a condition object (v1 `_buildSelectSQL` parity).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `conditions` | `ConditionObject` |

#### Returns

`ConditionObject`

***

### inSubquery()

```ts
static inSubquery<T extends typeof DBModel, S>(this: T, keyPairs: KeyPair | CompositeKeyPairs, conditions?: Array<readonly [Column<any, S>, unknown]>): readonly [string, DBSubquery];
```

Defined in: [DBModel.ts:1533](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1533)

IN subquery condition.
Creates a condition like: column IN (SELECT selectColumn FROM targetModel WHERE ...)
Supports composite keys using key pairs (same format as relation decorators).
Type-safe: first column in pair must belong to caller model, second to target model.

#### Example

```typescript
import { parentRef } from 'litedbmodel';

// Single key: id IN (SELECT user_id FROM orders WHERE status = 'paid')
await User.find([
  User.inSubquery([[User.id, Order.user_id]], [
    [Order.status, 'paid']
  ])
]);

// Composite key: (id, group_id) IN (SELECT user_id, group_id FROM orders WHERE ...)
await User.find([
  User.inSubquery([
    [User.id, Order.user_id],
    [User.group_id, Order.group_id],
  ], [[Order.status, 'paid']])
]);

// Correlated subquery with parentRef
await User.find([
  User.inSubquery([[User.id, Order.user_id]], [
    [Order.tenant_id, parentRef(User.tenant_id)],
    [Order.status, 'paid']
  ])
]);
```

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T extends typeof DBModel` | Parent model class type (inferred from this) |
| `S` | Target model class type |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `keyPairs` | `KeyPair \| CompositeKeyPairs` | Key pairs: [[parentCol, targetCol], ...] or single pair [parentCol, targetCol] |
| `conditions?` | `Array<readonly [`[`Column`](../interfaces/Column.md)`<any, S>, unknown]>` | WHERE conditions for subquery (columns must belong to target model S) **Default** `[]` |

#### Returns

`readonly [string, DBSubquery]`

Condition tuple for use in find() conditions

***

### notInSubquery()

```ts
static notInSubquery<T extends typeof DBModel, S>(this: T, keyPairs: KeyPair | CompositeKeyPairs, conditions?: Array<readonly [Column<any, S>, unknown]>): readonly [string, DBSubquery];
```

Defined in: [DBModel.ts:1578](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1578)

NOT IN subquery condition.
Creates a condition like: table.column NOT IN (SELECT table.column FROM targetModel WHERE ...)
Supports composite keys using key pairs (same format as relation decorators).
Type-safe: first column in pair must belong to caller model, second to target model.

#### Example

```typescript
// users.id NOT IN (SELECT banned_users.user_id FROM banned_users)
await User.find([
  User.notInSubquery([[User.id, BannedUser.user_id]])
]);

// Composite key NOT IN
await User.find([
  User.notInSubquery([
    [User.id, BannedUser.user_id],
    [User.tenant_id, BannedUser.tenant_id],
  ])
]);
```

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T extends typeof DBModel` | Parent model class type (inferred from this) |
| `S` | Target model class type |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `keyPairs` | `KeyPair \| CompositeKeyPairs` | Key pairs: [[parentCol, targetCol], ...] or single pair [parentCol, targetCol] |
| `conditions?` | `Array<readonly [`[`Column`](../interfaces/Column.md)`<any, S>, unknown]>` | WHERE conditions for subquery (columns must belong to target model S) **Default** `[]` |

#### Returns

`readonly [string, DBSubquery]`

Condition tuple for use in find() conditions

***

### exists()

```ts
static exists<S>(conditions: Array<readonly [Column<any, S>, unknown]>): readonly [string, DBExists];
```

Defined in: [DBModel.ts:1618](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1618)

EXISTS subquery condition.
Creates a condition like: EXISTS (SELECT 1 FROM targetModel WHERE table.column = ...)
Uses table.column format for unambiguous references.
Type-safe: conditions columns must belong to the same target model.

#### Example

```typescript
import { parentRef } from 'litedbmodel';

// EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id)
await User.find([
  [User.is_active, true],
  User.exists([
    [Order.user_id, parentRef(User.id)]
  ])
]);
```

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `S` | Target model instance type |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `conditions` | `Array<readonly [`[`Column`](../interfaces/Column.md)`<any, S>, unknown]>` | WHERE conditions for subquery (columns determine target table) |

#### Returns

`readonly [string, DBExists]`

Condition tuple for use in find() conditions

***

### notExists()

```ts
static notExists<S>(conditions: Array<readonly [Column<any, S>, unknown]>): readonly [string, DBExists];
```

Defined in: [DBModel.ts:1650](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1650)

NOT EXISTS subquery condition.
Creates a condition like: NOT EXISTS (SELECT 1 FROM targetModel WHERE table.column = ...)
Uses table.column format for unambiguous references.
Type-safe: conditions columns must belong to the same target model.

#### Example

```typescript
import { parentRef } from 'litedbmodel';

// NOT EXISTS (SELECT 1 FROM banned_users WHERE banned_users.user_id = users.id)
await User.find([
  User.notExists([
    [BannedUser.user_id, parentRef(User.id)]
  ])
]);
```

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `S` | Target model instance type |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `conditions` | `Array<readonly [`[`Column`](../interfaces/Column.md)`<any, S>, unknown]>` | WHERE conditions for subquery (columns determine target table) |

#### Returns

`readonly [string, DBExists]`

Condition tuple for use in find() conditions

***

### getTableName()

```ts
static getTableName(): string;
```

Defined in: [DBModel.ts:1728](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1728)

Get table name for SELECT queries.
For query-based models, returns the CTE alias (TABLE_NAME).

#### Returns

`string`

***

### isQueryBased()

```ts
static isQueryBased(): boolean;
```

Defined in: [DBModel.ts:1786](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1786)

Check if this model is query-based (uses QUERY instead of TABLE_NAME)

#### Returns

`boolean`

***

### withQuery()

```ts
static withQuery<T extends typeof DBModel>(this: T, queryConfig: { sql: string; params?: unknown[] } | SqlFragment | SqlCondition | SqlTypedFragment): T;
```

Defined in: [DBModel.ts:1815](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1815)

Create a new model class bound to specific query parameters.
Used for parameterized query-based models.
Accepts either `{ sql, params }` object or a `SqlFragment` from `sql` tagged template.

#### Example

```typescript
import { sql } from 'litedbmodel';

class SalesReportModel extends DBModel {
  static forPeriod(startDate: string, endDate: string) {
    return this.withQuery(sql`
      SELECT p.id, SUM(oi.quantity) AS total
      FROM products p
      JOIN order_items oi ON p.id = oi.product_id
      WHERE oi.created_at >= ${startDate} AND oi.created_at < ${endDate}
      GROUP BY p.id
    `);
  }
}
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `queryConfig` | `{`[`sql`](../functions/sql.md)`: string; params?: unknown[] } \|`[`SqlFragment`](../interfaces/SqlFragment.md)`\|`[`SqlCondition`](../interfaces/SqlCondition.md)`\|`[`SqlTypedFragment`](../interfaces/SqlTypedFragment.md) | Query configuration with sql and params, or SqlFragment |

#### Returns

`T`

A new model class with bound parameters

***

### getUpdateTableName()

```ts
static getUpdateTableName(): string;
```

Defined in: [DBModel.ts:1865](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1865)

Get table name for UPDATE/DELETE queries.
Query-based models cannot be updated/deleted directly.

#### Returns

`string`

***

### clearRelationCache()

```ts
clearRelationCache(): void;
```

Defined in: [DBModel.ts:1929](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1929)

Clear the relation cache for this instance.
Also clears the context cache to force reload from DB.

#### Returns

`void`

***

### typeCastFromDB()

```ts
typeCastFromDB(): void;
```

Defined in: [DBModel.ts:2071](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2071)

Called after loading from DB to convert types
Override in derived class to implement type conversions

#### Example

```typescript
typeCastFromDB(): void {
  this.created_at = PostgresHelper.castToDatetime(this.created_at);
  this.is_active = PostgresHelper.castToBoolean(this.is_active);
}
```

#### Returns

`void`

***

### getPkey()

```ts
getPkey(): Record<string, unknown> | null;
```

Defined in: [DBModel.ts:2083](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2083)

Get primary key as object

#### Returns

`Record<string, unknown> | null`

Object with primary key column names and values, or null if not set

***

### setPkey()

```ts
setPkey(key: unknown): void;
```

Defined in: [DBModel.ts:2104](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2104)

Set primary key value

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `key` | `unknown` | Single value for single-column PK, or object for composite PK |

#### Returns

`void`

***

### getPkeyString()

```ts
getPkeyString(): string;
```

Defined in: [DBModel.ts:2122](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2122)

Get primary key as string (for logging, caching, etc.)

#### Returns

`string`

***

### getSingleColId()

```ts
getSingleColId(): unknown;
```

Defined in: [DBModel.ts:2134](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2134)

Get single-column ID value

#### Returns

`unknown`

ID value or undefined

***

### clone()

```ts
clone<T extends DBModel>(this: T): T;
```

Defined in: [DBModel.ts:2149](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2149)

Create a shallow copy of the model instance

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `T` |

#### Returns

`T`

***

### assign()

```ts
assign(source: Partial<this>): this;
```

Defined in: [DBModel.ts:2157](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2157)

Copy properties from another object

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `source` | `Partial<this>` |

#### Returns

`this`

***

### toObject()

```ts
toObject(): Record<string, unknown>;
```

Defined in: [DBModel.ts:2168](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2168)

Convert to plain object

#### Returns

`Record<string, unknown>`

***

### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Defined in: [DBModel.ts:2181](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2181)

Convert to JSON-serializable object

#### Returns

`Record<string, unknown>`

***

### fromObject()

```ts
static fromObject<T extends DBModel>(this: new () => T, obj: Record<string, unknown>): T;
```

Defined in: [DBModel.ts:2192](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2192)

Create an instance from a plain object

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `new () => T` |
| `obj` | `Record<string, unknown>` |

#### Returns

`T`

***

### fromObjects()

```ts
static fromObjects<T extends DBModel>(this: new () => T, objs: Record<string, unknown>[]): T[];
```

Defined in: [DBModel.ts:2205](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2205)

Create multiple instances from an array of plain objects

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `new () => T` |
| `objs` | `Record<string, unknown>[]` |

#### Returns

`T[]`

***

### columnList()

```ts
static columnList<T extends DBModel>(records: T[], columnName: string): unknown[];
```

Defined in: [DBModel.ts:2215](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2215)

Get column values from an array of model instances

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `records` | `T[]` |
| `columnName` | `string` |

#### Returns

`unknown[]`

***

### hashByProperty()

```ts
static hashByProperty<T extends DBModel>(records: T[], propertyKey: string): Record<string, T>;
```

Defined in: [DBModel.ts:2225](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2225)

Create a hash map by property value

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `records` | `T[]` |
| `propertyKey` | `string` |

#### Returns

`Record<string, T>`

***

### groupByProperty()

```ts
static groupByProperty<T extends DBModel>(records: T[], propertyKey: string): Record<string, T[]>;
```

Defined in: [DBModel.ts:2240](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2240)

Group records by property value

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `records` | `T[]` |
| `propertyKey` | `string` |

#### Returns

`Record<string, T[]>`

***

### idList()

```ts
static idList<T extends DBModel>(records: T[], column?: string): unknown[];
```

Defined in: [DBModel.ts:2258](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2258)

Get ID list from records

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `records` | `T[]` |
| `column?` | `string` |

#### Returns

`unknown[]`

***

### makeLikeString()

```ts
static makeLikeString(src: string, front?: boolean, back?: boolean): string;
```

Defined in: [DBModel.ts:2266](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2266)

Generate LIKE pattern string

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `src` | `string` |  |
| `front?` | `boolean` | **Default** `true` |
| `back?` | `boolean` | **Default** `true` |

#### Returns

`string`

***

### or()

```ts
static or<T extends typeof DBModel>(this: T, ...condGroups: readonly CondsOf<T>[]): OrCondOf<T>;
```

Defined in: [DBModel.ts:2303](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2303)

Create a type-safe OR condition for this model.
All columns in the conditions must belong to this model.

#### Example

```typescript
// (role = 'admin') OR (role = 'moderator')
const admins = await User.find([
  [User.deleted, false],
  User.or(
    [[User.role, 'admin']],
    [[User.role, 'moderator']],
  ),
]);

// This will cause a compile error:
User.or([[OtherModel.id, 1]]);  // Error: OtherModel.id is not a User column
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `...condGroups` | `readonly CondsOf<T>[]` | Arrays of conditions to OR together |

#### Returns

`OrCondOf<T>`

OR condition that can be used in find(), findOne(), etc.

***

### find()

```ts
static find<T extends typeof DBModel>(this: T, conditions: CondsOf<T>, options?: SelectOptions): Promise<InstanceType<T>[]>;
```

Defined in: [DBModel.ts:2339](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2339)

Find all records using type-safe condition tuples.
All columns in conditions must belong to this model.

#### Example

```typescript
const users = await User.find([
  [User.is_active, true],
  [`${User.age} >= ?`, 18],
]);

// With OR conditions (use Model.or() for type safety)
const admins = await User.find([
  [User.deleted, false],
  User.or(
    [[User.role, 'admin']],
    [[User.role, 'moderator']],
  ),
]);
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `conditions` | `CondsOf<T>` | Array of condition tuples |
| `options?` | [`SelectOptions`](../interfaces/SelectOptions.md) | Query options (order, limit, offset, etc.) |

#### Returns

`Promise<InstanceType<T>[]>`

Array of model instances

***

### findOne()

```ts
static findOne<T extends typeof DBModel>(this: T, conditions: CondsOf<T>, options?: SelectOptions): Promise<InstanceType<T> | null>;
```

Defined in: [DBModel.ts:2385](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2385)

Find first record using type-safe condition tuples.

#### Example

```typescript
const user = await User.findOne([
  [User.email, 'test@example.com'],
]);
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `conditions` | `CondsOf<T>` | Array of condition tuples |
| `options?` | [`SelectOptions`](../interfaces/SelectOptions.md) | Query options |

#### Returns

`Promise<InstanceType<T> | null>`

Model instance or null

***

### findById()

```ts
static findById<T extends typeof DBModel>(this: T, pkeyResult: Pick<PkeyResult, 'values'>, options?: SelectOptions): Promise<InstanceType<T>[]>;
```

Defined in: [DBModel.ts:2424](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2424)

Find records by primary key using PkeyResult format.
Efficiently fetches multiple records by their primary keys.

#### Example

```typescript
// Single record
const [user] = await User.findById({ values: [[1]] });

// Multiple records
const users = await User.findById({ values: [[1], [2], [3]] });

// Composite PK
const [entry] = await TenantUser.findById({
  values: [[1, 100]]  // [tenant_id, id]
});

// Use with write operation result
const result = await User.update(..., { returning: true });
const users = await User.findById(result);
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `pkeyResult` | `Pick<`[`PkeyResult`](../interfaces/PkeyResult.md)`, 'values'>` | Object with `values` property containing 2D array of PK values |
| `options?` | [`SelectOptions`](../interfaces/SelectOptions.md) | Query options |

#### Returns

`Promise<InstanceType<T>[]>`

Array of model instances (empty array if no matches)

***

### count()

```ts
static count<T extends typeof DBModel>(this: T, conditions: CondsOf<T>): Promise<number>;
```

Defined in: [DBModel.ts:2489](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2489)

Count records using type-safe condition tuples.

#### Example

```typescript
const count = await User.count([[User.is_active, true]]);
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `conditions` | `CondsOf<T>` | Array of condition tuples |

#### Returns

`Promise<number>`

Count

***

### create()

```ts
static create<T extends typeof DBModel, P extends readonly (readonly [Column<any, any>, any])[]>(this: T, pairs: P & CVs<P>, options?: InsertOptions<InstanceType<T>>): Promise<PkeyResult | null>;
```

Defined in: [DBModel.ts:2524](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2524)

Create a new record using type-safe column-value tuples.
Value types are validated at compile time.

#### Example

```typescript
// Default: returns null
await User.create([
  [User.name, 'John'],
  [User.email, 'john@test.com'],
]);

// With returning: true → PkeyResult
const result = await User.create([
  [User.name, 'John'],
  [User.email, 'john@test.com'],
], { returning: true });
const [user] = await User.findById(result);
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |
| `P extends readonly (readonly [Column<any, any>, any])[]` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `pairs` | `P & CVs<P>` | Array of [Column, value] tuples |
| `options?` | [`InsertOptions`](../interfaces/InsertOptions.md)`<InstanceType<T>>` | Insert options (returning: true to get PkeyResult) |

#### Returns

`Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`| null>`

null by default, or PkeyResult if returning: true

***

### createMany()

```ts
static createMany<T extends typeof DBModel>(this: T, pairsArray: readonly (readonly (readonly [Column<any, any>, any])[])[], options?: InsertOptions<InstanceType<T>>): Promise<PkeyResult | null>;
```

Defined in: [DBModel.ts:2594](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2594)

Create multiple records using type-safe column-value tuples.

#### Example

```typescript
// Default: returns null
await User.createMany([
  [[User.name, 'John'], [User.email, 'john@test.com']],
  [[User.name, 'Jane'], [User.email, 'jane@test.com']],
]);

// With returning: true → PkeyResult
const result = await User.createMany([
  [[User.name, 'John'], [User.email, 'john@test.com']],
  [[User.name, 'Jane'], [User.email, 'jane@test.com']],
], { returning: true });
const users = await User.findById(result);
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `pairsArray` | `readonly (readonly (readonly [`[`Column`](../interfaces/Column.md)`<any, any>, any])[])[]` | Array of tuple arrays |
| `options?` | [`InsertOptions`](../interfaces/InsertOptions.md)`<InstanceType<T>>` | Insert options (returning: true to get PkeyResult) |

#### Returns

`Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`| null>`

null by default, or PkeyResult if returning: true

***

### update()

```ts
static update<T extends typeof DBModel, V extends readonly (readonly [Column<any, any>, any])[]>(this: T, conditions: CondsOf<T>, values: V & CVs<V>, options?: UpdateOptions): Promise<PkeyResult | null>;
```

Defined in: [DBModel.ts:2664](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2664)

Update records using type-safe column-value tuples.
Value types are validated at compile time.

#### Example

```typescript
// Default: returns null
await User.update(
  [[User.id, 1]],
  [[User.name, 'Jane']],
);

// With returning: true → PkeyResult
const result = await User.update(
  [[User.status, 'pending']],
  [[User.status, 'active']],
  { returning: true }
);
const users = await User.findById(result);
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |
| `V extends readonly (readonly [Column<any, any>, any])[]` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `conditions` | `CondsOf<T>` | Array of condition tuples for WHERE clause |
| `values` | `V & CVs<V>` | Array of [Column, value] tuples for SET clause |
| `options?` | [`UpdateOptions`](../interfaces/UpdateOptions.md) | Update options (returning: true to get PkeyResult) |

#### Returns

`Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`| null>`

null by default, or PkeyResult if returning: true

***

### delete()

```ts
static delete<T extends typeof DBModel>(this: T, conditions: CondsOf<T>, options?: DeleteOptions): Promise<PkeyResult | null>;
```

Defined in: [DBModel.ts:2743](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2743)

Delete records matching conditions

#### Example

```typescript
// Default: returns null
await User.delete([[User.is_active, false]]);

// With returning: true → PkeyResult
const result = await User.delete([[User.is_active, false]], { returning: true });
// result: { key: [User.id], values: [[4], [5]] }
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `conditions` | `CondsOf<T>` | Filter conditions |
| `options?` | [`DeleteOptions`](../interfaces/DeleteOptions.md) | Delete options (returning: true to get PkeyResult) |

#### Returns

`Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`| null>`

null by default, or PkeyResult if returning: true

***

### updateMany()

```ts
static updateMany<T extends typeof DBModel>(this: T, rows: readonly (readonly (readonly [Column<any, any>, any])[])[], options: UpdateManyOptions): Promise<PkeyResult | null>;
```

Defined in: [DBModel.ts:2821](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2821)

Update multiple records with different values per row.
Uses efficient bulk update strategies (UNNEST for PostgreSQL, VALUES for MySQL/SQLite).

#### Example

```typescript
// Default: returns null
await User.updateMany([
  [[User.id, 1], [User.name, 'John'], [User.email, 'john@example.com']],
  [[User.id, 2], [User.name, 'Jane'], [User.email, 'jane@example.com']],
], { keyColumns: [User.id] });

// With returning: true → PkeyResult
const result = await User.updateMany([
  [[User.id, 1], [User.name, 'John']],
  [[User.id, 2], [User.name, 'Jane']],
], { keyColumns: [User.id], returning: true });
const users = await User.findById(result);
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `rows` | `readonly (readonly (readonly [`[`Column`](../interfaces/Column.md)`<any, any>, any])[])[]` | Array of [Column, value][] tuples, each representing one row's values |
| `options` | [`UpdateManyOptions`](../interfaces/UpdateManyOptions.md) | Options including keyColumns to identify rows |

#### Returns

`Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`| null>`

null by default, or PkeyResult if returning: true

***

### execute()

```ts
static execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;
```

Defined in: [DBModel.ts:2964](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2964)

Execute raw SQL query.
Accepts either a SQL string with params, or a `SqlFragment` from `sql` tagged template.

#### Example

```typescript
// Traditional
const result = await DBModel.execute(
  'SELECT * FROM users WHERE id = $1',
  [1]
);

// With sql tag
import { sql } from 'litedbmodel';
const result = await DBModel.execute(
  sql`SELECT process_daily_aggregates(${targetDate})`
);
```

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `sql` | `string` | SQL query string or SqlFragment |
| `params?` | `unknown[]` | Query parameters (ignored when SqlFragment is passed) |

#### Returns

`Promise<ExecuteResult>`

QueryResult with rows, rowCount

***

```ts
static execute(fragment: SqlFragment | SqlCondition | SqlTypedFragment): Promise<ExecuteResult>;
```

Defined in: [DBModel.ts:2965](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2965)

Execute raw SQL query.
Accepts either a SQL string with params, or a `SqlFragment` from `sql` tagged template.

#### Example

```typescript
// Traditional
const result = await DBModel.execute(
  'SELECT * FROM users WHERE id = $1',
  [1]
);

// With sql tag
import { sql } from 'litedbmodel';
const result = await DBModel.execute(
  sql`SELECT process_daily_aggregates(${targetDate})`
);
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fragment` | [`SqlFragment`](../interfaces/SqlFragment.md)`\|`[`SqlCondition`](../interfaces/SqlCondition.md)`\|`[`SqlTypedFragment`](../interfaces/SqlTypedFragment.md) |

#### Returns

`Promise<ExecuteResult>`

***

### query()

```ts
static query<T extends typeof DBModel>(this: T, sql: string, params?: unknown[]): Promise<InstanceType<T>[]>;
```

Defined in: [DBModel.ts:3031](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3031)

Execute raw SQL and return model instances.
The SQL should return columns matching the model's properties.

#### Example

```typescript
const users = await User.query(
  'SELECT * FROM users WHERE is_active = $1',
  [true]
);

// Complex join query
const posts = await Post.query(`
  SELECT p.* FROM posts p
  JOIN users u ON p.user_id = u.id
  WHERE u.email = $1
`, ['admin@example.com']);
```

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `this` | `T` |  |
| `sql` | `string` | SQL query |
| `params?` | `unknown[]` | Query parameters |

#### Returns

`Promise<InstanceType<T>[]>`

Model instances

***

### inTransaction()

```ts
static inTransaction(): boolean;
```

Defined in: [DBModel.ts:3063](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3063)

Check if currently in a transaction

#### Returns

`boolean`

***

### transaction()

```ts
static transaction<R>(func: () => Promise<R>, options?: TransactionOptions): Promise<R>;
```

Defined in: [DBModel.ts:3101](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3101)

Execute a function within a transaction
All model operations inside the callback will use the same database connection.
Supports automatic retry on deadlock/serialization errors.

#### Example

```typescript
// Basic transaction
await DBModel.transaction(async () => {
  const user = await User.findFirst({ [User.def.id]: 1 });
  await Account.updateAll(
    { [Account.def.user_id]: user.id },
    { [Account.def.balance]: user.balance - 100 }
  );
  await Transaction.create({ user_id: user.id, amount: -100 });
});

// Transaction with return value
const result = await DBModel.transaction(async () => {
  const user = await User.create({ name: 'Alice' });
  return user;
});

// Transaction with options
await DBModel.transaction(
  async () => { ... },
  { retryLimit: 5, retryDuration: 100 }
);
```

#### Type Parameters

| Type Parameter |
| ------ |
| `R` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `func` | `() => Promise<R>` | Function to execute within transaction |
| `options?` | [`TransactionOptions`](../interfaces/TransactionOptions.md) | Transaction options (retry settings) **Default** `{}` |

#### Returns

`Promise<R>`

Result of the function

***

### acquireConnection()

```ts
static acquireConnection(): Promise<DBConnection>;
```

Defined in: [DBModel.ts:3229](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3229)

Acquire a writer connection (the one `transaction()` takes) and return it. Pass it as
`TransactionOptions.connection` to open transactions on it, so that connections can be taken in the
same order by every process. The caller releases it with `release()`, which is safe to call twice;
`release(error)` destroys the connection instead of returning it to the pool. On the SCP route it is
the SCP writer pool's connection (`withTransactionAsync` runs on it); on the v1 branch the handler's.

#### Returns

`Promise<DBConnection>`

***

### getCurrentConnection()

```ts
static getCurrentConnection(): DBConnection | null;
```

Defined in: [DBModel.ts:3301](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3301)

Get current transaction connection
Use this to execute raw SQL queries within a transaction

#### Example

```typescript
await DBModel.transaction(async () => {
  const conn = DBModel.getCurrentConnection();
  if (conn) {
    await conn.query('SELECT * FROM some_table WHERE ...');
  }
});
```

#### Returns

`DBConnection | null`

Current DBConnection if in a transaction, null otherwise

***

### getCurrentClient()

```ts
static getCurrentClient(): DBConnection | null;
```

Defined in: [DBModel.ts:3309](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3309)

> **Deprecated** Use getCurrentConnection() instead

#### Returns

`DBConnection | null`

***

### withWriter()

```ts
static withWriter<R>(func: () => Promise<R>): Promise<R>;
```

Defined in: [DBModel.ts:3334](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3334)

Execute a function with explicit writer connection access.
Use this when you need to read from writer to avoid replication lag.
Write operations are NOT allowed in this context - use transaction() instead.

#### Example

```typescript
// Read from writer to avoid replication lag
const user = await DBModel.withWriter(async () => {
  return await User.findOne([[User.id, 1]]);
});

// Write operations throw an error
await DBModel.withWriter(async () => {
  await User.create([[User.name, 'Error']]);  // Throws WriteInReadOnlyContextError
});
```

#### Type Parameters

| Type Parameter |
| ------ |
| `R` |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `func` | `() => Promise<R>` | Function to execute with writer connection |

#### Returns

`Promise<R>`

Result of the function

***

### createDBBase()

```ts
static createDBBase(config: DBConfig, options?: DBConfigOptions): typeof DBModel;
```

Defined in: [DBModel.ts:3398](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3398)

Create an independent database base class.
Use this to connect to multiple databases with isolated configurations.

#### Example

```typescript
// Create separate base classes for different databases
const BaseDB = DBModel.createDBBase({
  host: 'base-db.example.com',
  database: 'base_db',
}, {
  writerConfig: { host: 'base-db-writer.example.com', database: 'base_db' },
});

const CmsDB = DBModel.createDBBase({
  host: 'cms-db.example.com',
  database: 'cms_db',
});

// Define models using appropriate base class
@model('users')
class UserModel extends BaseDB {
  @column.number() id?: number;
}

@model('articles')
class ArticleModel extends CmsDB {
  @column.number() id?: number;
}

// Each base class has independent transactions
await BaseDB.transaction(async () => {
  await User.create([[User.name, 'John']]);
});
```

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `config` | [`DBConfig`](../interfaces/DBConfig.md) | Database configuration |
| `options?` | [`DBConfigOptions`](../interfaces/DBConfigOptions.md) | Configuration options (writerConfig, limits, etc.) |

#### Returns

`typeof DBModel`

A new DBModel subclass with its own connection pool

***

### reload()

```ts
reload(forUpdate?: boolean): Promise<this | null>;
```

Defined in: [DBModel.ts:3475](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3475)

Reload this instance from the database

#### Example

```typescript
await user.reload();
```

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `forUpdate?` | `boolean` | If true, lock the row for update **Default** `false` |

#### Returns

`Promise<this | null>`

Reloaded instance or null if not found

