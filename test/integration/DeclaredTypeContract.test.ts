/**
 * The DECLARED type of a column and the value `find()` returns must be the SAME type — on every
 * dialect (issue #286).
 *
 * A model's `@column.*` family is the type authority: it states both what the caller declares and
 * what the read path materializes. Nothing here is read back from the compiler, so it holds
 * identically under tsc, esbuild/tsx and standard decorators.
 *
 * {@link DECLARED} IS the assertion: property → the `typeof` its declared type demands. A family
 * whose read contract drifts from the type models declare for it fails here — the gate the
 * "declared `Date`, got `string`" defect got past.
 *
 * Requires live PG (:5433) + MySQL (:3307). Bring up: `npm run docker:livedb:up`. SQLite is in-process.
 */

import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DBModel, model, column, closeAllPools } from '../../src';
import type { ColumnsOf } from '../../src';
import { skipIntegrationTests, pgConfig, mysqlConfig, sqliteConfig } from '../helpers/setup';

// The declared types are the CONTRACT: `@column.datetime()` / `.date()` / `.bigint()` read back a
// string (issue #9's read realignment), so a model declares a string for them.
const PgBase = DBModel.createDBBase(pgConfig);
const MyBase = DBModel.createDBBase(mysqlConfig);
const LiteBase = DBModel.createDBBase(sqliteConfig);

@model('dtc_types')
class TypesPgModel extends PgBase {
  @column.bigint({ primaryKey: true, autoIncrement: true }) id?: bigint;
  @column.text() t_text?: string;
  @column.bigint() n_int?: bigint;
  @column.text() n_num?: string;
  @column.bigint() n_big?: bigint;
  @column.datetime() t_stamp?: string;
  @column.date() d_date?: string;
  @column.boolean() b_flag?: boolean;
}
@model('dtc_types')
class TypesMyModel extends MyBase {
  @column.bigint({ primaryKey: true, autoIncrement: true }) id?: bigint;
  @column.text() t_text?: string;
  @column.bigint() n_int?: bigint;
  @column.text() n_num?: string;
  @column.bigint() n_big?: bigint;
  @column.datetime() t_stamp?: string;
  @column.date() d_date?: string;
  @column.boolean() b_flag?: boolean;
}
@model('dtc_types')
class TypesLiteModel extends LiteBase {
  @column.bigint({ primaryKey: true, autoIncrement: true }) id?: bigint;
  @column.text() t_text?: string;
  @column.bigint() n_int?: bigint;
  @column.text() n_num?: string;
  @column.bigint() n_big?: bigint;
  @column.datetime() t_stamp?: string;
  @column.date() d_date?: string;
  @column.boolean() b_flag?: boolean;
}

/** property → the `typeof` its DECLARED type demands. */
const DECLARED: Record<string, string> = {
  id: 'bigint', t_text: 'string', n_int: 'bigint', n_num: 'string',
  n_big: 'bigint', t_stamp: 'string', d_date: 'string', b_flag: 'boolean',
};

const DIALECTS = [
  {
    name: 'postgres',
    Base: PgBase,
    Model: TypesPgModel as typeof TypesPgModel & ColumnsOf<TypesPgModel>,
    ddl: `CREATE TABLE dtc_types (
      id serial PRIMARY KEY, t_text text NOT NULL, n_int integer NOT NULL, n_num numeric(10,2) NOT NULL,
      n_big bigint NOT NULL, t_stamp timestamptz NOT NULL, d_date date NOT NULL, b_flag boolean NOT NULL)`,
  },
  {
    name: 'mysql',
    Base: MyBase,
    Model: TypesMyModel as typeof TypesMyModel & ColumnsOf<TypesMyModel>,
    ddl: `CREATE TABLE dtc_types (
      id int AUTO_INCREMENT PRIMARY KEY, t_text text NOT NULL, n_int int NOT NULL, n_num decimal(10,2) NOT NULL,
      n_big bigint NOT NULL, t_stamp timestamp NOT NULL, d_date date NOT NULL, b_flag boolean NOT NULL)`,
  },
  {
    name: 'sqlite',
    Base: LiteBase,
    Model: TypesLiteModel as typeof TypesLiteModel & ColumnsOf<TypesLiteModel>,
    ddl: `CREATE TABLE dtc_types (
      id integer PRIMARY KEY AUTOINCREMENT, t_text text NOT NULL, n_int integer NOT NULL, n_num numeric NOT NULL,
      n_big bigint NOT NULL, t_stamp timestamp NOT NULL, d_date date NOT NULL, b_flag boolean NOT NULL)`,
  },
] as const;

describe.skipIf(skipIntegrationTests)('declared type === value type (#286)', () => {
  afterAll(async () => { await closeAllPools(); });

  for (const { name, Base, Model, ddl } of DIALECTS) {
    describe(name, () => {
      beforeAll(async () => {
        await Base.execute('DROP TABLE IF EXISTS dtc_types');
        await Base.execute(ddl);
        await Base.transaction(async () =>
          Model.create([
            [Model.t_text, 'hello'],
            [Model.n_int, 42n],
            [Model.n_num, '12.34'],
            [Model.n_big, 9007199254740993n],
            [Model.t_stamp, new Date('2026-11-01T10:00:00Z')],
            [Model.d_date, '2026-11-01'],
            [Model.b_flag, true],
          ]),
        );
      });

      afterAll(async () => { await Base.execute('DROP TABLE IF EXISTS dtc_types'); });

      it('every column reads back as the type its family declares', async () => {
        const [row] = await Model.find([]);
        const r = row as unknown as Record<string, unknown>;
        const actual = Object.fromEntries(
          Object.keys(DECLARED).map((k) => [k, r[k] instanceof Date ? 'Date' : typeof r[k]]),
        );
        expect(actual).toEqual(DECLARED);
      });

      it('an integer keeps its exact value, and JSON needs a conversion at the boundary', async () => {
        const [row] = await Model.find([]);
        const r = row as unknown as Record<string, unknown>;
        // Exact: a JS number would have rounded this to …92.
        expect(r.n_big).toBe(9007199254740993n);
        // A JS bigint is not JSON — that is the language, not this library. `JSON.stringify` throws
        // unless the caller converts, so the contract is stated here rather than hidden.
        expect(() => JSON.stringify(row)).toThrow(/BigInt/);
        const json = JSON.parse(
          JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        ) as Record<string, unknown>;
        expect(json.n_big).toBe('9007199254740993');
        // The date family carries no bigint: those columns are strings and survive as they are.
        expect(typeof json.t_stamp).toBe('string');
        expect(json.d_date).toBe('2026-11-01');
      });

      it('a text column REFUSES a value it cannot serialize (no silent {} in the row)', async () => {
        // `WriteValue` widens every string-reading column to accept the Date/bigint a datetime or
        // bigint column serializes, because `Column<V>` carries only the READ type. The FAMILY knows
        // better: a Date handed to a text column reached the driver unserialized and PostgreSQL
        // stored `{}`. It is refused instead, naming the family that would have taken it.
        await expect(
          Base.transaction(async () => Model.create([[Model.t_text, new Date() as unknown as string]])),
        ).rejects.toThrow(/@column\.text\(\) received a Date/);
        const [row] = await Model.find([]);
        expect((row as unknown as Record<string, unknown>).t_text).toBe('hello');
      });

      it('the DRIVER plane is unchanged by the family', async () => {
        // The driver plane and the family now AGREE: both hand back a JS bigint for an integer
        // (`configurePgDeboxTypeParsers` / `mysqlDeboxPoolOptions`), which is behavior-contracts'
        // `int`. The v1 in-proc SQLite path has no `safeIntegers`, so a RAW statement still returns a
        // JS number there — the family's materializer is what makes the declared column exact.
        const res = await Base.execute('SELECT n_int FROM dtc_types');
        const raw = (res.rows as Record<string, unknown>[])[0].n_int;
        expect(typeof raw).toBe(name === 'sqlite' ? 'number' : 'bigint');
        expect(raw).toBe(name === 'sqlite' ? 42 : 42n);
      });
    });
  }
});
