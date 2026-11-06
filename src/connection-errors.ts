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
    code === 'PROTOCOL_CONNECTION_LOST'
  );
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

/** Receive the 'error' of an idle client of a pg Pool (a closed idle connection must not crash the process). */
export function guardIdlePoolErrors(
  pool: { on(event: 'error', listener: (err: Error) => void): unknown },
  logger: { warn(message: string, ...args: unknown[]): void },
): void {
  pool.on('error', (err) => logger.warn('Pool idle client error', err));
}
