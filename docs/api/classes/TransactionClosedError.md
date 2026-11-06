[**litedbmodel v2.2.14**](../README.md)

***

[litedbmodel](../globals.md) / TransactionClosedError

# Class: TransactionClosedError

Defined in: [types.ts:413](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L413)

Error thrown when a query is issued through a transaction after its function has settled, or when the
function settled while a query started inside it had not finished (the transaction is rolled back).

## Extends

- `Error`

## Constructors

### Constructor

```ts
new TransactionClosedError(unfinished?: boolean, options?: {
  cause: unknown;
}): TransactionClosedError;
```

Defined in: [types.ts:419](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L419)

#### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `unfinished` | `boolean` | `false` | `true` when the transaction function settled while a query started inside it had not finished; `false` (default) for a query issued after the function settled. |
| `options?` | \{ `cause`: `unknown`; \} | `undefined` | `cause`: the error the function failed with, when it failed while a query was unfinished. |
| `options.cause?` | `unknown` | `undefined` | - |

#### Returns

`TransactionClosedError`

#### Overrides

```ts
Error.constructor
```
