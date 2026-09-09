[**litedbmodel v2.2.7**](../README.md)

***

[litedbmodel](../globals.md) / dbDynamic

# Function: dbDynamic()

```ts
function dbDynamic(func: string, values?: unknown[]): DBDynamicValue;
```

Defined in: [DBValues.ts:380](https://github.com/foo-ogawa/litedbmodel/blob/main/src/DBValues.ts#L380)

Create a dynamic value (function call with parameters)

## Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `func` | `string` | `undefined` |
| `values` | `unknown`[] | `[]` |

## Returns

`DBDynamicValue`
