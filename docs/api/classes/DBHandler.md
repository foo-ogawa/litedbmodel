[API](../README.md) / DBHandler

# Class: DBHandler

Defined in: [DBHandler.ts:147](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBHandler.ts#L147)

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

Defined in: [DBHandler.ts:153](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBHandler.ts#L153)

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

Defined in: [DBHandler.ts:171](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBHandler.ts#L171)

Get the driver type

#### Returns

`'postgres' | 'sqlite' | 'mysql'`

***

### getLogger()

```ts
getLogger(): Logger;
```

Defined in: [DBHandler.ts:178](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBHandler.ts#L178)

Get the logger

#### Returns

`Logger`

***

### getDriver()

```ts
getDriver(): DBDriver;
```

Defined in: [DBHandler.ts:185](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBHandler.ts#L185)

Get the underlying driver

#### Returns

`DBDriver`

***

### execute()

```ts
execute(sql: string, params?: unknown[]): Promise<QueryResult>;
```

Defined in: [DBHandler.ts:192](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBHandler.ts#L192)

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

Defined in: [DBHandler.ts:202](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBHandler.ts#L202)

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
executeOnWriter(sql: string, params?: unknown[], isRead?: boolean): Promise<QueryResult>;
```

Defined in: [DBHandler.ts:213](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBHandler.ts#L213)

Execute a query on writer pool (for withWriter context). `isRead` is true for a read routed to the
writer: it keeps the read's connection-error retry; any other statement is a write and is not resent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `sql` | `string` |  |
| `params?` | `unknown[]` | **Default** `[]` |
| `isRead?` | `boolean` | **Default** `false` |

#### Returns

`Promise<QueryResult>`

***

### hasWriterPool()

```ts
hasWriterPool(): boolean;
```

Defined in: [DBHandler.ts:223](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBHandler.ts#L223)

Check if writer pool is configured

#### Returns

`boolean`

***

### getConnection()

```ts
getConnection(): Promise<DBConnection>;
```

Defined in: [DBHandler.ts:230](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBHandler.ts#L230)

Get a connection from the pool (for transactions)

#### Returns

`Promise<DBConnection>`

***

### withConnection()

```ts
withConnection(connection: DBConnection): DBHandler;
```

Defined in: [DBHandler.ts:237](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBHandler.ts#L237)

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

Defined in: [DBHandler.ts:249](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBHandler.ts#L249)

Close all connections

#### Returns

`Promise<void>`

***

### setLogger()

```ts
setLogger(logger: Logger): void;
```

Defined in: [DBHandler.ts:256](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBHandler.ts#L256)

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

Defined in: [DBHandler.ts:265](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBHandler.ts#L265)

> **Deprecated** Use driver-specific methods instead

Get the underlying PostgreSQL pool (for backward compatibility)

#### Returns

`unknown`

