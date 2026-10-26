/**
 * litedbmodel - Request scope
 *
 * One request's state: its middleware instances and its commits (writer-sticky). The scope is
 * opened by `Middleware.run` at the request entry; everything the request does — at any `await`
 * depth — shares it, and other requests have their own. Outside a scope there is no request state.
 */
import { AsyncLocalStorage } from 'async_hooks';

/** The state of one request. */
export interface RequestScope {
  /** Middleware instances, by middleware class. */
  readonly middlewares: Map<Function, object>;
  /** Time of the request's last commit, by writer-sticky clock. */
  readonly commits: Map<object, number>;
}

const scopes = new AsyncLocalStorage<RequestScope>();

/** The current request's scope, or `undefined` outside any request scope. */
export function currentRequestScope(): RequestScope | undefined {
  return scopes.getStore();
}

/** Run `fn` with `scope` as the current request scope. */
export function runInRequestScope<R>(scope: RequestScope, fn: () => R): R {
  return scopes.run(scope, fn);
}
