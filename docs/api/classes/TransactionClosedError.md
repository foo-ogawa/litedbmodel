[API](../README.md) / TransactionClosedError

# Class: TransactionClosedError

Defined in: [types.ts:411](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L411)

Error thrown when a query is issued through a transaction after its function has settled
(`'issued-after-settle'`), or when the function settled while a query it started had not
finished (`'unfinished-query'`).

## Extends

- `Error`

## Constructors

### constructor

```ts
new TransactionClosedError(reason?: 'issued-after-settle' | 'unfinished-query', cause?: unknown): TransactionClosedError;
```

Defined in: [types.ts:412](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L412)

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `'issued-after-settle' \| 'unfinished-query'` | **Default** `'issued-after-settle'` |
| `cause?` | `unknown` |  |

