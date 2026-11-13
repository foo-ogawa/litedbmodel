[API](../README.md) / ModelOptions

# Interface: ModelOptions

Defined in: [types.ts:44](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L44)

Options for the

## Model

decorator.
All options use lazy evaluation (functions) to support forward references.

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="order"></a> `order?` | `() => OrderSpec` | DEFAULT_ORDER: Returns OrderSpec for default ordering | [types.ts:46](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L46) |
| <a id="filter"></a> `filter?` | `() => Conds` | FIND_FILTER: Returns Conds for automatic filtering in find() | [types.ts:49](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L49) |
| <a id="select"></a> `select?` | `string` | SELECT_COLUMN: Column selection string (default: '*') | [types.ts:52](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L52) |
| <a id="updatetable"></a> `updateTable?` | `string` | UPDATE_TABLE_NAME: Table name for INSERT/UPDATE operations | [types.ts:55](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L55) |
| <a id="group"></a> `group?` | `() =>`[`Column`](../interfaces/Column.md)`\|`[`Column`](../interfaces/Column.md)`[] \| string` | DEFAULT_GROUP: Returns Column(s) or string for default grouping | [types.ts:58](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L58) |
| <a id="connection"></a> `connection?` | `string` | CONNECTION: the NAME of the database this model lives in (multi-DB). Absent ⇒ the default connection. This is the SAME authority v1 gives the model — a v1 model picks its database by extending a `DBModel.createDBBase(config)` base class, whose handler owns the connection, and a relation is batch-loaded on the TARGET model's (`LazyRelation.ts:236` `TargetClass.getDriverType()`). Naming it makes that authority READABLE at emit time, which is what the codegen path needs: the emitter bakes the name onto every statement of every endpoint declared over this model, and onto the child fetch of every relation whose TARGET is this model, so a per-language runtime routes the statement to the pooled driver registered under it (`ConnectionRegistry`). Unregistered ⇒ LOUD, never a silent run against the wrong database. | [types.ts:71](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L71) |

