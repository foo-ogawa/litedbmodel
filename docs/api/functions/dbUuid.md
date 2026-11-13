[API](../README.md) / dbUuid

# Function: dbUuid()

```ts
function dbUuid(value: string, operator?: string): DBCast;
```

Defined in: [DBValues.ts:519](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBValues.ts#L519)

Create a type-cast UUID value

## Example

```typescript
await User.find([[User.id, dbUuid('123e4567-e89b-12d3-a456-426614174000')]]);
// → WHERE id = ?::uuid
```

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `string` | The UUID string value |
| `operator?` | `string` | The comparison operator (default: '=') **Default** `'='` |

## Returns

`DBCast`

