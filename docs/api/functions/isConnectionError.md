[**litedbmodel v2.2.3**](../README.md)

***

[litedbmodel](../globals.md) / isConnectionError

# Function: isConnectionError()

```ts
function isConnectionError(error: Error): boolean;
```

Defined in: connection-errors.ts:5

Check if an error indicates a broken/stale connection.
Used by both transaction retry (DBModel) and execute-level retry (drivers).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `error` | `Error` |

## Returns

`boolean`
