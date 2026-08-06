[**litedbmodel v2.2.6**](../README.md)

***

[litedbmodel](../globals.md) / SqlCondition

# Interface: SqlCondition\<M\>

Defined in: [SqlFragment.ts:48](https://github.com/foo-ogawa/litedbmodel/blob/main/src/SqlFragment.ts#L48)

A SQL condition with embedded parameter values.
Used for Pattern B (value-embedded) conditions and value-free conditions (IS NULL).

## Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `M` | `unknown` | The model type the Column belongs to |

## Properties

| Property | Modifier | Type | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="_tag"></a> `_tag` | `readonly` | `"SqlCondition"` | [SqlFragment.ts:49](https://github.com/foo-ogawa/litedbmodel/blob/main/src/SqlFragment.ts#L49) |
| <a id="sql"></a> `sql` | `readonly` | `string` | [SqlFragment.ts:50](https://github.com/foo-ogawa/litedbmodel/blob/main/src/SqlFragment.ts#L50) |
| <a id="params"></a> `params` | `readonly` | readonly `unknown`[] | [SqlFragment.ts:51](https://github.com/foo-ogawa/litedbmodel/blob/main/src/SqlFragment.ts#L51) |
| <a id="__modeltype"></a> `__modelType?` | `readonly` | `M` | [SqlFragment.ts:52](https://github.com/foo-ogawa/litedbmodel/blob/main/src/SqlFragment.ts#L52) |
