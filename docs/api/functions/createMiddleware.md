[**litedbmodel v2.2.12**](../README.md)

***

[litedbmodel](../globals.md) / createMiddleware

# Function: createMiddleware()

```ts
function createMiddleware<S>(config: MiddlewareConfig<S>): CreatedMiddlewareClass<S>;
```

Defined in: [Middleware.ts:494](https://github.com/foo-ogawa/litedbmodel/blob/main/src/Middleware.ts#L494)

Create a middleware class from a configuration object.

This is a simpler alternative to extending the Middleware class directly.
Each request (a [Middleware.run](../classes/Middleware.md#run) scope) gets its own copy of the state object.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `S` *extends* `object` | `Record`\<`string`, `never`\> |

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `config` | [`MiddlewareConfig`](../interfaces/MiddlewareConfig.md)\<`S`\> | Middleware configuration with state and hook functions |

## Returns

[`CreatedMiddlewareClass`](../interfaces/CreatedMiddlewareClass.md)\<`S`\>

A middleware class that can be passed to DBModel.use()

## Example

```typescript
// Simple logger (no state)
const LoggerMiddleware = createMiddleware({
  execute: async function(next, sql, params) {
    console.log('SQL:', sql);
    return next(sql, params);
  }
});

// With per-request state
const TenantMiddleware = createMiddleware({
  state: { tenantId: 0 },
  
  // Hook signature: (model, next, ...args) for method-level hooks
  find: async function(model, next, conditions, options) {
    // `this` is typed as { tenantId: number }
    if (model.tenant_id) {
      conditions = [[model.tenant_id, this.tenantId], ...conditions];
    }
    return next(conditions, options);
  }
});

// Register and use
DBModel.use(TenantMiddleware);

// Set tenant for the current request (inside Middleware.run at the request entry)
TenantMiddleware.getCurrentContext().tenantId = 123;
```
