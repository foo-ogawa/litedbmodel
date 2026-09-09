[**litedbmodel v3.0.0**](../README.md)

***

[litedbmodel](../globals.md) / ColumnDecorator

# Interface: ColumnDecorator()\<Value\>

Defined in: [decorators.ts:350](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L350)

What a `@column.*` decorator may be applied to, under EITHER protocol.

The standard-decorator overload is typed: `Value` is the decorated field's declared TS type, so a
family whose read contract yields a `string` (`@column.datetime()`, `@column.bigint()`, …) will not
compile onto a field declared `Date` / `bigint`. That is the compile-time half of the fix for the
"declared type ≠ value `find()` returns" defect (issue #286); the legacy protocol hands decorators
no type information at all, so there it can only be documented.

## Type Parameters

| Type Parameter |
| ------ |
| `Value` |

## Call Signature

```ts
ColumnDecorator(target: object, propertyKey: string | symbol): void;
```

Defined in: [decorators.ts:352](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L352)

Legacy (`experimentalDecorators`) property decorator.

### Parameters

| Parameter | Type |
| ------ | ------ |
| `target` | `object` |
| `propertyKey` | `string` \| `symbol` |

### Returns

`void`

## Call Signature

```ts
ColumnDecorator<This>(value: undefined, context: ClassFieldDecoratorContext<This, Value>): void;
```

Defined in: [decorators.ts:354](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L354)

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
