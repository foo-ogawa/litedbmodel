/**
 * The `litedbmodel/drivers` literal helpers splice their value into the SQL text, so a string is encoded
 * for the dialect's literal rules (it can never close the literal) and a number must be a finite number.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll } from 'vitest';
import { DBModel, model, column } from '../../src';
import type { ColumnsOf } from '../../src';
import * as drivers from '../../src/drivers';
import { pgNumericArray } from '../../src/drivers/PostgresHelper';

const Base = DBModel.createDBBase({ database: ':memory:', driver: 'sqlite', max: 1 } as never);

@model('lhe_post')
class PostModel extends Base {
  @column.number({ primaryKey: true }) id?: number;
  @column.stringArray() tags?: string[];
}
const Post = PostModel as typeof PostModel & ColumnsOf<PostModel>;

beforeAll(async () => {
  await Base.execute('CREATE TABLE lhe_post (id INTEGER PRIMARY KEY, tags TEXT)');
  await Base.execute("INSERT INTO lhe_post VALUES (1, '[]'), (2, '[]')");
  await Base.execute('CREATE TABLE lhe_secret (secret TEXT)');
  await Base.execute("INSERT INTO lhe_secret VALUES ('DUMMY-SECRET')");
});

const breakout = "x'||(SELECT secret FROM lhe_secret LIMIT 1)||'";

describe('SQLite JSON helpers', () => {
  it('double every quote of the JSON text', () => {
    expect(drivers.jsonStringArray(["O'Brien"]).value).toBe(`'["O''Brien"]'`);
    expect(drivers.jsonObject({ a: "it's" }).value).toBe(`'{"a":"it''s"}'`);
    expect(drivers.jsonIntArray([1, 2]).value).toBe(`'[1,2]'`);
  });

  it('store a quote-bearing value as data', async () => {
    const stored = await Base.transaction(async () => {
      await Post.update([[Post.id, 1]] as never, [[Post.tags, drivers.jsonStringArray([breakout])]] as never);
      await Post.update([[Post.id, 2]] as never, [[Post.tags, drivers.jsonStringArray(["O'Brien"])]] as never);
      return (await Post.find([], { order: 'id' })).map((p) => p.tags);
    }, { rollbackOnly: true });
    expect(stored).toEqual([[breakout], ["O'Brien"]]);
  });

  it('compare a quote-bearing value as data', async () => {
    const rows = await Post.find([[Post.tags, drivers.jsonStringArray(["x' OR 1=1 OR '"])]] as never);
    expect(rows).toEqual([]);
  });
});

describe('MySQL JSON helpers', () => {
  it('carry the JSON text as the hexadecimal literal of its UTF-8 bytes', () => {
    const text = JSON.stringify(['a"b\\c\'d']);
    expect(drivers.mysqlJsonStringArray(['a"b\\c\'d']).value).toBe(
      `CAST(CONVERT(X'${Buffer.from(text, 'utf8').toString('hex')}' USING utf8mb4) AS JSON)`,
    );
    expect(drivers.mysqlJsonObject({ k: 'v' }).value).toBe(`CAST(CONVERT(X'${Buffer.from('{"k":"v"}').toString('hex')}' USING utf8mb4) AS JSON)`);
    expect(drivers.mysqlJsonIntArray([1]).value).toBe(`CAST(CONVERT(X'${Buffer.from('[1]').toString('hex')}' USING utf8mb4) AS JSON)`);
  });
});

describe('numeric helpers accept only a finite number', () => {
  const notNumber = '1]::int[] IS NOT NULL OR ARRAY[1' as unknown as number;
  it.each([
    ['pgIntArray', () => drivers.pgIntArray([notNumber])],
    ['pgNumericArray', () => pgNumericArray([notNumber])],
    ['pgTimeAfter', () => drivers.pgTimeAfter(notNumber, 'day')],
    ['pgDayAfter', () => drivers.pgDayAfter(notNumber)],
    ['sqliteTimeAfter', () => drivers.sqliteTimeAfter(notNumber, 'days')],
    ['sqliteDayAfter', () => drivers.sqliteDayAfter(notNumber)],
    ['mysqlTimeAfter', () => drivers.mysqlTimeAfter(notNumber, 'DAY')],
    ['mysqlDayAfter', () => drivers.mysqlDayAfter(notNumber)],
  ])('%s rejects a non-number', (_name, call) => {
    expect(call).toThrow(/must be a finite number/);
  });

  it('render a number as before', () => {
    expect(drivers.pgIntArray([1, 2]).value).toBe('ARRAY[1,2]::INTEGER[]');
    expect(pgNumericArray([1.5, null]).value).toBe('ARRAY[1.5,NULL]::NUMERIC[]');
    expect(drivers.pgTimeAfter(3, 'day').value).toBe("NOW() + INTERVAL '3 day'");
    expect(drivers.sqliteDayAfter(7).value).toBe("date('now', '+7 days')");
    expect(drivers.mysqlDayAfter(7).value).toBe('DATE_ADD(CURDATE(), INTERVAL 7 DAY)');
  });
});
