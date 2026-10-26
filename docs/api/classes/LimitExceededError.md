[**litedbmodel v2.2.12**](../README.md)

***

[litedbmodel](../globals.md) / LimitExceededError

# Class: LimitExceededError

Defined in: [types.ts:371](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L371)

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

Defined in: [types.ts:372](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L372)

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
| <a id="limit"></a> `limit` | `readonly` | `number` | - | [types.ts:373](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L373) |
| <a id="actualcount"></a> `actualCount` | `readonly` | `number` | Number of records returned. For find() with findHardLimit, this is limit+1 (actual total may be higher). For relation loading, this is the exact count. | [types.ts:378](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L378) |
| <a id="context"></a> `context` | `readonly` | `"find"` \| `"relation"` | - | [types.ts:379](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L379) |
| <a id="modelname"></a> `modelName?` | `readonly` | `string` | - | [types.ts:380](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L380) |
| <a id="relationname"></a> `relationName?` | `readonly` | `string` | - | [types.ts:381](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L381) |
