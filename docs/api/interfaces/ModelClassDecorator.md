[**litedbmodel v2.2.7**](../README.md)

***

[litedbmodel](../globals.md) / ModelClassDecorator

# Interface: ModelClassDecorator()

Defined in: [decorators.ts:1059](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1059)

A class decorator that works under both protocols.

## Call Signature

```ts
ModelClassDecorator<T>(constructor: T): T;
```

Defined in: [decorators.ts:1060](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1060)

A class decorator that works under both protocols.

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
ModelClassDecorator<T>(value: T, context: ClassDecoratorContext): T;
```

Defined in: [decorators.ts:1061](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1061)

A class decorator that works under both protocols.

### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* (...`args`: `unknown`[]) => `object` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `T` |
| `context` | `ClassDecoratorContext` |

### Returns

`T`
