[API](../README.md) / TransactionClosedError

# Class: TransactionClosedError

Defined in: [types.ts:427](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L427)

Error thrown when a query is issued through a transaction after its function has settled, or when the
function settled while a query started inside it had not finished (the transaction is rolled back).

## Extends

- `Error`

## Constructors

### constructor

```ts
new TransactionClosedError(unfinished?: boolean, options?: { cause: unknown }): TransactionClosedError;
```

Defined in: [types.ts:433](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L433)

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `unfinished?` | `boolean` | `true` when the transaction function settled while a query started inside it had not finished; `false` (default) for a query issued after the function settled. **Default** `false` |
| `options?` | `{ cause: unknown }` | `cause`: the error the function failed with, when it failed while a query was unfinished. |

