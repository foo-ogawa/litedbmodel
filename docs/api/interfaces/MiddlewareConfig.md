[**litedbmodel v2.2.6**](../README.md)

***

[litedbmodel](../globals.md) / MiddlewareConfig

# Interface: MiddlewareConfig\<S\>

Defined in: [Middleware.ts:326](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L326)

Configuration object for createMiddleware.
All hook functions receive `this` bound to the state object.

Hook signature matches the Middleware class:
- Method-level hooks: `(model, next, ...args)`
- execute hook: `(next, sql, params)`

## Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `S` *extends* `object` | `Record`\<`string`, `never`\> | Type of the state object (defaults to empty object) |

## Properties

| Property | Type | Description | Defined in |
| ------ | ------ | ------ | ------ |
| <a id="state"></a> `state?` | `S` | Initial state for each request context. A fresh copy is created for each request via structuredClone. Access via `this` in hook functions or `getCurrentContext()`. | [Middleware.ts:332](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L332) |
| <a id="init"></a> `init?` | (`this`: `S`) => `void` | Called when a new context is created | [Middleware.ts:335](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L335) |
| <a id="find"></a> `find?` | \<`T`\>(`this`: `S`, `model`: `T`, `next`: `NextFind`\<`T`\>, `conditions`: `Conds`, `options?`: [`SelectOptions`](SelectOptions.md)) => `Promise`\<`InstanceType`\<`T`\>[]\> | Intercept find() | [Middleware.ts:338](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L338) |
| <a id="findone"></a> `findOne?` | \<`T`\>(`this`: `S`, `model`: `T`, `next`: `NextFindOne`\<`T`\>, `conditions`: `Conds`, `options?`: [`SelectOptions`](SelectOptions.md)) => `Promise`\<`InstanceType`\<`T`\> \| `null`\> | Intercept findOne() | [Middleware.ts:347](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L347) |
| <a id="findbyid"></a> `findById?` | \<`T`\>(`this`: `S`, `model`: `T`, `next`: `NextFindById`\<`T`\>, `id`: `unknown`, `options?`: [`SelectOptions`](SelectOptions.md)) => `Promise`\<`InstanceType`\<`T`\>[]\> | Intercept findById() | [Middleware.ts:356](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L356) |
| <a id="count"></a> `count?` | \<`T`\>(`this`: `S`, `model`: `T`, `next`: `NextCount`, `conditions`: `Conds`) => `Promise`\<`number`\> | Intercept count() | [Middleware.ts:365](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L365) |
| <a id="create"></a> `create?` | \<`T`\>(`this`: `S`, `model`: `T`, `next`: `NextCreate`, `pairs`: readonly readonly \[[`Column`](Column.md)\<`any`, `any`\>, `any`\][], `options?`: [`InsertOptions`](InsertOptions.md)\<`unknown`\>) => `Promise`\<[`PkeyResult`](PkeyResult.md) \| `null`\> | Intercept create() | [Middleware.ts:373](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L373) |
| <a id="createmany"></a> `createMany?` | \<`T`\>(`this`: `S`, `model`: `T`, `next`: `NextCreateMany`, `pairsArray`: readonly readonly readonly \[[`Column`](Column.md)\<`any`, `any`\>, `any`\][][], `options?`: [`InsertOptions`](InsertOptions.md)\<`unknown`\>) => `Promise`\<[`PkeyResult`](PkeyResult.md) \| `null`\> | Intercept createMany() | [Middleware.ts:382](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L382) |
| <a id="update"></a> `update?` | \<`T`\>(`this`: `S`, `model`: `T`, `next`: `NextUpdate`, `conditions`: `Conds`, `values`: readonly readonly \[[`Column`](Column.md)\<`any`, `any`\>, `any`\][], `options?`: [`UpdateOptions`](UpdateOptions.md)) => `Promise`\<[`PkeyResult`](PkeyResult.md) \| `null`\> | Intercept update() | [Middleware.ts:391](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L391) |
| <a id="updatemany"></a> `updateMany?` | \<`T`\>(`this`: `S`, `model`: `T`, `next`: `NextUpdateMany`, `records`: readonly readonly readonly \[[`Column`](Column.md)\<`any`, `any`\>, `any`\][][], `options?`: [`UpdateManyOptions`](UpdateManyOptions.md)) => `Promise`\<[`PkeyResult`](PkeyResult.md) \| `null`\> | Intercept updateMany() | [Middleware.ts:401](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L401) |
| <a id="delete"></a> `delete?` | \<`T`\>(`this`: `S`, `model`: `T`, `next`: `NextDelete`, `conditions`: `Conds`, `options?`: [`DeleteOptions`](DeleteOptions.md)) => `Promise`\<[`PkeyResult`](PkeyResult.md) \| `null`\> | Intercept delete() | [Middleware.ts:410](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L410) |
| <a id="execute"></a> `execute?` | (`this`: `S`, `next`: `NextExecute`, `sql`: `string`, `params?`: `unknown`[]) => `Promise`\<`ExecuteResult`\> | Intercept execute() - lowest level, catches ALL SQL queries | [Middleware.ts:419](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L419) |
| <a id="query"></a> `query?` | \<`T`\>(`this`: `S`, `model`: `T`, `next`: `NextQuery`\<`T`\>, `sql`: `string`, `params?`: `unknown`[]) => `Promise`\<`InstanceType`\<`T`\>[]\> | Intercept query() - catches raw SQL that returns model instances | [Middleware.ts:427](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L427) |
