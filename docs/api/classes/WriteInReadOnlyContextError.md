[API](../README.md) / WriteInReadOnlyContextError

# Class: WriteInReadOnlyContextError

Defined in: [types.ts:454](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L454)

Error thrown when attempting write operations inside withWriter() context.

## Extends

- `Error`

## Constructors

### constructor

```ts
new WriteInReadOnlyContextError(operation: string, modelName?: string): WriteInReadOnlyContextError;
```

Defined in: [types.ts:455](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L455)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `operation` | `string` |
| `modelName?` | `string` |

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="operation"></a> `operation` (readonly) | `string` |  | [types.ts:456](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L456) |
| <a id="modelname"></a> `modelName?` (readonly) | `string` |  | [types.ts:457](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L457) |

