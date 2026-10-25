[**litedbmodel v2.2.11**](../README.md)

***

[litedbmodel](../globals.md) / DBConfigOptions

# Interface: DBConfigOptions

Defined in: [types.ts:292](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L292)

Options for database configuration.
Used with DBModel.setConfig() and DBModel.createDBBase().

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="writerconfig"></a> `writerConfig?` | [`DBConfig`](DBConfig.md) | Writer database configuration for reader/writer separation | [types.ts:294](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L294) |
| <a id="logger"></a> `logger?` | `Logger` | Logger instance | [types.ts:296](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L296) |
| <a id="findhardlimit"></a> `findHardLimit?` | `number` \| `null` | Hard limit for find() - throws if exceeded | [types.ts:298](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L298) |
| <a id="hasmanyhardlimit"></a> `hasManyHardLimit?` | `number` \| `null` | Hard limit for hasMany lazy loading - throws if exceeded | [types.ts:300](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L300) |
| <a id="usewriteraftertransaction"></a> `useWriterAfterTransaction?` | `boolean` | Keep using writer connection after transaction completes. Helps avoid stale reads due to replication lag. **Default** `true` | [types.ts:306](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L306) |
| <a id="writerstickyduration"></a> `writerStickyDuration?` | `number` | Duration (in milliseconds) to keep using writer after transaction. Only applies when useWriterAfterTransaction is true. **Default** `5000` | [types.ts:312](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L312) |
