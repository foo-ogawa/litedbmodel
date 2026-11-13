/**
 * #357 — a lazy relation whose key is NULL relates to nothing, whatever else the batch loaded.
 *
 * LazyRelationContext.getRelation stringified the record's key to look it up: `String(null)` is 'null'
 * (and a composite NULL part joined as ''), so a NULL-FK record resolved to a related row whose key is
 * the TEXT 'null' / '' — a row loaded only because another record of the same batch references it.
 * Loaded alone, it was null.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll } from 'vitest';
import { DBModel, model, column, belongsTo, hasMany } from '../../src';
import type { ColumnsOf } from '../../src';

const Base = DBModel.createDBBase({ database: ':memory:', driver: 'sqlite', max: 1 } as never);

@model('lrn_user')
class UserModel extends Base {
  @column.number({ primaryKey: true }) id?: number;
  @column() handle?: string;
}
const User = UserModel as typeof UserModel & ColumnsOf<UserModel>;

@model('lrn_item')
class ItemModel extends Base {
  @column.number({ primaryKey: true }) id?: number;
  @column() owner?: string;
  @belongsTo(() => [Item.owner, User.handle])
  declare ownerRow: Promise<UserModel | null>;
}
const Item = ItemModel as typeof ItemModel & ColumnsOf<ItemModel>;

@model('lrn_child')
class ChildModel extends Base {
  @column.number({ primaryKey: true }) id?: number;
  @column() org?: string;
  @column() code?: string;
}
const Child = ChildModel as typeof ChildModel & ColumnsOf<ChildModel>;

@model('lrn_parent')
class ParentModel extends Base {
  @column.number({ primaryKey: true }) id?: number;
  @column() org?: string;
  @column() code?: string;
  @hasMany(() => [[Parent.org, Child.org], [Parent.code, Child.code]])
  declare kids: Promise<ChildModel[]>;
}
const Parent = ParentModel as typeof ParentModel & ColumnsOf<ParentModel>;

beforeAll(async () => {
  await Base.transaction(async () => {
    await Base.execute('CREATE TABLE lrn_user (id INTEGER PRIMARY KEY, handle TEXT NOT NULL UNIQUE)');
    await Base.execute('CREATE TABLE lrn_item (id INTEGER PRIMARY KEY, owner TEXT)');
    await Base.execute("INSERT INTO lrn_user VALUES (10, 'bob'), (20, 'null')");
    await Base.execute("INSERT INTO lrn_item VALUES (1, NULL), (2, 'null'), (3, 'bob')");
    await Base.execute('CREATE TABLE lrn_parent (id INTEGER PRIMARY KEY, org TEXT, code TEXT)');
    await Base.execute('CREATE TABLE lrn_child (id INTEGER PRIMARY KEY, org TEXT, code TEXT)');
    await Base.execute("INSERT INTO lrn_parent VALUES (1, 'acme', NULL), (2, 'acme', '')");
    await Base.execute("INSERT INTO lrn_child VALUES (100, 'acme', '')");
  });
});

describe('lazy relations never resolve a NULL key (#357)', () => {
  it("belongsTo: a NULL FK batched with an FK of text 'null' resolves to null", async () => {
    const items = await Item.find([], { order: 'id' });
    const owners = await Promise.all(items.map(async (i) => (await i.ownerRow)?.id ?? null));
    expect(owners).toEqual([null, 20, 10]);
  });

  it("hasMany: a composite key with a NULL part does not receive the child whose part is ''", async () => {
    const parents = await Parent.find([], { order: 'id' });
    const kids = await Promise.all(parents.map(async (p) => (await p.kids).map((c) => c.id)));
    expect(kids).toEqual([[], [100]]);
  });
});
