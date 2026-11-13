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
 * The default `retryLimit` of `transaction()`; also the number of connections the drivers' re-send after a
 * connection error probes ({@link acquireCheckedConnection}).
 */
export const DEFAULT_RETRY_LIMIT = 3;

/**
 * Acquire the connection a retry after a connection error runs on. After a failover or a database restart the
 * pool may still hold dead connections, so each acquired connection is first sent a harmless `SELECT 1`; one
 * that fails it is destroyed (never returned to the pool) and another is acquired, at most `attempts`
 * connections in all (the retry limit). The last probe's error is thrown when every one failed. The probe
 * only shows that the connection is usable — not whether the statement that failed ran on the server.
 * The drivers' re-send and the transaction retry both acquire through this.
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
 * Is `sql` certainly a read-only statement — may it go to the reader? This decides reader routing for a
 * raw statement (`DBModel.execute`). Anything not certain is a write (writer, never re-sent):
 *   - a `RETURNING`, a row lock (`FOR UPDATE` / `FOR NO KEY UPDATE` / `FOR SHARE` / `FOR KEY SHARE` /
 *     `LOCK IN SHARE MODE`) or an `INTO` anywhere ⇒ write (it writes, locks rows or writes a table / variable);
 *   - starts with `with` or `explain` ⇒ read only if it contains no insert / update / delete / merge
 *     word (`EXPLAIN ANALYZE DELETE …` executes the statement; a data-modifying CTE writes);
 *   - starts with select / show / pragma / values / table ⇒ read;
 *   - anything else (INSERT / UPDATE / DELETE …, DDL, maintenance) ⇒ write.
 * Whether a statement may be re-sent after a connection error is a different question:
 * {@link isResendableStatement}.
 */
export function isReadOnlyStatement(sql: string): boolean {
  if (/\breturning\b/i.test(sql)) return false;
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b|\block\s+in\s+share\s+mode\b|\binto\b/i.test(sql)) return false;
  if (/^\s*(with|explain)\b/i.test(sql)) return !/\b(insert|update|delete|merge)\b/i.test(sql);
  return /^\s*(select|show|pragma|values|table)\b/i.test(sql);
}

/**
 * SQL grammar keywords that take a parenthesis (`IN (…)`, `EXISTS (…)`, `OVER (…)`, `AS (…)`, …): a bare
 * one of these before `(` is not a function call. This is NOT a list of side-effect-free functions —
 * every other name before `(` (`COUNT(*)` included) is a function call.
 */
const PAREN_KEYWORDS = new Set([
  'all', 'and', 'any', 'array', 'as', 'between', 'by', 'case', 'distinct', 'else', 'except', 'exists',
  'explain', 'filter', 'from', 'group', 'having', 'ilike', 'in', 'intersect', 'is', 'join', 'lateral',
  'like', 'limit', 'materialized', 'not', 'offset', 'on', 'or', 'over', 'row', 'select', 'some', 'then',
  'union', 'using', 'values', 'when', 'where', 'within',
]);

/**
 * May `sql` be re-sent after a connection error? Only a read-only statement ({@link isReadOnlyStatement})
 * that calls no function: the server may have run the first send before the connection dropped, and a
 * function (a user function, `nextval`, …) can write. A function call is a name — bare, schema-qualified,
 * `"quoted"` or `` `backticked` `` — followed by `(`, other than a bare {@link PAREN_KEYWORDS} word. When
 * unsure the answer is "not resendable" (a `(` after a name inside a string literal or comment also counts).
 */
export function isResendableStatement(sql: string): boolean {
  if (!isReadOnlyStatement(sql)) return false;
  for (const m of sql.matchAll(/(\.\s*)?("(?:[^"]|"")*"|`(?:[^`]|``)*`|[A-Za-z_][A-Za-z0-9_$]*)\s*\(/g)) {
    if (m[1] !== undefined || /^["`]/.test(m[2]) || !PAREN_KEYWORDS.has(m[2].toLowerCase())) return false;
  }
  return true;
}
