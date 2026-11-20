/**
 * Every element of a condition array is one more AND member, and every value fills exactly the `?`s
 * of its own condition.
 *
 * A condition array is converted to a key-unique object keyed by column / SQL fragment / special key
 * (`__or__`, `__exists__`, …), so a repeated key must not replace the member before it. The params are
 * bound by position, so a value count that differs from the key's `?` count must fail rather than shift
 * the following conditions' values onto the wrong placeholders.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll } from 'vitest';
import { DBModel, model, column, hasMany, sql, condsToRecord } from '../../src';
import type { ColumnsOf } from '../../src';
import { DBConditions } from '../../src/DBConditions';

const Base = DBModel.createDBBase({ database: ':memory:', driver: 'sqlite', max: 1 } as never);

@model('cm_post')
class PostModel extends Base {
  @column.number({ primaryKey: true }) id?: number;
  @column.number() owner_id?: number;
  @column.text() visibility?: string;
  @column.text() title?: string;
  @column.number() tenant_id?: number;
  @column.number() price?: number;
}
const Post = PostModel as typeof PostModel & ColumnsOf<PostModel>;

@model('cm_owner')
class OwnerModel extends Base {
  @column.number({ primaryKey: true }) id?: number;
  @hasMany(() => [Owner.id, Post.owner_id], { where: () => [[Post.owner_id, 2]] })
  declare postsOfTwo: Promise<PostModel[]>;
}
const Owner = OwnerModel as typeof OwnerModel & ColumnsOf<OwnerModel>;

beforeAll(async () => {
  await Base.execute('CREATE TABLE cm_post (id INTEGER PRIMARY KEY, owner_id INTEGER, visibility TEXT, title TEXT, tenant_id INTEGER, price INTEGER)');
  await Base.execute("INSERT INTO cm_post VALUES (1, 1, 'public', 'a1', 1, 10), (2, 2, 'private', 'a2', 2, 20), (3, 2, 'private', 'b3', 2, 30)");
  await Base.execute('CREATE TABLE cm_owner (id INTEGER PRIMARY KEY)');
  await Base.execute('INSERT INTO cm_owner VALUES (1), (2)');
});

const compile = (rec: Record<string, unknown>) => {
  const params: unknown[] = [];
  return { sql: new DBConditions(rec as never).compile(params), params };
};

describe('a repeated key is one more AND member', () => {
  const twoOrs = () => [
    Post.or([[Post.owner_id, 1]], [[Post.visibility, 'public']]),
    Post.or([[sql`${Post.title} LIKE ?`, '%a%']], [[Post.title, 'a']]),
  ];

  it('two or() groups both reach the WHERE', () => {
    const { sql: where, params } = compile(condsToRecord(twoOrs() as never));
    expect(where).toBe('((owner_id = ?) OR (visibility = ?)) AND (((title LIKE ?) OR (title = ?)))');
    expect(params).toEqual([1, 'public', '%a%', 'a']);
  });

  it('the same column twice keeps both predicates', () => {
    const { sql: where, params } = compile(condsToRecord([[Post.tenant_id, 1], [Post.tenant_id, 2]] as never));
    expect(where).toBe('tenant_id = ? AND (tenant_id = ?)');
    expect(params).toEqual([1, 2]);
  });

  it('find returns only the rows every member admits', async () => {
    const rows = await Post.find(twoOrs() as never, { order: 'id' });
    expect(rows.map((p) => p.id)).toEqual([1]);
  });

  it('delete removes only the rows every member admits', async () => {
    const left = await Base.transaction(
      async () => {
        await Post.delete([[Post.tenant_id, 1], [Post.tenant_id, 2]] as never);
        return (await Post.find([], { order: 'id' })).map((p) => p.id);
      },
      { rollbackOnly: true },
    );
    expect(left).toEqual([1, 2, 3]);
  });

  it("a relation's where on the key column ANDs with the key, never replaces it", async () => {
    const owners = await Owner.find([], { order: 'id' });
    const posts = await Promise.all(owners.map(async (o) => (await o.postsOfTwo).map((p) => p.id)));
    expect(posts).toEqual([[], [2, 3]]);
  });
});

describe("a value fills exactly its condition's placeholders", () => {
  it.each([
    ['more values than placeholders', { 'price BETWEEN ? AND ?': [0, 1000000, 2], owner_id: 1 }],
    ['a scalar for two placeholders', { 'price BETWEEN ? AND ?': 5, owner_id: 1 }],
    ['fewer values than placeholders', { 'price BETWEEN ? AND ?': [5], owner_id: 1 }],
  ])('%s throws', (_label, rec) => {
    expect(() => compile(rec)).toThrow(/placeholder\(s\) but \d+ value\(s\)/);
  });

  it.each([
    ['true', true],
    ['false', false],
    ['null', null],
  ])('%s is bound to the key\'s placeholder', (_label, value) => {
    expect(compile({ 'title = ?': value, owner_id: 1 })).toEqual({ sql: 'title = ? AND owner_id = ?', params: [value, 1] });
  });

  it('a boolean interpolated by the sql tag is bound', () => {
    expect(compile(condsToRecord([sql`${Post.visibility} = ${true}`, [Post.owner_id, 1]] as never))).toEqual({
      sql: 'visibility = ? AND owner_id = ?',
      params: [true, 1],
    });
  });

  it('the IN-list idiom and a positional match still bind every value', () => {
    expect(compile({ 'id IN (?)': [1, 2, 3] })).toEqual({ sql: 'id IN (?, ?, ?)', params: [1, 2, 3] });
    expect(compile({ 'id IN (?)': [] })).toEqual({ sql: 'id IN (NULL)', params: [] });
    expect(compile({ 'price BETWEEN ? AND ?': [1, 2] })).toEqual({ sql: 'price BETWEEN ? AND ?', params: [1, 2] });
  });

  it('find with a mismatched value count fails instead of binding a later condition', async () => {
    await expect(
      Post.find([[sql`${Post.price} BETWEEN ? AND ?`, [0, 1000000, 2]], [Post.owner_id, 1]] as never),
    ).rejects.toThrow(/placeholder\(s\) but 3 value\(s\)/);
  });
});
