// A relation endpoint declared on the bc 0.11.2 authoring surface, importing the LIBRARY's single
// `@leaf static` transport declaration. Read by `bc generate --from`, never executed.
import { behavior, type Float, type WireValue } from 'behavior-contracts';
import { Db } from '../../../src/scp/leaf-transport.js';

interface PostRow { id: Float; title: string | null; author_id: Float | null }
interface UserWithPosts { id: Float; name: string | null; posts: PostRow[] }

export class Rel {
  @behavior static usersWithPosts(): UserWithPosts[] {
    const users: WireValue[] = Db.executeSQL("SELECT id, name FROM p150_users ORDER BY id ASC", []);
    const userKeys: WireValue[] = Db.pluck(users, ["id"]);
    const posts: WireValue[] = Db.executeSQL("SELECT id, title, author_id FROM p150_posts WHERE author_id = ANY(?::@@PG_ARRAY_CAST@@) ORDER BY id ASC", [userKeys]);
    const out: UserWithPosts[] = Db.group(users, posts, ["id"], ["author_id"], "posts", false) as UserWithPosts[];
    return out;
  }
}
