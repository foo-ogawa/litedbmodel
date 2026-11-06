[**litedbmodel v2.2.14**](../README.md)

***

[litedbmodel](../globals.md) / WriteOutsideTransactionError

# Class: WriteOutsideTransactionError

Defined in: [types.ts:436](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L436)

Error thrown when attempting write operations outside a transaction.

## Extends

- `Error`

## Constructors

### Constructor

```ts
new WriteOutsideTransactionError(operation: string, modelName?: string): WriteOutsideTransactionError;
```

Defined in: [types.ts:437](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L437)

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
| <a id="operation"></a> `operation` | `readonly` | `string` | [types.ts:438](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L438) |
| <a id="modelname"></a> `modelName?` | `readonly` | `string` | [types.ts:439](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L439) |
