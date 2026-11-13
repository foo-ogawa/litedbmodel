[API](../README.md) / isConnectionError

# Function: isConnectionError()

```ts
function isConnectionError(error: Error): boolean;
```

Defined in: [connection-errors.ts:7](https://github.com/foo-ogawa/litedbmodel/blob/main/src/connection-errors.ts#L7)

Check if an error indicates a broken/stale connection.
Used by both transaction retry (DBModel) and execute-level retry (drivers).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `error` | `Error` |

## Returns

`boolean`

