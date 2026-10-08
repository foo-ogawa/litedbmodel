[**litedbmodel v2.2.8**](../README.md)

***

[litedbmodel](../globals.md) / ModelClassDecorator

# Interface: ModelClassDecorator()

Defined in: [decorators.ts:1143](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1143)

A class decorator that works under both protocols.

## Call Signature

```ts
ModelClassDecorator<T>(constructor: T): T;
```

Defined in: [decorators.ts:1144](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1144)

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

Defined in: [decorators.ts:1145](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1145)

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
