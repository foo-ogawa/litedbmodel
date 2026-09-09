/**
 * ONE model source, compiled under BOTH decorator protocols by `test/unit/decorator-protocols.test.ts`.
 *
 * Nothing here may depend on the protocol: the same source must register the same model whether the
 * compiler emits legacy decorators (`experimentalDecorators`, with or without `emitDecoratorMetadata`)
 * or TC39 standard decorators (TypeScript 5's default). It prints what got registered; the test
 * compares the runs — the gate for issue #287.
 */
import 'reflect-metadata';
import { DBModel, model, column, hasMany, getColumnMeta, getRelationMeta } from '../../../src';
import type { ColumnsOf } from '../../../src';

@model('proto_posts')
class PostModel extends DBModel {
  @column.number({ primaryKey: true, autoIncrement: true }) id?: number;
  @column.number() author_id?: number;
}
const Post = PostModel as typeof PostModel & ColumnsOf<PostModel>;

@model('proto_users')
class UserModel extends DBModel {
  @column.number({ primaryKey: true, autoIncrement: true }) id?: number;
  @column.text() name?: string;              // `name` also collides with `Function.name`
  @column.text('mail_addr') email?: string;
  @column.boolean() is_active?: boolean;
  @column.datetime() created_at?: string;
  @column.bigint() big?: string;
  @column.uuid() ext_id?: string;
  @hasMany(() => [User.id, Post.author_id]) posts!: Promise<PostModel[]>;
}
const User = UserModel as typeof UserModel & ColumnsOf<UserModel>;

/** A base with columns, extended twice: neither subclass may see the other's columns. */
class AuditedBase extends DBModel {
  @column.datetime() created_at?: string;
}
@model('proto_a') class AModel extends AuditedBase { @column.text() a_only?: string; }
@model('proto_b') class BModel extends AuditedBase { @column.text() b_only?: string; }

const columns = (c: object): string[] =>
  [...(getColumnMeta(c) ?? new Map()).entries()].map(
    ([k, v]) =>
      `${k}:${v.columnName}:${v.typeCast ? 'cast' : '-'}:${v.sqlCast ?? '-'}:` +
      `${(v as { baseSqlType?: string }).baseSqlType ?? '-'}:${v.primaryKey ? 'pk' : '-'}:${v.autoIncrement ? 'ai' : '-'}`,
  );

const statics = (c: object): string[] => {
  const rec = c as unknown as Record<string, { columnName?: string } | undefined>;
  return ['id', 'name', 'email', 'created_at'].map((k) => `${k}->${rec[k]?.columnName ?? String(rec[k])}`);
};

const instance = new UserModel();
const proto = Object.getPrototypeOf(instance) as object;

console.log(JSON.stringify({
  userColumns: columns(UserModel),
  userStatics: statics(UserModel),
  relations: getRelationMeta(UserModel).map((r) => `${r.propertyKey}:${r.type}`),
  /** The lazy relation getter `@model` installs, and whether an instance can actually reach it. */
  relationGetterOnPrototype: typeof Object.getOwnPropertyDescriptor(proto, 'posts')?.get === 'function',
  relationReachableOnInstance: !Object.prototype.hasOwnProperty.call(instance, 'posts'),
  aColumns: columns(AModel),
  bColumns: columns(BModel),
  tableNames: [
    (UserModel as unknown as { TABLE_NAME: string }).TABLE_NAME,
    (AModel as unknown as { TABLE_NAME: string }).TABLE_NAME,
  ],
}));
