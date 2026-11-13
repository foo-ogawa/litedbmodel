[API](../README.md) / DBConfigOptions

# Interface: DBConfigOptions

Defined in: [types.ts:315](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L315)

Options for database configuration.
Used with DBModel.setConfig() and DBModel.createDBBase().

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="writerconfig"></a> `writerConfig?` | [`DBConfig`](../interfaces/DBConfig.md) | Writer database configuration for reader/writer separation | [types.ts:317](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L317) |
| <a id="logger"></a> `logger?` | `Logger` | Logger instance | [types.ts:319](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L319) |
| <a id="findhardlimit"></a> `findHardLimit?` | `number \| null` | Hard limit for find() - throws if exceeded | [types.ts:321](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L321) |
| <a id="hasmanyhardlimit"></a> `hasManyHardLimit?` | `number \| null` | Hard limit for hasMany lazy loading - throws if exceeded | [types.ts:323](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L323) |
| <a id="usewriteraftertransaction"></a> `useWriterAfterTransaction?` | `boolean` | Keep using writer connection after transaction completes. Helps avoid stale reads due to replication lag.<br><br>**Default** `true` | [types.ts:329](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L329) |
| <a id="writerstickyduration"></a> `writerStickyDuration?` | `number` | Duration (in milliseconds) to keep using writer after transaction. Only applies when useWriterAfterTransaction is true.<br><br>**Default** `5000` | [types.ts:335](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L335) |

