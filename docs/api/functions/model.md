[**litedbmodel v2.2.8**](../README.md)

***

[litedbmodel](../globals.md) / model

# Function: model()

## Call Signature

```ts
function model<T>(constructor: T): T;
```

Defined in: [decorators.ts:1131](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1131)

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

Defined in: [decorators.ts:1135](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1135)

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

Defined in: [decorators.ts:1137](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1137)

### Parameters

| Parameter | Type |
| ------ | ------ |
| `tableName` | `string` |
| `options` | [`ModelOptions`](../interfaces/ModelOptions.md) |

### Returns

[`ModelClassDecorator`](../interfaces/ModelClassDecorator.md)
