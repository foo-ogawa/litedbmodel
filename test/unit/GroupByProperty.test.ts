/**
 * `groupByProperty` / `hashByProperty` key their result by a stored value, so every value — including
 * `constructor` and `__proto__` — is an ordinary key of the result.
 */
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { DBModel } from '../../src';

class Row extends DBModel {
  declare title?: string;
}

const rows = (...titles: string[]) => titles.map((title) => Object.assign(new Row(), { title }));

describe('value-keyed helpers', () => {
  it('groupByProperty groups rows whose value is a prototype member name', () => {
    const records = rows('constructor', '__proto__', 'x', 'x');
    const grouped = DBModel.groupByProperty(records, 'title');
    expect(Object.keys(grouped).sort()).toEqual(['__proto__', 'constructor', 'x']);
    expect(grouped['constructor']).toEqual([records[0]]);
    expect(grouped['__proto__']).toEqual([records[1]]);
    expect(grouped['x']).toEqual([records[2], records[3]]);
  });

  it('hashByProperty keeps rows whose value is a prototype member name', () => {
    const records = rows('constructor', '__proto__', 'x');
    const hashed = DBModel.hashByProperty(records, 'title');
    expect(Object.keys(hashed).sort()).toEqual(['__proto__', 'constructor', 'x']);
    expect(hashed['__proto__']).toBe(records[1]);
  });
});
