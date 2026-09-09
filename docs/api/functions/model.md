[**litedbmodel v3.0.0**](../README.md)

***

[litedbmodel](../globals.md) / model

# Function: model()

## Call Signature

```ts
function model<T>(constructor: T): T;
```

Defined in: [decorators.ts:1065](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1065)

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

Defined in: [decorators.ts:1069](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1069)

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

Defined in: [decorators.ts:1071](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1071)

### Parameters

| Parameter | Type |
| ------ | ------ |
| `tableName` | `string` |
| `options` | [`ModelOptions`](../interfaces/ModelOptions.md) |

### Returns

[`ModelClassDecorator`](../interfaces/ModelClassDecorator.md)
