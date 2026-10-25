[**litedbmodel v2.2.11**](../README.md)

***

[litedbmodel](../globals.md) / LimitConfig

# Interface: LimitConfig

Defined in: [types.ts:347](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L347)

Configuration for query result limits.
Used to prevent accidentally loading too many records.

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="findhardlimit"></a> `findHardLimit?` | `number` \| `null` | Hard limit for find() queries. If a query returns more than this many records, an exception is thrown. Set to null to disable. **Default** `null (no limit)` | [types.ts:354](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L354) |
| <a id="hasmanyhardlimit"></a> `hasManyHardLimit?` | `number` \| `null` | Hard limit for hasMany relation loading (batch total). If a hasMany batch load returns more than this many records in total, an exception is thrown. Set to null to disable. **Default** `null (no limit)` | [types.ts:363](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L363) |
