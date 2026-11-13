[API](../README.md) / DBModel

# Abstract Class: DBModel

Defined in: [DBModel.ts:150](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L150)

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

Defined in: [DBModel.ts:1910](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1910)

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="query"></a> `QUERY` (static) | `string \|`[`SqlFragment`](../interfaces/SqlFragment.md)`\|`[`SqlCondition`](../interfaces/SqlCondition.md)`\|`[`SqlTypedFragment`](../interfaces/SqlTypedFragment.md)`\| null` | SQL query for query-based models (view models, aggregations, etc.) When defined, the model uses this query as a CTE instead of TABLE_NAME.<br><br>**Example** `// Static query` `` static QUERY = ` `` `SELECT users.id, COUNT(posts.id) as post_count` `FROM users LEFT JOIN posts ON users.id = posts.user_id` `GROUP BY users.id` `` `; `` | [DBModel.ts:209](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L209) |
| <a id="_dbconfig"></a> `_dbConfig` (static protected) | [`DBConfig`](../interfaces/DBConfig.md)`\| null` | Database config | [DBModel.ts:231](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L231) |
| <a id="_limitconfig"></a> `_limitConfig` (static protected) | [`LimitConfig`](../interfaces/LimitConfig.md) | Limit config for safety guards | [DBModel.ts:234](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L234) |
| <a id="_configoptions"></a> `_configOptions` (static protected) | [`DBConfigOptions`](../interfaces/DBConfigOptions.md) | Configuration options for reader/writer separation | [DBModel.ts:237](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L237) |
| <a id="_writersticky"></a> `_writerSticky` (static protected) | `WriterStickyClock` | Writer-sticky clock of the v1 execution path (the SCP runtime carries its own in its routing). | [DBModel.ts:243](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L243) |
| <a id="true"></a> `true` (static readonly) | `DBBoolValue` | Boolean TRUE value | [DBModel.ts:1497](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1497) |
| <a id="false"></a> `false` (static readonly) | `DBBoolValue` | Boolean FALSE value | [DBModel.ts:1500](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1500) |
| <a id="null"></a> `null` (static readonly) | `DBNullValue` | NULL value | [DBModel.ts:1503](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1503) |
| <a id="notnull"></a> `notNull` (static readonly) | `DBNotNullValue` | NOT NULL value | [DBModel.ts:1506](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1506) |
| <a id="now"></a> `now` (static readonly) | `DBImmediateValue` | NOW() value | [DBModel.ts:1509](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1509) |
| <a id="_modelclass"></a> `_modelClass` (protected) | `typeof DBModel` | Instance reference to the static class | [DBModel.ts:1899](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1899) |
| <a id="_relationcache"></a> `_relationCache` (protected) | `Map<string, unknown> \| null` | Per-instance cache for loaded relations (lazy-initialized) | [DBModel.ts:1902](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1902) |
| <a id="_deferredcontext"></a> `_deferredContext` | `[typeof DBModel, DBModel[]] \| null` | Deferred context info: [sourceClass, records] set by _select, resolved on first relation access | [DBModel.ts:1908](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1908) |

## Methods

### asModel()

```ts
static asModel<T extends typeof DBModel>(this: T): T & ColumnsOf<InstanceType<T>>;
```

Defined in: [DBModel.ts:176](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L176)

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

Defined in: [DBModel.ts:405](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L405)

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

Defined in: [DBModel.ts:438](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L438)

Get current limit configuration.

#### Returns

[`LimitConfig`](../interfaces/LimitConfig.md)

***

### setLimitConfig()

```ts
static setLimitConfig(config: LimitConfig): void;
```

Defined in: [DBModel.ts:453](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L453)

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

Defined in: [DBModel.ts:460](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L460)

Get database config

#### Returns

[`DBConfig`](../interfaces/DBConfig.md)`| null`

***

### getDriverType()

```ts
static getDriverType(): 'postgres' | 'mysql' | 'sqlite';
```

Defined in: [DBModel.ts:468](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L468)

Get the database driver type.
Returns 'postgres', 'mysql', or 'sqlite'.

#### Returns

`'postgres' | 'mysql' | 'sqlite'`

***

### getHandler()

```ts
static getHandler(): DBHandler;
```

Defined in: [DBModel.ts:519](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L519)

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

Defined in: [DBModel.ts:534](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L534)

Check if this async chain should read from the writer because it committed a transaction within
`writerStickyDuration` (read-your-writes for the request that wrote).

#### Returns

`boolean`

***

### \_getTransactionContext()

```ts
static _getTransactionContext(): AsyncLocalStorage<TransactionContext>;
```

Defined in: [DBModel.ts:542](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L542)

Get transaction context storage.
Override in subclass to use independent transaction context.

#### Returns

`AsyncLocalStorage<TransactionContext>`

***

### \_getWriterContext()

```ts
static _getWriterContext(): AsyncLocalStorage<WriterContext>;
```

Defined in: [DBModel.ts:550](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L550)

Get writer context storage.
Override in subclass to use independent writer context.

#### Returns

`AsyncLocalStorage<WriterContext>`

***

### inWriterContext()

```ts
static inWriterContext(): boolean;
```

Defined in: [DBModel.ts:557](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L557)

Check if currently in a withWriter context.

#### Returns

`boolean`

***

### use()

```ts
static use(MiddlewareClass: MiddlewareClass): () => void;
```

Defined in: [DBModel.ts:603](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L603)

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

Defined in: [DBModel.ts:655](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L655)

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

Defined in: [DBModel.ts:666](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L666)

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

Defined in: [DBModel.ts:678](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L678)

Clear all middlewares (useful for testing)

#### Returns

`void`

***

### getMiddlewares()

```ts
static getMiddlewares(): readonly MiddlewareClass[];
```

Defined in: [DBModel.ts:685](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L685)

Get registered middleware classes

#### Returns

`readonly`[`MiddlewareClass`](../README.md#middlewareclass)`[]`

***

### buildSelectSQL()

```ts
static buildSelectSQL<T extends typeof DBModel>(this: T, conditions: ConditionObject, options?: SelectOptions, params?: unknown[]): { sql: string; params: unknown[] };
```

Defined in: [DBModel.ts:875](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L875)

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

Defined in: [DBModel.ts:962](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L962)

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

Defined in: [DBModel.ts:1555](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1555)

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

Defined in: [DBModel.ts:1600](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1600)

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

Defined in: [DBModel.ts:1640](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1640)

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

Defined in: [DBModel.ts:1672](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1672)

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

Defined in: [DBModel.ts:1750](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1750)

Get table name for SELECT queries.
For query-based models, returns the CTE alias (TABLE_NAME).

#### Returns

`string`

***

### isQueryBased()

```ts
static isQueryBased(): boolean;
```

Defined in: [DBModel.ts:1808](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1808)

Check if this model is query-based (uses QUERY instead of TABLE_NAME)

#### Returns

`boolean`

***

### withQuery()

```ts
static withQuery<T extends typeof DBModel>(this: T, queryConfig: { sql: string; params?: unknown[] } | SqlFragment | SqlCondition | SqlTypedFragment): T;
```

Defined in: [DBModel.ts:1837](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1837)

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

Defined in: [DBModel.ts:1887](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1887)

Get table name for UPDATE/DELETE queries.
Query-based models cannot be updated/deleted directly.

#### Returns

`string`

***

### clearRelationCache()

```ts
clearRelationCache(): void;
```

Defined in: [DBModel.ts:1951](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L1951)

Clear the relation cache for this instance.
Also clears the context cache to force reload from DB.

#### Returns

`void`

***

### typeCastFromDB()

```ts
typeCastFromDB(): void;
```

Defined in: [DBModel.ts:2093](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2093)

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

Defined in: [DBModel.ts:2105](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2105)

Get primary key as object

#### Returns

`Record<string, unknown> | null`

Object with primary key column names and values, or null if not set

***

### setPkey()

```ts
setPkey(key: unknown): void;
```

Defined in: [DBModel.ts:2126](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2126)

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

Defined in: [DBModel.ts:2144](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2144)

Get primary key as string (for logging, caching, etc.)

#### Returns

`string`

***

### getSingleColId()

```ts
getSingleColId(): unknown;
```

Defined in: [DBModel.ts:2156](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2156)

Get single-column ID value

#### Returns

`unknown`

ID value or undefined

***

### clone()

```ts
clone<T extends DBModel>(this: T): T;
```

Defined in: [DBModel.ts:2171](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2171)

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

Defined in: [DBModel.ts:2179](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2179)

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

Defined in: [DBModel.ts:2190](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2190)

Convert to plain object

#### Returns

`Record<string, unknown>`

***

### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

Defined in: [DBModel.ts:2203](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2203)

Convert to JSON-serializable object

#### Returns

`Record<string, unknown>`

***

### fromObject()

```ts
static fromObject<T extends DBModel>(this: new () => T, obj: Record<string, unknown>): T;
```

Defined in: [DBModel.ts:2214](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2214)

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

Defined in: [DBModel.ts:2227](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2227)

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

Defined in: [DBModel.ts:2237](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2237)

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

Defined in: [DBModel.ts:2247](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2247)

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

Defined in: [DBModel.ts:2262](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2262)

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

Defined in: [DBModel.ts:2280](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2280)

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

Defined in: [DBModel.ts:2288](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2288)

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

Defined in: [DBModel.ts:2325](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2325)

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

Defined in: [DBModel.ts:2361](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2361)

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

Defined in: [DBModel.ts:2407](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2407)

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

Defined in: [DBModel.ts:2446](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2446)

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

Defined in: [DBModel.ts:2511](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2511)

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

Defined in: [DBModel.ts:2546](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2546)

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

Defined in: [DBModel.ts:2616](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2616)

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

Defined in: [DBModel.ts:2686](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2686)

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

Defined in: [DBModel.ts:2740](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2740)

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

Defined in: [DBModel.ts:2793](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2793)

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

Defined in: [DBModel.ts:2936](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2936)

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

Defined in: [DBModel.ts:2937](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L2937)

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

Defined in: [DBModel.ts:3003](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3003)

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

Defined in: [DBModel.ts:3035](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3035)

Check if currently in a transaction

#### Returns

`boolean`

***

### transaction()

```ts
static transaction<R>(func: () => Promise<R>, options?: TransactionOptions): Promise<R>;
```

Defined in: [DBModel.ts:3073](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3073)

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

Defined in: [DBModel.ts:3209](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3209)

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

Defined in: [DBModel.ts:3281](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3281)

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

Defined in: [DBModel.ts:3289](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3289)

> **Deprecated** Use getCurrentConnection() instead

#### Returns

`DBConnection | null`

***

### withWriter()

```ts
static withWriter<R>(func: () => Promise<R>): Promise<R>;
```

Defined in: [DBModel.ts:3314](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3314)

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

Defined in: [DBModel.ts:3378](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3378)

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

Defined in: [DBModel.ts:3455](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBModel.ts#L3455)

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

