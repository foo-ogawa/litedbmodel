[API](../README.md) / CreatedMiddlewareClass

# Interface: CreatedMiddlewareClass\<S\>

Defined in: [Middleware.ts:428](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L428)

Type for the middleware class created by createMiddleware.
Provides typed access to state via getCurrentContext().

## Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `S extends object` | The state object type |

## Constructors

### constructor

```ts
new CreatedMiddlewareClass(): CreatedMiddlewareClass;
```

Defined in: [Middleware.ts:438](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L438)

Constructor

## Methods

### getCurrentContext()

```ts
getCurrentContext(): S;
```

Defined in: [Middleware.ts:430](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L430)

Get the current request's state (creates new instance if none exists)

#### Returns

`S`

***

### run()

```ts
run<R>(fn: () => R): R;
```

Defined in: [Middleware.ts:432](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L432)

Run a function with a fresh middleware context

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
hasContext(): boolean;
```

Defined in: [Middleware.ts:434](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L434)

Check if a context exists for the current request

#### Returns

`boolean`

***

### clearContext()

```ts
clearContext(): void;
```

Defined in: [Middleware.ts:436](https://github.com/foo-ogawa/litedbmodel/blob/v1.x/src/Middleware.ts#L436)

Clear the current context (useful for testing)

#### Returns

`void`

