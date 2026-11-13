[API](../README.md) / DBConfig

# Interface: DBConfig

Defined in: [types.ts:81](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L81)

Database connection configuration.
Used in `DBConfigOptions.config` and `DBConfigOptions.writerConfig`.

## Example

```typescript
const config: DBConfig = {
  driver: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'user',
  password: 'pass',
};
```

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="driver"></a> `driver?` | `'postgres' \| 'sqlite' \| 'mysql'` | Database driver: 'postgres' (default), 'sqlite', or 'mysql' | [types.ts:83](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L83) |
| <a id="host"></a> `host?` | `string` | Database host (for server-based DBs like PostgreSQL) | [types.ts:85](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L85) |
| <a id="port"></a> `port?` | `number` | Database port | [types.ts:87](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L87) |
| <a id="database"></a> `database` | `string` | Database name or file path (for SQLite) | [types.ts:89](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L89) |
| <a id="user"></a> `user?` | `string` | Username | [types.ts:91](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L91) |
| <a id="password"></a> `password?` | `string` | Password | [types.ts:93](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L93) |
| <a id="max"></a> `max?` | `number` | Maximum pool size | [types.ts:95](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L95) |
| <a id="timeout"></a> `timeout?` | `number` | Seconds allowed for getting a connection (default: 30). With PostgreSQL this also bounds the wait for a free connection when the pool is at `max`. | [types.ts:100](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L100) |
| <a id="idletimeoutmillis"></a> `idleTimeoutMillis?` | `number` | Milliseconds an unused pooled connection stays open before it is closed (default: 10000) | [types.ts:102](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L102) |
| <a id="querytimeout"></a> `queryTimeout?` | `number` | Query timeout in seconds | [types.ts:104](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L104) |
| <a id="keepalive"></a> `keepAlive?` | `boolean` | Enable TCP keepalive on connections (recommended for serverless/Lambda) | [types.ts:106](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L106) |
| <a id="keepaliveinitialdelaymillis"></a> `keepAliveInitialDelayMillis?` | `number` | Delay in milliseconds before first keepalive probe (default: 10000) | [types.ts:108](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L108) |

