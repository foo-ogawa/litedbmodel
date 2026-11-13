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

const COUPONS = `mwp_coupons_${process.pid}`;

@model(COUPONS)
class CouponModel extends Base {
  @column({ primaryKey: true }) id?: number;
  @column() status?: string;
}
const Coupon = CouponModel.asModel();

const SEATS = `mwp_seats_${process.pid}`;

@model(SEATS)
class SeatModel extends Base {
  @column({ primaryKey: true }) hall?: number;
  @column({ primaryKey: true }) seat?: number;
  @column() status?: string;
}
const Seat = SeatModel.asModel();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(skipIntegrationTests)('MySQL write PKs (live)', () => {
  beforeAll(async () => {
    await Base.transaction(async () => {
      await Base.execute(`DROP TABLE IF EXISTS ${POSTS}`);
      await Base.execute(`CREATE TABLE ${POSTS} (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, title VARCHAR(50) NOT NULL, content VARCHAR(50) NOT NULL)`);
      await Base.execute(`DROP TABLE IF EXISTS ${ACCOUNTS}`);
      await Base.execute(`CREATE TABLE ${ACCOUNTS} (id INT AUTO_INCREMENT PRIMARY KEY, tenant_id INT NOT NULL, email VARCHAR(100) NOT NULL UNIQUE, name VARCHAR(50) NOT NULL)`);
      await Base.execute(`DROP TABLE IF EXISTS ${COUPONS}`);
      await Base.execute(`CREATE TABLE ${COUPONS} (id INT AUTO_INCREMENT PRIMARY KEY, status VARCHAR(20) NOT NULL)`);
      await Base.execute(`DROP TABLE IF EXISTS ${SEATS}`);
      await Base.execute(`CREATE TABLE ${SEATS} (hall INT NOT NULL, seat INT NOT NULL, status VARCHAR(20) NOT NULL, PRIMARY KEY (hall, seat))`);
    });
  });

  afterAll(async () => {
    await Base.transaction(async () => {
      await Base.execute(`DROP TABLE IF EXISTS ${POSTS}`);
      await Base.execute(`DROP TABLE IF EXISTS ${ACCOUNTS}`);
      await Base.execute(`DROP TABLE IF EXISTS ${COUPONS}`);
      await Base.execute(`DROP TABLE IF EXISTS ${SEATS}`);
    });
  });

  /**
   * Two requests claim the same row at once. The first holds its write until the second has started; only
   * one of them may be told it wrote the row (#361 / #362) — as PostgreSQL's native RETURNING answers.
   */
  describe('update / delete returning under a concurrent claim of the same row (#361 / #362)', () => {
    async function seedCoupon(): Promise<number> {
      return Base.transaction(async () => {
        const r = await Coupon.create([[Coupon.status, 'open']], { returning: true });
        return Number(r!.values[0][0]);
      });
    }

    async function race<R>(claim: () => Promise<R>): Promise<[R, R]> {
      let releaseFirst!: () => void;
      const gate = new Promise<void>((r) => { releaseFirst = r; });
      let firstWrote!: () => void;
      const wrote = new Promise<void>((r) => { firstWrote = r; });
      const first = Base.transaction(async () => {
        const r = await claim();
        firstWrote();
        await gate;
        return r;
      }, { retryOnError: false });
      await wrote;
      const second = Base.transaction(claim, { retryOnError: false });
      await sleep(300); // the second request is now waiting on the first one's row lock
      releaseFirst();
      return Promise.all([first, second]);
    }

    it('update: only the request that changed the row gets its PK', async () => {
      const id = await seedCoupon();
      const [a, b] = await race(() =>
        Coupon.update([[Coupon.id, id], [Coupon.status, 'open']], [[Coupon.status, 'used']], { returning: true }),
      );
      expect(a!.values).toEqual([[id]]);
      expect(b!.values).toEqual([]);
    });

    it('composite PK: update / delete write exactly the locked rows and report their PKs', async () => {
      await Base.transaction(async () => {
        await Base.execute(`DELETE FROM ${SEATS}`);
        await Base.execute(`INSERT INTO ${SEATS} (hall, seat, status) VALUES (1, 1, 'open'), (1, 2, 'open'), (2, 1, 'open'), (2, 2, 'held')`);
      });
      const updated = await Base.transaction(() =>
        Seat.update([[Seat.status, 'open'], [Seat.seat, 1]], [[Seat.status, 'sold']], { returning: true }),
      );
      expect(updated!.values.map((v) => v.join(':')).sort()).toEqual(['1:1', '2:1']);
      const deleted = await Base.transaction(() => Seat.delete([[Seat.status, 'sold']], { returning: true }));
      expect(deleted!.values.map((v) => v.join(':')).sort()).toEqual(['1:1', '2:1']);
      const left = (await Seat.find([], { order: 'hall, seat' })).map((r) => `${r.hall}:${r.seat}:${r.status}`);
      expect(left).toEqual(['1:2:open', '2:2:held']);
    });

    it('delete: only the request that deleted the row gets its PK', async () => {
      const id = await seedCoupon();
      const [a, b] = await race(() => Coupon.delete([[Coupon.id, id]], { returning: true }));
      expect(a!.values).toEqual([[id]]);
      expect(b!.values).toEqual([]);
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
