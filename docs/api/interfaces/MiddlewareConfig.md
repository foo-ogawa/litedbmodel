[API](../README.md) / MiddlewareConfig

# Interface: MiddlewareConfig\<S\>

Defined in: [Middleware.ts:312](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L312)

Configuration object for createMiddleware.
All hook functions receive `this` bound to the state object.

Hook signature matches the Middleware class:
- Method-level hooks: `(model, next, ...args)`
- execute hook: `(next, sql, params)`

## Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `S extends object = Record<string, never>` | Type of the state object (defaults to empty object) |

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="state"></a> `state?` | `S` | Initial state for each request context. A fresh copy is created for each request via structuredClone. Access via `this` in hook functions or `getCurrentContext()`. | [Middleware.ts:318](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L318) |
| <a id="init"></a> `init?` | `(this: S) => void` | Called when a new context is created | [Middleware.ts:321](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L321) |
| <a id="find"></a> `find?` | `<T extends typeof`[`DBModel`](../classes/DBModel.md)`>( this: S,`[`model`](../functions/model.md)`: T, next: NextFind<T>, conditions: Conds, options?:`[`SelectOptions`](../interfaces/SelectOptions.md)`) => Promise<InstanceType<T>[]>` | Intercept find() | [Middleware.ts:324](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L324) |
| <a id="findone"></a> `findOne?` | `<T extends typeof`[`DBModel`](../classes/DBModel.md)`>( this: S,`[`model`](../functions/model.md)`: T, next: NextFindOne<T>, conditions: Conds, options?:`[`SelectOptions`](../interfaces/SelectOptions.md)`) => Promise<InstanceType<T> \| null>` | Intercept findOne() | [Middleware.ts:333](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L333) |
| <a id="findbyid"></a> `findById?` | `<T extends typeof`[`DBModel`](../classes/DBModel.md)`>( this: S,`[`model`](../functions/model.md)`: T, next: NextFindById<T>, id: unknown \|`[`PkeyResult`](../interfaces/PkeyResult.md)`, options?:`[`SelectOptions`](../interfaces/SelectOptions.md)`) => Promise<InstanceType<T>[]>` | Intercept findById() | [Middleware.ts:342](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L342) |
| <a id="count"></a> `count?` | `<T extends typeof`[`DBModel`](../classes/DBModel.md)`>( this: S,`[`model`](../functions/model.md)`: T, next: NextCount, conditions: Conds ) => Promise<number>` | Intercept count() | [Middleware.ts:351](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L351) |
| <a id="create"></a> `create?` | `<T extends typeof`[`DBModel`](../classes/DBModel.md)`>( this: S,`[`model`](../functions/model.md)`: T, next: NextCreate, pairs: readonly (readonly [`[`Column`](../interfaces/Column.md)`<any, any>, any])[], options?:`[`InsertOptions`](../interfaces/InsertOptions.md)`) => Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`\| null>` | Intercept create() | [Middleware.ts:359](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L359) |
| <a id="createmany"></a> `createMany?` | `<T extends typeof`[`DBModel`](../classes/DBModel.md)`>( this: S,`[`model`](../functions/model.md)`: T, next: NextCreateMany, pairsArray: readonly (readonly (readonly [`[`Column`](../interfaces/Column.md)`<any, any>, any])[])[], options?:`[`InsertOptions`](../interfaces/InsertOptions.md)`) => Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`\| null>` | Intercept createMany() | [Middleware.ts:368](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L368) |
| <a id="update"></a> `update?` | `<T extends typeof`[`DBModel`](../classes/DBModel.md)`>( this: S,`[`model`](../functions/model.md)`: T, next: NextUpdate, conditions: Conds, values: readonly (readonly [`[`Column`](../interfaces/Column.md)`<any, any>, any])[], options?:`[`UpdateOptions`](../interfaces/UpdateOptions.md)`) => Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`\| null>` | Intercept update() | [Middleware.ts:377](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L377) |
| <a id="updatemany"></a> `updateMany?` | `<T extends typeof`[`DBModel`](../classes/DBModel.md)`>( this: S,`[`model`](../functions/model.md)`: T, next: NextUpdateMany, records: readonly (readonly (readonly [`[`Column`](../interfaces/Column.md)`<any, any>, any])[])[], options?:`[`UpdateManyOptions`](../interfaces/UpdateManyOptions.md)`) => Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`\| null>` | Intercept updateMany() | [Middleware.ts:387](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L387) |
| <a id="delete"></a> `delete?` | `<T extends typeof`[`DBModel`](../classes/DBModel.md)`>( this: S,`[`model`](../functions/model.md)`: T, next: NextDelete, conditions: Conds, options?:`[`DeleteOptions`](../interfaces/DeleteOptions.md)`) => Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`\| null>` | Intercept delete() | [Middleware.ts:396](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L396) |
| <a id="execute"></a> `execute?` | `( this: S, next: NextExecute,`[`sql`](../functions/sql.md)`: string, params?: unknown[] ) => Promise<ExecuteResult>` | Intercept execute() - lowest level, catches ALL SQL queries | [Middleware.ts:405](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L405) |
| <a id="query"></a> `query?` | `<T extends typeof`[`DBModel`](../classes/DBModel.md)`>( this: S,`[`model`](../functions/model.md)`: T, next: NextQuery<T>,`[`sql`](../functions/sql.md)`: string, params?: unknown[] ) => Promise<InstanceType<T>[]>` | Intercept query() - catches raw SQL that returns model instances | [Middleware.ts:413](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L413) |

