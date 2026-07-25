/**
 * The decorator → SCP lowering emitter: what a DECLARED endpoint set lowers to, per dialect.
 *
 * The input is `./emit-models` — decorated models plus endpoint declarations with no SQL in them. The
 * assertions pin the SQL the emitter baked in, so a change in a `makesql` builder or in the emitter is
 * visible here rather than only in a live run. The emitted source is also type-checked and fed to the
 * REAL `bc generate` in `test/integration/EmitterEndToEnd.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { emitBehaviorModule, resetLimitConfig, setLimitConfig, type EndpointSet } from '../../src/scp';
import { EMIT_COLUMN_OPTIONS, EMIT_ENDPOINTS, emitModels, Post, TenantUser, User } from './emit-models';

const LEAF = '../../src/scp/leaf-transport.js';

/**
 * The endpoints a dialect can express. Two declarations are deliberately NOT emittable everywhere and
 * are loud rejects rather than silently-wrong SQL (both are asserted below): a COMPOSITE-key relation
 * on PostgreSQL (its batch form binds one array param per key column) and a RETURNING write on MySQL.
 */
function endpointsFor(dialect: 'sqlite' | 'postgres' | 'mysql'): EndpointSet {
  const drop = dialect === 'postgres' ? ['tenantUsersWithPosts'] : dialect === 'mysql' ? ['createUser'] : [];
  return Object.fromEntries(Object.entries(EMIT_ENDPOINTS).filter(([k]) => !drop.includes(k)));
}

function emit(dialect: 'sqlite' | 'postgres' | 'mysql', endpoints: EndpointSet = endpointsFor(dialect)) {
  return emitBehaviorModule({
    behavior: 'Blog',
    dialect,
    leafImport: LEAF,
    endpoints,
    models: emitModels,
    columnOptions: EMIT_COLUMN_OPTIONS,
  });
}

/** The body lines of ONE emitted method (whitespace-trimmed). */
function bodyOf(source: string, method: string): string[] {
  const start = source.indexOf(`@behavior static ${method}(`);
  expect(start, `method '${method}' is not emitted`).toBeGreaterThan(-1);
  const end = source.indexOf('\n  }', start);
  return source
    .slice(source.indexOf('{', source.indexOf(')', start)) + 1, end)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

describe('emitter — the emitted module is SCP-restricted TS over the ONE leaf catalog', () => {
  it('imports only bc authoring markers + the library leaf catalog, and exports the declared class', () => {
    const { source } = emit('sqlite');
    expect(source).toContain(`import { Db } from "${LEAF}";`);
    expect(source).toMatch(/^import \{ behavior, type .*\} from 'behavior-contracts';$/m);
    expect(source).toContain('export class Blog {');
    // No second leaf declaration, no IR, no SQL builder call — the module is declarations only.
    expect(source).not.toMatch(/@leaf\s+static/);
    expect(source).not.toContain('irVersion');
  });

  it('every emitted method is `@behavior static` and every DB call goes through `Db.`', () => {
    const { source, endpoints } = emit('sqlite');
    for (const e of endpoints) expect(source).toContain(`@behavior static ${e.name}(`);
    for (const line of source.split('\n')) {
      if (line.includes('Db.')) expect(line).toMatch(/Db\.(executeSQL|pluck|group)\(/);
    }
  });
});

describe('emitter — READ', () => {
  it('bakes the dialect SELECT the makesql builder produced (bounded WHERE is static)', () => {
    expect(bodyOf(emit('postgres').source, 'usersByIds')[0]).toContain(
      'SELECT id, name FROM e2e_users WHERE id = ANY(?) ORDER BY id ASC',
    );
    expect(bodyOf(emit('sqlite').source, 'usersByIds')[0]).toContain(
      'SELECT id, name FROM e2e_users WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id ASC',
    );
    expect(bodyOf(emit('mysql').source, 'usersByIds')[0]).toContain(
      "SELECT id, name FROM e2e_users WHERE id IN (SELECT JSON_UNQUOTE(v) FROM JSON_TABLE(?, '$[*]' COLUMNS(v JSON PATH '$')) jt) ORDER BY id ASC",
    );
  });

  it('#46 — the PG IN-list is the NO-CAST `= ANY(?)` form (a value-inferred cast breaks int/uuid/empty)', () => {
    const line = bodyOf(emit('postgres').source, 'usersByIds')[0];
    expect(line).toContain('id = ANY(?)');
    expect(line).not.toContain('::text[]');
    expect(line).not.toContain('PG_ARRAY_CAST');
    // ONE param — the whole key set. The text does not depend on how many keys are passed.
    expect(line).toContain('[ids]');
  });

  it('types the projection + the bound params from the model column SoT (never hand-written)', () => {
    const { source, endpoints } = emit('sqlite');
    expect(source).toContain('interface UsersByIdsRow {');
    // id is INTEGER → the READ de-box scalar is a JS number (Float); name is the pinned TEXT.
    expect(source).toMatch(/interface UsersByIdsRow \{\n {2}id: Float \| null;\n {2}name: string \| null;\n\}/);
    // The BOUND param is the bc scalar of the column's SQL type — an INTEGER key set is `Int[]`.
    expect(endpoints.find((e) => e.name === 'usersByIds')?.params).toEqual([{ name: 'ids', type: 'Int[]' }]);
  });

  it('#97 — a correlated EXISTS carries the parentRef as `<parent>.<col>`, no param', () => {
    expect(bodyOf(emit('sqlite').source, 'authorsWithAnyPost')[0]).toContain(
      'WHERE EXISTS (SELECT 1 FROM e2e_posts WHERE e2e_posts.author_id = e2e_users.id)',
    );
  });

  it('#97 — a typed IN-subquery binds its own param inside the subquery', () => {
    const line = bodyOf(emit('sqlite').source, 'usersWhoWrote')[0];
    expect(line).toContain('WHERE e2e_users.id IN (SELECT e2e_posts.author_id FROM e2e_posts WHERE e2e_posts.title = ?)');
    expect(line).toContain('[title]');
  });

  it('#98 — a QUERY view reads from the derived CTE, its own params bound FIRST', () => {
    const line = bodyOf(emit('sqlite').source, 'postsOfAuthorView')[0];
    expect(line).toContain('WITH derived AS (SELECT id, title FROM e2e_posts WHERE author_id = ?) SELECT id, title FROM derived ORDER BY id ASC');
    expect(line).toContain('[1]'); // the fragment's own literal param rides the CTE slot
  });
});

describe('emitter — SKIP / dynamic WHERE (assembled by the leaf at execution time)', () => {
  it('bakes the BOUNDED predicate statically and passes only the optional ones as fragments', () => {
    const body = bodyOf(emit('sqlite').source, 'feed');
    const call = body.join(' ');
    // The base statement carries the head + tail only — the WHERE is assembled at execution time.
    expect(call).toContain('SELECT id, author_id, title FROM e2e_posts ORDER BY id ASC", []');
    // Every fragment is literal SQL text + params (the whole vocabulary); the BOUNDED one is
    // unguarded, so it is a constant in the generated native code too.
    expect(call).toContain('frags: [{ sql: "author_id = ?", params: [authorId] }');
    expect(call).toContain('title !== null ? { sql: "title LIKE ?", params: [title] } : null');
    expect(call).toContain('minId !== null ? { sql: "id >= ?", params: [minId] } : null');
  });

  it('the optional parameters are declared nullable; the bounded one is not', () => {
    const feed = emit('sqlite').endpoints.find((e) => e.name === 'feed');
    expect(feed?.params).toEqual([
      { name: 'authorId', type: 'Int' },
      { name: 'title', type: 'string | null' },
      { name: 'minId', type: 'Int | null' },
    ]);
  });

  it('a fully-bounded read carries NO plan at all (native-clean)', () => {
    expect(bodyOf(emit('sqlite').source, 'usersByIds')[0]).not.toContain('frags');
  });
});

describe('emitter — RELATIONS (one query per level, N+1-free)', () => {
  it('lowers users → posts → comments as pluck / executeSQL / group, deepest level grouped first', () => {
    const body = bodyOf(emit('sqlite').source, 'usersWithPosts');
    expect(body.map((l) => l.replace(/ =.*/, ''))).toEqual([
      'const rows: WireValue[]',
      'const postsKeys: WireValue[]',
      'const posts: WireValue[]',
      'const commentsKeys: WireValue[]',
      'const comments: WireValue[]',
      'const commentsGraph: WireValue[]',
      'const postsGraph: UsersWithPostsRow[]',
      'return postsGraph;',
    ]);
    expect(body[1]).toContain('Db.pluck(rows, ["id"])');
    expect(body[2]).toContain('WHERE author_id IN (SELECT value FROM json_each(?)) ORDER BY id ASC');
    expect(body[3]).toContain('Db.pluck(posts, ["id"])');
    expect(body[5]).toContain('Db.group(posts, comments, ["id"], ["post_id"], "comments", false)');
    expect(body[6]).toContain('Db.group(rows, commentsGraph, ["id"], ["author_id"], "posts", false)');
  });

  it('the SINGLE de-box is the terminal group; every intermediate stays opaque WireValue[]', () => {
    const body = bodyOf(emit('sqlite').source, 'usersWithPosts');
    expect(body.filter((l) => l.includes(' as ')).length).toBe(1);
    expect(body[6]).toMatch(/const postsGraph: UsersWithPostsRow\[\] = Db\.group\(.*\) as UsersWithPostsRow\[\];/);
  });

  it('the nested row type carries the child FIELDS at every level (#150 — never an empty struct)', () => {
    const { source } = emit('sqlite');
    expect(source).toContain('posts: UsersWithPostsRow_posts[];');
    expect(source).toContain('comments: UsersWithPostsRow_posts_comments[];');
    expect(source).toMatch(/interface UsersWithPostsRow_posts_comments \{\n {2}id: Float \| null;\n {2}post_id: Float \| null;\n {2}body: string \| null;\n\}/);
  });

  it('composite-key relations bind the key TUPLE set on mysql/sqlite', () => {
    const body = bodyOf(emit('sqlite').source, 'tenantUsersWithPosts');
    expect(body[1]).toContain('Db.pluck(rows, ["tenant_id", "user_id"])');
    expect(body[2]).toContain("EXISTS (SELECT 1 FROM json_each(?) je WHERE json_extract(je.value, '$[0]') = e2e_tenant_posts.tenant_id");
  });

  it('a composite-key relation on POSTGRES is a loud reject, not a mis-bound statement', () => {
    expect(() => emit('postgres', { tenantUsersWithPosts: EMIT_ENDPOINTS.tenantUsersWithPosts })).toThrow(
      /COMPOSITE-key relation .* on PostgreSQL binds one array param PER key column/,
    );
  });
});

describe('emitter — WRITES', () => {
  it('emits the compileWriteNode INSERT / UPDATE / DELETE with the builder param order', () => {
    const { source } = emit('sqlite');
    expect(bodyOf(source, 'createUser')[0]).toContain('INSERT INTO e2e_users (name) VALUES (?) RETURNING id, name');
    expect(bodyOf(source, 'renameUser')[0]).toContain('UPDATE e2e_users SET name = ? WHERE id = ?');
    expect(bodyOf(source, 'renameUser')[0]).toContain('[name, id]');
    expect(bodyOf(source, 'removeUser')[0]).toContain('DELETE FROM e2e_users WHERE id = ?');
  });

  it('a non-RETURNING write returns the uniform transport summary row', () => {
    const { source } = emit('sqlite');
    expect(source).toContain('interface WriteSummary {');
    expect(source).toMatch(/interface WriteSummary \{\n {2}changes: Int;\n {2}lastInsertRowid: Int;\n\}/);
  });

  it('a RETURNING write on MySQL is a loud reject (no native RETURNING outside the tx runtime)', () => {
    expect(() => emit('mysql', { createUser: EMIT_ENDPOINTS.createUser })).toThrow(/MySQL has no native RETURNING/);
  });

  it('batch writes bind ONE record-array JSON param on mysql/sqlite', () => {
    const { source, endpoints } = emit('sqlite');
    expect(bodyOf(source, 'createComments')[0]).toContain(
      "INSERT INTO e2e_comments (body, post_id) SELECT json_extract(value, '$.body'), json_extract(value, '$.post_id') FROM json_each(?)",
    );
    expect(bodyOf(source, 'createComments')[0]).toContain('[rows]');
    expect(endpoints.find((e) => e.name === 'createComments')?.params).toEqual([{ name: 'rows', type: 'CreateCommentsRecord[]' }]);
    expect(source).toMatch(/interface CreateCommentsRecord \{\n {2}post_id: Int;\n {2}body: string;\n\}/);
  });

  it('batch writes bind ONE ARRAY PER COLUMN on postgres (the UNNEST builder shape)', () => {
    const r = emit('postgres', { createComments: EMIT_ENDPOINTS.createComments });
    expect(bodyOf(r.source, 'createComments')[0]).toContain('UNNEST(?::text[], ?::int[])');
    expect(r.endpoints[0].params).toEqual([
      { name: 'rows_post_id', type: 'Int[]' },
      { name: 'rows_body', type: 'string[]' },
    ]);
  });

  it('deleteMany is a key-set DELETE using the SAME static membership predicate as a read IN-list', () => {
    expect(bodyOf(emit('postgres', { removeComments: EMIT_ENDPOINTS.removeComments }).source, 'removeComments')[0]).toContain(
      'DELETE FROM e2e_comments WHERE id = ANY(?)',
    );
    expect(bodyOf(emit('sqlite', { removeComments: EMIT_ENDPOINTS.removeComments }).source, 'removeComments')[0]).toContain(
      'DELETE FROM e2e_comments WHERE id IN (SELECT value FROM json_each(?))',
    );
  });
});

describe('emitter — find hard-limit guard (the LIMIT cap+1 bounded fetch)', () => {
  it('bakes `LIMIT cap + 1` into a capped read and reports the cap the read boundary enforces', () => {
    try {
      setLimitConfig({ findHardLimit: 2 });
      const r = emit('sqlite', { usersByIds: EMIT_ENDPOINTS.usersByIds });
      expect(bodyOf(r.source, 'usersByIds')[0]).toContain('ORDER BY id ASC LIMIT 3');
      expect(r.endpoints[0].findHardLimit).toBe(2);
    } finally {
      resetLimitConfig();
    }
  });

  it('an AUTHORED limit governs — no cap injected, no guard reported (v1 skip rule)', () => {
    try {
      setLimitConfig({ findHardLimit: 2 });
      const r = emit('sqlite', { top: { kind: 'read', model: User, order: 'id ASC', limit: 100 } });
      expect(bodyOf(r.source, 'top')[0]).toContain('ORDER BY id ASC LIMIT 100');
      expect(r.endpoints[0].findHardLimit).toBeUndefined();
    } finally {
      resetLimitConfig();
    }
  });

  it('no configured cap ⇒ byte-unchanged SQL (the native path never configures one)', () => {
    resetLimitConfig();
    expect(bodyOf(emit('sqlite', { usersByIds: EMIT_ENDPOINTS.usersByIds }).source, 'usersByIds')[0]).not.toContain('LIMIT');
  });
});

describe('emitter — fail-closed', () => {
  it('rejects an endpoint naming a column the model does not declare', () => {
    expect(() =>
      emit('sqlite', { bad: { kind: 'read', model: Post, where: [{ column: 'nope', op: 'eq', param: 'x' }] } }),
    ).toThrow(/has no @column 'nope'/);
  });

  it('rejects an endpoint naming a relation the model does not declare', () => {
    expect(() => emit('sqlite', { bad: { kind: 'read', model: TenantUser, with: ['nope'] } })).toThrow(
      /declares no relation 'nope'/,
    );
  });

  it('rejects a SKIP predicate on a QUERY view (the CTE and the plan cannot share one param order)', () => {
    expect(() =>
      emit('sqlite', {
        bad: {
          kind: 'read',
          model: Post,
          select: ['id', 'title'],
          view: { query: 'SELECT id, title FROM e2e_posts' },
          where: [{ column: 'title', op: 'like', param: 'title', optional: true }],
        },
      }),
    ).toThrow(/cannot share one param order/);
  });
});
