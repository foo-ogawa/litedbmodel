[API](../README.md) / LimitConfig

# Interface: LimitConfig

Defined in: [types.ts:335](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L335)

Configuration for query result limits.
Used to prevent accidentally loading too many records.

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="findhardlimit"></a> `findHardLimit?` | `number \| null` | Hard limit for find() queries. If a query returns more than this many records, an exception is thrown. Set to null to disable.<br><br>**Default** `null (no limit)` | [types.ts:342](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L342) |
| <a id="hasmanyhardlimit"></a> `hasManyHardLimit?` | `number \| null` | Hard limit for hasMany relation loading (batch total). If a hasMany batch load returns more than this many records in total, an exception is thrown. Set to null to disable.<br><br>**Default** `null (no limit)` | [types.ts:351](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L351) |

