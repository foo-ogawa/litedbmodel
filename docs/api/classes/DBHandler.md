[**litedbmodel v2.2.4**](../README.md)

***

[litedbmodel](../globals.md) / DBHandler

# Class: DBHandler

Defined in: [DBHandler.ts:179](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L179)

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

Defined in: [DBHandler.ts:185](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L185)

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
getDriverType(): "postgres" | "mysql" | "sqlite";
```

Defined in: [DBHandler.ts:203](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L203)

Get the driver type

#### Returns

`"postgres"` \| `"mysql"` \| `"sqlite"`

***

### getDriver()

```ts
getDriver(): DBDriver;
```

Defined in: [DBHandler.ts:210](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L210)

Get the underlying driver

#### Returns

`DBDriver`

***

### execute()

```ts
execute(sql: string, params?: unknown[]): Promise<QueryResult>;
```

Defined in: [DBHandler.ts:217](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L217)

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

Defined in: [DBHandler.ts:227](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L227)

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

Defined in: [DBHandler.ts:237](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L237)

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

Defined in: [DBHandler.ts:247](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L247)

Check if writer pool is configured

#### Returns

`boolean`

***

### getConnection()

```ts
getConnection(): Promise<DBConnection>;
```

Defined in: [DBHandler.ts:254](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L254)

Get a connection from the pool (for transactions)

#### Returns

`Promise`\<`DBConnection`\>

***

### withConnection()

```ts
withConnection(connection: DBConnection): DBHandler;
```

Defined in: [DBHandler.ts:261](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L261)

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

Defined in: [DBHandler.ts:273](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L273)

Close all connections

#### Returns

`Promise`\<`void`\>

***

### setLogger()

```ts
setLogger(logger: Logger): void;
```

Defined in: [DBHandler.ts:280](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L280)

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

Defined in: [DBHandler.ts:289](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBHandler.ts#L289)

Get the underlying PostgreSQL pool (for backward compatibility)

#### Returns

`unknown`

#### Deprecated

Use driver-specific methods instead
