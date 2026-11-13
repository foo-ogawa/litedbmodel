[API](../README.md) / LimitConfig

# Interface: LimitConfig

Defined in: [types.ts:370](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L370)

Configuration for query result limits.
Used to prevent accidentally loading too many records.

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="findhardlimit"></a> `findHardLimit?` | `number \| null` | Hard limit for find() queries. If a query returns more than this many records, an exception is thrown. Set to null to disable.<br><br>**Default** `null (no limit)` | [types.ts:377](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L377) |
| <a id="hasmanyhardlimit"></a> `hasManyHardLimit?` | `number \| null` | Hard limit for hasMany relation loading (batch total). If a hasMany batch load returns more than this many records in total, an exception is thrown. Set to null to disable.<br><br>**Default** `null (no limit)` | [types.ts:386](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L386) |

