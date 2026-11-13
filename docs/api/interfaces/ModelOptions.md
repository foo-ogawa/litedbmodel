[API](../README.md) / ModelOptions

# Interface: ModelOptions

Defined in: [types.ts:44](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L44)

Options for the

## Model

decorator.
All options use lazy evaluation (functions) to support forward references.

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="order"></a> `order?` | `() => OrderSpec` | DEFAULT_ORDER: Returns OrderSpec for default ordering | [types.ts:46](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L46) |
| <a id="filter"></a> `filter?` | `() => Conds` | FIND_FILTER: Returns Conds for automatic filtering in find() | [types.ts:49](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L49) |
| <a id="select"></a> `select?` | `string` | SELECT_COLUMN: Column selection string (default: '*') | [types.ts:52](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L52) |
| <a id="updatetable"></a> `updateTable?` | `string` | UPDATE_TABLE_NAME: Table name for INSERT/UPDATE operations | [types.ts:55](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L55) |
| <a id="group"></a> `group?` | `() =>`[`Column`](../interfaces/Column.md)`\|`[`Column`](../interfaces/Column.md)`[] \| string` | DEFAULT_GROUP: Returns Column(s) or string for default grouping | [types.ts:58](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/types.ts#L58) |

