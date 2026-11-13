/**
 * MySQL: the PKs a write reports (MySQL has no RETURNING, so they are selected separately) are exactly the
 * rows the write touched. Live MySQL (:3307); tables are suffixed with the process id.
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DBModel, model, column } from '../../src';
import { mysqlConfig, skipIntegrationTests } from '../helpers/setup';

const Base = DBModel.createDBBase(mysqlConfig);
const POSTS = `mwp_posts_${process.pid}`;

@model(POSTS)
class PostModel extends Base {
  @column({ primaryKey: true }) id?: number;
  @column() user_id?: number;
  @column() title?: string;
  @column() content?: string;
}
const Post = PostModel.asModel();

const ACCOUNTS = `mwp_accounts_${process.pid}`;

@model(ACCOUNTS)
class AccountModel extends Base {
  @column({ primaryKey: true }) id?: number;
  @column() tenant_id?: number;
  @column() email?: string;
  @column() name?: string;
}
const Account = AccountModel.asModel();

describe.skipIf(skipIntegrationTests)('MySQL write PKs (live)', () => {
  beforeAll(async () => {
    await Base.transaction(async () => {
      await Base.execute(`DROP TABLE IF EXISTS ${POSTS}`);
      await Base.execute(`CREATE TABLE ${POSTS} (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, title VARCHAR(50) NOT NULL, content VARCHAR(50) NOT NULL)`);
      await Base.execute(`DROP TABLE IF EXISTS ${ACCOUNTS}`);
      await Base.execute(`CREATE TABLE ${ACCOUNTS} (id INT AUTO_INCREMENT PRIMARY KEY, tenant_id INT NOT NULL, email VARCHAR(100) NOT NULL UNIQUE, name VARCHAR(50) NOT NULL)`);
    });
  });

  afterAll(async () => {
    await Base.transaction(async () => {
      await Base.execute(`DROP TABLE IF EXISTS ${POSTS}`);
      await Base.execute(`DROP TABLE IF EXISTS ${ACCOUNTS}`);
    });
  });

  describe('upsert … RETURNING reports only the rows the statement wrote (#367 / #382)', () => {
    async function seed(): Promise<number[]> {
      return Base.transaction(async () => {
        await Base.execute(`DELETE FROM ${ACCOUNTS}`);
        const r = await Account.createMany(
          [
            [[Account.tenant_id, 1], [Account.email, 'a@t1'], [Account.name, 'a']],
            [[Account.tenant_id, 2], [Account.email, 'b@t2'], [Account.name, 'b']],
          ],
          { returning: true },
        );
        return r!.values.map((v) => Number(v[0]));
      });
    }

    it("an upsert that updates an existing row returns that row's PK only, not the id+1 row of another tenant", async () => {
      const [a] = await seed();
      const result = await Base.transaction(() =>
        Account.create(
          [[Account.tenant_id, 1], [Account.email, 'a@t1'], [Account.name, 'a2']],
          { onConflict: Account.email, onConflictUpdate: [Account.name], returning: true },
        ),
      );
      expect(result!.values.map((v) => Number(v[0]))).toEqual([a]);
    });

    it('a multi-row upsert (one update, one insert) returns the PKs of both written rows', async () => {
      const [a] = await seed();
      const result = await Base.transaction(() =>
        Account.createMany(
          [
            [[Account.tenant_id, 1], [Account.email, 'a@t1'], [Account.name, 'a3']],
            [[Account.tenant_id, 1], [Account.email, 'c@t1'], [Account.name, 'c']],
          ],
          { onConflict: Account.email, onConflictUpdate: [Account.name], returning: true },
        ),
      );
      const [c] = (await Account.find([[Account.email, 'c@t1']])).map((r) => r.id!);
      expect(result!.values.map((v) => Number(v[0])).sort((x, y) => x - y)).toEqual([a, c]);
    });

    it('the driver refuses a raw INSERT … ON DUPLICATE KEY UPDATE … RETURNING before sending it', async () => {
      await seed();
      await expect(Base.transaction(() => Base.execute(
        `INSERT INTO ${ACCOUNTS} (tenant_id, email, name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name) RETURNING id`,
        [1, 'a@t1', 'raw'],
      ))).rejects.toThrow(/ON DUPLICATE KEY UPDATE is not supported/);
      expect((await Account.find([[Account.email, 'a@t1']]))[0].name).toBe('a');
    });
  });

  describe('updateMany returning with composite keyColumns (#375)', () => {
    it('returns only the PKs of the key tuples it updated, not the cross product of key values', async () => {
      const posts = await Base.transaction(async () => {
        const p = await Post.createMany(
          [
            [[Post.user_id, 1], [Post.title, 'a'], [Post.content, '-']],
            [[Post.user_id, 1], [Post.title, 'b'], [Post.content, '-']],
            [[Post.user_id, 2], [Post.title, 'a'], [Post.content, '-']],
            [[Post.user_id, 2], [Post.title, 'b'], [Post.content, '-']],
          ],
          { returning: true },
        );
        return p!.values.map((v) => Number(v[0]));
      });

      const result = await Base.transaction(() =>
        Post.updateMany(
          [
            [[Post.user_id, 1], [Post.title, 'a'], [Post.content, 'X']],
            [[Post.user_id, 2], [Post.title, 'b'], [Post.content, 'Y']],
          ],
          { keyColumns: [Post.user_id, Post.title], returning: true },
        ),
      );

      const changed = (await Post.find([[Post.content, ['X', 'Y']]])).map((p) => p.id).sort();
      expect(changed).toEqual([posts[0], posts[3]]);
      expect(result!.values.map((v) => Number(v[0])).sort()).toEqual(changed);
    });
  });
});
