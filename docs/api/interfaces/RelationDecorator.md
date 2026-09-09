[**litedbmodel v2.2.7**](../README.md)

***

[litedbmodel](../globals.md) / RelationDecorator

# Interface: RelationDecorator()\<Value\>

Defined in: [decorators.ts:356](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L356)

What a relation decorator may be applied to, under either protocol.

## Type Parameters

| Type Parameter |
| ------ |
| `Value` |

## Call Signature

```ts
RelationDecorator(target: object, propertyKey: string | symbol): void;
```

Defined in: [decorators.ts:357](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L357)

What a relation decorator may be applied to, under either protocol.

### Parameters

| Parameter | Type |
| ------ | ------ |
| `target` | `object` |
| `propertyKey` | `string` \| `symbol` |

### Returns

`void`

## Call Signature

```ts
RelationDecorator<This>(value: undefined, context: ClassFieldDecoratorContext<This, Value>): void;
```

Defined in: [decorators.ts:358](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L358)

What a relation decorator may be applied to, under either protocol.

### Type Parameters

| Type Parameter |
| ------ |
| `This` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `undefined` |
| `context` | `ClassFieldDecoratorContext`\<`This`, `Value`\> |

### Returns

`void`
