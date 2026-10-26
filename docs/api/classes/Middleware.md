[**litedbmodel v2.2.12**](../README.md)

***

[litedbmodel](../globals.md) / Middleware

# Abstract Class: Middleware

Defined in: [Middleware.ts:137](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L137)

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

Defined in: [Middleware.ts:143](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L143)

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

Defined in: [Middleware.ts:161](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L161)

Run `fn` as one request. Call it at the request entry. Everything `fn` does (directly or through
DBModel operations, at any `await` depth) shares the request's state and no other request sees
it: the middleware instances, and the request's commits that make its later reads go to the
writer (writer-sticky). `Middleware.run` opens a new request; `X.run` inside a request gives `X`
a fresh instance and keeps the rest of the enclosing request.

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

Defined in: [Middleware.ts:174](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L174)

Check if the current request scope holds an instance of this middleware

#### Returns

`boolean`

***

### clearContext()

```ts
static clearContext(): void;
```

Defined in: [Middleware.ts:181](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L181)

Drop this middleware's instance from the current request scope (for testing)

#### Returns

`void`

***

### init()?

```ts
optional init(): void;
```

Defined in: [Middleware.ts:190](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L190)

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

Defined in: [Middleware.ts:193](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L193)

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

Defined in: [Middleware.ts:202](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L202)

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

Defined in: [Middleware.ts:211](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L211)

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

Defined in: [Middleware.ts:220](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L220)

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

Defined in: [Middleware.ts:228](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L228)

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

Defined in: [Middleware.ts:237](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L237)

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

Defined in: [Middleware.ts:246](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L246)

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

Defined in: [Middleware.ts:256](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L256)

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

Defined in: [Middleware.ts:265](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L265)

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

Defined in: [Middleware.ts:274](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L274)

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

Defined in: [Middleware.ts:282](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L282)

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
