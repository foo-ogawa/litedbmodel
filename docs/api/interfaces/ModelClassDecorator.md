[API](../README.md) / ModelClassDecorator

# Interface: ModelClassDecorator

Defined in: [decorators.ts:1143](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1143)

A class decorator that works under both protocols.

## Call Signature

```ts
<T extends { new (...args: unknown[]): object }>(constructor: T): T;
```

Defined in: [decorators.ts:1144](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1144)

### Type Parameters

| Type Parameter |
| ------ |
| `T extends { new (...args: unknown[]): object }` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `constructor` | `T` |

### Returns

`T`

***

```ts
<T extends { new (...args: unknown[]): object }>(value: T, context: ClassDecoratorContext): T;
```

Defined in: [decorators.ts:1145](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1145)

### Type Parameters

| Type Parameter |
| ------ |
| `T extends { new (...args: unknown[]): object }` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `T` |
| `context` | `ClassDecoratorContext` |

### Returns

`T`

