[API](../README.md) / LimitExceededError

# Class: LimitExceededError

Defined in: [types.ts:380](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L380)

Error thrown when a query exceeds the configured limit.

## Extends

- `Error`

## Constructors

### constructor

```ts
new LimitExceededError(limit: number, actualCount: number, context: 'find' | 'relation', modelName?: string, relationName?: string): LimitExceededError;
```

Defined in: [types.ts:381](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L381)

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `limit` | `number` |
| `actualCount` | `number` |
| `context` | `'find' \| 'relation'` |
| `modelName?` | `string` |
| `relationName?` | `string` |

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="limit"></a> `limit` (readonly) | `number` |  | [types.ts:382](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L382) |
| <a id="actualcount"></a> `actualCount` (readonly) | `number` |  | [types.ts:387](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L387) |
| <a id="context"></a> `context` (readonly) | `'find' \| 'relation'` |  | [types.ts:388](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L388) |
| <a id="modelname"></a> `modelName?` (readonly) | `string` |  | [types.ts:389](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L389) |
| <a id="relationname"></a> `relationName?` (readonly) | `string` |  | [types.ts:390](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L390) |

