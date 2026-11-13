[API](../README.md) / dbDynamic

# Function: dbDynamic()

```ts
function dbDynamic(func: string, values?: unknown[]): DBDynamicValue;
```

Defined in: [DBValues.ts:380](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/DBValues.ts#L380)

Create a dynamic value (function call with parameters)

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `func` | `string` |  |
| `values?` | `unknown[]` | **Default** `[]` |

## Returns

`DBDynamicValue`

