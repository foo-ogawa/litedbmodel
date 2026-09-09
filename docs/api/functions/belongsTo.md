[**litedbmodel v2.2.6**](../README.md)

***

[litedbmodel](../globals.md) / belongsTo

# Function: belongsTo()

```ts
function belongsTo<Value>(keys: KeysFactory, options?: RelationDecoratorOptions): RelationDecorator<Value>;
```

Defined in: [decorators.ts:966](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L966)

BelongsTo relation decorator (N:1).
Defines a many-to-one relationship where this model belongs to a parent record.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `Value` | `unknown` |

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `keys` | `KeysFactory` | Factory function returning [sourceKey, targetKey] or composite key pairs |
| `options?` | `RelationDecoratorOptions` | Optional order and where clauses |

## Returns

[`RelationDecorator`](../interfaces/RelationDecorator.md)\<`Value`\>

## Example

```typescript
// Single key relation
@belongsTo(() => [Post.author_id, User.id])
declare author: Promise<User | null>;

// Composite key relation
@belongsTo(() => [
  [TenantPost.tenant_id, TenantUser.tenant_id],
  [TenantPost.author_id, TenantUser.id],
])
declare author: Promise<TenantUser | null>;
```
