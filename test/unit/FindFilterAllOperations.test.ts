/**
 * A model's default filter (`@model({ filter })`) applies to EVERY operation that addresses its existing
 * rows — find / findOne / count / findById / update / delete / updateMany — ANDed after the operation's
 * own conditions as one group. A write still needs conditions of its own: the filter alone never selects
 * the rows to write.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { DBModel, model, column } from '../../src';
import type { ColumnsOf } from '../../src';
import { postgresSqlBuilder } from '../../src/drivers/PostgresSqlBuilder';
import { mysqlSqlBuilder } from '../../src/drivers/MysqlSqlBuilder';
import { sqliteSqlBuilder } from '../../src/drivers/SqliteSqlBuilder';

const Base = DBModel.createDBBase({ database: ':memory:', driver: 'sqlite', max: 1 } as never);

@model('ffa_note', { filter: () => [[Note.archived, 0]] })
class NoteModel extends Base {
  @column.number({ primaryKey: true }) id?: number;
  @column.text() body?: string;
  @column.number() archived?: number;
}
const Note = NoteModel as typeof NoteModel & ColumnsOf<NoteModel>;

/** Every row, the filter bypassed (a raw read), to observe what a write really changed. */
const allRows = async () =>
  (await Base.execute('SELECT id, body, archived FROM ffa_note ORDER BY id')).rows as Array<{ id: number; body: string; archived: number }>;

beforeEach(async () => {
  await Base.execute('DROP TABLE IF EXISTS ffa_note');
  await Base.execute('CREATE TABLE ffa_note (id INTEGER PRIMARY KEY, body TEXT, archived INTEGER)');
  await Base.execute("INSERT INTO ffa_note VALUES (1, 'live', 0), (2, 'archived', 1), (3, 'live', 0)");
});

describe('the default filter applies to every operation', () => {
  it('find / findOne / count', async () => {
    expect((await Note.find([], { order: 'id' })).map((n) => n.id)).toEqual([1, 3]);
    expect(await Note.findOne([[Note.id, 2]] as never)).toBeNull();
    expect(await Note.count([])).toBe(2);
  });

  it('findById', async () => {
    expect((await Note.findById({ values: [[1], [2], [3]] })).map((n) => n.id).sort()).toEqual([1, 3]);
  });

  it('update writes only the rows the filter admits', async () => {
    await Base.transaction(async () => {
      await Note.update([[Note.id, [1, 2]]] as never, [[Note.body, 'edited']] as never);
    });
    expect((await allRows()).map((r) => r.body)).toEqual(['edited', 'archived', 'live']);
  });

  it('update with returning reports only the rows it wrote', async () => {
    const result = await Base.transaction(async () =>
      Note.update([[Note.id, [1, 2]]] as never, [[Note.body, 'edited']] as never, { returning: true }),
    );
    expect(result?.values).toEqual([[1]]);
  });

  it('delete removes only the rows the filter admits', async () => {
    await Base.transaction(async () => {
      await Note.delete([[Note.id, [1, 2]]] as never);
    });
    expect((await allRows()).map((r) => r.id)).toEqual([2, 3]);
  });

  it('updateMany writes only the rows the filter admits', async () => {
    await Base.transaction(async () => {
      await Note.updateMany(
        [
          [[Note.id, 1], [Note.body, 'one']],
          [[Note.id, 2], [Note.body, 'two']],
        ] as never,
        { keyColumns: Note.id } as never,
      );
    });
    expect((await allRows()).map((r) => r.body)).toEqual(['one', 'archived', 'live']);
  });

  it('a write still needs conditions of its own', async () => {
    await expect(Base.transaction(async () => Note.update([] as never, [[Note.body, 'x']] as never))).rejects.toThrow(
      'UPDATE requires conditions',
    );
    await expect(Base.transaction(async () => Note.delete([] as never))).rejects.toThrow('DELETE requires conditions');
  });
});

describe('a dialect builder ANDs the filter after its own predicate, qualified by its table alias', () => {
  const scope = (qualifier?: string) => ({ sql: `(${qualifier ? `${qualifier}.` : ''}archived = ?)`, params: [0] });

  it('findById', () => {
    const base = { tableName: 'n', pkeyColumns: ['id'], pkeyValues: [[1], [2]], selectColumn: '*', scope };
    expect(postgresSqlBuilder.buildFindByPkeys({ ...base, sqlCastMap: new Map([['id', 'int']]) })).toEqual({
      sql: 'SELECT * FROM n WHERE id = ANY(?::int[]) AND (archived = ?)',
      params: [[1, 2], 0],
    });
    expect(mysqlSqlBuilder.buildFindByPkeys(base)).toEqual({ sql: 'SELECT * FROM n WHERE id IN (?, ?) AND (archived = ?)', params: [1, 2, 0] });
    const composite = { ...base, pkeyColumns: ['a', 'b'], pkeyValues: [[1, 2]] };
    expect(sqliteSqlBuilder.buildFindByPkeys(composite).sql).toMatch(/JOIN v ON t\.a = v\.a AND t\.b = v\.b WHERE \(t\.archived = \?\)$/);
  });

  it('updateMany', () => {
    const base = { tableName: 'n', keyColumns: ['id'], updateColumns: ['archived'], records: [{ id: 1, archived: 1 }], scope };
    const pg = postgresSqlBuilder.buildUpdateMany({ ...base, rawRecords: base.records, sqlCastMap: new Map([['id', 'int'], ['archived', 'int']]) });
    expect(pg.sql).toMatch(/WHERE t\.id = v\.id AND \(t\.archived = \?\)$/);
    expect(pg.params.at(-1)).toBe(0);
    const my = mysqlSqlBuilder.buildUpdateMany(base);
    expect(my.sql).toMatch(/SET t\.archived = v\.archived WHERE \(t\.archived = \?\)$/);
    expect(my.params.at(-1)).toBe(0);
    const sq = sqliteSqlBuilder.buildUpdateMany(base);
    expect(sq.sql).toMatch(/WHERE id IN \(\?\) AND \(archived = \?\)$/);
    expect(sq.params.at(-1)).toBe(0);
  });
});
