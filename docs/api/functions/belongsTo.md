[API](../README.md) / belongsTo

# Function: belongsTo()

```ts
function belongsTo<Value = unknown>(keys: KeysFactory, options?: RelationDecoratorOptions): RelationDecorator<Value>;
```

Defined in: [decorators.ts:1050](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L1050)

BelongsTo relation decorator (N:1).
Defines a many-to-one relationship where this model belongs to a parent record.

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

## Type Parameters

| Type Parameter |
| ------ |
| `Value = unknown` |

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `keys` | `KeysFactory` | Factory function returning [sourceKey, targetKey] or composite key pairs |
| `options?` | `RelationDecoratorOptions` | Optional order and where clauses |

## Returns

[`RelationDecorator`](../interfaces/RelationDecorator.md)`<Value>`

