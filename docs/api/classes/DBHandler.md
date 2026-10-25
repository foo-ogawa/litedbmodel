[**litedbmodel v2.2.11**](../README.md)

***

[litedbmodel](../globals.md) / DBHandler

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

### Constructor

```ts
new DBHandler(config: DBConfig, options?: DBHandlerOptions): DBHandler;
```

Defined in: [DBHandler.ts:154](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L154)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`DBConfig`](../interfaces/DBConfig.md) |
| `options?` | `DBHandlerOptions` |

#### Returns

`DBHandler`

## Methods

### getDriverType()

```ts
getDriverType(): "postgres" | "sqlite" | "mysql";
```

Defined in: [DBHandler.ts:172](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L172)

Get the driver type

#### Returns

`"postgres"` \| `"sqlite"` \| `"mysql"`

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

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `sql` | `string` | `undefined` |
| `params` | `unknown`[] | `[]` |

#### Returns

`Promise`\<`QueryResult`\>

***

### executeWrite()

```ts
executeWrite(sql: string, params?: unknown[]): Promise<QueryResult>;
```

Defined in: [DBHandler.ts:196](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L196)

Execute a write query (INSERT/UPDATE/DELETE)

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `sql` | `string` | `undefined` |
| `params` | `unknown`[] | `[]` |

#### Returns

`Promise`\<`QueryResult`\>

***

### executeOnWriter()

```ts
executeOnWriter(sql: string, params?: unknown[]): Promise<QueryResult>;
```

Defined in: [DBHandler.ts:206](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L206)

Execute a query on writer pool (for withWriter context)

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `sql` | `string` | `undefined` |
| `params` | `unknown`[] | `[]` |

#### Returns

`Promise`\<`QueryResult`\>

***

### hasWriterPool()

```ts
hasWriterPool(): boolean;
```

Defined in: [DBHandler.ts:216](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L216)

Check if writer pool is configured

#### Returns

`boolean`

***

### getConnection()

```ts
getConnection(): Promise<DBConnection>;
```

Defined in: [DBHandler.ts:223](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L223)

Get a connection from the pool (for transactions)

#### Returns

`Promise`\<`DBConnection`\>

***

### withConnection()

```ts
withConnection(connection: DBConnection): DBHandler;
```

Defined in: [DBHandler.ts:230](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L230)

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

Defined in: [DBHandler.ts:242](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L242)

Close all connections

#### Returns

`Promise`\<`void`\>

***

### setLogger()

```ts
setLogger(logger: Logger): void;
```

Defined in: [DBHandler.ts:249](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L249)

Set logger

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `logger` | `Logger` |

#### Returns

`void`

***

### ~~getPool()~~

```ts
getPool(): unknown;
```

Defined in: [DBHandler.ts:258](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L258)

Get the underlying PostgreSQL pool (for backward compatibility)

#### Returns

`unknown`

#### Deprecated

Use driver-specific methods instead
