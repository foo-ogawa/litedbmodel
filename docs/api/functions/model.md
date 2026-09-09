[**litedbmodel v2.2.7**](../README.md)

***

[litedbmodel](../globals.md) / model

# Function: model()

## Call Signature

```ts
function model<T>(constructor: T): T;
```

Defined in: [decorators.ts:1120](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1120)

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

Defined in: [decorators.ts:1124](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1124)

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

Defined in: [decorators.ts:1126](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1126)

### Parameters

| Parameter | Type |
| ------ | ------ |
| `tableName` | `string` |
| `options` | [`ModelOptions`](../interfaces/ModelOptions.md) |

### Returns

[`ModelClassDecorator`](../interfaces/ModelClassDecorator.md)
