[API](../README.md) / WriteInReadOnlyContextError

# Class: WriteInReadOnlyContextError

Defined in: [types.ts:468](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L468)

Error thrown when attempting write operations inside withWriter() context.

## Extends

- `Error`

## Constructors

### constructor

```ts
new WriteInReadOnlyContextError(operation: string, modelName?: string): WriteInReadOnlyContextError;
```

Defined in: [types.ts:469](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L469)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `operation` | `string` |
| `modelName?` | `string` |

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="operation"></a> `operation` (readonly) | `string` |  | [types.ts:470](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L470) |
| <a id="modelname"></a> `modelName?` (readonly) | `string` |  | [types.ts:471](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L471) |

