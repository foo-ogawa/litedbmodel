[**litedbmodel v2.2.13**](../README.md)

***

[litedbmodel](../globals.md) / WriteInReadOnlyContextError

# Class: WriteInReadOnlyContextError

Defined in: [types.ts:445](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L445)

Error thrown when attempting write operations inside withWriter() context.

## Extends

- `Error`

## Constructors

### Constructor

```ts
new WriteInReadOnlyContextError(operation: string, modelName?: string): WriteInReadOnlyContextError;
```

Defined in: [types.ts:446](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L446)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `operation` | `string` |
| `modelName?` | `string` |

#### Returns

`WriteInReadOnlyContextError`

#### Overrides

```ts
Error.constructor
```

## Properties

| Property | Modifier | Type | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="operation"></a> `operation` | `readonly` | `string` | [types.ts:447](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L447) |
| <a id="modelname"></a> `modelName?` | `readonly` | `string` | [types.ts:448](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L448) |
