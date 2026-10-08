[**litedbmodel v2.2.8**](../README.md)

***

[litedbmodel](../globals.md) / ColumnDecorator

# Interface: ColumnDecorator()\<Value\>

Defined in: [decorators.ts:351](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L351)

What a `@column.*` decorator may be applied to, under EITHER protocol.

Both overloads are typed: `Value` is the decorated field's declared TS type, so a family whose read
contract yields a `string` (`@column.datetime()`, `@column.bigint()`, …) will not compile onto a
field declared `Date` / `bigint`. That is the compile-time half of the fix for the "declared type ≠
value `find()` returns" defect (issue #286), and it holds under BOTH protocols — the legacy
property decorator receives the prototype, whose property types a mapped type can constrain.

## Type Parameters

| Type Parameter |
| ------ |
| `Value` |

## Call Signature

```ts
ColumnDecorator<This, Key>(target: This, propertyKey: Key): void;
```

Defined in: [decorators.ts:358](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L358)

Legacy (`experimentalDecorators`) property decorator. The prototype it receives IS typed, so the
decorated property's declared type is constrained here too — `@column.datetime() x?: Date` does
not compile under either protocol. (It was believed legacy carried no type information; it does,
and the majority of models are compiled that way.)

### Type Parameters

| Type Parameter |
| ------ |
| `This` *extends* `Partial`\<`Record`\<`Key`, `Value`\>\> |
| `Key` *extends* `string` \| `symbol` |

### Parameters

| Parameter | Type |
| ------ | ------ |
| `target` | `This` |
| `propertyKey` | `Key` |

### Returns

`void`

## Call Signature

```ts
ColumnDecorator<This>(value: undefined, context: ClassFieldDecoratorContext<This, Value>): void;
```

Defined in: [decorators.ts:363](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L363)

TC39 standard class-field decorator.

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
