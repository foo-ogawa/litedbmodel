[API](../README.md) / UpdateManyOptions

# Interface: UpdateManyOptions

Defined in: [types.ts:217](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L217)

Options for updateMany operation.

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="keycolumns"></a> `keyColumns` | [`Column`](../interfaces/Column.md)`\|`[`Column`](../interfaces/Column.md)`[]` | Columns that identify each row (used in WHERE/JOIN clause). Must uniquely identify rows (primary key or unique constraint). | [types.ts:222](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L222) |
| <a id="returning"></a> `returning?` | `boolean` | If true, return PkeyResult with affected primary keys. If false (default), return null for better performance. | [types.ts:227](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L227) |

