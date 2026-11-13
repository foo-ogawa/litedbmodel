[API](../README.md) / UpdateManyOptions

# Interface: UpdateManyOptions

Defined in: [types.ts:237](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L237)

Options for updateMany operation.

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="keycolumns"></a> `keyColumns` | [`Column`](../interfaces/Column.md)`\|`[`Column`](../interfaces/Column.md)`[]` | Columns that identify each row (used in WHERE/JOIN clause). Must uniquely identify rows (primary key or unique constraint). | [types.ts:242](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L242) |
| <a id="returning"></a> `returning?` | `boolean` | If true, return PkeyResult with affected primary keys. If false (default), return null for better performance. | [types.ts:247](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L247) |

