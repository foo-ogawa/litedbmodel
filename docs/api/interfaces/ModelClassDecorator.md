[**litedbmodel v2.2.8**](../README.md)

***

[litedbmodel](../globals.md) / ModelClassDecorator

# Interface: ModelClassDecorator()

Defined in: [decorators.ts:1125](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1125)

A class decorator that works under both protocols.

## Call Signature

```ts
ModelClassDecorator<T>(constructor: T): T;
```

Defined in: [decorators.ts:1126](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1126)

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

Defined in: [decorators.ts:1127](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1127)

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
