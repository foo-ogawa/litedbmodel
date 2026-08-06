[**litedbmodel v2.2.6**](../README.md)

***

[litedbmodel](../globals.md) / isConnectionError

# Function: isConnectionError()

```ts
function isConnectionError(error: Error): boolean;
```

Defined in: [connection-errors.ts:5](https://github.com/foo-ogawa/litedbmodel/blob/main/src/connection-errors.ts#L5)

Check if an error indicates a broken/stale connection.
Used by both transaction retry (DBModel) and execute-level retry (drivers).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `error` | `Error` |

## Returns

`boolean`
