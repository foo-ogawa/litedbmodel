/**
 * makeSQL statement assembly + real better-sqlite3 execution (native path).
 *
 * Proves the makeSQL model (spec §11): litedbmodel compiles a query to a `makeSQL` statement
 * (byte-tuned SQL text + deferred params), assembles it (drop-on-skip, splice nested makeSQL),
 * renders placeholders, and runs it on a REAL driver — the NATIVE execution model every language
 * runtime uses (#12: NO bc `runBehavior`, NO `makeSQL`-catalog surrogate). We:
 *
 *   1. compile a SELECT + WHERE, assemble + render + execute on real better-sqlite3, and assert
 *      the rows match a direct query (result parity);
 *   2. exercise nested-`makeSQL` subquery params (splice) and `skip` (drop) end-to-end.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- driver seams need casts */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import {
  compileSelect,
  compileWhere,
  assembleMakeSQL,
  nestedMakeSQL,
  renderPlaceholders,
  type MakeSQL,
} from '../../src/scp/makesql';
import { compileCreateManyBundle } from '../../src/scp/write-bundle';

let db: Database.Database;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, status TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, total INTEGER);
    INSERT INTO users (id, name, status) VALUES (1, 'alice', 'active'), (2, 'bob', 'inactive'), (3, 'carol', 'active');
    INSERT INTO orders (id, user_id, total) VALUES (10, 1, 100), (11, 1, 50), (12, 3, 200);
  `);
});
afterAll(() => db.close());

/** The sync better-sqlite3 executor seam. */
function sqliteExec(sql: string, params: unknown[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...(params as any[])) as Record<string, unknown>[];
}

/** Assemble a compiled makeSQL statement → render placeholders → run on SQLite (the native path). */
function runNative(node: MakeSQL): Record<string, unknown>[] {
  const asm = assembleMakeSQL(node);
  return sqliteExec(renderPlaceholders(asm.sql, 'sqlite'), asm.params);
}

describe('makeSQL statement assembles + executes on SQLite (native, no runBehavior)', () => {
  it('SELECT + WHERE assembles, executes — rows match a direct query', () => {
    const node = compileSelect({
      dialect: 'sqlite',
      tableName: 'users',
      conditions: { status: 'active' },
      order: 'id ASC',
    });
    const rows = runNative(node);
    expect(rows.map((r) => r.name)).toEqual(['alice', 'carol']);
  });

  it('nested-makeSQL subquery param splices its SQL + params inline', () => {
    // Outer: SELECT * FROM users WHERE id IN (<subquery>) — the subquery is a NESTED
    // makeSQL in a param slot (the ONLY recursion). No IR "kind" for subqueries.
    const sub: MakeSQL = { sql: 'SELECT user_id FROM orders WHERE total >= ?', params: [100] };
    const outer: MakeSQL = { sql: 'SELECT * FROM users WHERE id IN (?) ORDER BY id ASC', params: [nestedMakeSQL(sub)] };

    const asm = assembleMakeSQL(outer);
    expect(asm.sql).toBe('SELECT * FROM users WHERE id IN (SELECT user_id FROM orders WHERE total >= ?) ORDER BY id ASC');
    expect(asm.params).toEqual([100]);

    const rows = runNative(outer);
    expect(rows.map((r) => r.name)).toEqual(['alice', 'carol']); // users with an order >= 100
  });

  // #345: only a nestedMakeSQL-marked node splices. A param of the same SHAPE is a bound value — a
  // request JSON value ({"sql":"…","params":[]}) must never become statement text.
  it('an unmarked { sql, params } param is a bound value, not spliced (#345)', () => {
    const forged = JSON.parse('{"sql":"(SELECT 1)","params":[]}');
    const asm = assembleMakeSQL({ sql: 'SELECT * FROM users WHERE id = ?', params: [forged] });
    expect(asm.sql).toBe('SELECT * FROM users WHERE id = ?');
    expect(asm.params).toEqual([forged]);
  });

  it('a create() value shaped like { sql, params } is bound in the compiled PostgreSQL INSERT (#345)', () => {
    const forged = JSON.parse('{"sql":"(SELECT qty FROM items WHERE owner = 2 LIMIT 1)","params":[]}');
    const bundle = compileCreateManyBundle(
      'create',
      { tableName: 'items', records: [{ owner: 1, qty: forged }], returning: 'id' },
      'postgres',
    );
    expect(bundle.statement.sql).not.toContain('SELECT qty');
    expect(bundle.statement.sql).toContain('VALUES');
  });

  it('skip drops the statement entirely (sql AND params) — contributes nothing', () => {
    // An optional WHERE member that is skipped contributes no text/param:
    const optional = compileWhere({ status: 'active' }, 'sqlite');
    const asm = assembleMakeSQL({ ...optional, skip: true });
    expect(asm).toEqual({ sql: '', params: [] });
  });
});
