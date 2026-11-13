[API](../README.md) / hasOne

# Function: hasOne()

```ts
function hasOne(keys: KeysFactory, options?: RelationDecoratorOptions): PropertyDecorator;
```

Defined in: [decorators.ts:870](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/decorators.ts#L870)

HasOne relation decorator (1:1).
Defines a one-to-one relationship where this model has one related record.

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

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `keys` | `KeysFactory` | Factory function returning [sourceKey, targetKey] or composite key pairs |
| `options?` | `RelationDecoratorOptions` | Optional order and where clauses |

## Returns

`PropertyDecorator`

