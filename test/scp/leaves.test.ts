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
import { executeSQL, pluck, group, leafHandlers, leafHandlersAsync, type LeafContext } from '../../src/scp/leaves';
import { LimitExceededError } from '../../src/scp/errors';
import type { Value } from 'behavior-contracts/runtime';
import {
  contextForConnection,
  PooledAsyncContext,
  withTransactionAsync,
  type SyncConnection,
  type AsyncConnection,
  type AsyncConnectionPool,
  type Rows,
  type RunInfo,
} from '../../src/scp/exec-context';
import { ConnectionRegistry, WriterStickyClock } from '../../src/scp/connection-routing';
import { createMiddleware, use, withMiddlewareScope } from '../../src/scp/middleware';

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
  const posts = executeSQL({ sql: 'SELECT id, author_id FROM posts', params: [], write: null }, ctx);
  const ids = pluck({ rows: posts, col: ['author_id'] });
  const authors = executeSQL(
    { sql: 'SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))', params: [ids], write: null },
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
  const posts = executeSQL({ sql: 'SELECT id, author_id FROM posts', params: [], write: null }, ctx);
  const ids = pluck({ rows: posts, col: ['author_id'] });
  executeSQL(
    { sql: 'SELECT id, name FROM users WHERE id = ANY(?::@@PG_ARRAY_CAST@@)', params: [ids], write: null },
    ctx,
  );
  expect(calls[1].sql).toContain('$1');
  expect(calls[1].sql).toContain('::int[]');
  expect(Array.isArray(calls[1].params[0])).toBe(true);
});

test('write routes through the run seam and returns the affected summary', () => {
  const calls: Call[] = [];
  const ctx: LeafContext = { exec: contextForConnection(recordingConn(calls)), dialect: 'sqlite' };
  const out = executeSQL({ sql: 'INSERT INTO users(id,name) VALUES (?,?)', params: [30, 'C'], write: { returning: false } }, ctx);
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
  const base = { sql: 'SELECT id, author_id FROM posts ORDER BY id ASC LIMIT 20', params: [], write: null };

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
    write: null,
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
  const base = { sql: 'SELECT id, author_id FROM posts ORDER BY id ASC', params: [], write: null };

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
  const base = { sql: 'SELECT id, author_id FROM posts', params: [], write: null };

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
    ({ sql: 'SELECT id, author_id FROM posts', params: [], opts: { db: null, write: null, whereDynamic: null, guard } }) as unknown as Record<string, Value>;

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

  // A guard that cannot be unboxed is LOUD — a dropped cap is a runaway that would sail through, and
  // the failure NAMES the field that is missing (#205).
  expect(() => handler(ports({ model: 'posts' }), { nodeId: 'n0', component: 'executeSQL' })).toThrow(
    /'guard' cap is missing its 'limit' field/,
  );

  // …and so is a control RECORD that cannot be unboxed: every fact the transport branches on lives in
  // it, so a record read as "absent" would silently downgrade a write to a read and drop the cap.
  const badOpts = { sql: 'SELECT id FROM posts', params: [], opts: 'nope' } as unknown as Record<string, Value>;
  expect(() => handler(badOpts, { nodeId: 'n0', component: 'executeSQL' })).toThrow(/'opts' must be record\|null/);

  // An ABSENT record is the plain READ a bounded statement declares by omission — not an error.
  const plain = { sql: 'SELECT id, author_id FROM posts', params: [] } as unknown as Record<string, Value>;
  expect(handler(plain, { nodeId: 'n0', component: 'executeSQL' })).toEqual({ ok: expect.any(Array) });
});

// #205 — a field that is ABSENT from a PRESENT struct, or present with the WRONG TYPE, is an ABI BREAK,
// never an absent VALUE. bc types a port by the literal wired into it and REJECTS a partial struct, so a
// generated module always spells every field of every struct it wires, with the type the port declares
// (`null` is how absence is spelled). Neither shape therefore came from one, and defaulting or coercing
// it silently downgrades a write to a read, drops a relation cap, or erases a SKIP predicate. The five
// languages must agree; this is the TS leg.
test('a MISSING or MISTYPED field of a present struct is loud in every position (#205, #209)', () => {
  const calls: Call[] = [];
  const handler = leafHandlers({ exec: contextForConnection(recordingConn(calls)), dialect: 'sqlite' }).executeSQL;
  const ctx = { nodeId: 'n0', component: 'executeSQL' };
  const run = (ports: unknown): void => void handler(ports as Record<string, Value>, ctx);
  const SQL = 'SELECT id, author_id FROM posts';
  const cap = { limit: 2n, model: 'posts', relation: 'posts' };

  // The two REQUIRED top-level ports.
  expect(() => run({ params: [], opts: null })).toThrow(/payload is missing its 'sql' field/);
  expect(() => run({ sql: SQL, opts: null })).toThrow(/payload is missing its 'params' field/);

  // Each field of a PRESENT control record — dropping one used to read as its default.
  expect(() => run({ sql: SQL, params: [], opts: { write: null, whereDynamic: null, guard: null } })).toThrow(
    /control record is missing its 'db' field/,
  );
  expect(() => run({ sql: SQL, params: [], opts: { db: null, whereDynamic: null, guard: null } })).toThrow(
    /control record is missing its 'write' field/,
  );
  expect(() => run({ sql: SQL, params: [], opts: { db: null, write: null, guard: null } })).toThrow(
    /control record is missing its 'whereDynamic' field/,
  );
  expect(() => run({ sql: SQL, params: [], opts: { db: null, write: null, whereDynamic: null } })).toThrow(
    /control record is missing its 'guard' field/,
  );

  // …the fields NESTED in the two concrete control structs…
  expect(() => run({ sql: SQL, params: [], opts: { db: null, write: {}, whereDynamic: null, guard: null } })).toThrow(
    /'write' mode is missing its 'returning' field/,
  );
  expect(() => run({ sql: SQL, params: [], opts: { db: null, write: null, whereDynamic: null, guard: { limit: 2n, relation: 'posts' } } })).toThrow(
    /'guard' cap is missing its 'model' field/,
  );

  // …and the PLAN and its FRAGMENTS, one level further down (#209). A fragment is a PRESENT struct
  // like every other: without `skipped` the statement applies a predicate the call SKIPPED, without
  // `sql` the predicate is erased entirely, and without `params` a value binds where none belongs —
  // all three used to run SILENTLY and return DIFFERENT ROWS.
  const plan = (frag: unknown): unknown => ({ sql: SQL, params: [], opts: { db: null, write: null, whereDynamic: { frags: [frag] }, guard: null } });
  expect(() => run({ sql: SQL, params: [], opts: { db: null, write: null, whereDynamic: {}, guard: null } })).toThrow(
    /'whereDynamic' plan is missing its 'frags' field/,
  );
  expect(() => run(plan({ sql: 'v = ?', params: ['zzz'] }))).toThrow(/fragment is missing its 'skipped' field/);
  expect(() => run(plan({ skipped: false, params: ['zzz'] }))).toThrow(/fragment is missing its 'sql' field/);
  expect(() => run(plan({ skipped: false, sql: 'v = ?' }))).toThrow(/fragment is missing its 'params' field/);
  // A SKIPPED fragment is unboxed too — it is spelled in full like any other, so a hole in one is the
  // same ABI break (and `skipped` alone would otherwise let the other two fields go unread).
  expect(() => run(plan({ skipped: true, params: ['zzz'] }))).toThrow(/fragment is missing its 'sql' field/);

  // A field of the WRONG TYPE is the same ABI break, in every one of those positions: bc emits the
  // literal the port's type says, so nothing else can arrive from a generated module, and coercing it
  // is how a `returning` that is not a bool ran an INSERT on the READ seam and a `skipped` that is not
  // a bool applied a predicate the call SKIPPED — the #209 failure modes, reached by another route.
  expect(() => run({ sql: 42, params: [] })).toThrow(/payload's 'sql' must be string/);
  expect(() => run({ sql: SQL, params: 'x' })).toThrow(/payload's 'params' must be list/);
  expect(() => run({ sql: SQL, params: [], opts: 'nope' })).toThrow(/payload's 'opts' must be record\|null/);
  const badOpt = (kw: Record<string, unknown>): unknown => ({ sql: SQL, params: [], opts: { db: null, write: null, whereDynamic: null, guard: null, ...kw } });
  expect(() => run(badOpt({ db: 42 }))).toThrow(/control record's 'db' must be string\|null/);
  expect(() => run(badOpt({ write: 'nope' }))).toThrow(/control record's 'write' must be record\|null/);
  expect(() => run(badOpt({ write: { returning: 'nope' } }))).toThrow(/'write' mode's 'returning' must be bool/);
  expect(() => run(badOpt({ write: { returning: 0 } }))).toThrow(/'write' mode's 'returning' must be bool/);
  expect(() => run(badOpt({ whereDynamic: 'nope' }))).toThrow(/control record's 'whereDynamic' must be record\|null/);
  expect(() => run(badOpt({ whereDynamic: { frags: 'nope' } }))).toThrow(/'whereDynamic' plan's 'frags' must be list/);
  expect(() => run(badOpt({ guard: 'nope' }))).toThrow(/control record's 'guard' must be record\|null/);
  expect(() => run(badOpt({ guard: { limit: 'nope', model: 'posts', relation: 'posts' } }))).toThrow(/'guard' cap's 'limit' must be int/);
  expect(() => run(badOpt({ guard: { limit: 2.5, model: 'posts', relation: 'posts' } }))).toThrow(/'guard' cap's 'limit' must be int/);
  expect(() => run(badOpt({ guard: { limit: 2n, model: 42, relation: 'posts' } }))).toThrow(/'guard' cap's 'model' must be string\|null/);
  expect(() => run(badOpt({ guard: { limit: 2n, model: 'posts', relation: 42 } }))).toThrow(/'guard' cap's 'relation' must be string/);
  expect(() => run(plan('nope'))).toThrow(/fragment must be record/);
  expect(() => run(plan({ skipped: 'no', sql: 'v = ?', params: ['zzz'] }))).toThrow(/fragment's 'skipped' must be bool/);
  expect(() => run(plan({ skipped: false, sql: 42, params: [] }))).toThrow(/fragment's 'sql' must be string/);
  expect(() => run(plan({ skipped: false, sql: 'v = ?', params: 'z' }))).toThrow(/fragment's 'params' must be list/);

  // The LEGAL absences stay silent: the omitted record is a plain read, and a null FIELD is how an
  // absent write mode / plan / cap is spelled. Neither may be turned into a failure by the above.
  expect(handler({ sql: SQL, params: [] } as unknown as Record<string, Value>, ctx)).toEqual({ ok: expect.any(Array) });
  const allNull = { sql: SQL, params: [], opts: { db: null, write: null, whereDynamic: null, guard: null } };
  expect(handler(allNull as unknown as Record<string, Value>, ctx)).toEqual({ ok: expect.any(Array) });
  // A guard that IS spelled still enforces the cap (the fail-closed reads did not disarm it).
  expect(() => run({ sql: SQL, params: [], opts: { db: null, write: null, whereDynamic: null, guard: cap } })).toThrow(LimitExceededError);
  // …and a WELL-FORMED plan still assembles: the surviving fragment reaches the statement, the skipped
  // one does not (the unbox reads every fragment, it does not change which ones apply).
  calls.length = 0;
  run(plan({ skipped: false, sql: 'author_id = ?', params: [7] }));
  expect(calls[0].sql).toBe('SELECT id, author_id FROM posts WHERE author_id = ?');
  expect(calls[0].params).toEqual([7]);
  run(plan({ skipped: true, sql: 'author_id = ?', params: [null] }));
  expect(calls[1].sql).toBe(SQL);
});

// #207 — the leaf hands the seam ONE StatementIntent, derived from the statement's RUN MODE, and the
// routing layer resolves the CONNECTION from it (`resolvePool`: write ⇒ writer). The branch that picks
// the SEAM is a different question: a RETURNING write runs on the ROW seam (`execute`) yet is still a
// write. Deriving the intent from the branch instead sent `INSERT … RETURNING` to the READ REPLICA.
// The single-pool conformance setup cannot see this (every intent returns the same pool), so the gate
// SPLITS reader and writer and records which pool served each statement — the TS leg of the five.
test('#207 — the RUN MODE, not the seam branch, picks the pool: a RETURNING write goes to the WRITER', async () => {
  const log: string[] = [];
  // A recording pool over a canned connection: the label is pushed on ACQUIRE, which is where
  // `PooledAsyncContext.connectionFor` reaches a pool after `resolvePool` has chosen it.
  const recording = (label: string): AsyncConnectionPool => ({
    async acquire(): Promise<AsyncConnection> {
      log.push(label);
      return {
        async execute(): Promise<Rows> {
          return [{ id: 1 }];
        },
        async run(): Promise<RunInfo> {
          return { changes: 1, lastInsertRowid: 7 } as RunInfo;
        },
      };
    },
    async release(): Promise<void> {},
  });
  const routing = {
    registry: ConnectionRegistry.fromDefault({ reader: recording('reader'), writer: recording('writer') }).build(),
    sticky: new WriterStickyClock({ useWriterAfterTransaction: false }),
  };
  const handler = leafHandlersAsync({ execAsync: new PooledAsyncContext(routing), dialect: 'postgres' }).executeSQL;
  const ctx = { nodeId: 'n0', component: 'executeSQL' };
  const call = (write: unknown): Promise<unknown> =>
    handler({ sql: 'INSERT INTO users (name) VALUES (?) RETURNING id', params: ['A'], opts: { db: null, write, whereDynamic: null, guard: null } } as unknown as Record<string, Value>, ctx);

  // A plain READ (the bounded payload that omits `opts` entirely) → the READER.
  await handler({ sql: 'SELECT id FROM users', params: [] } as unknown as Record<string, Value>, ctx);
  expect(log).toEqual(['reader']);

  // A RETURNING write → the WRITER, even though it runs on the ROW seam. This is the #207 case: with
  // the intent taken from the branch it landed on the reader above.
  const returning = await call({ returning: true });
  expect(log).toEqual(['reader', 'writer']);
  // …and it really did take the ROW seam (the rows, not the `[{changes,lastInsertRowid}]` summary) —
  // so the two decisions are proven INDEPENDENT, not accidentally aligned.
  expect(returning).toEqual({ ok: [{ id: 1 }] });

  // A NON-returning write → the WRITER too (the half that was already right stays right).
  const summary = await call({ returning: false });
  expect(log).toEqual(['reader', 'writer', 'writer']);
  expect(summary).toEqual({ ok: [{ changes: 1n, lastInsertRowid: 7n }] });
});

// #215 — a covered-plane transaction is the runtime's ONE transaction: it acquires from the WRITER
// pool, PINS that connection for the whole body, issues its tx-control THROUGH the seam (so a
// registered middleware sees BEGIN/COMMIT) and arms writer-sticky on COMMIT. TS gets all four from
// `withTransactionAsync`, which is why it is the reference — go and rust each ran a private BEGIN/
// COMMIT beside the central one and lost some of them. The single-pool conformance/livedb setups
// cannot tell (reader IS writer there), so the gate SPLITS the pair — the TS leg of the five.
test('#215 — a covered transaction opens on the WRITER, pins its body, and is seam-visible', async () => {
  const pools: string[] = [];
  const seen: string[] = [];
  let clock = 1_000_000;
  const recording = (label: string): AsyncConnectionPool => ({
    async acquire(): Promise<AsyncConnection> {
      pools.push(label);
      return {
        async execute(): Promise<Rows> {
          return [{ id: 1 }];
        },
        async run(): Promise<RunInfo> {
          return { changes: 1, lastInsertRowid: 7 } as RunInfo;
        },
      };
    },
    async release(): Promise<void> {},
  });
  const routing = {
    registry: ConnectionRegistry.fromDefault({ reader: recording('reader'), writer: recording('writer') }).build(),
    sticky: new WriterStickyClock({ useWriterAfterTransaction: true, writerStickyDuration: 5000, now: () => clock }),
  };
  const ctx = new PooledAsyncContext(routing);
  const handler = leafHandlersAsync({ execAsync: ctx, dialect: 'postgres' }).executeSQL;
  const leafCtx = { nodeId: 'n0', component: 'executeSQL' };
  const read = (): Promise<unknown> => handler({ sql: 'SELECT id FROM users', params: [] } as unknown as Record<string, Value>, leafCtx);
  const write = (): Promise<unknown> =>
    handler(
      { sql: 'INSERT INTO users (name) VALUES (?)', params: ['A'], opts: { db: null, write: { returning: false }, whereDynamic: null, guard: null } } as unknown as Record<string, Value>,
      leafCtx,
    );

  await withMiddlewareScope(async () => {
    use(createMiddleware({ execute: function (next, sql, params) { seen.push(sql); return next(sql, params); } }));
    // Before any transaction: a plain read ⇒ the READER (the sticky clock is unarmed).
    await read();
    await withTransactionAsync(ctx, async () => {
      // A READ inside the tx: its intent says READER, but the tx PIN wins — and it acquires NO further
      // connection, because the pinned one is not drawn from a pool per statement.
      await read();
      await write();
    });
    // The COMMIT armed writer-sticky: the SAME plain read now routes to the WRITER (read-your-writes).
    clock += 100;
    await read();
  });

  expect(pools).toEqual(['reader', 'writer', 'writer']);
  expect(seen).toEqual([
    'SELECT id FROM users',
    'BEGIN',
    'SELECT id FROM users',
    'INSERT INTO users (name) VALUES ($1)',
    'COMMIT',
    'SELECT id FROM users',
  ]);
});

// #213 — `pluck` / `group` read their ports through the SAME fail-closed reader as the SQL transport.
// Their ports are FLAT, which is not a reason to trust them: the generator spells every one with the
// type the catalog declares, so anything else is an ABI break — and on `group` the break is SILENT and
// changes the SHAPE of the returned graph. A `single` that is not a bool flipped the relation's
// CARDINALITY, an `into` that is not a string nested the children under a stringified number, and an
// absent `pk`/`col` surfaced as a raw `Cannot read properties of undefined` that named no port at all.
test('#213 — a MISSING or MISTYPED pluck / group port is loud, and names the port', () => {
  const calls: Call[] = [];
  const handlers = leafHandlers({ exec: contextForConnection(recordingConn(calls)), dialect: 'sqlite' });
  const ctx = { nodeId: 'n0', component: 'group' };
  const rows = [{ id: 1 }, { id: 2 }];
  const kids = [{ post_id: 1, t: 'a' }, { post_id: 1, t: 'b' }];
  const pluckPorts = (kw: Record<string, unknown>): Record<string, Value> => ({ rows, col: ['id'], ...kw }) as unknown as Record<string, Value>;
  const groupPorts = (kw: Record<string, unknown>): Record<string, Value> =>
    ({ parents: rows, children: kids, pk: ['id'], fk: ['post_id'], into: 'kids', single: false, ...kw }) as unknown as Record<string, Value>;
  const drop = (ports: Record<string, Value>, name: string): Record<string, Value> => {
    const { [name]: _dropped, ...rest } = ports;
    return rest as Record<string, Value>;
  };

  // ABSENT ports — every one of the two + six, by name.
  expect(() => handlers.pluck(drop(pluckPorts({}), 'rows'), ctx)).toThrow(/pluck payload is missing its 'rows' field/);
  expect(() => handlers.pluck(drop(pluckPorts({}), 'col'), ctx)).toThrow(/pluck payload is missing its 'col' field/);
  for (const name of ['parents', 'children', 'pk', 'fk', 'into', 'single']) {
    expect(() => handlers.group(drop(groupPorts({}), name), ctx)).toThrow(new RegExp(`group payload is missing its '${name}' field`));
  }

  // MISTYPED ports — the SILENT failures the issue measured.
  expect(() => handlers.pluck(pluckPorts({ rows: 'x' }), ctx)).toThrow(/pluck payload's 'rows' must be list/);
  expect(() => handlers.pluck(pluckPorts({ col: [1] }), ctx)).toThrow(/pluck payload's 'col' must be string\[\]/);
  expect(() => handlers.group(groupPorts({ single: 'yes' }), ctx)).toThrow(/group payload's 'single' must be bool/);
  expect(() => handlers.group(groupPorts({ into: 42 }), ctx)).toThrow(/group payload's 'into' must be string/);
  expect(() => handlers.group(groupPorts({ pk: [1] }), ctx)).toThrow(/group payload's 'pk' must be string\[\]/);
  expect(() => handlers.group(groupPorts({ fk: 'post_id' }), ctx)).toThrow(/group payload's 'fk' must be string\[\]/);
  expect(() => handlers.group(groupPorts({ parents: 'x' }), ctx)).toThrow(/group payload's 'parents' must be list/);
  expect(() => handlers.group(groupPorts({ children: 'x' }), ctx)).toThrow(/group payload's 'children' must be list/);
  // A KEYED map is a `record` on this plane, never a list. php's `is_array` used to say otherwise, so
  // the case is pinned in all three of the legs that can spell it.
  expect(() => handlers.pluck(pluckPorts({ rows: { a: 1 } }), ctx)).toThrow(/pluck payload's 'rows' must be list/);
  expect(() => handlers.pluck(pluckPorts({ col: { a: 'id' } }), ctx)).toThrow(/pluck payload's 'col' must be string\[\]/);

  // The LEGAL shapes stay silent, and the CARDINALITY the ports declare is the one that comes out: a
  // hasMany nests the LIST, `single` nests the ONE child. (The mistyped `single` above used to land on
  // the other branch without a word.)
  expect(handlers.pluck(pluckPorts({}), ctx)).toEqual({ ok: [1, 2] });
  expect(handlers.group(groupPorts({}), ctx)).toEqual({ ok: [{ id: 1, kids: kids }, { id: 2, kids: [] }] });
  expect(handlers.group(groupPorts({ single: true }), ctx)).toEqual({ ok: [{ id: 1, kids: kids[0] }, { id: 2, kids: null }] });
});

// ── #217 named-DB: the statement's own connection reaches the router, or is LOUD ─────────────────

test('#217 — the leaf carries `opts.db` onto the StatementIntent, so the ROUTER sees the named database', async () => {
  // The wire half of the lowering, on the async (routed) plane: two registered connections, each its own
  // pool, and the leaf's `db` field is the ONLY thing that decides which one serves the statement. A
  // recording pool per connection makes the choice observable — the offline twin of the live cross-DB
  // gate (`test/integration/NamedDbCodegen.test.ts`).
  const served: string[] = [];
  const poolFor = (label: string): AsyncConnectionPool => ({
    async acquire(): Promise<AsyncConnection> {
      served.push(label);
      return {
        execute: () => Promise.resolve([{ who: label }] as Rows),
        run: () => Promise.resolve({ changes: 1, lastInsertRowid: 0 } as RunInfo),
      };
    },
    release: () => Promise.resolve(),
  });
  const a = poolFor('A');
  const b = poolFor('B');
  const registry = new ConnectionRegistry(new Map([
    ['default', { reader: a, writer: a }],
    ['B', { reader: b, writer: b }],
  ]));
  const execAsync = new PooledAsyncContext({ registry, sticky: new WriterStickyClock({ useWriterAfterTransaction: false }) });
  const handler = leafHandlersAsync({ execAsync, dialect: 'postgres' }).executeSQL;
  const at = { nodeId: 'n0', component: 'executeSQL' };
  const call = (db: string | null): Promise<{ ok?: Value }> =>
    handler({ sql: 'SELECT 1', params: [], opts: { db, write: null, whereDynamic: null, guard: null } } as unknown as Record<string, Value>, at) as Promise<{ ok?: Value }>;

  // NAMED ⇒ B's pool served it, and the row proves it came from there (not merely that B was acquired).
  expect((await call('B')).ok).toEqual([{ who: 'B' }]);
  // NULL (the default connection — and the pre-#217 lowering) ⇒ the DEFAULT pool. This is the negative
  // control in place: with the name dropped, the SAME statement lands on a DIFFERENT database.
  expect((await call(null)).ok).toEqual([{ who: 'A' }]);
  expect(served).toEqual(['B', 'A']);
  // An UNREGISTERED name is LOUD, never a silent fall back to the default.
  await expect((async () => call('ghost'))()).rejects.toThrow(/no connection registered under name 'ghost'/);
});

test('#217 — a NON-ROUTED (single-connection) context REJECTS a named statement instead of running it', () => {
  // The seam's own fail-closed half: `contextForConnection` holds ONE connection and no registry, so a
  // statement naming another database cannot be honored. Running it on that one connection anyway is the
  // silent wrong-database execution the named-DB lowering exists to prevent — every single-DB deployment
  // is precisely where it would go unnoticed.
  const calls: Call[] = [];
  const ctx: LeafContext = { exec: contextForConnection(recordingConn(calls)), dialect: 'sqlite' };
  expect(() => executeSQL({ sql: 'SELECT id, name FROM users', params: [], write: null, db: 'analytics' }, ctx)).toThrow(
    /a statement names connection 'analytics'.*no connection registry/s,
  );
  expect(calls).toEqual([]); // it never reached the database
  // The DEFAULT connection is the single-connection case itself and still runs.
  expect(executeSQL({ sql: 'SELECT id, name FROM users', params: [], write: null, db: null }, ctx).length).toBe(2);
});

// ── #217 R1/R2 — inside a transaction the named db must AGREE, or be LOUD ─────────────────────────

test('#217 — a statement naming a DIFFERENT db than the tx opened on is LOUD; the tx\'s own db still runs', async () => {
  // The pin is resolved BEFORE routing (per-execution ownership depends on it), so `intent.db` used to be
  // dropped unread: a `db:"B"` statement inside a tx opened on the DEFAULT connection ran on the DEFAULT
  // one, silently, and an UNREGISTERED name never surfaced at all. A transaction is ONE connection on ONE
  // database, so the two cannot both be honored — the only honest outcomes are "runs on its own db" and
  // "loud". The whole matrix is asserted here, INCLUDING the normal cases that must NOT become loud.
  const served: string[] = [];
  const poolFor = (label: string): AsyncConnectionPool => ({
    async acquire(): Promise<AsyncConnection> {
      served.push(label);
      return {
        execute: () => Promise.resolve([{ who: label }] as Rows),
        run: () => Promise.resolve({ changes: 1, lastInsertRowid: 0 } as RunInfo),
      };
    },
    release: () => Promise.resolve(),
  });
  const a = poolFor('A');
  const b = poolFor('B');
  const execAsync = new PooledAsyncContext({
    registry: new ConnectionRegistry(new Map([['default', { reader: a, writer: a }], ['B', { reader: b, writer: b }]])),
    sticky: new WriterStickyClock({ useWriterAfterTransaction: false }),
  });
  const handler = leafHandlersAsync({ execAsync, dialect: 'postgres' }).executeSQL;
  const at = { nodeId: 'n0', component: 'executeSQL' };
  const stmt = (db: string | null): Record<string, Value> =>
    ({ sql: 'SELECT 1', params: [], opts: { db, write: null, whereDynamic: null, guard: null } }) as unknown as Record<string, Value>;
  const call = (db: string | null): Promise<{ ok?: Value }> => handler(stmt(db), at) as Promise<{ ok?: Value }>;

  // A transaction on the DEFAULT connection.
  await withTransactionAsync(execAsync, async () => {
    // The ORDINARY in-body statement (no name) resolves the pin — unchanged, and it must NOT be loud.
    expect((await call(null)).ok).toEqual([{ who: 'A' }]);
    // A statement naming ANOTHER database is LOUD. Before this it returned `[{who:'A'}]` — the tx's DB.
    await expect(call('B')).rejects.toThrow(/names connection 'B'.*transaction opened on 'default'/s);
    // An UNREGISTERED name is loud too (the pin used to swallow it whole).
    await expect(call('ghost')).rejects.toThrow(/names connection 'ghost'.*transaction opened on 'default'/s);
  });

  // A transaction on 'B': the statement naming 'B' AGREES and runs on the pin; 'default' now disagrees.
  served.length = 0;
  await withTransactionAsync(execAsync, async () => {
    expect((await call('B')).ok).toEqual([{ who: 'B' }]);
    expect((await call(null)).ok).toEqual([{ who: 'B' }]);
    await expect(call('default')).rejects.toThrow(/names connection 'default'.*transaction opened on 'B'/s);
  }, {}, 'postgres', undefined, 'B');
  // ONE acquire for the whole tx — the agreement check did not turn an in-body statement into a second
  // pooled checkout (that would break per-execution ownership while looking green).
  expect(served).toEqual(['B']);
});

test('#217 R2 — a NON-ROUTED context rejects a named statement identically inside a tx and outside it', () => {
  // The parity half: this guard used to sit BEFORE the pin on the TS/php planes and AFTER it on
  // go/py/rust, so "a named statement in a non-routed tx" threw in two languages and ran silently in
  // three. Both states are now the same LOUD outcome, and the ordinary unnamed statement still runs.
  const calls: Call[] = [];
  const base = contextForConnection(recordingConn(calls));
  const txCtx = base.withConnection(recordingConn(calls), true);
  for (const ctx of [base, txCtx]) {
    const leaf: LeafContext = { exec: ctx, dialect: 'sqlite' };
    expect(() => executeSQL({ sql: 'SELECT id, name FROM users', params: [], write: null, db: 'analytics' }, leaf)).toThrow(
      /names connection 'analytics'/,
    );
    expect(executeSQL({ sql: 'SELECT id, name FROM users', params: [], write: null, db: null }, leaf).length).toBe(2);
  }
});
