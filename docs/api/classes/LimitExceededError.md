[API](../README.md) / LimitExceededError

# Class: LimitExceededError

Defined in: [types.ts:359](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L359)

Error thrown when a query exceeds the configured limit.

## Extends

- `Error`

## Constructors

### constructor

```ts
new LimitExceededError(limit: number, actualCount: number, context: 'find' | 'relation', modelName?: string, relationName?: string): LimitExceededError;
```

Defined in: [types.ts:360](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L360)

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
| <a id="limit"></a> `limit` (readonly) | `number` |  | [types.ts:361](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L361) |
| <a id="actualcount"></a> `actualCount` (readonly) | `number` |  | [types.ts:366](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L366) |
| <a id="context"></a> `context` (readonly) | `'find' \| 'relation'` |  | [types.ts:367](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L367) |
| <a id="modelname"></a> `modelName?` (readonly) | `string` |  | [types.ts:368](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L368) |
| <a id="relationname"></a> `relationName?` (readonly) | `string` |  | [types.ts:369](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L369) |

