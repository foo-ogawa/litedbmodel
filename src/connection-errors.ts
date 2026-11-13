import { TransactionClosedError } from './types';

/**
 * Check if an error indicates a broken/stale connection.
 * Used by both transaction retry (DBModel) and execute-level retry (drivers).
 */
export function isConnectionError(error: Error): boolean {
  const message = error.message || '';
  const code = (error as NodeJS.ErrnoException).code || '';

  return (
    message.includes('Connection terminated unexpectedly') ||
    message.includes('Connection terminated') ||
    message.includes('Client has encountered a connection error') ||
    message.includes('read ECONNRESET') ||
    message.includes('connect ECONNREFUSED') ||
    message.includes('Connection lost') ||
    message.includes('This socket has been ended by the other party') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'EAI_AGAIN' ||
    code === 'PROTOCOL_CONNECTION_LOST' ||
    // PG SQLSTATE 57P01 admin_shutdown: the server ended this connection (`pg_terminate_backend`, a
    // shutdown, a failover) and answers the statement in flight with it before closing.
    code === '57P01'
  );
}

/**
 * Acquire the connection a retry after a connection error runs on. After a failover or a database restart the
 * pool may still hold dead connections, so each acquired connection is first sent a harmless `SELECT 1`; one
 * that fails it is destroyed (never returned to the pool) and another is acquired, at most `attempts`
 * connections in all (the retry limit). The last probe's error is thrown when every one failed. The probe
 * only shows that the connection is usable — not whether the statement that failed ran on the server.
 * The v1 drivers' re-send and transaction retry, and the SCP transaction retry, all acquire through this.
 */
export async function acquireCheckedConnection<C>(
  acquire: () => Promise<C>,
  query: (conn: C, sql: string) => Promise<unknown>,
  destroy: (conn: C) => void | Promise<void>,
  attempts: number,
): Promise<C> {
  for (let attempt = 1; ; attempt++) {
    const conn = await acquire();
    try {
      await query(conn, 'SELECT 1');
      return conn;
    } catch (error) {
      await destroy(conn);
      if (attempt >= attempts) throw error;
    }
  }
}

/**
 * Is `error` a connection error that a transaction must throw instead of re-running its body? True at the
 * COMMIT stage (the server may have committed before the response was lost: re-running could write twice)
 * and on a connection the caller gave (`TransactionOptions.connection`: a new connection cannot be taken).
 * v1 `DBModel.transaction` and scp `withTransactionAsync` both decide with this.
 */
export function isUnretriedConnectionError(
  error: unknown,
  where: { committing: boolean; givenConnection: boolean },
  isConn: (e: Error) => boolean = isConnectionError,
): boolean {
  return (where.committing || where.givenConnection) && error instanceof Error && isConn(error);
}

/**
 * A nested transaction that is given a connection (`TransactionOptions.connection`) must be given the
 * enclosing transaction's own connection (it then joins it); any other connection is an error, never
 * silently ignored. `opened` is the connection the enclosing transaction was opened on. v1
 * `DBModel.transaction` and scp `withTransactionAsync` both decide with this.
 */
export function assertNestedConnection<C>(given: C | undefined, opened: C | undefined): void {
  if (given !== undefined && given !== opened) {
    throw new Error('transaction(): the connection option is a different connection from the enclosing transaction\'s');
  }
}

/** The pg `Client` surface {@link guardLeasedClient} needs (an EventEmitter). */
export interface LeasedClientLike {
  on(event: 'error', listener: (err: Error) => void): unknown;
  removeListener(event: 'error', listener: (err: Error) => void): unknown;
}

/**
 * Receive the 'error' of a pg Client while it is leased. pg-pool detaches its idle listener on checkout,
 * so a disconnection of a leased client would otherwise be an unhandled 'error' that crashes the process.
 * The error is logged; the returned function, called on release, detaches the listener and returns the
 * value for `client.release()` (`destroy`, else the error seen while leased, so that connection is dropped).
 */
export function guardLeasedClient(
  client: LeasedClientLike,
  logger: { warn(message: string, ...args: unknown[]): void },
): (destroy?: Error | boolean) => Error | boolean | undefined {
  let leaseError: Error | undefined;
  const onError = (err: Error): void => {
    leaseError ??= err;
    logger.warn('Leased client error', err);
  };
  client.on('error', onError);
  return (destroy) => {
    client.removeListener('error', onError);
    return destroy || leaseError;
  };
}

/**
 * The gate through which a transaction body reaches its connection (v1 `DBModel.transaction` and scp
 * `withTransactionAsync` both use it). BEGIN/COMMIT/ROLLBACK do not go through it.
 *
 * - {@link TransactionGuard.run} counts a query while it is unfinished. After the body settled it does not
 *   start the query: it logs the failure (`logger.error`) and returns a promise rejected with
 *   {@link TransactionClosedError} that already has a no-op catch, so a caller that forgot to `await` it
 *   does not raise `unhandledRejection` (which would stop the process); an awaiting caller still receives it.
 * - {@link TransactionGuard.settle} runs the body. When the body settles, the gate closes and the
 *   unfinished queries are waited for (so a ROLLBACK sent afterwards follows them); if the body succeeded
 *   but one was unfinished, it throws {@link TransactionClosedError} so the transaction rolls back. If the
 *   body failed and one was unfinished, it throws the same error with the body's error as its `cause`
 *   (not retried, whatever the body's error was); with none unfinished the body's error is thrown as is.
 */
export interface TransactionGuard {
  run<T>(query: () => Promise<T>): Promise<T>;
  settle<R>(body: () => Promise<R>): Promise<R>;
}

export function createTransactionGuard(logger: { error(message: string, ...args: unknown[]): void }): TransactionGuard {
  let closed = false;
  const unfinished = new Set<Promise<unknown>>();
  const track = async <T>(started: Promise<T>): Promise<T> => {
    unfinished.add(started);
    try {
      return await started;
    } finally {
      unfinished.delete(started);
    }
  };
  return {
    run<T>(query: () => Promise<T>): Promise<T> {
      if (closed) {
        const error = new TransactionClosedError();
        logger.error(error.message);
        const rejected = Promise.reject<T>(error);
        rejected.catch(() => undefined);
        return rejected;
      }
      return track(query());
    },
    async settle<R>(body: () => Promise<R>): Promise<R> {
      let outcome: { value: R } | { error: unknown };
      try {
        outcome = { value: await body() };
      } catch (error) {
        outcome = { error };
      }
      closed = true;
      const pending = [...unfinished];
      await Promise.allSettled(pending);
      if (pending.length > 0) {
        throw new TransactionClosedError(true, 'error' in outcome ? { cause: outcome.error } : undefined);
      }
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    },
  };
}

/** Receive the 'error' of an idle client of a pg Pool (a closed idle connection must not crash the process). */
export function guardIdlePoolErrors(
  pool: { on(event: 'error', listener: (err: Error) => void): unknown },
  logger: { warn(message: string, ...args: unknown[]): void },
): void {
  pool.on('error', (err) => logger.warn('Pool idle client error', err));
}
