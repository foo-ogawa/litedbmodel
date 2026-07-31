[**litedbmodel v2.2.3**](../README.md)

***

[litedbmodel](../globals.md) / WriteInReadOnlyContextError

# Class: WriteInReadOnlyContextError

Defined in: types.ts:419

Error thrown when attempting write operations inside withWriter() context.

## Extends

- `Error`

## Constructors

### Constructor

```ts
new WriteInReadOnlyContextError(operation: string, modelName?: string): WriteInReadOnlyContextError;
```

Defined in: types.ts:420

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
| <a id="operation"></a> `operation` | `readonly` | `string` | types.ts:421 |
| <a id="modelname"></a> `modelName?` | `readonly` | `string` | types.ts:422 |
