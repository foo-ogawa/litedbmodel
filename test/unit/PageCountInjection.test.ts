/**
 * #356 — `limit` / `offset` never become SQL text unless they are non-negative integers.
 *
 * Both v1 select builders inlined `LIMIT ${options.limit}` / `OFFSET ${options.offset}` with no check,
 * so a request value (a string at run time, whatever the `number` type says) became SQL: on PostgreSQL a
 * param-less find ran `… OFFSET 0; DELETE …` as a second statement.
 */
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { DBModel, model, column } from '../../src';
import { PooledAsyncContext, type AsyncConnection, type AsyncConnectionPool } from '../../src/scp';

const sent: string[] = [];
const conn: AsyncConnection = {
  async execute(sql) {
    sent.push(sql);
    return [{ id: 1 }];
  },
  async run(sql) {
    sent.push(sql);
    return { changes: 0, lastInsertRowid: 0 };
  },
};
const pool: AsyncConnectionPool = { async acquire() { return conn; }, async release() {} };
const runtime = { ctx: new PooledAsyncContext(pool), dialect: 'postgres', close: async () => {} } as never;
class Base extends DBModel {
  protected static _getScpRuntime() { return runtime; }
}
@model('page_items')
class ItemModel extends Base {
  @column.number({ primaryKey: true }) id?: number;
}
const Item = ItemModel.asModel();

const injected = ['1; DELETE FROM page_items', '(SELECT 1)', -1, 1.5, Number.NaN];

describe('page counts are validated before they become SQL text (#356)', () => {
  it.each(injected)('find() rejects limit %j before sending anything', async (limit) => {
    sent.length = 0;
    await expect(Item.find([], { limit: limit as number })).rejects.toBeInstanceOf(TypeError);
    expect(sent).toEqual([]);
  });

  it.each(injected)('find() rejects offset %j before sending anything', async (offset) => {
    sent.length = 0;
    await expect(Item.find([], { limit: 10, offset: offset as number })).rejects.toBeInstanceOf(TypeError);
    expect(sent).toEqual([]);
  });

  it('buildSelectSQL() rejects a non-integer limit', () => {
    expect(() => Item.buildSelectSQL({}, { limit: '1; SELECT 1' as unknown as number })).toThrow(TypeError);
  });

  it('integer page counts are rendered as before', async () => {
    sent.length = 0;
    await Item.find([], { limit: 10, offset: 0 });
    expect(sent).toEqual(['SELECT * FROM page_items LIMIT 10 OFFSET 0']);
  });
});
