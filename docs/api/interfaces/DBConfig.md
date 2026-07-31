[**litedbmodel v2.2.3**](../README.md)

***

[litedbmodel](../globals.md) / DBConfig

# Interface: DBConfig

Defined in: DBHandler.ts:41

Database configuration

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="host"></a> `host?` | `string` | Database host (for server-based DBs) | DBHandler.ts:43 |
| <a id="port"></a> `port?` | `number` | Database port | DBHandler.ts:45 |
| <a id="database"></a> `database` | `string` | Database name or file path | DBHandler.ts:47 |
| <a id="user"></a> `user?` | `string` | Username | DBHandler.ts:49 |
| <a id="password"></a> `password?` | `string` | Password | DBHandler.ts:51 |
| <a id="max"></a> `max?` | `number` | Maximum pool size | DBHandler.ts:53 |
| <a id="timeout"></a> `timeout?` | `number` | Connection timeout in seconds | DBHandler.ts:55 |
| <a id="querytimeout"></a> `queryTimeout?` | `number` | Query timeout in seconds | DBHandler.ts:57 |
| <a id="keepalive"></a> `keepAlive?` | `boolean` | Enable TCP keepalive on connections (recommended for serverless/Lambda) | DBHandler.ts:59 |
| <a id="keepaliveinitialdelaymillis"></a> `keepAliveInitialDelayMillis?` | `number` | Delay in milliseconds before first keepalive probe (default: 10000) | DBHandler.ts:61 |
| <a id="driver"></a> `driver?` | `"postgres"` \| `"mysql"` \| `"sqlite"` | Driver type: 'postgres' (default), 'sqlite', or 'mysql' | DBHandler.ts:63 |
