[**litedbmodel v3.0.0**](../README.md)

***

[litedbmodel](../globals.md) / ModelOptions

# Interface: ModelOptions

Defined in: [types.ts:43](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L43)

Options for the

## Model

decorator.
All options use lazy evaluation (functions) to support forward references.

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="order"></a> `order?` | () => `OrderSpec` | DEFAULT_ORDER: Returns OrderSpec for default ordering | [types.ts:45](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L45) |
| <a id="filter"></a> `filter?` | () => `Conds` | FIND_FILTER: Returns Conds for automatic filtering in find() | [types.ts:48](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L48) |
| <a id="select"></a> `select?` | `string` | SELECT_COLUMN: Column selection string (default: '*') | [types.ts:51](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L51) |
| <a id="updatetable"></a> `updateTable?` | `string` | UPDATE_TABLE_NAME: Table name for INSERT/UPDATE operations | [types.ts:54](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L54) |
| <a id="group"></a> `group?` | () => \| `string` \| [`Column`](Column.md)\<`unknown`, `unknown`\> \| [`Column`](Column.md)\<`unknown`, `unknown`\>[] | DEFAULT_GROUP: Returns Column(s) or string for default grouping | [types.ts:57](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L57) |
| <a id="connection"></a> `connection?` | `string` | CONNECTION: the NAME of the database this model lives in (multi-DB). Absent ⇒ the default connection. This is the SAME authority v1 gives the model — a v1 model picks its database by extending a `DBModel.createDBBase(config)` base class, whose handler owns the connection, and a relation is batch-loaded on the TARGET model's (`LazyRelation.ts:236` `TargetClass.getDriverType()`). Naming it makes that authority READABLE at emit time, which is what the codegen path needs: the emitter bakes the name onto every statement of every endpoint declared over this model, and onto the child fetch of every relation whose TARGET is this model, so a per-language runtime routes the statement to the pooled driver registered under it (`ConnectionRegistry`). Unregistered ⇒ LOUD, never a silent run against the wrong database. | [types.ts:70](https://github.com/foo-ogawa/litedbmodel/blob/main/src/types.ts#L70) |
