[API](../README.md) / WriteOutsideTransactionError

# Class: WriteOutsideTransactionError

Defined in: [types.ts:450](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L450)

Error thrown when attempting write operations outside a transaction.

## Extends

- `Error`

## Constructors

### constructor

```ts
new WriteOutsideTransactionError(operation: string, modelName?: string): WriteOutsideTransactionError;
```

Defined in: [types.ts:451](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L451)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `operation` | `string` |
| `modelName?` | `string` |

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="operation"></a> `operation` (readonly) | `string` |  | [types.ts:452](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L452) |
| <a id="modelname"></a> `modelName?` (readonly) | `string` |  | [types.ts:453](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L453) |

