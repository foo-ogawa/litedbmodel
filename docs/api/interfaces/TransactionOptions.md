[API](../README.md) / TransactionOptions

# Interface: TransactionOptions

Defined in: [types.ts:269](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L269)

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="retryonerror"></a> `retryOnError?` | `boolean` |  | [types.ts:270](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L270) |
| <a id="retrylimit"></a> `retryLimit?` | `number` |  | [types.ts:271](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L271) |
| <a id="retryduration"></a> `retryDuration?` | `number` |  | [types.ts:272](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L272) |
| <a id="rollbackonly"></a> `rollbackOnly?` | `boolean` | If true, always rollback instead of commit (useful for preview/dry-run) | [types.ts:274](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L274) |
| <a id="usewriteraftertransaction"></a> `useWriterAfterTransaction?` | `boolean` | Override global useWriterAfterTransaction for this transaction. If true, subsequent reads will use writer connection for writerStickyDuration.<br><br>**Default** `Uses global setting (true by default)` | [types.ts:280](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L280) |
| <a id="connection"></a> `connection?` | `DBConnection` | A connection acquired with `DBModel.acquireConnection()`. The transaction runs on it instead of taking a new one, and it is not released after COMMIT or ROLLBACK (the caller that acquired it releases it). A connection error is not retried (the connection cannot be taken again); a deadlock or serialization failure is retried on the same connection after ROLLBACK. Inside an enclosing transaction it must be the enclosing transaction's own connection (else an error). | [types.ts:288](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L288) |

