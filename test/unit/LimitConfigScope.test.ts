/**
 * #354 — the find / hasMany hard limits are read from the CALLING model's class chain.
 *
 * `createDBBase(config, { findHardLimit, hasManyHardLimit })` stores the caps on the generated base,
 * and `Base.setLimitConfig()` writes the base's own static. The enforcement sites read the root
 * `DBModel._limitConfig` instead, so a cap configured for a base was never applied to its models
 * (no `LIMIT N+1`, no `LimitExceededError`) while `Base.getLimitConfig()` reported it as active.
 */
import 'reflect-metadata';
import { afterEach, describe, it, expect } from 'vitest';
import { DBModel, model, column, LimitExceededError } from '../../src';
import { PooledAsyncContext, type AsyncConnection, type AsyncConnectionPool } from '../../src/scp';

const sent: string[] = [];
const FIVE_ROWS = [1, 2, 3, 4, 5].map((id) => ({ id, name: `u${id}` }));
const conn: AsyncConnection = {
  async execute(sql) {
    sent.push(sql);
    return FIVE_ROWS.map((r) => ({ ...r }));
  },
  async run(sql) {
    sent.push(sql);
    return { changes: 0, lastInsertRowid: 0 };
  },
};
const pool: AsyncConnectionPool = { async acquire() { return conn; }, async release() {} };
const runtime = { ctx: new PooledAsyncContext(pool), dialect: 'postgres', close: async () => {} } as never;

const dummy = { host: '127.0.0.1', port: 1, database: 'dummy', user: 'dummy', password: 'dummy' };

const BaseDB = DBModel.createDBBase(dummy, { findHardLimit: 2, hasManyHardLimit: 2 });
class StubBase extends BaseDB {
  protected static _getScpRuntime() { return runtime; }
}
@model('limit_scope_items')
class ItemModel extends StubBase {
  @column.number({ primaryKey: true }) id?: number;
  @column.text() name?: string;
}
const Item = ItemModel.asModel();

const OtherBase = DBModel.createDBBase(dummy);
class OtherStubBase extends OtherBase {
  protected static _getScpRuntime() { return runtime; }
}
@model('limit_scope_others')
class OtherModel extends OtherStubBase {
  @column.number({ primaryKey: true }) id?: number;
  @column.text() name?: string;
}
const Other = OtherModel.asModel();

afterEach(() => {
  sent.length = 0;
  BaseDB.setLimitConfig({ findHardLimit: 2, hasManyHardLimit: 2 });
});

describe('hard limits configured on a createDBBase base apply to its models (#354)', () => {
  it('find() injects LIMIT cap+1 and throws past the base findHardLimit', async () => {
    await expect(Item.find([])).rejects.toBeInstanceOf(LimitExceededError);
    expect(sent).toEqual(['SELECT * FROM limit_scope_items LIMIT 3']);
  });

  it('the relation loader enforces the base hasManyHardLimit', async () => {
    await expect(
      (ItemModel as unknown as { _selectForRelation: (c: object, o: object, r: object) => Promise<unknown[]> })
        ._selectForRelation({}, {}, {}),
    ).rejects.toBeInstanceOf(LimitExceededError);
    expect(sent).toEqual(['SELECT * FROM limit_scope_items LIMIT 3']);
  });

  it('Base.setLimitConfig() changes what the base models enforce', async () => {
    BaseDB.setLimitConfig({ findHardLimit: 10 });
    await expect(Item.find([])).resolves.toHaveLength(5);
    expect(sent).toEqual(['SELECT * FROM limit_scope_items LIMIT 11']);
  });

  it("one base's caps do not leak into another base's models", async () => {
    await expect(Other.find([])).resolves.toHaveLength(5);
    expect(sent).toEqual(['SELECT * FROM limit_scope_others']);
  });
});
