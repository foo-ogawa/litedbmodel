[**litedbmodel v2.2.8**](../README.md)

***

[litedbmodel](../globals.md) / model

# Function: model()

## Call Signature

```ts
function model<T>(constructor: T): T;
```

Defined in: [decorators.ts:1149](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1149)

### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* (...`args`: `unknown`[]) => `object` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `constructor` | `T` |

### Returns

`T`

## Call Signature

```ts
function model(tableName: string): ModelClassDecorator;
```

Defined in: [decorators.ts:1153](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1153)

### Parameters

| Parameter | Type |
| ------ | ------ |
| `tableName` | `string` |

### Returns

[`ModelClassDecorator`](../interfaces/ModelClassDecorator.md)

## Call Signature

```ts
function model(tableName: string, options: ModelOptions): ModelClassDecorator;
```

Defined in: [decorators.ts:1155](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1155)

### Parameters

| Parameter | Type |
| ------ | ------ |
| `tableName` | `string` |
| `options` | [`ModelOptions`](../interfaces/ModelOptions.md) |

### Returns

[`ModelClassDecorator`](../interfaces/ModelClassDecorator.md)
