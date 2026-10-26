[**litedbmodel v2.2.12**](../README.md)

***

[litedbmodel](../globals.md) / DBConfig

# Interface: DBConfig

Defined in: [types.ts:93](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L93)

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
| <a id="driver"></a> `driver?` | `"postgres"` \| `"sqlite"` \| `"mysql"` | Database driver: 'postgres' (default), 'sqlite', or 'mysql' | [types.ts:95](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L95) |
| <a id="host"></a> `host?` | `string` | Database host (for server-based DBs like PostgreSQL) | [types.ts:97](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L97) |
| <a id="port"></a> `port?` | `number` | Database port | [types.ts:99](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L99) |
| <a id="database"></a> `database` | `string` | Database name or file path (for SQLite) | [types.ts:101](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L101) |
| <a id="user"></a> `user?` | `string` | Username | [types.ts:103](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L103) |
| <a id="password"></a> `password?` | `string` | Password | [types.ts:105](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L105) |
| <a id="max"></a> `max?` | `number` | Maximum pool size | [types.ts:107](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L107) |
| <a id="timeout"></a> `timeout?` | `number` | Seconds allowed for getting a connection (default: 30). With PostgreSQL this also bounds the wait for a free connection when the pool is at `max`. | [types.ts:112](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L112) |
| <a id="idletimeoutmillis"></a> `idleTimeoutMillis?` | `number` | Milliseconds an unused pooled connection stays open before it is closed (default: 10000) | [types.ts:114](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L114) |
| <a id="querytimeout"></a> `queryTimeout?` | `number` | Query timeout in seconds | [types.ts:116](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L116) |
| <a id="keepalive"></a> `keepAlive?` | `boolean` | Enable TCP keepalive on connections (recommended for serverless/Lambda) | [types.ts:118](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L118) |
| <a id="keepaliveinitialdelaymillis"></a> `keepAliveInitialDelayMillis?` | `number` | Delay in milliseconds before first keepalive probe (default: 10000) | [types.ts:120](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L120) |
