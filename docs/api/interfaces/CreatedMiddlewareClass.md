[**litedbmodel v2.2.12**](../README.md)

***

[litedbmodel](../globals.md) / CreatedMiddlewareClass

# Interface: CreatedMiddlewareClass\<S\>

Defined in: [Middleware.ts:439](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L439)

Type for the middleware class created by createMiddleware.
Provides typed access to state via getCurrentContext().

## Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `S` *extends* `object` | The state object type |

## Constructors

### Constructor

```ts
new CreatedMiddlewareClass(): Middleware & S;
```

Defined in: [Middleware.ts:449](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L449)

Constructor

#### Returns

[`Middleware`](../classes/Middleware.md) & `S`

## Methods

### getCurrentContext()

```ts
getCurrentContext(): S;
```

Defined in: [Middleware.ts:441](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L441)

Get the current request's state (creates new instance if none exists)

#### Returns

`S`

***

### run()

```ts
run<R>(fn: () => R): R;
```

Defined in: [Middleware.ts:443](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L443)

Run a function with a fresh middleware context

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
hasContext(): boolean;
```

Defined in: [Middleware.ts:445](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L445)

Check if a context exists for the current request

#### Returns

`boolean`

***

### clearContext()

```ts
clearContext(): void;
```

Defined in: [Middleware.ts:447](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L447)

Clear the current context (useful for testing)

#### Returns

`void`
