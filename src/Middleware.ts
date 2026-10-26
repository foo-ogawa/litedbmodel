/**
 * litedbmodel - Middleware System
 * 
 * Class-based middleware with per-request instance via AsyncLocalStorage.
 */

import { currentRequestScope, runInRequestScope } from './RequestScope';
import type { DBModel } from './DBModel';
import type { SelectOptions, InsertOptions, UpdateOptions, DeleteOptions, UpdateManyOptions, PkeyResult } from './types';
import type { Column, Conds } from './Column';

// ===========================================
// Execute Result Type
// ===========================================

/** 
 * Result from SQL execution 
 * @internal
 */
export interface ExecuteResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

// ===========================================
// Next Function Types
// ===========================================

/** @internal */
export type NextFind<T extends typeof DBModel> = (
  conditions: Conds,
  options?: SelectOptions
) => Promise<InstanceType<T>[]>;

/** @internal */
export type NextFindOne<T extends typeof DBModel> = (
  conditions: Conds,
  options?: SelectOptions
) => Promise<InstanceType<T> | null>;

/** @internal */
export type NextFindById<T extends typeof DBModel> = (
  id: unknown | PkeyResult,
  options?: SelectOptions
) => Promise<InstanceType<T>[]>;

/** @internal */
export type NextCount = (
  conditions: Conds
) => Promise<number>;

/** @internal */
export type NextCreate = (
  pairs: readonly (readonly [Column<any, any>, any])[],
  options?: InsertOptions
) => Promise<PkeyResult | null>;

/** @internal */
export type NextCreateMany = (
  pairsArray: readonly (readonly (readonly [Column<any, any>, any])[])[],
  options?: InsertOptions
) => Promise<PkeyResult | null>;

/** @internal */
export type NextUpdate = (
  conditions: Conds,
  values: readonly (readonly [Column<any, any>, any])[],
  options?: UpdateOptions
) => Promise<PkeyResult | null>;

/** @internal */
export type NextUpdateMany = (
  records: readonly (readonly (readonly [Column<any, any>, any])[])[],
  options?: UpdateManyOptions
) => Promise<PkeyResult | null>;

/** @internal */
export type NextDelete = (
  conditions: Conds,
  options?: DeleteOptions
) => Promise<PkeyResult | null>;

/** @internal */
export type NextExecute = (
  sql: string,
  params?: unknown[]
) => Promise<ExecuteResult>;

/** @internal */
export type NextQuery<T extends typeof DBModel> = (
  sql: string,
  params?: unknown[]
) => Promise<InstanceType<T>[]>;

// ===========================================
// Middleware Base Class
// ===========================================

/**
 * Base class for middlewares.
 * 
 * Middlewares keep per-request instances in AsyncLocalStorage. A request is the scope opened by
 * {@link Middleware.run} at the request entry; on first access within it, a new instance is created.
 * 
 * Middleware hooks are called in the following flow:
 * - Method-level: `find`, `findOne`, `findById`, `count`, `create`, `createMany`, `update`, `updateMany`, `delete`
 * - Instantiation-level: `query` — returns model instances from raw SQL
 * - SQL-level: `execute` — intercepts ALL SQL queries
 * 
 * @example
 * ```typescript
 * class LoggerMiddleware extends Middleware {
 *   logs: string[] = [];
 *   
 *   async execute(next: NextExecute, sql: string, params?: unknown[]) {
 *     this.logs.push(sql);
 *     return next(sql, params);
 *   }
 *   
 *   getLogs() {
 *     return this.logs;
 *   }
 * }
 * 
 * // Register
 * DBModel.use(LoggerMiddleware);
 *
 * // One request
 * await Middleware.run(async () => {
 *   await handleRequest();
 *   console.log(LoggerMiddleware.getCurrentContext().getLogs());
 * });
 * ```
 * 
 * @category Middleware
 */
export abstract class Middleware {
  /**
   * Get the current request's instance of this middleware. Inside a {@link Middleware.run} scope the
   * instance is created on first access and shared by the rest of the scope; outside any scope each
   * call gets a new instance that lives only for that call.
   */
  static getCurrentContext<T extends Middleware>(this: new () => T): T {
    const scope = currentRequestScope();
    let instance = scope?.middlewares.get(this) as T | undefined;
    if (!instance) {
      instance = new this();
      instance.init?.();
      scope?.middlewares.set(this, instance);
    }
    return instance;
  }

  /**
   * Run `fn` as one request. Call it at the request entry. Everything `fn` does (directly or through
   * DBModel operations, at any `await` depth) shares the request's state and no other request sees
   * it: the middleware instances, and the request's commits that make its later reads go to the
   * writer (writer-sticky). `Middleware.run` opens a new request; `X.run` inside a request gives `X`
   * a fresh instance and keeps the rest of the enclosing request.
   */
  static run<R>(fn: () => R): R {
    const enclosing = currentRequestScope();
    if (this === Middleware || enclosing === undefined) {
      return runInRequestScope({ middlewares: new Map(), commits: new Map() }, fn);
    }
    const middlewares = new Map(enclosing.middlewares);
    middlewares.delete(this);
    return runInRequestScope({ middlewares, commits: enclosing.commits }, fn);
  }

  /**
   * Check if the current request scope holds an instance of this middleware
   */
  static hasContext(): boolean {
    return currentRequestScope()?.middlewares.has(this) ?? false;
  }

  /**
   * Drop this middleware's instance from the current request scope (for testing)
   */
  static clearContext(): void {
    currentRequestScope()?.middlewares.delete(this);
  }

  // ===========================================
  // Hooks (override in subclass)
  // ===========================================
  
  /** Called when instance is created */
  init?(): void;
  
  /** Intercept find() */
  find?<T extends typeof DBModel>(
    this: InstanceType<typeof Middleware>,
    model: T,
    next: NextFind<T>,
    conditions: Conds,
    options?: SelectOptions
  ): Promise<InstanceType<T>[]>;
  
  /** Intercept findOne() */
  findOne?<T extends typeof DBModel>(
    this: InstanceType<typeof Middleware>,
    model: T,
    next: NextFindOne<T>,
    conditions: Conds,
    options?: SelectOptions
  ): Promise<InstanceType<T> | null>;
  
  /** Intercept findById() */
  findById?<T extends typeof DBModel>(
    this: InstanceType<typeof Middleware>,
    model: T,
    next: NextFindById<T>,
    id: unknown | PkeyResult,
    options?: SelectOptions
  ): Promise<InstanceType<T>[]>;
  
  /** Intercept count() */
  count?<T extends typeof DBModel>(
    this: InstanceType<typeof Middleware>,
    model: T,
    next: NextCount,
    conditions: Conds
  ): Promise<number>;
  
  /** Intercept create() */
  create?<T extends typeof DBModel>(
    this: InstanceType<typeof Middleware>,
    model: T,
    next: NextCreate,
    pairs: readonly (readonly [Column<any, any>, any])[],
    options?: InsertOptions
  ): Promise<PkeyResult | null>;
  
  /** Intercept createMany() */
  createMany?<T extends typeof DBModel>(
    this: InstanceType<typeof Middleware>,
    model: T,
    next: NextCreateMany,
    pairsArray: readonly (readonly (readonly [Column<any, any>, any])[])[],
    options?: InsertOptions
  ): Promise<PkeyResult | null>;
  
  /** Intercept update() */
  update?<T extends typeof DBModel>(
    this: InstanceType<typeof Middleware>,
    model: T,
    next: NextUpdate,
    conditions: Conds,
    values: readonly (readonly [Column<any, any>, any])[],
    options?: UpdateOptions
  ): Promise<PkeyResult | null>;
  
  /** Intercept updateMany() */
  updateMany?<T extends typeof DBModel>(
    this: InstanceType<typeof Middleware>,
    model: T,
    next: NextUpdateMany,
    records: readonly (readonly (readonly [Column<any, any>, any])[])[],
    options?: UpdateManyOptions
  ): Promise<PkeyResult | null>;
  
  /** Intercept delete() */
  delete?<T extends typeof DBModel>(
    this: InstanceType<typeof Middleware>,
    model: T,
    next: NextDelete,
    conditions: Conds,
    options?: DeleteOptions
  ): Promise<PkeyResult | null>;
  
  /** Intercept execute() */
  execute?(
    this: InstanceType<typeof Middleware>,
    next: NextExecute,
    sql: string,
    params?: unknown[]
  ): Promise<ExecuteResult>;
  
  /** Intercept query() */
  query?<T extends typeof DBModel>(
    this: InstanceType<typeof Middleware>,
    model: T,
    next: NextQuery<T>,
    sql: string,
    params?: unknown[]
  ): Promise<InstanceType<T>[]>;
}

/**
 * Type for middleware class (not instance) — what {@link DBModel.use} registers.
 *
 * The requirement is exactly what the registry's ONE consumer uses: a registered class is only ever
 * constructed and asked for the current request's instance (`MWClass.getCurrentContext()`), whose hook
 * is then looked up BY NAME and invoked (`DBModel._applyMiddleware` — the lookup is already a cast,
 * because which hooks a middleware implements is its own choice).
 *
 * Naming `typeof Middleware` here instead demanded the whole static side — `_storage` / `getStorage`
 * included — and a `getCurrentContext()` returning a full `Middleware`. The class produced by
 * {@link createMiddleware} advertises neither: its state is its own shape, and a state key may
 * deliberately SHADOW a hook of the same name (`state: { count: 0 }` vs. the `count` hook — at runtime
 * the assigned own property wins over the prototype method). So the DOCUMENTED pairing
 * (`DBModel.use(DBModel.createMiddleware(…))`, README) did not typecheck even though it is the
 * runtime-correct call, and every stateful middleware in the README was affected.
 */
export type MiddlewareClass = { getCurrentContext(): object };

// ===========================================
// createMiddleware Factory Function
// ===========================================

/**
 * Configuration object for createMiddleware.
 * All hook functions receive `this` bound to the state object.
 * 
 * Hook signature matches the Middleware class:
 * - Method-level hooks: `(model, next, ...args)`
 * - execute hook: `(next, sql, params)`
 * 
 * @typeParam S - Type of the state object (defaults to empty object)
 */
export interface MiddlewareConfig<S extends object = Record<string, never>> {
  /** 
   * Initial state for each request context.
   * A fresh copy is created for each request via structuredClone.
   * Access via `this` in hook functions or `getCurrentContext()`.
   */
  state?: S;
  
  /** Called when a new context is created */
  init?: (this: S) => void;
  
  /** Intercept find() */
  find?: <T extends typeof DBModel>(
    this: S,
    model: T,
    next: NextFind<T>,
    conditions: Conds,
    options?: SelectOptions
  ) => Promise<InstanceType<T>[]>;
  
  /** Intercept findOne() */
  findOne?: <T extends typeof DBModel>(
    this: S,
    model: T,
    next: NextFindOne<T>,
    conditions: Conds,
    options?: SelectOptions
  ) => Promise<InstanceType<T> | null>;
  
  /** Intercept findById() */
  findById?: <T extends typeof DBModel>(
    this: S,
    model: T,
    next: NextFindById<T>,
    id: unknown | PkeyResult,
    options?: SelectOptions
  ) => Promise<InstanceType<T>[]>;
  
  /** Intercept count() */
  count?: <T extends typeof DBModel>(
    this: S,
    model: T,
    next: NextCount,
    conditions: Conds
  ) => Promise<number>;
  
  /** Intercept create() */
  create?: <T extends typeof DBModel>(
    this: S,
    model: T,
    next: NextCreate,
    pairs: readonly (readonly [Column<any, any>, any])[],
    options?: InsertOptions
  ) => Promise<PkeyResult | null>;
  
  /** Intercept createMany() */
  createMany?: <T extends typeof DBModel>(
    this: S,
    model: T,
    next: NextCreateMany,
    pairsArray: readonly (readonly (readonly [Column<any, any>, any])[])[],
    options?: InsertOptions
  ) => Promise<PkeyResult | null>;
  
  /** Intercept update() */
  update?: <T extends typeof DBModel>(
    this: S,
    model: T,
    next: NextUpdate,
    conditions: Conds,
    values: readonly (readonly [Column<any, any>, any])[],
    options?: UpdateOptions
  ) => Promise<PkeyResult | null>;
  
  /** Intercept updateMany() */
  updateMany?: <T extends typeof DBModel>(
    this: S,
    model: T,
    next: NextUpdateMany,
    records: readonly (readonly (readonly [Column<any, any>, any])[])[],
    options?: UpdateManyOptions
  ) => Promise<PkeyResult | null>;
  
  /** Intercept delete() */
  delete?: <T extends typeof DBModel>(
    this: S,
    model: T,
    next: NextDelete,
    conditions: Conds,
    options?: DeleteOptions
  ) => Promise<PkeyResult | null>;
  
  /** Intercept execute() - lowest level, catches ALL SQL queries */
  execute?: (
    this: S,
    next: NextExecute,
    sql: string,
    params?: unknown[]
  ) => Promise<ExecuteResult>;
  
  /** Intercept query() - catches raw SQL that returns model instances */
  query?: <T extends typeof DBModel>(
    this: S,
    model: T,
    next: NextQuery<T>,
    sql: string,
    params?: unknown[]
  ) => Promise<InstanceType<T>[]>;
}

/**
 * Type for the middleware class created by createMiddleware.
 * Provides typed access to state via getCurrentContext().
 * 
 * @typeParam S - The state object type
 */
export interface CreatedMiddlewareClass<S extends object> {
  /** Get the current request's state (creates new instance if none exists) */
  getCurrentContext(): S;
  /** Run a function with a fresh middleware context */
  run<R>(fn: () => R): R;
  /** Check if a context exists for the current request */
  hasContext(): boolean;
  /** Clear the current context (useful for testing) */
  clearContext(): void;
  /** Constructor */
  new(): Middleware & S;
};

/**
 * Create a middleware class from a configuration object.
 * 
 * This is a simpler alternative to extending the Middleware class directly.
 * Each request (a {@link Middleware.run} scope) gets its own copy of the state object.
 * 
 * @param config - Middleware configuration with state and hook functions
 * @returns A middleware class that can be passed to DBModel.use()
 * 
 * @example
 * ```typescript
 * // Simple logger (no state)
 * const LoggerMiddleware = createMiddleware({
 *   execute: async function(next, sql, params) {
 *     console.log('SQL:', sql);
 *     return next(sql, params);
 *   }
 * });
 * 
 * // With per-request state
 * const TenantMiddleware = createMiddleware({
 *   state: { tenantId: 0 },
 *   
 *   // Hook signature: (model, next, ...args) for method-level hooks
 *   find: async function(model, next, conditions, options) {
 *     // `this` is typed as { tenantId: number }
 *     if (model.tenant_id) {
 *       conditions = [[model.tenant_id, this.tenantId], ...conditions];
 *     }
 *     return next(conditions, options);
 *   }
 * });
 * 
 * // Register and use
 * DBModel.use(TenantMiddleware);
 * 
 * // Set tenant for the current request (inside Middleware.run at the request entry)
 * TenantMiddleware.getCurrentContext().tenantId = 123;
 * ```
 * 
 * @category Middleware
 */
export function createMiddleware<S extends object = Record<string, never>>(
  config: MiddlewareConfig<S>
): CreatedMiddlewareClass<S> {
  // Create a dynamic class extending Middleware
  class DynamicMiddleware extends Middleware {
    constructor() {
      super();
      // Copy initial state to this instance
      if (config.state) {
        // Use structuredClone for deep copy (handles nested objects/arrays)
        Object.assign(this, structuredClone(config.state));
      }
    }
    
    // Override init if provided
    init(): void {
      if (config.init) {
        config.init.call(this as unknown as S);
      }
    }
  }
  
  // Dynamically add hook methods from config
  const hookNames = [
    'find', 'findOne', 'findById', 'count',
    'create', 'createMany', 'update', 'updateMany', 'delete',
    'execute', 'query'
  ] as const;
  
  for (const hookName of hookNames) {
    const hookFn = config[hookName];
    if (hookFn) {
      // Wrap the hook to bind `this` correctly
       
      (DynamicMiddleware.prototype as any)[hookName] = function(
        this: Middleware,
        ...args: unknown[]
      ) {
         
        return (hookFn as any).apply(this, args);
      };
    }
  }
  
  return DynamicMiddleware as unknown as CreatedMiddlewareClass<S>;
}
