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

describe.skipIf(skipIntegrationTests)('MySQL write PKs (live)', () => {
  beforeAll(async () => {
    await Base.transaction(async () => {
      await Base.execute(`DROP TABLE IF EXISTS ${POSTS}`);
      await Base.execute(`CREATE TABLE ${POSTS} (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, title VARCHAR(50) NOT NULL, content VARCHAR(50) NOT NULL)`);
    });
  });

  afterAll(async () => {
    await Base.transaction(() => Base.execute(`DROP TABLE IF EXISTS ${POSTS}`));
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
