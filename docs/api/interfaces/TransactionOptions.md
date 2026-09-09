[**litedbmodel v2.2.7**](../README.md)

***

[litedbmodel](../globals.md) / TransactionOptions

# Interface: TransactionOptions

Defined in: [types.ts:266](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L266)

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="retryonerror"></a> `retryOnError?` | `boolean` | - | [types.ts:267](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L267) |
| <a id="retrylimit"></a> `retryLimit?` | `number` | - | [types.ts:268](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L268) |
| <a id="retryduration"></a> `retryDuration?` | `number` | - | [types.ts:269](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L269) |
| <a id="rollbackonly"></a> `rollbackOnly?` | `boolean` | If true, always rollback instead of commit (useful for preview/dry-run) | [types.ts:271](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L271) |
| <a id="usewriteraftertransaction"></a> `useWriterAfterTransaction?` | `boolean` | Override global useWriterAfterTransaction for this transaction. If true, subsequent reads will use writer connection for writerStickyDuration. **Default** `Uses global setting (true by default)` | [types.ts:277](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L277) |
