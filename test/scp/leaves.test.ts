/**
 * Unit coverage for the op-independent runtime leaves (`src/scp/leaves.ts`, #141): the
 * `executeSQL`/`pluck`/`group` transport+util leaves that replace the retired per-op catalog.
 *
 * Exercises the REAL plain leaf functions directly against a fake {@link SyncConnection} (the
 * central seam's driver contact) — no native driver, so it runs in any env (better-sqlite3 is
 * arch-gated here). It pins the load-bearing transport behavior:
 *   - a relation reads N+1-free (parents → pluck → children WHERE fk = ANY($1) → group) = 2 queries;
 *   - the key array binds as ONE param: MySQL/SQLite JSON-encoded, PostgreSQL a raw array;
 *   - the deferred PG cast resolves from the real keys (`::int[]`, v1 byte-parity) + `?`→`$N` render;
 *   - a write routes through the `run` seam and returns the `[{changes,lastInsertRowid}]` summary.
 */

import { test, expect } from 'vitest';
import { executeSQL, pluck, group, leafHandlers, type LeafContext } from '../../src/scp/leaves';
import { LimitExceededError } from '../../src/scp/errors';
import type { Value } from 'behavior-contracts/runtime';
import { contextForConnection, type SyncConnection, type Rows, type RunInfo } from '../../src/scp/exec-context';

interface Call { kind: 'execute' | 'executeSafe' | 'run'; sql: string; params: unknown[] }

function recordingConn(calls: Call[]): SyncConnection {
  const rows = (sql: string): Rows => {
    if (sql.includes('FROM posts')) return [{ id: 1, author_id: 10 }, { id: 2, author_id: 10 }, { id: 3, author_id: 20 }];
    if (sql.includes('FROM users')) return [{ id: 10, name: 'A' }, { id: 20, name: 'B' }];
    return [];
  };
  return {
    execute(sql, params) { calls.push({ kind: 'execute', sql, params: [...params] }); return rows(sql); },
    executeSafeIntegers(sql, params) { calls.push({ kind: 'executeSafe', sql, params: [...params] }); return rows(sql); },
    run(sql, params) { calls.push({ kind: 'run', sql, params: [...params] }); return { changes: 1, lastInsertRowid: 42 } as RunInfo; },
  };
}

test('relation read is N+1-free (2 queries) with JSON key param on sqlite + belongsTo grouping', () => {
  const calls: Call[] = [];
  const ctx: LeafContext = { exec: contextForConnection(recordingConn(calls)), dialect: 'sqlite' };
  const posts = executeSQL({ sql: 'SELECT id, author_id FROM posts', params: [], write: false, returning: false }, ctx);
  const ids = pluck({ rows: posts, col: ['author_id'] });
  const authors = executeSQL(
    { sql: 'SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))', params: [ids], write: false, returning: false },
    ctx,
  );
  const out = group({ parents: posts, children: authors, pk: ['author_id'], fk: ['id'], into: 'author', single: true });
  // exactly two SELECTs — the child fetch is one batched `IN (json_each(?))`, never one-per-parent.
  // A read is always exact-integer (`executeSafeIntegers`), so an INTEGER column reads back in bc's `int`
  // model on every dialect; the count is of reads, not of which driver entry point served them.
  expect(calls.filter((c) => c.kind === 'executeSafe').length).toBe(2);
  // the deduped key set binds as ONE JSON string param
  expect(calls[1].params).toEqual(['[10,20]']);
  expect(out.length).toBe(3);
  expect(out[0].author).toMatchObject({ name: 'A' });
  expect(out[2].author).toMatchObject({ name: 'B' });
});

test('postgres: key array binds raw, deferred cast resolves to ::int[], placeholders render $N', () => {
  const calls: Call[] = [];
  const ctx: LeafContext = { exec: contextForConnection(recordingConn(calls)), dialect: 'postgres' };
  const posts = executeSQL({ sql: 'SELECT id, author_id FROM posts', params: [], write: false, returning: false }, ctx);
  const ids = pluck({ rows: posts, col: ['author_id'] });
  executeSQL(
    { sql: 'SELECT id, name FROM users WHERE id = ANY(?::@@PG_ARRAY_CAST@@)', params: [ids], write: false, returning: false },
    ctx,
  );
  expect(calls[1].sql).toContain('$1');
  expect(calls[1].sql).toContain('::int[]');
  expect(Array.isArray(calls[1].params[0])).toBe(true);
});

test('write routes through the run seam and returns the affected summary', () => {
  const calls: Call[] = [];
  const ctx: LeafContext = { exec: contextForConnection(recordingConn(calls)), dialect: 'sqlite' };
  const out = executeSQL({ sql: 'INSERT INTO users(id,name) VALUES (?,?)', params: [30, 'C'], write: true, returning: false }, ctx);
  expect(calls[0].kind).toBe('run');
  expect(out[0].changes).toBe(1n); // the summary is bc `int` on BOTH fields (the declared contract)
  expect(out[0].lastInsertRowid).toBe(42n);
});

// ── #151 the DYNAMIC (SKIP) WHERE — assembled by the transport at EXECUTION time ────────────────
//
// The fragment vocabulary is SQL text + params + a SKIP FLAG: every fragment is the SAME homogeneous
// struct `{ skipped, sql, params }`, and a skipped one is PRESENT with `skipped: true` (bc carries the
// per-call SKIP decision as DATA, never a `cond`-to-null variant element). The leaf drops the skipped
// fragments, joins the survivors, splices the clause at the WHERE position, and only THEN renders
// `?`→`$N` on the final SQL: the statement's shape is not known until the call, so it cannot be
// rendered at generate time. `whereDynamic` is OPTIONAL — a bounded statement OMITS it (no plan).

test('a SKIP plan assembles only the surviving fragments, at the WHERE position, before the tail', () => {
  const calls: Call[] = [];
  const ctx: LeafContext = { exec: contextForConnection(recordingConn(calls)), dialect: 'sqlite' };
  const base = { sql: 'SELECT id, author_id FROM posts ORDER BY id ASC LIMIT 20', params: [], write: false, returning: false };

  // The middle fragment is SKIPPED (`skipped: true`) — present with plausible sql/params, but dropped
  // by the leaf, so the surviving assembly is exactly `author_id = ? AND id >= ?`.
  executeSQL({ ...base, whereDynamic: { frags: [{ skipped: false, sql: 'author_id = ?', params: [10] }, { skipped: true, sql: 'status = ?', params: ['draft'] }, { skipped: false, sql: 'id >= ?', params: [2] }] } }, ctx);
  expect(calls[0].sql).toBe('SELECT id, author_id FROM posts WHERE author_id = ? AND id >= ? ORDER BY id ASC LIMIT 20');
  expect(calls[0].params).toEqual([10, 2]);

  // Every fragment skipped ⇒ no WHERE at all (the base statement is untouched).
  executeSQL({ ...base, whereDynamic: { frags: [{ skipped: true, sql: 'status = ?', params: ['draft'] }, { skipped: true, sql: 'author_id = ?', params: [99] }] } }, ctx);
  expect(calls[1].sql).toBe('SELECT id, author_id FROM posts ORDER BY id ASC LIMIT 20');
  expect(calls[1].params).toEqual([]);

  // No plan at all ⇒ the bounded statement passes through unchanged.
  executeSQL(base, ctx);
  expect(calls[2].sql).toBe('SELECT id, author_id FROM posts ORDER BY id ASC LIMIT 20');
});

test('#192 — the survivors CONTINUE the statement\'s BOUNDED WHERE, binding between it and the page tail', () => {
  const calls: Call[] = [];
  const ctx: LeafContext = { exec: contextForConnection(recordingConn(calls)), dialect: 'sqlite' };
  // A MIXED read as the emitter now lowers it (CLAUDE.md §2): the bounded predicate IS the statement's
  // WHERE (static SQL + a main param), the page count binds after it, and ONLY the optional predicates
  // ride the plan.
  const base = {
    sql: 'SELECT id, author_id FROM posts WHERE author_id = ? ORDER BY id ASC LIMIT ?',
    params: [10, 20],
    write: false,
    returning: false,
  };

  executeSQL({ ...base, whereDynamic: { frags: [{ skipped: false, sql: 'status = ?', params: ['live'] }, { skipped: false, sql: 'id >= ?', params: [2] }] } }, ctx);
  // ONE WHERE — the survivors continue the bounded one with ` AND `, at the position it ends…
  expect(calls[0].sql).toBe('SELECT id, author_id FROM posts WHERE author_id = ? AND status = ? AND id >= ? ORDER BY id ASC LIMIT ?');
  // …and their params bind at the slot their own `?`s occupy: after the bounded value, before the count.
  expect(calls[0].params).toEqual([10, 'live', 2, 20]);

  // A skipped fragment is dropped from BOTH the text and the binding.
  executeSQL({ ...base, whereDynamic: { frags: [{ skipped: true, sql: 'status = ?', params: [null] }, { skipped: false, sql: 'id >= ?', params: [2] }] } }, ctx);
  expect(calls[1].sql).toBe('SELECT id, author_id FROM posts WHERE author_id = ? AND id >= ? ORDER BY id ASC LIMIT ?');
  expect(calls[1].params).toEqual([10, 2, 20]);

  // EVERY fragment skipped ⇒ the emitted statement runs exactly as it was compiled (bounded WHERE and all).
  executeSQL({ ...base, whereDynamic: { frags: [{ skipped: true, sql: 'status = ?', params: [null] }, { skipped: true, sql: 'id >= ?', params: [null] }] } }, ctx);
  expect(calls[2].sql).toBe(base.sql);
  expect(calls[2].params).toEqual([10, 20]);
});

test('`?`→`$N` is rendered AFTER the SKIP assembly, so the numbering follows the FINAL statement', () => {
  const calls: Call[] = [];
  const ctx: LeafContext = { exec: contextForConnection(recordingConn(calls)), dialect: 'postgres' };
  const base = { sql: 'SELECT id, author_id FROM posts ORDER BY id ASC', params: [], write: false, returning: false };

  executeSQL({ ...base, whereDynamic: { frags: [{ skipped: false, sql: 'author_id = ?', params: [10] }, { skipped: false, sql: 'id >= ?', params: [2] }] } }, ctx);
  expect(calls[0].sql).toBe('SELECT id, author_id FROM posts WHERE author_id = $1 AND id >= $2 ORDER BY id ASC');

  // The SAME plan with the first fragment skipped renumbers — proof the render cannot happen earlier.
  executeSQL({ ...base, whereDynamic: { frags: [{ skipped: true, sql: 'author_id = ?', params: [10] }, { skipped: false, sql: 'id >= ?', params: [2] }] } }, ctx);
  expect(calls[1].sql).toBe('SELECT id, author_id FROM posts WHERE id >= $1 ORDER BY id ASC');
  expect(calls[1].params).toEqual([2]);
});

test('the relation guard trips on the RAW child rows, and an uncapped statement is never checked', () => {
  const calls: Call[] = [];
  const ctx: LeafContext = { exec: contextForConnection(recordingConn(calls)), dialect: 'sqlite' };
  const base = { sql: 'SELECT id, author_id FROM posts', params: [], write: false, returning: false };

  // 3 child rows > cap 2 ⇒ the transport throws with the relation-context fields and the EXACT batch
  // total (the batch is fetched in full — v1 `_selectForRelation` parity, no `LIMIT cap + 1` here).
  // The cap rides as the OPTIONAL single `guard` port — the resolved relation cap.
  expect(() => executeSQL({ ...base, guard: { limit: 2, model: 'posts', relation: 'posts' } }, ctx)).toThrow(LimitExceededError);
  try {
    executeSQL({ ...base, guard: { limit: 2, model: 'posts', relation: 'posts' } }, ctx);
  } catch (e) {
    const err = e as LimitExceededError;
    expect([err.limit, err.count, err.context, err.model, err.relation]).toEqual([2, 3, 'relation', 'posts', 'posts']);
  }

  // Within the cap, and with no guard at all, the rows come back untouched.
  expect(executeSQL({ ...base, guard: { limit: 3, model: 'posts', relation: 'posts' } }, ctx)).toHaveLength(3);
  expect(executeSQL(base, ctx)).toHaveLength(3);
});

test('the leaf handler unboxes the guard port fail-closed (bc int is a BigInt; a malformed cap is loud)', () => {
  const calls: Call[] = [];
  const handler = leafHandlers({ exec: contextForConnection(recordingConn(calls)), dialect: 'sqlite' }).executeSQL;
  // The generated module hands the control facts as the ONE `opts` record (#193), never as loose ports.
  const ports = (guard: unknown): Record<string, Value> =>
    ({ sql: 'SELECT id, author_id FROM posts', params: [], opts: { write: false, returning: false, whereDynamic: null, guard } }) as unknown as Record<string, Value>;

  // The cap arrives in bc's `int` value model — a BigInt on the TS plane — and must still compare and
  // REPORT as the `number` the error contract declares.
  try {
    handler(ports({ limit: 2n, model: 'posts', relation: 'posts' }), { nodeId: 'n0', component: 'executeSQL' });
    throw new Error('the guard must trip');
  } catch (e) {
    const err = e as LimitExceededError;
    expect(err).toBeInstanceOf(LimitExceededError);
    expect(typeof err.limit).toBe('number');
    expect(err.limit).toBe(2);
  }

  // A guard that cannot be unboxed is LOUD — a dropped cap is a runaway that would sail through.
  expect(() => handler(ports({ model: 'posts' }), { nodeId: 'n0', component: 'executeSQL' })).toThrow(/guard.*port/i);

  // …and so is a control RECORD that cannot be unboxed: every fact the transport branches on lives in
  // it, so a record read as "absent" would silently downgrade a write to a read and drop the cap.
  const badOpts = { sql: 'SELECT id FROM posts', params: [], opts: 'nope' } as unknown as Record<string, Value>;
  expect(() => handler(badOpts, { nodeId: 'n0', component: 'executeSQL' })).toThrow(/'opts' port must be/);

  // An ABSENT record is the plain READ a bounded statement declares by omission — not an error.
  const plain = { sql: 'SELECT id, author_id FROM posts', params: [] } as unknown as Record<string, Value>;
  expect(handler(plain, { nodeId: 'n0', component: 'executeSQL' })).toEqual({ ok: expect.any(Array) });
});
