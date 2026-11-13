[API](../README.md) / DBConfigOptions

# Interface: DBConfigOptions

Defined in: [types.ts:301](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L301)

Options for database configuration.
Used with DBModel.setConfig() and DBModel.createDBBase().

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="writerconfig"></a> `writerConfig?` | [`DBConfig`](../interfaces/DBConfig.md) | Writer database configuration for reader/writer separation | [types.ts:303](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L303) |
| <a id="logger"></a> `logger?` | `Logger` | Logger instance | [types.ts:305](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L305) |
| <a id="findhardlimit"></a> `findHardLimit?` | `number \| null` | Hard limit for find() - throws if exceeded | [types.ts:307](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L307) |
| <a id="hasmanyhardlimit"></a> `hasManyHardLimit?` | `number \| null` | Hard limit for hasMany lazy loading - throws if exceeded | [types.ts:309](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L309) |
| <a id="usewriteraftertransaction"></a> `useWriterAfterTransaction?` | `boolean` | Keep using writer connection after transaction completes. Helps avoid stale reads due to replication lag.<br><br>**Default** `true` | [types.ts:315](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L315) |
| <a id="writerstickyduration"></a> `writerStickyDuration?` | `number` | Duration (in milliseconds) to keep using writer after transaction. Only applies when useWriterAfterTransaction is true.<br><br>**Default** `5000` | [types.ts:321](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L321) |

