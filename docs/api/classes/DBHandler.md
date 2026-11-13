[API](../README.md) / DBHandler

# Class: DBHandler

Defined in: [DBHandler.ts:148](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L148)

Database handler - wraps a driver and provides a unified interface.

## Example

```typescript
// PostgreSQL
const handler = new DBHandler({ host: 'localhost', port: 5432, database: 'mydb', ... });

// SQLite
const handler = new DBHandler({ database: './mydb.sqlite', driver: 'sqlite' });

const result = await handler.execute('SELECT * FROM users WHERE id = $1', [1]);
```

## Constructors

### constructor

```ts
new DBHandler(config: DBConfig, options?: DBHandlerOptions): DBHandler;
```

Defined in: [DBHandler.ts:154](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L154)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`DBConfig`](../interfaces/DBConfig.md) |
| `options?` | `DBHandlerOptions` |

## Methods

### getDriverType()

```ts
getDriverType(): 'postgres' | 'sqlite' | 'mysql';
```

Defined in: [DBHandler.ts:172](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L172)

Get the driver type

#### Returns

`'postgres' | 'sqlite' | 'mysql'`

***

### getDriver()

```ts
getDriver(): DBDriver;
```

Defined in: [DBHandler.ts:179](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L179)

Get the underlying driver

#### Returns

`DBDriver`

***

### execute()

```ts
execute(sql: string, params?: unknown[]): Promise<QueryResult>;
```

Defined in: [DBHandler.ts:186](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L186)

Execute a SQL query

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `sql` | `string` |  |
| `params?` | `unknown[]` | **Default** `[]` |

#### Returns

`Promise<QueryResult>`

***

### executeWrite()

```ts
executeWrite(sql: string, params?: unknown[]): Promise<QueryResult>;
```

Defined in: [DBHandler.ts:196](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L196)

Execute a write query (INSERT/UPDATE/DELETE)

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `sql` | `string` |  |
| `params?` | `unknown[]` | **Default** `[]` |

#### Returns

`Promise<QueryResult>`

***

### executeOnWriter()

```ts
executeOnWriter(sql: string, params?: unknown[], read?: boolean): Promise<QueryResult>;
```

Defined in: [DBHandler.ts:208](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L208)

Execute a query on the writer pool (for withWriter context / writer-sticky / writes).
`read`: the statement is read-only (it runs through the driver's `execute`, which decides whether it
may be re-sent after a connection error); otherwise it runs through `executeWrite` (never re-sent).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `sql` | `string` |  |
| `params?` | `unknown[]` | **Default** `[]` |
| `read?` | `boolean` | **Default** `false` |

#### Returns

`Promise<QueryResult>`

***

### hasWriterPool()

```ts
hasWriterPool(): boolean;
```

Defined in: [DBHandler.ts:218](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L218)

Check if writer pool is configured

#### Returns

`boolean`

***

### getConnection()

```ts
getConnection(checkAttempts?: number): Promise<DBConnection>;
```

Defined in: [DBHandler.ts:226](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L226)

Get a connection from the pool (for transactions). `checkAttempts`: a retry after a connection error
takes only a connection that passed a `SELECT 1` probe, trying at most that many.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `checkAttempts?` | `number` |

#### Returns

`Promise<DBConnection>`

***

### withConnection()

```ts
withConnection(connection: DBConnection): DBHandler;
```

Defined in: [DBHandler.ts:233](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L233)

Create handler with specific connection (for transaction)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `connection` | `DBConnection` |

#### Returns

`DBHandler`

***

### close()

```ts
close(): Promise<void>;
```

Defined in: [DBHandler.ts:245](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L245)

Close all connections

#### Returns

`Promise<void>`

***

### setLogger()

```ts
setLogger(logger: Logger): void;
```

Defined in: [DBHandler.ts:252](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L252)

Set logger

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `logger` | `Logger` |

#### Returns

`void`

***

### getPool()

```ts
getPool(): unknown;
```

Defined in: [DBHandler.ts:261](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L261)

> **Deprecated** Use driver-specific methods instead

Get the underlying PostgreSQL pool (for backward compatibility)

#### Returns

`unknown`

