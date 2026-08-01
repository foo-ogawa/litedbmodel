/**
 * The cross-lang bench cells hold NO SQL and NO values of their own (#172).
 *
 * SQL is a property of the DIALECT and the values are a property of the OP; neither is a property of the
 * language. Before this, each of the ten cells (5 languages × native/sdk, TypeScript sharing one input
 * table across its three modes) spelled both out for itself, and two had already drifted with every gate
 * green: `findUnique` ran on `user500@example.com` in go/TypeScript and `user1@example.com` in
 * rust-native/python/php — rust's own two cells disagreeing with each other — and `updateMany` sent
 * `Many 1…Many 10` from every native cell and `Many 0…Many 9` from every SDK cell but TypeScript's. Both
 * move the same NUMBER of rows, so rows/op parity, the only cross-cell check there was, passed on all of
 * it. The MySQL RETURNING recovery had been hand-copied into all five SDK cells and all five were wrong
 * against the runtime they are the baseline FOR.
 *
 * So the run-time check (`run-cells.sh`'s verify phase, which holds the ten cells to the same statements
 * and rows before anything is timed) is backed by a STATIC one: a cell cannot name a value or a table.
 *
 * Both clauses read their needles from the SSoT rather than from a list kept here, so a value added to
 * `contract.ts` is guarded the moment it is declared. Neither clause interprets comment or string syntax
 * — a scanner that models five languages' lexers is the thing #222 (A) deleted 361 lines of — so a SQL
 * word or a value in a COMMENT fails too. That is the red direction: the explanation belongs beside the
 * value it explains, which is `contract.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ORM_OPS, ORM_OP_INPUT, type OrmOpInputValue } from '../../benchmark/crosslang/contract.js';
import { derive } from '../../benchmark/crosslang/derive-ops.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/**
 * The nine cells whose numbers the report divides (native ÷ sdk). Every one of them must take its
 * statements and its values from `.setup/<dialect>.json`.
 */
const CELLS = [
  'go/lm_bench/lm_orm_native/main.go',
  'go/lm_bench/lm_orm/main.go',
  'rust/orm_bench/src/main.rs',
  'rust/orm_bench_sdk/src/main.rs',
  'python/orm_bench/main.py',
  'python/orm_bench_sdk/main.py',
  'php/orm_bench/OrmBench.php',
  'php/orm_bench_sdk/main.php',
  'benchmark/crosslang/ts-cell/mode-sdk.ts',
  'benchmark/crosslang/ts-cell/mode-codegen.ts',
];

/**
 * The TypeScript `runtime` cell measures the IMPERATIVE DBModel path, so it declares models the way a
 * DBModel consumer does — `@model('benchmark_users')` — and those table names are the ORM's API, not a
 * hand-written statement. It is checked for values like every other cell, and its table names are
 * required to appear ONLY in a model decorator.
 */
const RUNTIME_CELL = 'benchmark/crosslang/ts-cell/mode-runtime.ts';

/** Every string a declared input carries, records included. */
function declaredStrings(value: OrmOpInputValue): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number') return [];
  return value.flatMap((record) => Object.values(record).filter((v): v is string => typeof v === 'string'));
}

/**
 * What a cell must not contain, for one declared value. `{it}` is a hole, so the fragments around it are
 * what a cell could have hard-coded; a fragment long enough to be distinctive is forbidden bare, and a
 * short one (`New`, `NC`, `Del`) only in the quoted form every one of the five languages writes a string
 * literal in — bare, `NC` would match the word inside `nestedCreate`.
 */
function needlesFor(value: string): string[] {
  return value
    .split('{it}')
    .filter((fragment) => fragment.length > 0)
    .flatMap((fragment) => (fragment.length >= 5 ? [fragment] : [`"${fragment}"`, `'${fragment}'`]));
}

describe('cross-lang bench: one source for every statement and every value (#172)', () => {
  const inputStrings = [...new Set(ORM_OPS.flatMap((op) => Object.values(op.input).flatMap(declaredStrings)))];

  it('declares an input scope for every op on the axis', () => {
    for (const op of ORM_OPS) expect(ORM_OP_INPUT[op.id], `op ${op.id}`).toBeDefined();
    expect(Object.keys(ORM_OP_INPUT)).toHaveLength(ORM_OPS.length);
  });

  it('declares the values in contract.ts and nowhere else', () => {
    // Anti-vacuity: this clause is only worth anything if there ARE needles, and in particular the two
    // that drifted. They are computed in `contract.ts` (`userRows`/`userPatches` build the batch records),
    // so the check is on the DECLARED set, not on the file's source text.
    expect(inputStrings).toContain('user500@example.com');
    expect(inputStrings).toContain('Many 1');
    expect(inputStrings.length).toBeGreaterThanOrEqual(19);

    const offenders: string[] = [];
    for (const cell of [...CELLS, RUNTIME_CELL]) {
      const text = read(cell);
      for (const value of inputStrings) {
        for (const needle of needlesFor(value)) {
          if (text.includes(needle)) offenders.push(`${cell} holds ${JSON.stringify(needle)} (declared for an op in contract.ts)`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('names no table in a cell — SQL comes from the captured artifact', () => {
    const tables = [...new Set(read('benchmark/crosslang/orm-domain.ts').match(/benchmark_[a-z_]+/g) ?? [])];
    expect(tables.length, 'orm-domain.ts should name the fixture tables').toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const cell of CELLS) {
      const text = read(cell);
      for (const table of tables) if (text.includes(table)) offenders.push(`${cell} names the table ${table}`);
    }
    // The imperative cell declares its models; every OTHER mention would be a statement it wrote itself.
    const runtime = read(RUNTIME_CELL);
    for (const table of tables) {
      const total = runtime.split(table).length - 1;
      const declared = runtime.split(`@model('${table}')`).length - 1;
      if (total !== declared) offenders.push(`${RUNTIME_CELL} names ${table} outside a @model() declaration`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('cross-lang bench: the MySQL RETURNING recovery is derived, never copied (#172)', () => {
  /** Every distinct statement the committed MySQL module issues — the derivation's real input. */
  function mysqlStatements(): string[] {
    const text = read('benchmark/crosslang/ts-cell/behaviors_mysql.ts');
    const found = [...text.matchAll(/"sql": "((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    return [...new Set(found)];
  }

  it('derives exactly what the runtime issues for every RETURNING write', () => {
    const statements = mysqlStatements();
    expect(statements.length, 'the committed mysql module should carry statements').toBeGreaterThan(0);

    const { recover } = derive({ all: statements }, 'mysql');
    const derived = (recover.all ?? []).filter((r) => r !== null).map((r) => ({ ...r! }));

    // The recoveries `src/scp/makesql/mysql-returning.ts` builds for this model's three RETURNING writes.
    // A change there that the cells would silently stop matching turns this red.
    expect(derived).toEqual([
      {
        writeSql:
          'INSERT INTO benchmark_users (email, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name)',
        selectSql: 'SELECT id FROM benchmark_users WHERE email = ? ORDER BY id',
        binds: [{ kind: 'param', index: 0 }],
      },
      {
        writeSql: 'INSERT INTO benchmark_users (email, name) VALUES (?, ?)',
        selectSql: 'SELECT id FROM benchmark_users WHERE id >= ? AND id < ? ORDER BY id',
        binds: [{ kind: 'lastId' }, { kind: 'highId' }],
      },
      {
        writeSql: 'UPDATE benchmark_users SET name = ? WHERE id = ?',
        selectSql: 'SELECT id FROM benchmark_users WHERE id = ? ORDER BY id',
        binds: [{ kind: 'param', index: 1 }],
      },
    ]);
  });

  it('derives no recovery for the dialects that execute RETURNING themselves', () => {
    for (const dialect of ['postgres', 'sqlite'] as const) {
      const text = read(`benchmark/crosslang/ts-cell/behaviors_${dialect}.ts`);
      const statements = [...new Set([...text.matchAll(/"sql": "((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string))];
      expect(Object.keys(derive({ all: statements }, dialect).recover), dialect).toEqual([]);
    }
  });

  it('reads each batch write column list off the statement, in the order it binds them', () => {
    // PostgreSQL binds one array PER COLUMN, so the order is the statement's; go used to sort its record
    // keys and rust to pin a tuple position, and both agreed with `AS v(id, name)` only by coincidence.
    const pg = read('benchmark/crosslang/ts-cell/behaviors_postgres.ts');
    const updateMany = [...pg.matchAll(/"sql": "((?:[^"\\]|\\.)*)"/g)]
      .map((m) => JSON.parse(`"${m[1]}"`) as string)
      .filter((s) => s.includes('UNNEST') && s.startsWith('UPDATE'));
    expect(updateMany.length).toBeGreaterThan(0);
    expect(derive({ updateMany }, 'postgres').batchColumns.updateMany).toEqual(['id', 'name']);
  });
});
