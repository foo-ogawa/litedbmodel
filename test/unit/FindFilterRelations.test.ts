/**
 * A target model's `@model({ filter })` applies to its relation loads whether or not the relation
 * declares a per-parent `limit` — the window form reads the target through `buildSelectSQL`, which adds
 * no default filter of its own, so the filter is joined into the window's conditions.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll } from 'vitest';
import { DBModel, model, column, hasMany } from '../../src';
import type { ColumnsOf } from '../../src';

const Base = DBModel.createDBBase({ database: ':memory:', driver: 'sqlite', max: 1 } as never);

@model('ffr_entry', { filter: () => [[Entry.is_deleted, 0]] })
class EntryModel extends Base {
  @column.number({ primaryKey: true }) id?: number;
  @column.number() owner_id?: number;
  @column.text() org?: string;
  @column.number() is_deleted?: number;
}
const Entry = EntryModel as typeof EntryModel & ColumnsOf<EntryModel>;

@model('ffr_owner')
class OwnerModel extends Base {
  @column.number({ primaryKey: true }) id?: number;
  @column.text() org?: string;
  @hasMany(() => [Owner.id, Entry.owner_id])
  declare entries: Promise<EntryModel[]>;
  @hasMany(() => [Owner.id, Entry.owner_id], { limit: 10, order: () => Entry.id.asc() })
  declare entriesLimited: Promise<EntryModel[]>;
  @hasMany(() => [[Owner.id, Entry.owner_id], [Owner.org, Entry.org]], { limit: 10, order: () => Entry.id.asc() })
  declare entriesLimitedComposite: Promise<EntryModel[]>;
}
const Owner = OwnerModel as typeof OwnerModel & ColumnsOf<OwnerModel>;

beforeAll(async () => {
  await Base.execute('CREATE TABLE ffr_entry (id INTEGER PRIMARY KEY, owner_id INTEGER, org TEXT, is_deleted INTEGER)');
  await Base.execute("INSERT INTO ffr_entry VALUES (1, 1, 'acme', 0), (2, 1, 'acme', 1), (3, 2, 'acme', 0)");
  await Base.execute('CREATE TABLE ffr_owner (id INTEGER PRIMARY KEY, org TEXT)');
  await Base.execute("INSERT INTO ffr_owner VALUES (1, 'acme'), (2, 'acme')");
});

const load = async (rel: 'entries' | 'entriesLimited' | 'entriesLimitedComposite') => {
  const owners = await Owner.find([], { order: 'id' });
  return Promise.all(owners.map(async (o) => (await o[rel]).map((e) => e.id)));
};

describe("a relation load applies the target's default filter", () => {
  it('without a limit', async () => {
    expect(await load('entries')).toEqual([[1], [3]]);
  });

  it('with a per-parent limit', async () => {
    expect(await load('entriesLimited')).toEqual([[1], [3]]);
  });

  it('with a per-parent limit on a composite key', async () => {
    expect(await load('entriesLimitedComposite')).toEqual([[1], [3]]);
  });
});
