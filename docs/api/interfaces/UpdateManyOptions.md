[**litedbmodel v2.2.5**](../README.md)

***

[litedbmodel](../globals.md) / UpdateManyOptions

# Interface: UpdateManyOptions

Defined in: [types.ts:234](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L234)

Options for updateMany operation.

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="keycolumns"></a> `keyColumns` | \| [`Column`](Column.md)\<`unknown`, `unknown`\> \| [`Column`](Column.md)\<`unknown`, `unknown`\>[] | Columns that identify each row (used in WHERE/JOIN clause). Must uniquely identify rows (primary key or unique constraint). | [types.ts:239](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L239) |
| <a id="returning"></a> `returning?` | `boolean` | If true, return PkeyResult with affected primary keys. If false (default), return null for better performance. | [types.ts:244](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L244) |
