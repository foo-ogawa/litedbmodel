[API](../README.md) / Middleware

# Abstract Class: Middleware

Defined in: [Middleware.ts:138](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L138)

Base class for middlewares.

Middlewares keep per-request instances in AsyncLocalStorage. A request is the scope opened by
[`Middleware.run`](../classes/Middleware.md#run) at the request entry; on first access within it, a new instance is created.

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

## Methods

### getCurrentContext()

```ts
static getCurrentContext<T extends Middleware>(this: new () => T): T;
```

Defined in: [Middleware.ts:144](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L144)

Get the current request's instance of this middleware. Inside a [`Middleware.run`](../classes/Middleware.md#run) scope the
instance is created on first access and shared by the rest of the scope; outside any scope each
call gets a new instance that lives only for that call.

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends Middleware` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `new () => T` |

#### Returns

`T`

***

### run()

```ts
static run<R>(fn: () => R): R;
```

Defined in: [Middleware.ts:164](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L164)

Run `fn` as one request. Call it at the request entry. Everything `fn` does (directly or through
DBModel operations, at any `await` depth) shares the request's state and no other request sees
it: the middleware instances, and the request's commits that make its later reads go to the
writer (writer-sticky), and the SQL middleware registry scope (`withMiddlewareScope`), so
the state of a middleware built with `createMiddleware` (a `Logger`'s entries) is the request's own
and is released with it. `Middleware.run` opens a new request; `X.run` inside a request gives `X`
a fresh instance and keeps the rest of the enclosing request.

#### Type Parameters

| Type Parameter |
| ------ |
| `R` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `fn` | `() => R` |

#### Returns

`R`

***

### hasContext()

```ts
static hasContext(): boolean;
```

Defined in: [Middleware.ts:177](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L177)

Check if the current request scope holds an instance of this middleware

#### Returns

`boolean`

***

### clearContext()

```ts
static clearContext(): void;
```

Defined in: [Middleware.ts:184](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L184)

Drop this middleware's instance from the current request scope (for testing)

#### Returns

`void`

***

### init()

```ts
init(): void;
```

Defined in: [Middleware.ts:193](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L193)

Called when instance is created

#### Returns

`void`

***

### find()

```ts
find<T extends typeof DBModel>(this: InstanceType<typeof Middleware>, model: T, next: NextFind<T>, conditions: Conds, options?: SelectOptions): Promise<InstanceType<T>[]>;
```

Defined in: [Middleware.ts:196](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L196)

Intercept find()

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `InstanceType<typeof Middleware>` |
| `model` | `T` |
| `next` | `NextFind<T>` |
| `conditions` | `Conds` |
| `options?` | [`SelectOptions`](../interfaces/SelectOptions.md) |

#### Returns

`Promise<InstanceType<T>[]>`

***

### findOne()

```ts
findOne<T extends typeof DBModel>(this: InstanceType<typeof Middleware>, model: T, next: NextFindOne<T>, conditions: Conds, options?: SelectOptions): Promise<InstanceType<T> | null>;
```

Defined in: [Middleware.ts:205](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L205)

Intercept findOne()

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `InstanceType<typeof Middleware>` |
| `model` | `T` |
| `next` | `NextFindOne<T>` |
| `conditions` | `Conds` |
| `options?` | [`SelectOptions`](../interfaces/SelectOptions.md) |

#### Returns

`Promise<InstanceType<T> | null>`

***

### findById()

```ts
findById<T extends typeof DBModel>(this: InstanceType<typeof Middleware>, model: T, next: NextFindById<T>, id: unknown | PkeyResult, options?: SelectOptions): Promise<InstanceType<T>[]>;
```

Defined in: [Middleware.ts:214](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L214)

Intercept findById()

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `InstanceType<typeof Middleware>` |
| `model` | `T` |
| `next` | `NextFindById<T>` |
| `id` | `unknown \|`[`PkeyResult`](../interfaces/PkeyResult.md) |
| `options?` | [`SelectOptions`](../interfaces/SelectOptions.md) |

#### Returns

`Promise<InstanceType<T>[]>`

***

### count()

```ts
count<T extends typeof DBModel>(this: InstanceType<typeof Middleware>, model: T, next: NextCount, conditions: Conds): Promise<number>;
```

Defined in: [Middleware.ts:223](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L223)

Intercept count()

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `InstanceType<typeof Middleware>` |
| `model` | `T` |
| `next` | `NextCount` |
| `conditions` | `Conds` |

#### Returns

`Promise<number>`

***

### create()

```ts
create<T extends typeof DBModel>(this: InstanceType<typeof Middleware>, model: T, next: NextCreate, pairs: readonly (readonly [Column<any, any>, any])[], options?: InsertOptions): Promise<PkeyResult | null>;
```

Defined in: [Middleware.ts:231](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L231)

Intercept create()

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `InstanceType<typeof Middleware>` |
| `model` | `T` |
| `next` | `NextCreate` |
| `pairs` | `readonly (readonly [`[`Column`](../interfaces/Column.md)`<any, any>, any])[]` |
| `options?` | [`InsertOptions`](../interfaces/InsertOptions.md) |

#### Returns

`Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`| null>`

***

### createMany()

```ts
createMany<T extends typeof DBModel>(this: InstanceType<typeof Middleware>, model: T, next: NextCreateMany, pairsArray: readonly (readonly (readonly [Column<any, any>, any])[])[], options?: InsertOptions): Promise<PkeyResult | null>;
```

Defined in: [Middleware.ts:240](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L240)

Intercept createMany()

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `InstanceType<typeof Middleware>` |
| `model` | `T` |
| `next` | `NextCreateMany` |
| `pairsArray` | `readonly (readonly (readonly [`[`Column`](../interfaces/Column.md)`<any, any>, any])[])[]` |
| `options?` | [`InsertOptions`](../interfaces/InsertOptions.md) |

#### Returns

`Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`| null>`

***

### update()

```ts
update<T extends typeof DBModel>(this: InstanceType<typeof Middleware>, model: T, next: NextUpdate, conditions: Conds, values: readonly (readonly [Column<any, any>, any])[], options?: UpdateOptions): Promise<PkeyResult | null>;
```

Defined in: [Middleware.ts:249](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L249)

Intercept update()

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `InstanceType<typeof Middleware>` |
| `model` | `T` |
| `next` | `NextUpdate` |
| `conditions` | `Conds` |
| `values` | `readonly (readonly [`[`Column`](../interfaces/Column.md)`<any, any>, any])[]` |
| `options?` | [`UpdateOptions`](../interfaces/UpdateOptions.md) |

#### Returns

`Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`| null>`

***

### updateMany()

```ts
updateMany<T extends typeof DBModel>(this: InstanceType<typeof Middleware>, model: T, next: NextUpdateMany, records: readonly (readonly (readonly [Column<any, any>, any])[])[], options?: UpdateManyOptions): Promise<PkeyResult | null>;
```

Defined in: [Middleware.ts:259](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L259)

Intercept updateMany()

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `InstanceType<typeof Middleware>` |
| `model` | `T` |
| `next` | `NextUpdateMany` |
| `records` | `readonly (readonly (readonly [`[`Column`](../interfaces/Column.md)`<any, any>, any])[])[]` |
| `options?` | [`UpdateManyOptions`](../interfaces/UpdateManyOptions.md) |

#### Returns

`Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`| null>`

***

### delete()

```ts
delete<T extends typeof DBModel>(this: InstanceType<typeof Middleware>, model: T, next: NextDelete, conditions: Conds, options?: DeleteOptions): Promise<PkeyResult | null>;
```

Defined in: [Middleware.ts:268](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L268)

Intercept delete()

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `InstanceType<typeof Middleware>` |
| `model` | `T` |
| `next` | `NextDelete` |
| `conditions` | `Conds` |
| `options?` | [`DeleteOptions`](../interfaces/DeleteOptions.md) |

#### Returns

`Promise<`[`PkeyResult`](../interfaces/PkeyResult.md)`| null>`

***

### execute()

```ts
execute(this: InstanceType<typeof Middleware>, next: NextExecute, sql: string, params?: unknown[]): Promise<ExecuteResult>;
```

Defined in: [Middleware.ts:277](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L277)

Intercept execute()

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `InstanceType<typeof Middleware>` |
| `next` | `NextExecute` |
| `sql` | `string` |
| `params?` | `unknown[]` |

#### Returns

`Promise<ExecuteResult>`

***

### query()

```ts
query<T extends typeof DBModel>(this: InstanceType<typeof Middleware>, model: T, next: NextQuery<T>, sql: string, params?: unknown[]): Promise<InstanceType<T>[]>;
```

Defined in: [Middleware.ts:285](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L285)

Intercept query()

#### Type Parameters

| Type Parameter |
| ------ |
| `T extends typeof DBModel` |

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `this` | `InstanceType<typeof Middleware>` |
| `model` | `T` |
| `next` | `NextQuery<T>` |
| `sql` | `string` |
| `params?` | `unknown[]` |

#### Returns

`Promise<InstanceType<T>[]>`

