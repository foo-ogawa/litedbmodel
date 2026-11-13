/**
 * Fake driver pools for the drivers' unit tests (no DB). Every statement — sent through the pool
 * (`pool.query`) or through an acquired connection (the re-send after a connection error, a transaction) —
 * goes to the ONE `query` mock, so a test reads the whole statement stream from it. `destroyed` counts the
 * connections released as destroyed (a connection that failed the probe, or the re-sent statement).
 */

import { EventEmitter } from 'node:events';
import { vi, type Mock } from 'vitest';

type QueryMock = Mock<(...args: never[]) => unknown>;

/** A pg `Pool` stand-in: `query(config | text, values)` and `connect()` → a client on the same mock. */
export function fakePgPool(query: QueryMock): { query: QueryMock; connect: () => Promise<unknown>; destroyed: () => number } {
  let destroyed = 0;
  return {
    query,
    connect: async () => Object.assign(new EventEmitter(), {
      query,
      release: (destroy?: unknown) => { if (destroy) destroyed++; },
    }),
    destroyed: () => destroyed,
  };
}

/** A mysql2 `Pool` stand-in: `query(sql, values)` and `getConnection()` → a connection on the same mock. */
export function fakeMysqlPool(query: QueryMock): { query: QueryMock; getConnection: () => Promise<unknown>; destroyed: () => number } {
  let destroyed = 0;
  return {
    query,
    getConnection: async () => ({
      query,
      release: vi.fn(),
      destroy: () => { destroyed++; },
    }),
    destroyed: () => destroyed,
  };
}

/** The SQL text of each call of a pg / mysql2 `query` mock (pg passes `{ text }` for a prepared statement). */
export function sentSql(query: QueryMock): string[] {
  return query.mock.calls.map((c) => {
    const first = (c as unknown[])[0];
    return typeof first === 'string' ? first : (first as { text: string }).text;
  });
}
