[API](../README.md) / RelationDecorator

# Interface: RelationDecorator\<Value\>

Defined in: [decorators.ts:367](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L367)

What a relation decorator may be applied to, under either protocol.

## Type Parameters

| Type Parameter |
| ------ |
| `Value` |

## Call Signature

```ts
<This extends Partial<Record<Key, Value>>, Key extends string | symbol>(target: This, propertyKey: Key): void;
```

Defined in: [decorators.ts:368](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L368)

### Type Parameters

| Type Parameter |
| ------ |
| `This extends Partial<Record<Key, Value>>` |
| `Key extends string \| symbol` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `target` | `This` |
| `propertyKey` | `Key` |

### Returns

`void`

***

```ts
<This>(value: undefined, context: ClassFieldDecoratorContext<This, Value>): void;
```

Defined in: [decorators.ts:372](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L372)

### Type Parameters

| Type Parameter |
| ------ |
| `This` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `undefined` |
| `context` | `ClassFieldDecoratorContext<This, Value>` |

### Returns

`void`

