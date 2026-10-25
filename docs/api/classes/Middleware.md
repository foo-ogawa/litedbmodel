[**litedbmodel v2.2.11**](../README.md)

***

[litedbmodel](../globals.md) / Middleware

# Abstract Class: Middleware

Defined in: [Middleware.ts:140](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L140)

Base class for middlewares.

Middlewares keep per-request instances in AsyncLocalStorage. A request is the scope opened by
[Middleware.run](#run) at the request entry; on first access within it, a new instance is created.

Middleware hooks are called in the following flow:
- Method-level: `find`, `findOne`, `findById`, `count`, `create`, `createMany`, `update`, `updateMany`, `delete`
- Instantiation-level: `query` — returns model instances from raw SQL
- SQL-level: `execute` — intercepts ALL SQL queries

## Example

```typescript
class LoggerMiddleware extends Middleware {
  logs: string[] = [];
  
  async execute(next: NextExecute, sql: string, params?: unknown[]) {
    this.logs.push(sql);
    return next(sql, params);
  }
  
  getLogs() {
    return this.logs;
  }
}

// Register
DBModel.use(LoggerMiddleware);

// One request
await Middleware.run(async () => {
  await handleRequest();
  console.log(LoggerMiddleware.getCurrentContext().getLogs());
});
```

## Constructors

### Constructor

```ts
new Middleware(): Middleware;
```

#### Returns

`Middleware`

## Methods

### getCurrentContext()

```ts
static getCurrentContext<T>(this: () => T): T;
```

Defined in: [Middleware.ts:146](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L146)

Get the current request's instance of this middleware. Inside a [Middleware.run](#run) scope the
instance is created on first access and shared by the rest of the scope; outside any scope each
call gets a new instance that lives only for that call.

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* `Middleware` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | () => `T` |

#### Returns

`T`

***

### run()

```ts
static run<R>(fn: () => R): R;
```

Defined in: [Middleware.ts:163](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L163)

Run `fn` as one request: the middleware instances `fn` uses (directly or through DBModel
operations) are created inside the scope and are not shared with any other request. Call it at
the request entry. `Middleware.run` gives every middleware a fresh instance; `X.run` gives `X` a
fresh instance and keeps the enclosing scope's instances of the others.

#### Type Parameters

| Type Parameter |
| ------ |
| `R` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fn` | () => `R` |

#### Returns

`R`

***

### hasContext()

```ts
static hasContext(): boolean;
```

Defined in: [Middleware.ts:173](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L173)

Check if the current request scope holds an instance of this middleware

#### Returns

`boolean`

***

### clearContext()

```ts
static clearContext(): void;
```

Defined in: [Middleware.ts:180](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L180)

Drop this middleware's instance from the current request scope (for testing)

#### Returns

`void`

***

### init()?

```ts
optional init(): void;
```

Defined in: [Middleware.ts:189](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L189)

Called when instance is created

#### Returns

`void`

***

### find()?

```ts
optional find<T>(
   this: Middleware, 
   model: T, 
   next: NextFind<T>, 
   conditions: Conds, 
options?: SelectOptions): Promise<InstanceType<T>[]>;
```

Defined in: [Middleware.ts:192](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L192)

Intercept find()

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* *typeof* [`DBModel`](DBModel.md) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `Middleware` |
| `model` | `T` |
| `next` | `NextFind`\<`T`\> |
| `conditions` | `Conds` |
| `options?` | [`SelectOptions`](../interfaces/SelectOptions.md) |

#### Returns

`Promise`\<`InstanceType`\<`T`\>[]\>

***

### findOne()?

```ts
optional findOne<T>(
   this: Middleware, 
   model: T, 
   next: NextFindOne<T>, 
   conditions: Conds, 
options?: SelectOptions): Promise<InstanceType<T> | null>;
```

Defined in: [Middleware.ts:201](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L201)

Intercept findOne()

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* *typeof* [`DBModel`](DBModel.md) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `Middleware` |
| `model` | `T` |
| `next` | `NextFindOne`\<`T`\> |
| `conditions` | `Conds` |
| `options?` | [`SelectOptions`](../interfaces/SelectOptions.md) |

#### Returns

`Promise`\<`InstanceType`\<`T`\> \| `null`\>

***

### findById()?

```ts
optional findById<T>(
   this: Middleware, 
   model: T, 
   next: NextFindById<T>, 
   id: unknown, 
options?: SelectOptions): Promise<InstanceType<T>[]>;
```

Defined in: [Middleware.ts:210](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L210)

Intercept findById()

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* *typeof* [`DBModel`](DBModel.md) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `Middleware` |
| `model` | `T` |
| `next` | `NextFindById`\<`T`\> |
| `id` | `unknown` |
| `options?` | [`SelectOptions`](../interfaces/SelectOptions.md) |

#### Returns

`Promise`\<`InstanceType`\<`T`\>[]\>

***

### count()?

```ts
optional count<T>(
   this: Middleware, 
   model: T, 
   next: NextCount, 
conditions: Conds): Promise<number>;
```

Defined in: [Middleware.ts:219](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L219)

Intercept count()

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* *typeof* [`DBModel`](DBModel.md) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `Middleware` |
| `model` | `T` |
| `next` | `NextCount` |
| `conditions` | `Conds` |

#### Returns

`Promise`\<`number`\>

***

### create()?

```ts
optional create<T>(
   this: Middleware, 
   model: T, 
   next: NextCreate, 
   pairs: readonly readonly [Column<any, any>, any][], 
options?: InsertOptions<unknown>): Promise<PkeyResult | null>;
```

Defined in: [Middleware.ts:227](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L227)

Intercept create()

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* *typeof* [`DBModel`](DBModel.md) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `Middleware` |
| `model` | `T` |
| `next` | `NextCreate` |
| `pairs` | readonly readonly \[[`Column`](../interfaces/Column.md)\<`any`, `any`\>, `any`\][] |
| `options?` | [`InsertOptions`](../interfaces/InsertOptions.md)\<`unknown`\> |

#### Returns

`Promise`\<[`PkeyResult`](../interfaces/PkeyResult.md) \| `null`\>

***

### createMany()?

```ts
optional createMany<T>(
   this: Middleware, 
   model: T, 
   next: NextCreateMany, 
   pairsArray: readonly readonly readonly [Column<any, any>, any][][], 
options?: InsertOptions<unknown>): Promise<PkeyResult | null>;
```

Defined in: [Middleware.ts:236](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L236)

Intercept createMany()

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* *typeof* [`DBModel`](DBModel.md) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `Middleware` |
| `model` | `T` |
| `next` | `NextCreateMany` |
| `pairsArray` | readonly readonly readonly \[[`Column`](../interfaces/Column.md)\<`any`, `any`\>, `any`\][][] |
| `options?` | [`InsertOptions`](../interfaces/InsertOptions.md)\<`unknown`\> |

#### Returns

`Promise`\<[`PkeyResult`](../interfaces/PkeyResult.md) \| `null`\>

***

### update()?

```ts
optional update<T>(
   this: Middleware, 
   model: T, 
   next: NextUpdate, 
   conditions: Conds, 
   values: readonly readonly [Column<any, any>, any][], 
options?: UpdateOptions): Promise<PkeyResult | null>;
```

Defined in: [Middleware.ts:245](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L245)

Intercept update()

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* *typeof* [`DBModel`](DBModel.md) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `Middleware` |
| `model` | `T` |
| `next` | `NextUpdate` |
| `conditions` | `Conds` |
| `values` | readonly readonly \[[`Column`](../interfaces/Column.md)\<`any`, `any`\>, `any`\][] |
| `options?` | [`UpdateOptions`](../interfaces/UpdateOptions.md) |

#### Returns

`Promise`\<[`PkeyResult`](../interfaces/PkeyResult.md) \| `null`\>

***

### updateMany()?

```ts
optional updateMany<T>(
   this: Middleware, 
   model: T, 
   next: NextUpdateMany, 
   records: readonly readonly readonly [Column<any, any>, any][][], 
options?: UpdateManyOptions): Promise<PkeyResult | null>;
```

Defined in: [Middleware.ts:255](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L255)

Intercept updateMany()

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* *typeof* [`DBModel`](DBModel.md) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `Middleware` |
| `model` | `T` |
| `next` | `NextUpdateMany` |
| `records` | readonly readonly readonly \[[`Column`](../interfaces/Column.md)\<`any`, `any`\>, `any`\][][] |
| `options?` | [`UpdateManyOptions`](../interfaces/UpdateManyOptions.md) |

#### Returns

`Promise`\<[`PkeyResult`](../interfaces/PkeyResult.md) \| `null`\>

***

### delete()?

```ts
optional delete<T>(
   this: Middleware, 
   model: T, 
   next: NextDelete, 
   conditions: Conds, 
options?: DeleteOptions): Promise<PkeyResult | null>;
```

Defined in: [Middleware.ts:264](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L264)

Intercept delete()

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* *typeof* [`DBModel`](DBModel.md) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `Middleware` |
| `model` | `T` |
| `next` | `NextDelete` |
| `conditions` | `Conds` |
| `options?` | [`DeleteOptions`](../interfaces/DeleteOptions.md) |

#### Returns

`Promise`\<[`PkeyResult`](../interfaces/PkeyResult.md) \| `null`\>

***

### execute()?

```ts
optional execute(
   this: Middleware, 
   next: NextExecute, 
   sql: string, 
params?: unknown[]): Promise<ExecuteResult>;
```

Defined in: [Middleware.ts:273](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L273)

Intercept execute()

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `Middleware` |
| `next` | `NextExecute` |
| `sql` | `string` |
| `params?` | `unknown`[] |

#### Returns

`Promise`\<`ExecuteResult`\>

***

### query()?

```ts
optional query<T>(
   this: Middleware, 
   model: T, 
   next: NextQuery<T>, 
   sql: string, 
params?: unknown[]): Promise<InstanceType<T>[]>;
```

Defined in: [Middleware.ts:281](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L281)

Intercept query()

#### Type Parameters

| Type Parameter |
| ------ |
| `T` *extends* *typeof* [`DBModel`](DBModel.md) |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `Middleware` |
| `model` | `T` |
| `next` | `NextQuery`\<`T`\> |
| `sql` | `string` |
| `params?` | `unknown`[] |

#### Returns

`Promise`\<`InstanceType`\<`T`\>[]\>
