[**litedbmodel v2.2.7**](../README.md)

***

[litedbmodel](../globals.md) / model

# Function: model()

## Call Signature

```ts
function model<T>(constructor: T): T;
```

Defined in: [decorators.ts:1066](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1066)

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

Defined in: [decorators.ts:1070](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1070)

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

Defined in: [decorators.ts:1072](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1072)

### Parameters

| Parameter | Type |
| ------ | ------ |
| `tableName` | `string` |
| `options` | [`ModelOptions`](../interfaces/ModelOptions.md) |

### Returns

[`ModelClassDecorator`](../interfaces/ModelClassDecorator.md)
