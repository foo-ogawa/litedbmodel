[**litedbmodel v2.2.3**](../README.md)

***

[litedbmodel](../globals.md) / WriteOutsideTransactionError

# Class: WriteOutsideTransactionError

Defined in: [types.ts:401](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L401)

Error thrown when attempting write operations outside a transaction.

## Extends

- `Error`

## Constructors

### Constructor

```ts
new WriteOutsideTransactionError(operation: string, modelName?: string): WriteOutsideTransactionError;
```

Defined in: [types.ts:402](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L402)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `operation` | `string` |
| `modelName?` | `string` |

#### Returns

`WriteOutsideTransactionError`

#### Overrides

```ts
Error.constructor
```

## Properties

| Property | Modifier | Type | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="operation"></a> `operation` | `readonly` | `string` | [types.ts:403](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L403) |
| <a id="modelname"></a> `modelName?` | `readonly` | `string` | [types.ts:404](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L404) |
