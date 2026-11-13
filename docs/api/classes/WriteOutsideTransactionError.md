[API](../README.md) / WriteOutsideTransactionError

# Class: WriteOutsideTransactionError

Defined in: [types.ts:436](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L436)

Error thrown when attempting write operations outside a transaction.

## Extends

- `Error`

## Constructors

### constructor

```ts
new WriteOutsideTransactionError(operation: string, modelName?: string): WriteOutsideTransactionError;
```

Defined in: [types.ts:437](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L437)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `operation` | `string` |
| `modelName?` | `string` |

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="operation"></a> `operation` (readonly) | `string` |  | [types.ts:438](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L438) |
| <a id="modelname"></a> `modelName?` (readonly) | `string` |  | [types.ts:439](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L439) |

