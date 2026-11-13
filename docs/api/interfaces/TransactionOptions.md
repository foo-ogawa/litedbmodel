[API](../README.md) / TransactionOptions

# Interface: TransactionOptions

Defined in: [types.ts:249](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L249)

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="retryonerror"></a> `retryOnError?` | `boolean` |  | [types.ts:250](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L250) |
| <a id="retrylimit"></a> `retryLimit?` | `number` |  | [types.ts:251](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L251) |
| <a id="retryduration"></a> `retryDuration?` | `number` |  | [types.ts:252](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L252) |
| <a id="rollbackonly"></a> `rollbackOnly?` | `boolean` | If true, always rollback instead of commit (useful for preview/dry-run) | [types.ts:254](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L254) |
| <a id="usewriteraftertransaction"></a> `useWriterAfterTransaction?` | `boolean` | Override global useWriterAfterTransaction for this transaction. If true, subsequent reads will use writer connection for writerStickyDuration.<br><br>**Default** `Uses global setting (true by default)` | [types.ts:260](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L260) |
| <a id="connection"></a> `connection?` | `DBConnection` | A connection acquired with `DBModel.acquireConnection()`. The transaction runs on it instead of taking a new one, and it is not released after COMMIT or ROLLBACK (the caller that acquired it releases it). A connection error is not retried (the connection cannot be taken again); a deadlock or serialization failure is retried on the same connection after ROLLBACK. | [types.ts:267](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L267) |

