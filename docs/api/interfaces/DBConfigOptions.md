[API](../README.md) / DBConfigOptions

# Interface: DBConfigOptions

Defined in: [types.ts:280](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L280)

Options for database configuration.
Used with DBModel.setConfig() and DBModel.createDBBase().

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="writerconfig"></a> `writerConfig?` | [`DBConfig`](../interfaces/DBConfig.md) | Writer database configuration for reader/writer separation | [types.ts:282](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L282) |
| <a id="logger"></a> `logger?` | `Logger` | Logger instance | [types.ts:284](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L284) |
| <a id="findhardlimit"></a> `findHardLimit?` | `number \| null` | Hard limit for find() - throws if exceeded | [types.ts:286](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L286) |
| <a id="hasmanyhardlimit"></a> `hasManyHardLimit?` | `number \| null` | Hard limit for hasMany lazy loading - throws if exceeded | [types.ts:288](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L288) |
| <a id="usewriteraftertransaction"></a> `useWriterAfterTransaction?` | `boolean` | Keep using writer connection after transaction completes. Helps avoid stale reads due to replication lag.<br><br>**Default** `true` | [types.ts:294](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L294) |
| <a id="writerstickyduration"></a> `writerStickyDuration?` | `number` | Duration (in milliseconds) to keep using writer after transaction. Only applies when useWriterAfterTransaction is true.<br><br>**Default** `5000` | [types.ts:300](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L300) |

