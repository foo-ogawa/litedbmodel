[**litedbmodel v2.2.7**](../README.md)

***

[litedbmodel](../globals.md) / hasMany

# Function: hasMany()

```ts
function hasMany<Value>(keys: KeysFactory, options?: RelationDecoratorOptions): RelationDecorator<Value>;
```

Defined in: [decorators.ts:936](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L936)

HasMany relation decorator (1:N).
Defines a one-to-many relationship where this model has many related records.

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
// Single key relation (legacy decorators: `declare`; standard decorators: `posts!: …`)
@hasMany(() => [User.id, Post.author_id])
declare posts: Promise<Post[]>;

// With options
@hasMany(() => [User.id, Post.author_id], {
  order: () => Post.created_at.desc(),
  where: () => [[Post.is_deleted, false]],
})
declare activePosts: Promise<Post[]>;

// Composite key relation
@hasMany(() => [
  [TenantUser.tenant_id, TenantPost.tenant_id],
  [TenantUser.id, TenantPost.author_id],
])
declare posts: Promise<TenantPost[]>;
```
