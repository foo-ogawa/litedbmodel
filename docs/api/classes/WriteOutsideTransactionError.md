[API](../README.md) / WriteOutsideTransactionError

# Class: WriteOutsideTransactionError

Defined in: [types.ts:391](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L391)

Error thrown when attempting write operations outside a transaction.

## Extends

- `Error`

## Constructors

### constructor

```ts
new WriteOutsideTransactionError(operation: string, modelName?: string): WriteOutsideTransactionError;
```

Defined in: [types.ts:392](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L392)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `operation` | `string` |
| `modelName?` | `string` |

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="operation"></a> `operation` (readonly) | `string` |  | [types.ts:393](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L393) |
| <a id="modelname"></a> `modelName?` (readonly) | `string` |  | [types.ts:394](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L394) |

