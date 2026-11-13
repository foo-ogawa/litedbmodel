[API](../README.md) / dbCast

# Function: dbCast()

```ts
function dbCast(value: unknown, sqlType: string, operator?: string): DBCast;
```

Defined in: [DBValues.ts:503](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBValues.ts#L503)

Create a type-cast value

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `value` | `unknown` | The value to cast |
| `sqlType` | `string` | The SQL type to cast to (e.g., 'uuid', 'jsonb') |
| `operator?` | `string` | The comparison operator (default: '=') **Default** `'='` |

## Returns

`DBCast`

