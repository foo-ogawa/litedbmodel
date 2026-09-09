[**litedbmodel v3.0.0**](../README.md)

***

[litedbmodel](../globals.md) / RelationDecorator

# Interface: RelationDecorator()\<Value\>

Defined in: [decorators.ts:358](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L358)

What a relation decorator may be applied to, under either protocol.

## Type Parameters

| Type Parameter |
| ------ |
| `Value` |

## Call Signature

```ts
RelationDecorator(target: object, propertyKey: string | symbol): void;
```

Defined in: [decorators.ts:359](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L359)

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

Defined in: [decorators.ts:360](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L360)

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
