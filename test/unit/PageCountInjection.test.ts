/**
 * #356 — `limit` / `offset` never become SQL text unless they are non-negative integers.
 *
 * Both select builders inlined `LIMIT ${options.limit}` / `OFFSET ${options.offset}` with no check,
 * so a request value (a string at run time, whatever the `number` type says) became SQL: on PostgreSQL a
 * param-less find ran `… OFFSET 0; DELETE …` as a second statement.
 */
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { DBModel, model, column } from '../../src';

const sent: string[] = [];

@model('page_items')
class ItemModel extends DBModel {
  @column.number({ primaryKey: true }) id?: number;

  // Capture the statement instead of sending it: the builder runs before this is reached.
  static query(sql: string): Promise<never[]> {
    sent.push(sql);
    return Promise.resolve([]);
  }
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

  it('buildSelectSQL() rejects a non-integer offset', () => {
    expect(() => Item.buildSelectSQL({}, { offset: '0; SELECT 1' as unknown as number })).toThrow(TypeError);
  });

  it('integer page counts are rendered as before', async () => {
    sent.length = 0;
    await Item.find([], { limit: 10, offset: 0 });
    expect(sent).toEqual(['SELECT * FROM page_items LIMIT 10 OFFSET 0']);
  });
});
