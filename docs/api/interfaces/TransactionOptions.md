[**litedbmodel v2.2.3**](../README.md)

***

[litedbmodel](../globals.md) / TransactionOptions

# Interface: TransactionOptions

Defined in: types.ts:266

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="retryonerror"></a> `retryOnError?` | `boolean` | - | types.ts:267 |
| <a id="retrylimit"></a> `retryLimit?` | `number` | - | types.ts:268 |
| <a id="retryduration"></a> `retryDuration?` | `number` | - | types.ts:269 |
| <a id="rollbackonly"></a> `rollbackOnly?` | `boolean` | If true, always rollback instead of commit (useful for preview/dry-run) | types.ts:271 |
| <a id="usewriteraftertransaction"></a> `useWriterAfterTransaction?` | `boolean` | Override global useWriterAfterTransaction for this transaction. If true, subsequent reads will use writer connection for writerStickyDuration. **Default** `Uses global setting (true by default)` | types.ts:277 |
