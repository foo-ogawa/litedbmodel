[API](../README.md) / DBConfig

# Interface: DBConfig

Defined in: [types.ts:94](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L94)

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
| <a id="driver"></a> `driver?` | `'postgres' \| 'sqlite' \| 'mysql'` | Database driver: 'postgres' (default), 'sqlite', or 'mysql' | [types.ts:96](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L96) |
| <a id="host"></a> `host?` | `string` | Database host (for server-based DBs like PostgreSQL) | [types.ts:98](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L98) |
| <a id="port"></a> `port?` | `number` | Database port | [types.ts:100](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L100) |
| <a id="database"></a> `database` | `string` | Database name or file path (for SQLite) | [types.ts:102](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L102) |
| <a id="user"></a> `user?` | `string` | Username | [types.ts:104](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L104) |
| <a id="password"></a> `password?` | `string` | Password | [types.ts:106](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L106) |
| <a id="max"></a> `max?` | `number` | Maximum pool size | [types.ts:108](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L108) |
| <a id="timeout"></a> `timeout?` | `number` | Seconds allowed for getting a connection (default: 30). With PostgreSQL this also bounds the wait for a free connection when the pool is at `max`. | [types.ts:113](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L113) |
| <a id="idletimeoutmillis"></a> `idleTimeoutMillis?` | `number` | Milliseconds an unused pooled connection stays open before it is closed (default: 10000) | [types.ts:115](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L115) |
| <a id="querytimeout"></a> `queryTimeout?` | `number` | Query timeout in seconds | [types.ts:117](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L117) |
| <a id="keepalive"></a> `keepAlive?` | `boolean` | Enable TCP keepalive on connections (recommended for serverless/Lambda) | [types.ts:119](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L119) |
| <a id="keepaliveinitialdelaymillis"></a> `keepAliveInitialDelayMillis?` | `number` | Delay in milliseconds before first keepalive probe (default: 10000) | [types.ts:121](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L121) |

