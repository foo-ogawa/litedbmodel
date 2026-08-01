[**litedbmodel v2.2.5**](../README.md)

***

[litedbmodel](../globals.md) / LimitExceededError

# Class: LimitExceededError

Defined in: [types.ts:369](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L369)

Error thrown when a query exceeds the configured limit.

## Extends

- `Error`

## Constructors

### Constructor

```ts
new LimitExceededError(
   limit: number, 
   actualCount: number, 
   context: "find" | "relation", 
   modelName?: string, 
   relationName?: string): LimitExceededError;
```

Defined in: [types.ts:370](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L370)

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `limit` | `number` | - |
| `actualCount` | `number` | Number of records returned. For find() with findHardLimit, this is limit+1 (actual total may be higher). For relation loading, this is the exact count. |
| `context` | `"find"` \| `"relation"` | - |
| `modelName?` | `string` | - |
| `relationName?` | `string` | - |

#### Returns

`LimitExceededError`

#### Overrides

```ts
Error.constructor
```

## Properties

| Property | Modifier | Type | Description | Defined in |
| ------ | ------ | ------ | ------ | ------ |
| <a id="limit"></a> `limit` | `readonly` | `number` | - | [types.ts:371](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L371) |
| <a id="actualcount"></a> `actualCount` | `readonly` | `number` | Number of records returned. For find() with findHardLimit, this is limit+1 (actual total may be higher). For relation loading, this is the exact count. | [types.ts:376](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L376) |
| <a id="context"></a> `context` | `readonly` | `"find"` \| `"relation"` | - | [types.ts:377](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L377) |
| <a id="modelname"></a> `modelName?` | `readonly` | `string` | - | [types.ts:378](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L378) |
| <a id="relationname"></a> `relationName?` | `readonly` | `string` | - | [types.ts:379](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L379) |
