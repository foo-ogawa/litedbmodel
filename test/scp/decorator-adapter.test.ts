/**
 * Phase F-1 (#104) — the decorator → SCP authoring ADAPTER. For representative decorator models
 * covering every README shape, the adapter-generated bundle is BYTE-IDENTICAL to the hand-written SCP
 * behavior for the same model (authoring.ts guarantees eager↔declaration byte-identity — this leans on
 * that). Proves the decorator surface lowers to the SAME SCP the native runtimes already execute.
 *
 * Note: a column's SQL type comes from the `@column.*` family it declares, so these expectations are
 * unavailable; the models here use the EXPLICIT `@column.*` variants (which set the `sqlCast` family),
 * and bare `@column()` id/number columns take the documented `DEFAULT_UNCAST_SQL_TYPE` (INTEGER) or a
 * `columnTypes` pin — exactly the adapter's column-type mapping under test.
 */

import type { ColumnsOf } from '../../src';
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { model, column, hasMany, belongsTo, hasOne } from '../../src/decorators';
import {
  deriveModelColumns,
  columnSqlType,
  tableNameOf,
  compileCreateBundle,
  compileUpdateBundle,
  compileDeleteBundle,
  deriveRelationDecls,
  compileRelationOps,
  modelColumnResolver,
  compileCreateManyBundle,
  compileUpdateManyBundle,
  compileDeleteManyBundle,
  compileRelationOp,
} from '../../src/scp';

// ── Representative README models ─────────────────────────────────────────────────────────────────

@model('users')
class User {
  // `@column` installs a STATIC accessor per column at runtime; this names its TYPE so a
  // static reference (User.id) is CHECKED instead of resolving to an implicit any.
  declare static id: ColumnsOf<User>['id'];
  declare static is_active: ColumnsOf<User>['is_active'];
  declare static created_at: ColumnsOf<User>['created_at'];
  declare static big_id: ColumnsOf<User>['big_id'];
  declare static ext_id: ColumnsOf<User>['ext_id'];
  declare static metadata: ColumnsOf<User>['metadata'];
  declare static birth_date: ColumnsOf<User>['birth_date'];
  declare static tags: ColumnsOf<User>['tags'];
  @column.number() id?: number;
  @column.text() name?: string;
  @column.boolean() is_active?: boolean;
  @column.datetime() created_at?: string;
  @column.bigint() big_id?: string;
  @column.uuid() ext_id?: string;
  @column.json() metadata?: Record<string, unknown>;
  @column.date() birth_date?: string;
  @column.stringArray() tags?: string[];

  @hasMany(() => [User.id, Post.author_id], {
    order: () => Post.created_at.desc(),
    limit: 10,
    hardLimit: 500,
  })
  declare recentPosts: Promise<Post[]>;

  @hasOne(() => [User.id, Profile.user_id])
  declare profile: Promise<Profile | null>;
}

@model('posts')
class Post {
  // `@column` installs a STATIC accessor per column at runtime; this names its TYPE so a
  // static reference (Post.id) is CHECKED instead of resolving to an implicit any.
  declare static id: ColumnsOf<Post>['id'];
  declare static author_id: ColumnsOf<Post>['author_id'];
  declare static title: ColumnsOf<Post>['title'];
  declare static created_at: ColumnsOf<Post>['created_at'];
  @column.number() id?: number;
  @column.number() author_id?: number;
  @column.text() title?: string;
  @column.datetime() created_at?: string;

  @belongsTo(() => [Post.author_id, User.id])
  declare author: Promise<User | null>;
}

@model('profiles')
class Profile {
  // `@column` installs a STATIC accessor per column at runtime; this names its TYPE so a
  // static reference (Profile.id) is CHECKED instead of resolving to an implicit any.
  declare static id: ColumnsOf<Profile>['id'];
  declare static user_id: ColumnsOf<Profile>['user_id'];
  declare static bio: ColumnsOf<Profile>['bio'];
  @column.number() id?: number;
  @column.number() user_id?: number;
  @column.text() bio?: string;
}

// Composite-key tenant models
@model('tenant_users')
class TenantUser {
  // `@column` installs a STATIC accessor per column at runtime; this names its TYPE so a
  // static reference (TenantUser.tenant_id) is CHECKED instead of resolving to an implicit any.
  declare static tenant_id: ColumnsOf<TenantUser>['tenant_id'];
  declare static id: ColumnsOf<TenantUser>['id'];
  @column.number() tenant_id?: number;
  @column.number() id?: number;
  @column.text() name?: string;

  @hasMany(() => [
    [TenantUser.tenant_id, TenantPost.tenant_id],
    [TenantUser.id, TenantPost.author_id],
  ])
  declare posts: Promise<TenantPost[]>;
}

@model('tenant_posts')
class TenantPost {
  // `@column` installs a STATIC accessor per column at runtime; this names its TYPE so a
  // static reference (TenantPost.tenant_id) is CHECKED instead of resolving to an implicit any.
  declare static tenant_id: ColumnsOf<TenantPost>['tenant_id'];
  declare static author_id: ColumnsOf<TenantPost>['author_id'];
  declare static title: ColumnsOf<TenantPost>['title'];
  @column.number() tenant_id?: number;
  @column.number() author_id?: number;
  @column.text() title?: string;
}

const registry: Record<string, unknown> = { User, Post, Profile, TenantUser, TenantPost };
const resolve = (name: string) => registry[name] as never;

// ── 1. Column-type mapping (every README @column.* type family) ──────────────────────────────────

describe('F1 columns — @column.* → SCP static columns SQL-type token', () => {
  it('maps each decorator type family to its §4.1 SQL-type token (uuid/json/date/array pinned; bare→INTEGER)', () => {
    const cols = deriveModelColumns(User as never, { columnTypes: { name: 'TEXT' } });
    expect(cols).toEqual({
      users: {
        id: 'INTEGER', // bare @column() number → DEFAULT_UNCAST_SQL_TYPE
        name: 'TEXT', // pinned override (bare string, no sqlCast)
        is_active: 'BOOLEAN',
        created_at: 'TIMESTAMP',
        big_id: 'BIGINT',
        ext_id: 'UUID',
        metadata: 'JSONB',
        birth_date: 'DATE',
        tags: 'TEXT[]',
      },
    });
  });

  it('columnSqlType honors the override, else the family, else the uncast default', () => {
    expect(columnSqlType('x', { columnName: 'x', sqlCast: 'boolean' })).toBe('BOOLEAN');
    expect(columnSqlType('x', { columnName: 'x' })).toBe('INTEGER'); // no sqlCast → default
    expect(columnSqlType('x', { columnName: 'x' }, 'REAL')).toBe('REAL'); // override wins
  });

  it('every produced token is accepted by coltype (fail-closed): a bogus family throws', () => {
    expect(() => columnSqlType('x', { columnName: 'x', sqlCast: 'geometry' })).toThrow(/no SCP SQL-type mapping/);
  });

  it('tableNameOf uses TABLE_NAME, else the model name lowercased', () => {
    expect(tableNameOf(User as never)).toBe('users');
    expect(tableNameOf({ name: 'FooBar' })).toBe('foobar');
  });
});

// ── 2. Reads: column-type mapping surviving the retired read-AUTHORING generation ─────────────────
//
// F1's read tests proved "the adapter-generated READ bundle is byte-identical to the hand-written SCP
// behavior" — that comparison drove `findAuthoring`/`countAuthoring`/`compileReadContract`/`emitRead`/
// `compileEager` (the SCP recorder/programmatic-compile authoring surface), which behavior-contracts
// removed with NO replacement (bc 0.11.2 migration). There is no substitute read-bundle generator to
// drive instead, so every byte-identity-of-a-generated-READ-bundle test below is deleted (one-line
// comment naming the removed feature each). The adapter's OWN translation — `deriveModelColumns` /
// `columnSqlType` — is untouched by the removal and stays covered by the "F1 columns" describe above.

// Used by the surviving column-type-only RED-proof test at the bottom of this file
// (`modelColumnResolver(User, usersColumns)`).
const usersColumns = { columnTypes: { name: 'TEXT' } };

describe('F1 reads — find/findOne/findById/count byte-identical to hand-written SCP', () => {
  // DELETED: 'find with a WHERE condition + order' — drove findAuthoring+emitRead+compileReadContract (removed read-authoring surface, no replacement).
  // DELETED: 'findById (identity WHERE) and findOne (identity WHERE) share the find authoring' — same (removed read-authoring surface).
  // DELETED: 'find with a SKIP-optional condition (when(ne(...), ...))' — same; also used the removed WHERE-sugar `when`/`ne`.
  // DELETED: 'find with limit + offset' — same (removed read-authoring surface).
  // DELETED: 'find with an IN-subquery condition (Phase E-1 sugar)' — same; also used the removed WHERE-sugar `inSubquery`/`col`/`parentRef`.
  // DELETED: 'count with a WHERE condition' — same (removed read-authoring surface).
  // DELETED: 'a QUERY view-model read (queryView → Select cte/cteParams) via the adapter' — same; also used the removed `queryView`.
  // DELETED: 'find with a GROUP BY port (group) — byte-identical' — same (removed read-authoring surface).

  it('deriveModelColumns maps the non-text[] array column families (int[] / numeric[] / boolean[]) for a find-shaped model', () => {
    // DELETED (renamed from 'projects the non-text[] array column families … — byte-identical, array
    // outType'): the byte-identity-of-a-generated-READ-bundle half drove `findAuthoring`+`emitRead`
    // (removed read-authoring surface, no replacement). The COLUMN-TYPE half survives directly against
    // `deriveModelColumns` (no read-bundle generation involved) — the same array-family mapping the
    // adjacent 'deriveModelColumns maps every array family' test proves generically, pinned here to the
    // SAME model shape (with a plain `id`) the retired read test used.
    @model('array_cols')
    class ArrayCols {
      @column.number() id?: number;
      @column.intArray() ints?: number[];
      @column.numericArray() nums?: number[];
      @column.booleanArray() flags?: boolean[];
      @column.stringArray() texts?: string[];
    }
    expect(deriveModelColumns(ArrayCols as never)).toEqual({
      array_cols: { id: 'INTEGER', ints: 'INT[]', nums: 'NUMERIC[]', flags: 'BOOLEAN[]', texts: 'TEXT[]' },
    });
  });

  it('deriveModelColumns maps every array family to its §4.1 array token', () => {
    @model('arr2')
    class Arr2 {
      @column.intArray() a?: number[];
      @column.numericArray() b?: number[];
      @column.booleanArray() c?: boolean[];
      @column.stringArray() d?: string[];
    }
    expect(deriveModelColumns(Arr2 as never)).toEqual({ arr2: { a: 'INT[]', b: 'NUMERIC[]', c: 'BOOLEAN[]', d: 'TEXT[]' } });
  });
});

// ── 3. Writes: createMany / update / delete via the surviving batch write bundles ──────────────────
//
// The SINGLE-record write path (`create`/`update`/`delete` via `compileCommandBundle`) drove
// `createAuthoring`/`updateAuthoring`/`deleteAuthoring`/`compileEager`/`emitWrite`/`compileWriteBundle`
// — the removed SCP write-authoring surface (no replacement). The BATCH write path
// (`createMany`/`updateMany`/`deleteMany` via `compileCreateBundle`/`compileUpdateBundle`/
// `compileDeleteBundle` → `compileCreateManyBundle`/`compileUpdateManyBundle`/`compileDeleteManyBundle`)
// never went through that authoring surface (it composes the v1-sourced batch builders directly) and
// is untouched — kept below.

describe('F1 writes — create/update/delete byte-identical to hand-written SCP', () => {
  // DELETED: 'create (single INSERT via compileWriteBundle)' — drove createAuthoring+compileEager+emitWrite+compileCommandBundle+compileWriteBundle (removed single-write authoring surface, no replacement).
  // DELETED: 'update byte-identical' — same (removed single-write authoring surface); also used the removed WHERE-sugar `whereEq`.
  // DELETED: 'delete byte-identical' — same (removed single-write authoring surface); also used the removed WHERE-sugar `whereEq`.

  it('createMany byte-identical (compileCreateManyBundle)', () => {
    const opts = { tableName: 'posts', records: [{ author_id: 1, title: 'a' }, { author_id: 2, title: 'b' }], returning: 'id' };
    const adapter = compileCreateBundle(Post as never, 'createMany', opts, 'sqlite');
    const hand = compileCreateManyBundle('createMany', opts, 'sqlite', modelColumnResolver(Post as never));
    expect(JSON.stringify(adapter)).toBe(JSON.stringify(hand));
  });

  it('upsert (create WITH onConflict) carries end-to-end via the createMany path — NO SCP authoring addition', () => {
    const opts = { tableName: 'posts', records: [{ author_id: 1, title: 'a' }], onConflict: ['id'], onConflictUpdate: 'all' as const, returning: 'id' };
    const adapter = compileCreateBundle(Post as never, 'create', opts, 'sqlite');
    const hand = compileCreateManyBundle('create', opts, 'sqlite', modelColumnResolver(Post as never));
    expect(JSON.stringify(adapter)).toBe(JSON.stringify(hand));
    // The ON CONFLICT verb reached the SQL text (proves the upsert carried).
    expect(adapter.transaction?.statements?.[0]?.op?.sql ?? adapter.statement?.sql).toMatch(/ON CONFLICT/i);
  });

  it('upsert onConflictIgnore (DO NOTHING) carries', () => {
    const opts = { tableName: 'posts', records: [{ author_id: 1, title: 'a' }], onConflict: ['id'], onConflictIgnore: true, returning: 'id' };
    const adapter = compileCreateBundle(Post as never, 'create', opts, 'sqlite');
    // SQLite's DO-NOTHING verb is `INSERT OR IGNORE` (v1 sqliteSqlBuilder); the ignore carried end-to-end
    // AND the typed-model outType annotation succeeded (writeouttype now recognizes the OR IGNORE verb).
    expect(adapter.statement?.sql).toMatch(/INSERT OR IGNORE/i);
    expect(adapter.outputType).toBeDefined();
  });

  it('updateMany (keyColumns) byte-identical', () => {
    const opts = { tableName: 'posts', keyColumns: ['id'], updateColumns: ['title'], records: [{ id: 1, title: 'x' }, { id: 2, title: 'y' }], returning: 'id' };
    const adapter = compileUpdateBundle('updateMany', opts, 'sqlite');
    const hand = compileUpdateManyBundle('updateMany', opts, 'sqlite');
    expect(JSON.stringify(adapter)).toBe(JSON.stringify(hand));
    // keyColumns reached the WHERE/JOIN.
    expect(adapter.statement?.sql).toMatch(/id/);
  });

  it('deleteMany (keyColumns + returning) byte-identical', () => {
    const opts = { tableName: 'posts', keyColumns: ['id'], keys: [{ id: 1 }, { id: 2 }], returning: 'id' };
    const adapter = compileDeleteBundle('deleteMany', opts, 'sqlite');
    const hand = compileDeleteManyBundle('deleteMany', opts, 'sqlite');
    expect(JSON.stringify(adapter)).toBe(JSON.stringify(hand));
  });
});

// ── 4. Relations: hasMany / belongsTo / hasOne (single + composite + limit + hardLimit) ──────────

describe('F1 relations — @hasMany/@belongsTo/@hasOne → RelationDecl → RelationOp byte-identical', () => {
  it('derives a single-key hasMany with per-parent limit + hardLimit + order', () => {
    const decls = deriveRelationDecls(User as never, resolve, 'sqlite');
    const recentPosts = decls.find((d) => d.name === 'recentPosts')!;
    expect(recentPosts).toMatchObject({
      name: 'recentPosts',
      kind: 'hasMany',
      targetTable: 'posts',
      parentKey: 'id',
      targetKey: 'author_id',
      limit: 10,
      hardLimit: 500,
      order: 'created_at DESC',
    });
    expect(recentPosts.select).toEqual(['id', 'author_id', 'title', 'created_at']);
  });

  it('derives a hasOne (single, single-cardinality)', () => {
    const decls = deriveRelationDecls(User as never, resolve, 'sqlite');
    const profile = decls.find((d) => d.name === 'profile')!;
    expect(profile).toMatchObject({ name: 'profile', kind: 'hasOne', targetTable: 'profiles', parentKey: 'id', targetKey: 'user_id' });
  });

  it('derives a belongsTo', () => {
    const decls = deriveRelationDecls(Post as never, resolve, 'sqlite');
    const author = decls.find((d) => d.name === 'author')!;
    expect(author).toMatchObject({ name: 'author', kind: 'belongsTo', targetTable: 'users', parentKey: 'author_id', targetKey: 'id' });
  });

  it('derives a COMPOSITE-key hasMany', () => {
    const decls = deriveRelationDecls(TenantUser as never, resolve, 'sqlite');
    const posts = decls.find((d) => d.name === 'posts')!;
    expect(posts).toMatchObject({ name: 'posts', kind: 'hasMany', targetTable: 'tenant_posts', parentKeys: ['tenant_id', 'id'], targetKeys: ['tenant_id', 'author_id'] });
    expect(posts.parentKey).toBeUndefined();
  });

  it('compileRelationOps is byte-identical to compileRelationOp over the derived decl', () => {
    const ops = compileRelationOps(User as never, resolve, 'sqlite');
    const decls = deriveRelationDecls(User as never, resolve, 'sqlite');
    for (const decl of decls) {
      // The op is compiled with the TARGET model's column resolver (child de-box materializers).
      const targetName = decl.targetTable === 'posts' ? 'Post' : decl.targetTable === 'profiles' ? 'Profile' : 'User';
      const hand = compileRelationOp(decl, modelColumnResolver(registry[targetName] as never));
      expect(JSON.stringify(ops[decl.name])).toBe(JSON.stringify(hand));
    }
  });
});

// ── RED proof: a WRONG column-type mapping diverges the resolved column type ───────────────────────

describe('F1 RED proof — a wrong column-type mapping diverges from the correct one / fails closed', () => {
  it('mis-mapping id INTEGER→BIGINT resolves a different SQL type for the column', () => {
    // DELETED (renamed from 'mis-mapping id INTEGER→BIGINT changes the read bundle bytes (a
    // byte-identity test would RED)'): the READ-BUNDLE-bytes-diverge half drove
    // `findAuthoring`+`adapterRead`+`handRead`+`emitRead` (removed read-authoring surface, no
    // replacement). The COLUMN-TYPE half survives directly against `modelColumnResolver` (no
    // read-bundle generation involved): correct id→INTEGER vs mis-mapped id→BIGINT resolve to
    // different SQL-type tokens for the SAME column — the observable divergence the wrong mapping
    // produces downstream (BIGINT de-boxes as bc `string`, INTEGER as bc `int`/`float`).
    const correct = modelColumnResolver(User as never, usersColumns)!;
    const wrong = modelColumnResolver(User as never, { columnTypes: { name: 'TEXT', id: 'BIGINT' } })!;
    expect(correct('users', 'id')).toBe('INTEGER');
    expect(wrong('users', 'id')).toBe('BIGINT');
    expect(correct('users', 'id')).not.toBe(wrong('users', 'id'));
  });

  it('a wrong SQL family for a column throws at derive (fail-closed, never a silent wrong bundle)', () => {
    expect(() => columnSqlType('c', { columnName: 'c', sqlCast: 'not-a-family' })).toThrow();
  });
});
