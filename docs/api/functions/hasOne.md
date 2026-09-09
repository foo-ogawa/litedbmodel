[**litedbmodel v2.2.6**](../README.md)

***

[litedbmodel](../globals.md) / hasOne

# Function: hasOne()

```ts
function hasOne<Value>(keys: KeysFactory, options?: RelationDecoratorOptions): RelationDecorator<Value>;
```

Defined in: [decorators.ts:996](https://github.com/foo-ogawa/litedbmodel/blob/main/src/decorators.ts#L996)

HasOne relation decorator (1:1).
Defines a one-to-one relationship where this model has one related record.

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
@hasOne(() => [User.id, UserProfile.user_id])
declare profile: Promise<UserProfile | null>;

// Composite key relation
@hasOne(() => [
  [TenantUser.tenant_id, TenantProfile.tenant_id],
  [TenantUser.id, TenantProfile.user_id],
])
declare profile: Promise<TenantProfile | null>;
```
