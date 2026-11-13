/**
 * REAL-DB result-parity tests for the single-JSON-param array/batch forms (epic #43/#45).
 *
 * The MySQL/SQLite JSON forms (`JSON_TABLE` subquery / `json_each`) INTENTIONALLY deviate
 * from v1's `IN (?, …)` / multi-VALUES / `VALUES ROW` / `CASE WHEN` SQL TEXT — so
 * byte-matching is the wrong bar for these dialects. The bar is RESULT PARITY: the NEW
 * JSON-form query must return the SAME rows / leave the SAME post-write DB state as v1's
 * N-placeholder form, on a REAL MySQL 8 + SQLite, over the same seed.
 *
 * Each case runs BOTH forms against identical seed in isolated tables:
 *   - v1-form  = the ORIGINAL builders (`mysql|sqliteSqlBuilder.buildInsert/buildUpdateMany`,
 *                `new DBConditions(...)` IN-list) — the baseline this library shipped.
 *   - JSON-form = the ACTUAL compile path (`compileWhere` for IN-list — so the empty-array
 *                case exercises the REAL routed `1 = 0`, not a faked re-run of v1;
 *                `mysqlInsertJson`/`sqliteInsertJson`, `mysqlUpdateManyJson`/
 *                `sqliteUpdateManyJson`) — one JSON param.
 * Coverage: IN-list incl. CROSS-TYPE (int-col × string values, text-col × int values),
 * bigint, decimal, and empty (routed `1 = 0`); createMany (homogeneous + heterogeneous
 * grouped + DEFAULT/undefined omission); updateMany + SKIP; type round-trips
 * (int/bigint/decimal/text/bool/null). (The DBToken(`NOW()`)-fallback pin lives in the
 * byte-golden suite `makesql-golden.test.ts`, since it asserts v1 TEXT identity.)
 *
 * SQLite runs in-process (better-sqlite3, always available). MySQL requires docker MySQL 8
 * (`npm run docker:livedb:up`, host localhost:3307). This suite is a PARITY PROOF, so a
 * MySQL leg that cannot reach the DB FAILS (throws) rather than silently skipping — a
 * green run without MySQL must never be mistaken for "parity proven". SQLite always runs.
 * PostgreSQL is NOT tested here — it is unchanged.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import { DBConditions, type ConditionObject } from '../../src/DBConditions';
import { mysqlSqlBuilder } from '../../src/drivers/MysqlSqlBuilder';
import { sqliteSqlBuilder } from '../../src/drivers/SqliteSqlBuilder';
import {
  compileWhere,
  compileSelect,
  compileDeleteMany,
  compileUpdateSingle,
  compileCompositeKeyStaticUnlimited,
  encodeJsonArrayParam,
  assembleMakeSQL,
  renderPlaceholders,
  mysqlInsertJson,
  sqliteInsertJson,
  mysqlUpdateManyJson,
  sqliteUpdateManyJson,
} from '../../src/scp/makesql';
import type { MakeSQL } from '../../src/scp/makesql/makesql';

// ---------------------------------------------------------------------------
// Driver seams: run a rendered { sql, params } and return rows / row objects.
// ---------------------------------------------------------------------------

const MY = {
  host: process.env.TEST_MYSQL_HOST || 'localhost',
  port: parseInt(process.env.TEST_MYSQL_PORT || '3307', 10),
  database: process.env.TEST_MYSQL_DB || 'testdb',
  user: process.env.TEST_MYSQL_USER || 'testuser',
  password: process.env.TEST_MYSQL_PASSWORD || 'testpass',
};

let myConn: mysql.Connection | undefined;
let mysqlErr: string | undefined;

beforeAll(async () => {
  try {
    myConn = await mysql.createConnection({ ...MY, multipleStatements: false });
    await myConn.query('SELECT 1');
  } catch (e) {
    mysqlErr = (e as Error).message;
  }
});

afterAll(async () => {
  if (myConn) await myConn.end();
});

/**
 * Guard for MySQL-leg tests: FAIL (throw) when MySQL is unreachable — this suite is a
 * parity PROOF, so a MySQL leg with no DB must not pass silently (coordinator BLOCKER #3).
 */
function requireMysql(): void {
  if (!myConn) {
    throw new Error(
      `[json-array-parity] MySQL is REQUIRED for this parity proof but is unreachable at ${MY.host}:${MY.port} — ${mysqlErr}. Bring it up: npm run docker:livedb:up`
    );
  }
}

/** Run a query on MySQL, return row objects (plain). */
async function my(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const [rows] = await myConn!.query(sql, params);
  return rows as Record<string, unknown>[];
}

/** A fresh in-memory SQLite db. */
function sqliteDb(): Database.Database {
  return new Database(':memory:');
}

// ---------------------------------------------------------------------------
// v1-form vs JSON-form builders per surface (dialect-parameterized).
// ---------------------------------------------------------------------------

type Dialect = 'mysql' | 'sqlite';

/** v1 IN-list WHERE core: `col IN (?, …)` / empty `1 = 0` via the ORIGINAL DBConditions. */
function v1InList(col: string, values: unknown[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const where = new DBConditions({ [col]: values }).compile(params);
  return { sql: where, params };
}

/**
 * JSON-form IN-list WHERE core via the ACTUAL compile path (`compileWhere`) — the SAME
 * code production runs. For MySQL/SQLite a non-empty array becomes the JSON-subquery
 * form (ONE param); an EMPTY array is ROUTED to v1's `1 = 0` (no param). Rendered to the
 * dialect placeholder form (a no-op for MySQL/SQLite). This is what proves the empty case
 * goes through the real routing rather than a faked re-run (coordinator BLOCKER #2).
 */
function jsonInList(col: string, values: unknown[], dialect: Dialect, columnTypes?: Record<string, string>): { sql: string; params: unknown[] } {
  const bundle = compileWhere({ [col]: values }, dialect, columnTypes);
  const asm = assembleMakeSQL(bundle);
  return { sql: renderPlaceholders(asm.sql, dialect), params: asm.params };
}

// ===========================================================================
// Test bodies — SQLite always runs; MySQL FAILS if unreachable (parity proof).
// ===========================================================================

describe('JSON-form == v1-form RESULT PARITY on real MySQL 8 + SQLite (epic #43/#45)', () => {
  // ---- IN-list (incl. CROSS-TYPE, bigint, decimal, empty) ---------------
  //
  // Cross-type is the case that killed `MEMBER OF` (coordinator MAJOR #1): an int column
  // compared against JSON STRING values (or a text column against JSON numbers) must
  // coerce EXACTLY like v1's `col IN (list)`. The JSON-subquery form (MySQL JSON_TABLE /
  // SQLite json_each) inherits that coercion; strict-JSON `MEMBER OF` did not.
  const inCases: Array<{ label: string; col: string; values: unknown[] }> = [
    { label: 'int col × int values', col: 'id', values: [1, 3, 10] },
    { label: 'int col × STRING values (cross-type)', col: 'id', values: ['1', '10'] },
    { label: 'text col × text values', col: 'code', values: ['AB', 'EF'] },
    { label: 'text col × INT values (cross-type)', col: 'code', values: [2, 10] },
    // Large 64-bit ints exceed JS Number precision, so they travel as strings (the only
    // JSON-safe representation); the JSON-subquery form coerces them back exactly like v1.
    { label: 'bigint col (precision, as strings)', col: 'big', values: ['9007199254740993', '9223372036854775807'] },
    { label: 'decimal col (precision)', col: 'price', values: ['12345.678900', '0.001000'] },
    { label: 'empty → routed 1 = 0 (no rows)', col: 'id', values: [] },
    { label: 'int col, one absent', col: 'id', values: [10, 5, 999] },
  ];
  // Seed rows: bigint values bound as strings to survive JSON round-trip without float loss.
  const inSeed = [
    { id: 1, code: 'AB', big: '9007199254740993', price: '12345.678900' },
    { id: 2, code: 'CD', big: '2', price: '0.001000' },
    { id: 3, code: 'EF', big: '9223372036854775807', price: '5.250000' },
    { id: 10, code: 'ZZ', big: '5', price: '99.990000' },
  ];

  it('[sqlite] IN-list (cross-type/bigint/decimal/empty): JSON-form == v1-form rows', () => {
    const db = sqliteDb();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, code TEXT, big INTEGER, price REAL)');
    const ins = db.prepare('INSERT INTO t VALUES (?,?,?,?)');
    for (const r of inSeed) ins.run(r.id, r.code, r.big, r.price);
    for (const { label, col, values } of inCases) {
      const v1 = v1InList(col, values);
      const v1Rows = db.prepare(`SELECT id FROM t WHERE ${v1.sql} ORDER BY id`).all(...(v1.params as never[]));
      const j = jsonInList(col, values, 'sqlite');
      const jsonRows = db.prepare(`SELECT id FROM t WHERE ${j.sql} ORDER BY id`).all(...(j.params as never[]));
      expect(jsonRows, `sqlite IN-list parity: ${label}`).toEqual(v1Rows);
      // Non-empty JSON form must be exactly ONE param (no N-explosion); empty → routed 1=0, zero params.
      expect(j.params.length).toBe(values.length === 0 ? 0 : 1);
    }
    db.close();
  });

  it('[mysql] IN-list (cross-type/bigint/decimal/empty): JSON-form == v1-form rows', async () => {
    requireMysql();
    await my('DROP TABLE IF EXISTS pj_t', []);
    await my('CREATE TABLE pj_t(id INT PRIMARY KEY, code VARCHAR(20), big BIGINT, price DECIMAL(20,6))', []);
    for (const r of inSeed) await my('INSERT INTO pj_t VALUES (?,?,?,?)', [r.id, r.code, r.big, r.price]);
    // The DECLARED column types, as every schema-carrying path (emitter / relation / write node) passes
    // them: MySQL reads the JSON element as the column's type, so cross-type values coerce like v1 (#376).
    const declared = { id: 'INT', code: 'VARCHAR(20)', big: 'BIGINT', price: 'DECIMAL(20,6)' };
    for (const { label, col, values } of inCases) {
      const v1 = v1InList(col, values);
      const v1Rows = await my(`SELECT id FROM pj_t WHERE ${v1.sql} ORDER BY id`, v1.params);
      const j = jsonInList(col, values, 'mysql', declared);
      const jsonRows = await my(`SELECT id FROM pj_t WHERE ${j.sql} ORDER BY id`, j.params);
      expect(jsonRows, `mysql IN-list parity: ${label}`).toEqual(v1Rows);
      expect(j.params.length).toBe(values.length === 0 ? 0 : 1);
    }
  });

  // ---- createMany (homogeneous + heterogeneous grouped + DEFAULT omission) --------
  for (const dialect of ['mysql', 'sqlite'] as Dialect[]) {
    it(`[${dialect}] createMany (homogeneous + types): JSON-form state == v1-form state`, async () => {
      if (dialect === 'mysql') requireMysql();

      // Mixed types: int id, text name, decimal score, bool active, nullable note.
      // Booleans arrive at the builders already SERIALIZED to 0/1 (what v1's DBModel does
      // before calling buildInsert — the raw builders/better-sqlite3 don't accept JS bools),
      // so both forms see identical serialized inputs.
      const columns = ['id', 'name', 'score', 'active', 'note'];
      const rows = [
        { id: 1, name: 'a', score: 9.5, active: 1, note: 'hi' },
        { id: 2, name: 'b', score: 3.25, active: 0, note: null },
        { id: 3, name: 'héllo', score: 100, active: 1, note: 'x' },
      ];

      if (dialect === 'sqlite') {
        const run = (build: 'v1' | 'json') => {
          const db = sqliteDb();
          db.exec('CREATE TABLE u(id INTEGER PRIMARY KEY, name TEXT, score REAL, active INTEGER, note TEXT)');
          if (build === 'v1') {
            const r = sqliteSqlBuilder.buildInsert({ tableName: 'u', columns, records: rows });
            db.prepare(r.sql).run(...r.params);
          } else {
            const r = sqliteInsertJson({ tableName: 'u', columns, records: rows });
            db.prepare(r.sql).run(...r.params);
          }
          const state = db.prepare('SELECT * FROM u ORDER BY id').all();
          db.close();
          return state;
        };
        expect(run('json')).toEqual(run('v1'));
      } else {
        const run = async (build: 'v1' | 'json') => {
          await my('DROP TABLE IF EXISTS pj_u', []);
          await my('CREATE TABLE pj_u(id INT PRIMARY KEY, name VARCHAR(50), score DECIMAL(10,2), active TINYINT(1), note VARCHAR(50))', []);
          if (build === 'v1') {
            const r = mysqlSqlBuilder.buildInsert({ tableName: 'pj_u', columns, records: rows });
            await my(r.sql, r.params);
          } else {
            const r = mysqlInsertJson({ tableName: 'pj_u', columns, records: rows });
            await my(r.sql, r.params);
          }
          return my('SELECT * FROM pj_u ORDER BY id', []);
        };
        const jsonState = await run('json');
        const v1State = await run('v1');
        expect(jsonState).toEqual(v1State);
      }
    });
  }

  // ---- heterogeneous createMany (grouped) + DEFAULT/undefined omission ----
  for (const dialect of ['mysql', 'sqlite'] as Dialect[]) {
    it(`[${dialect}] heterogeneous createMany (grouped, DEFAULT-omitted): JSON-form state == v1-form state`, async () => {
      if (dialect === 'mysql') requireMysql();

      // Rows with DIFFERENT column subsets → `compileInsertMany` emits ONE component per
      // sorted-column-set group (age omitted where undefined). v1 baseline runs the SAME
      // grouping via the original builder per group.
      const records = [
        { id: 1, name: 'a', age: 10 },
        { id: 2, name: 'b' }, // age omitted → separate group
        { id: 3, name: 'c', age: 30 },
        { id: 4, name: 'd' }, // age omitted
      ];
      // Group by sorted-column-set (mirrors compileInsertMany / DBModel._insert grouping).
      const groups = new Map<string, { cols: string[]; rows: Record<string, unknown>[] }>();
      for (const r of records) {
        const cols = Object.keys(r).filter((k) => (r as Record<string, unknown>)[k] !== undefined).sort();
        const key = cols.join(',');
        if (!groups.has(key)) groups.set(key, { cols, rows: [] });
        groups.get(key)!.rows.push(r);
      }

      if (dialect === 'sqlite') {
        const run = (build: 'v1' | 'json') => {
          const db = sqliteDb();
          db.exec('CREATE TABLE u(id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
          for (const { cols, rows } of groups.values()) {
            const r =
              build === 'v1'
                ? sqliteSqlBuilder.buildInsert({ tableName: 'u', columns: cols, records: rows })
                : sqliteInsertJson({ tableName: 'u', columns: cols, records: rows });
            db.prepare(r.sql).run(...r.params);
          }
          const state = db.prepare('SELECT * FROM u ORDER BY id').all();
          db.close();
          return state;
        };
        expect(run('json')).toEqual(run('v1'));
      } else {
        const run = async (build: 'v1' | 'json') => {
          await my('DROP TABLE IF EXISTS pj_h', []);
          await my('CREATE TABLE pj_h(id INT PRIMARY KEY, name VARCHAR(50), age INT NULL DEFAULT NULL)', []);
          for (const { cols, rows } of groups.values()) {
            const r =
              build === 'v1'
                ? mysqlSqlBuilder.buildInsert({ tableName: 'pj_h', columns: cols, records: rows })
                : mysqlInsertJson({ tableName: 'pj_h', columns: cols, records: rows });
            await my(r.sql, r.params);
          }
          return my('SELECT * FROM pj_h ORDER BY id', []);
        };
        expect(await run('json')).toEqual(await run('v1'));
      }
    });
  }

  // ---- updateMany + SKIP ------------------------------------------------
  for (const dialect of ['mysql', 'sqlite'] as Dialect[]) {
    it(`[${dialect}] updateMany + SKIP: JSON-form state == v1-form state`, async () => {
      if (dialect === 'mysql') requireMysql();

      const keyColumns = ['id'];
      const updateColumns = ['name', 'age'];
      const records = [
        { id: 1, name: 'A', age: 11 },
        { id: 2, name: 'B', age: 99 },
        { id: 3, name: 'C', age: 33 },
      ];
      // SKIP age on record index 1 (id=2) → its age must stay the seeded value.
      const skipMap = new Map<number, Set<string>>([[1, new Set(['age'])]]);
      const seed = [
        { id: 1, name: 'a', age: 10 },
        { id: 2, name: 'b', age: 20 },
        { id: 3, name: 'c', age: 30 },
      ];

      if (dialect === 'sqlite') {
        const run = (build: 'v1' | 'json') => {
          const db = sqliteDb();
          db.exec('CREATE TABLE u(id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
          const ins = db.prepare('INSERT INTO u VALUES (?,?,?)');
          for (const r of seed) ins.run(r.id, r.name, r.age);
          const r =
            build === 'v1'
              ? sqliteSqlBuilder.buildUpdateMany({ tableName: 'u', keyColumns, updateColumns, records, skipMap })
              : sqliteUpdateManyJson({ tableName: 'u', keyColumns, updateColumns, records, skipMap });
          db.prepare(r.sql).run(...r.params);
          const state = db.prepare('SELECT * FROM u ORDER BY id').all();
          db.close();
          return state;
        };
        const jsonState = run('json');
        const v1State = run('v1');
        expect(jsonState).toEqual(v1State);
        // Explicit SKIP proof: id=2 age unchanged (20), name updated (B).
        expect(jsonState).toContainEqual({ id: 2, name: 'B', age: 20 });
      } else {
        const run = async (build: 'v1' | 'json') => {
          await my('DROP TABLE IF EXISTS pj_um', []);
          await my('CREATE TABLE pj_um(id INT PRIMARY KEY, name VARCHAR(50), age INT)', []);
          for (const r of seed) await my('INSERT INTO pj_um VALUES (?,?,?)', [r.id, r.name, r.age]);
          const r =
            build === 'v1'
              ? mysqlSqlBuilder.buildUpdateMany({ tableName: 'pj_um', keyColumns, updateColumns, records, skipMap })
              : mysqlUpdateManyJson({ tableName: 'pj_um', keyColumns, updateColumns, records, skipMap });
          await my(r.sql, r.params);
          return my('SELECT * FROM pj_um ORDER BY id', []);
        };
        const jsonState = await run('json');
        const v1State = await run('v1');
        expect(jsonState).toEqual(v1State);
        expect(jsonState).toContainEqual({ id: 2, name: 'B', age: 20 });
      }
    });
  }

  // ---- #378: the batch key column is typed from EVERY record, not the first ----------------
  //
  // `[{id:1},{id:1.5}]` used to type the key column from its first value (`id BIGINT PATH`), so MySQL
  // silently rounded 1.5 to 2 and the JOIN updated row 2 — a row no record names. Typed from every
  // record the column reads both keys exactly: 1 updates row 1, 1.5 matches nothing (as a bound
  // `WHERE id = 1.5` would).
  it('[mysql] updateMany with keys [1, 1.5] updates exactly row 1 (#378)', async () => {
    requireMysql();
    await my('DROP TABLE IF EXISTS pj378_um', []);
    await my('CREATE TABLE pj378_um(id INT PRIMARY KEY, v VARCHAR(20) NOT NULL)', []);
    for (const id of [1, 2, 3]) await my('INSERT INTO pj378_um VALUES (?, ?)', [id, 'seed']);
    const r = mysqlUpdateManyJson({
      tableName: 'pj378_um',
      keyColumns: ['id'],
      updateColumns: ['v'],
      records: [{ id: 1, v: 'one' }, { id: 1.5, v: 'EVIL' }],
    });
    const [res] = await myConn!.query(r.sql, r.params);
    expect((res as { affectedRows: number }).affectedRows).toBe(1);
    expect(await my('SELECT id, v FROM pj378_um ORDER BY id', [])).toEqual([
      { id: 1, v: 'one' },
      { id: 2, v: 'seed' },
      { id: 3, v: 'seed' },
    ]);
    await my('DROP TABLE pj378_um', []);
  });

  // ---- Type round-trip (int / bigint / decimal / text / bool / null) via createMany ----
  for (const dialect of ['mysql', 'sqlite'] as Dialect[]) {
    it(`[${dialect}] type round-trip: JSON-form == v1-form for int/bigint/decimal/text/bool/null`, async () => {
      if (dialect === 'mysql') requireMysql();

      // `flag` serialized to 0/1 (as v1 runtime does); `dec_val` avoids MySQL's reserved `dec`.
      const columns = ['id', 'big', 'dec_val', 'txt', 'flag', 'maybe'];
      const rows = [
        { id: 1, big: 9007199254740992, dec_val: 12345.6789, txt: 'unicode 日本', flag: 1, maybe: null },
        { id: 2, big: 1, dec_val: 0.001, txt: '', flag: 0, maybe: 'set' },
      ];
      if (dialect === 'sqlite') {
        const run = (build: 'v1' | 'json') => {
          const db = sqliteDb();
          db.exec('CREATE TABLE r(id INTEGER PRIMARY KEY, big INTEGER, dec_val REAL, txt TEXT, flag INTEGER, maybe TEXT)');
          const r =
            build === 'v1'
              ? sqliteSqlBuilder.buildInsert({ tableName: 'r', columns, records: rows })
              : sqliteInsertJson({ tableName: 'r', columns, records: rows });
          db.prepare(r.sql).run(...r.params);
          const state = db.prepare('SELECT * FROM r ORDER BY id').all();
          db.close();
          return state;
        };
        expect(run('json')).toEqual(run('v1'));
      } else {
        const run = async (build: 'v1' | 'json') => {
          await my('DROP TABLE IF EXISTS pj_r', []);
          await my('CREATE TABLE pj_r(id INT PRIMARY KEY, big BIGINT, dec_val DECIMAL(20,6), txt VARCHAR(100), flag TINYINT(1), maybe VARCHAR(50))', []);
          const r =
            build === 'v1'
              ? mysqlSqlBuilder.buildInsert({ tableName: 'pj_r', columns, records: rows })
              : mysqlInsertJson({ tableName: 'pj_r', columns, records: rows });
          await my(r.sql, r.params);
          return my('SELECT * FROM pj_r ORDER BY id', []);
        };
        expect(await run('json')).toEqual(await run('v1'));
      }
    });
  }
});

// ---------------------------------------------------------------------------
// #376 — MySQL membership must compare a BIGINT / DECIMAL key EXACTLY.
//
// `JSON_UNQUOTE` handed every element back as a STRING, and MySQL compares a string with an integer or
// decimal column as DOUBLE. Keys past 2^53 then collapse onto their double neighbours (256 apart near
// 1.2e18) and long-digit decimals onto theirs, so one bound key deleted / updated / read the
// neighbouring rows too. The seed below plants exactly those neighbours; every surface must touch the
// ONE bound row and nothing else. The SELECTs read BIGINT through `CAST(… AS CHAR)` because the test
// connection returns BIGINT as a (lossy) JS number.
// ---------------------------------------------------------------------------
describe('[mysql] #376 BIGINT / DECIMAL keys match exactly the bound row (no DOUBLE neighbours)', () => {
  const T = 'pj376_keys';
  const BOUND = '1234567890123456789';
  const NEIGHBOURS = ['1234567890123456700', '1234567890123456701', '1234567890123456800'];
  const DEC_BOUND = '12345678901234567890.0000000001';
  const DEC_NEIGHBOUR = '12345678901234567890.0000000002';
  /** The DECLARED column types — what the schema-carrying paths (emitter / relation / adapter) thread. */
  const TYPES = { id: 'BIGINT', tenant: 'INT', nb: 'BIGINT', d: 'DECIMAL(30,10)', label: 'VARCHAR(20)' };

  async function seed(): Promise<void> {
    await my(`DROP TABLE IF EXISTS ${T}`, []);
    await my(
      `CREATE TABLE ${T}(id BIGINT PRIMARY KEY, tenant INT NOT NULL, nb BIGINT NOT NULL, d DECIMAL(30,10) NOT NULL, label VARCHAR(20) NOT NULL)`,
      [],
    );
    // nb mirrors id WITHOUT an index; d plants a 10th-decimal-place neighbour on 700. One tenant, so
    // the tuple-IN cannot be rescued by the tenant column.
    const rows: [string, string][] = [
      [NEIGHBOURS[0], DEC_NEIGHBOUR],
      [NEIGHBOURS[1], '1.5000000000'],
      [BOUND, DEC_BOUND],
      [NEIGHBOURS[2], '2.5000000000'],
    ];
    for (const [id, d] of rows) await my(`INSERT INTO ${T} VALUES (?, 7, ?, ?, 'seed')`, [id, id, d]);
  }

  async function run(m: MakeSQL, params?: unknown[]): Promise<{ affectedRows?: number; rows: { id: string }[] }> {
    const asm = assembleMakeSQL(m);
    const [res] = await myConn!.query(renderPlaceholders(asm.sql, 'mysql'), params ?? asm.params);
    if (Array.isArray(res)) return { rows: res as { id: string }[] };
    return { affectedRows: (res as { affectedRows: number }).affectedRows, rows: [] };
  }

  async function ids(where = '1 = 1'): Promise<string[]> {
    const rows = await my(`SELECT CAST(id AS CHAR) AS id FROM ${T} WHERE ${where} ORDER BY id`, []);
    return rows.map((r) => r.id as string);
  }

  const select = (conditions: Record<string, unknown[]>, columnTypes?: Record<string, string>): MakeSQL =>
    compileSelect({
      dialect: 'mysql',
      tableName: T,
      select: 'CAST(id AS CHAR) AS id',
      conditions,
      order: 'id',
      ...(columnTypes !== undefined ? { columnTypes } : {}),
    });

  it('DELETE (compileDeleteMany) removes only the bound BIGINT key — untyped bigint and typed string', async () => {
    requireMysql();
    for (const variant of [
      { keys: [{ id: BigInt(BOUND) }] },
      { keys: [{ id: BOUND }], columnTypes: { id: TYPES.id } },
    ]) {
      await seed();
      const [op] = compileDeleteMany({ dialect: 'mysql', tableName: T, keyColumns: ['id'], ...variant });
      const res = await run(op);
      expect(res.affectedRows, `affectedRows (${JSON.stringify(variant.columnTypes)})`).toBe(1);
      expect(await ids()).toEqual([...NEIGHBOURS]);
    }
  });

  it('UPDATE (compileUpdateSingle with an array condition) changes only the bound row', async () => {
    requireMysql();
    const variants: { conditions: ConditionObject; columnTypes?: Record<string, string> }[] = [
      { conditions: { id: [BigInt(BOUND)] } },
      { conditions: { id: [BOUND] }, columnTypes: { id: TYPES.id } },
      { conditions: { nb: [BigInt(BOUND)] } },
    ];
    for (const variant of variants) {
      await seed();
      const op = compileUpdateSingle({ dialect: 'mysql', tableName: T, serializedValues: { label: 'hit' }, ...variant });
      const res = await run(op);
      expect(res.affectedRows, `affectedRows ${JSON.stringify(Object.keys(variant.conditions))}`).toBe(1);
      expect(await ids(`label = 'hit'`)).toEqual([BOUND]);
    }
  });

  it('SELECT on the PK and on a non-indexed BIGINT column returns only the bound row', async () => {
    requireMysql();
    await seed();
    for (const col of ['id', 'nb']) {
      expect((await run(select({ [col]: [BigInt(BOUND)] }))).rows, `${col} untyped bigint`).toEqual([{ id: BOUND }]);
      expect((await run(select({ [col]: [BOUND] }, { [col]: TYPES.id }))).rows, `${col} typed string`).toEqual([{ id: BOUND }]);
    }
  });

  it('tuple-IN (composite static membership) returns only the bound tuple', async () => {
    requireMysql();
    await seed();
    const param = encodeJsonArrayParam('mysql', [[7, BigInt(BOUND)]]);
    for (const keyTypes of [undefined, [TYPES.tenant, TYPES.nb]]) {
      const op = compileCompositeKeyStaticUnlimited({
        dialect: 'mysql',
        tableName: T,
        select: 'CAST(id AS CHAR) AS id',
        targetKeys: ['tenant', 'nb'],
        ...(keyTypes !== undefined ? { keyTypes } : {}),
      });
      expect((await run(op, [param])).rows, `keyTypes ${JSON.stringify(keyTypes)}`).toEqual([{ id: BOUND }]);
    }
  });

  it('DECIMAL(30,10) IN returns only the row equal to the 10th decimal place', async () => {
    requireMysql();
    await seed();
    expect((await run(select({ d: [DEC_BOUND] }, { d: TYPES.d }))).rows).toEqual([{ id: BOUND }]);
    // With no declared type the comparison must still never widen onto the neighbour.
    expect((await run(select({ d: [DEC_BOUND] }))).rows).not.toContainEqual({ id: NEIGHBOURS[0] });
  });
});

// ---------------------------------------------------------------------------
// #383 — a BIGINT UNSIGNED key at or above 2^63 reaches its row.
//
// The JSON param carried a bc `int` as a JSON NUMBER, and MySQL reads a JSON integer above the signed
// 64-bit max into `DECIMAL(65,30)` as a NEGATIVE number (2^63+5 → -9223372036854775803), so a
// deleteMany / updateMany keyed by it matched nothing and the write was silently lost. Such a key goes
// as a digit string, which the DECIMAL read takes exactly.
// ---------------------------------------------------------------------------
describe('[mysql] #383 BIGINT UNSIGNED keys >= 2^63 hit exactly their row', () => {
  const T = 'pj383_u';
  const KEY = 2n ** 63n + 5n;
  const IDS = [KEY - 1n, KEY, KEY + 1n, 5n].map(String);
  const TYPES = { k: 'BIGINT UNSIGNED', v: 'VARCHAR(20)' };

  async function seed(): Promise<void> {
    await my(`DROP TABLE IF EXISTS ${T}`, []);
    await my(`CREATE TABLE ${T}(k BIGINT UNSIGNED PRIMARY KEY, v VARCHAR(20) NOT NULL)`, []);
    for (const k of IDS) await my(`INSERT INTO ${T} VALUES (?, 'seed')`, [k]);
  }
  const state = async (): Promise<string[]> =>
    (await my(`SELECT CAST(k AS CHAR) AS k, v FROM ${T} ORDER BY k`, [])).map((r) => `${String(r.k)}:${String(r.v)}`);

  it('deleteMany deletes exactly the 2^63+5 row', async () => {
    requireMysql();
    await seed();
    const [op] = compileDeleteMany({ dialect: 'mysql', tableName: T, keyColumns: ['k'], keys: [{ k: KEY }], columnTypes: { k: TYPES.k } });
    const asm = assembleMakeSQL(op);
    const [res] = await myConn!.query(renderPlaceholders(asm.sql, 'mysql'), asm.params);
    expect((res as { affectedRows: number }).affectedRows).toBe(1);
    expect(await state()).toEqual(['5:seed', `${KEY - 1n}:seed`, `${KEY + 1n}:seed`]);
  });

  it('updateMany updates exactly the 2^63+5 row', async () => {
    requireMysql();
    await seed();
    const r = mysqlUpdateManyJson({ tableName: T, keyColumns: ['k'], updateColumns: ['v'], records: [{ k: KEY, v: 'hit' }], columnTypes: TYPES });
    const [res] = await myConn!.query(r.sql, r.params);
    expect((res as { affectedRows: number }).affectedRows).toBe(1);
    expect(await state()).toEqual(['5:seed', `${KEY - 1n}:seed`, `${KEY}:hit`, `${KEY + 1n}:seed`]);
  });
});
