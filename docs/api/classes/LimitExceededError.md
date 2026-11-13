[API](../README.md) / LimitExceededError

# Class: LimitExceededError

Defined in: [types.ts:394](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L394)

Error thrown when a query exceeds the configured limit.

## Extends

- `Error`

## Constructors

### constructor

```ts
new LimitExceededError(limit: number, actualCount: number, context: 'find' | 'relation', modelName?: string, relationName?: string): LimitExceededError;
```

Defined in: [types.ts:395](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L395)

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
| <a id="limit"></a> `limit` (readonly) | `number` |  | [types.ts:396](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L396) |
| <a id="actualcount"></a> `actualCount` (readonly) | `number` |  | [types.ts:401](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L401) |
| <a id="context"></a> `context` (readonly) | `'find' \| 'relation'` |  | [types.ts:402](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L402) |
| <a id="modelname"></a> `modelName?` (readonly) | `string` |  | [types.ts:403](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L403) |
| <a id="relationname"></a> `relationName?` (readonly) | `string` |  | [types.ts:404](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L404) |

