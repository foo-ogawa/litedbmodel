[API](../README.md) / WriteInReadOnlyContextError

# Class: WriteInReadOnlyContextError

Defined in: [types.ts:429](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L429)

Error thrown when attempting write operations inside withWriter() context.

## Extends

- `Error`

## Constructors

### constructor

```ts
new WriteInReadOnlyContextError(operation: string, modelName?: string): WriteInReadOnlyContextError;
```

Defined in: [types.ts:430](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L430)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `operation` | `string` |
| `modelName?` | `string` |

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="operation"></a> `operation` (readonly) | `string` |  | [types.ts:431](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L431) |
| <a id="modelname"></a> `modelName?` (readonly) | `string` |  | [types.ts:432](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L432) |

