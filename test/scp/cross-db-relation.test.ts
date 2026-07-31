/**
 * V0 R1 — CROSS-DB relations on the TYPED-OBJECT / LAZY read surface: a relation whose TARGET model
 * lives in a DIFFERENT database (v1 `LazyRelation.ts:236` runs a relation on
 * `TargetClass.getDriverType()`'s driver) is batch-loaded against ITS OWN connection, not the parent's.
 *
 * ## The one channel
 *
 * The compiled op NAMES its database (`RelationOp.connection`, from the target model) and the
 * EXECUTION TARGET owns the registry that resolves names. They meet on the `StatementIntent` — the
 * only input `connectionFor` routes on, and the same channel the `executeSQL` leaf uses on the codegen
 * surface (`leaves.ts` `prepareSql` → `test/scp/leaves.test.ts`, live in
 * `test/integration/NamedDbCodegen.test.ts`). This surface therefore carries NO connection registry of
 * its own: it hands the name to the seam.
 *
 * ## Why the evidence here is unforgeable
 *
 * Two REAL SQLite databases with DISJOINT tables: the parent `posts` exists only in DB-A and the
 * target `users` only in DB-B. A relation that lands on the wrong database cannot see a table at all,
 * so a green hydrate means the name routed the batch. And what the runtime put on the intent is
 * recorded, so the assertion is on the produced routing key, not on a fixture's own switch.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { compileRelationOp, type RelationDecl } from '../../src/scp/relation';
import { buildResultSet } from '../../src/scp/typed-object';
import {
  connectionForDriver,
  MiddlewareChain,
  type ExecutionContext,
  type StatementIntent,
  type SyncConnection,
} from '../../src/scp/exec-context';

/** The cross-DB `belongsTo`: `users` lives on the 'analytics' connection. `connection` omitted ⇒ same-DB. */
const authorDecl = (connection?: string): RelationDecl => ({
  name: 'author',
  kind: 'belongsTo',
  targetTable: 'users',
  select: ['id', 'name'],
  parentKey: 'author_id',
  targetKey: 'id',
  dialect: 'sqlite',
  ...(connection !== undefined ? { connection } : {}),
});

/**
 * A ROUTING sync execution context over named connections — the seam's public extension point
 * (`connectionFor(intent)`), standing in for the pooled `ConnectionRegistry` the async plane resolves
 * against (its pools are async, so the sync relation batch cannot draw from them). Every intent it is
 * asked to resolve is RECORDED, which is what makes the routing key the runtime produced observable.
 */
function routingContext(
  seen: StatementIntent[],
  named: Readonly<Record<string, SyncConnection>>,
  fallback: SyncConnection,
): ExecutionContext {
  const ctx: ExecutionContext = {
    middleware: new MiddlewareChain(),
    connectionFor(intent: StatementIntent): SyncConnection {
      seen.push(intent);
      if (intent.db === undefined) return fallback;
      const conn = named[intent.db];
      if (conn === undefined) throw new Error(`fixture: connection '${intent.db}' is not registered`);
      return conn;
    },
    // The read-only relation batch never opens a transaction, so there is no connection to pin.
    withConnection: () => ctx,
  };
  return ctx;
}

/** DB-A holds the parents only; DB-B holds the relation TARGET only (disjoint ⇒ a mis-route sees no table). */
function twoDatabases(): { dbA: Database.Database; dbB: Database.Database } {
  const dbA = new Database(':memory:');
  dbA.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL)');
  dbA.exec('INSERT INTO posts VALUES (1, 7), (2, 8)');
  const dbB = new Database(':memory:');
  dbB.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
  dbB.exec("INSERT INTO users VALUES (7, 'Ada'), (8, 'Alan')");
  return { dbA, dbB };
}

describe('R1 cross-DB relation routing (typed-object surface, two real SQLite DBs)', () => {
  it('the op names its DB, the batch intent carries the name, and the routed target serves it', async () => {
    const { dbA, dbB } = twoDatabases();
    const op = compileRelationOp(authorDecl('analytics'));
    expect(op.connection).toBe('analytics');

    const seen: StatementIntent[] = [];
    const ctx = routingContext(seen, { analytics: connectionForDriver(dbB) }, connectionForDriver(dbA));
    const parents = dbA.prepare('SELECT id, author_id FROM posts ORDER BY id').all() as Record<string, unknown>[];

    // DECLARATIVE SELECT: the tagged relation resolves to REAL rows — only DB-B has `users`.
    const rows = buildResultSet(parents, { author: op }, ctx, { with: { author: true } });
    expect(rows).toEqual([
      { id: 1, author_id: 7, author: { id: 7, name: 'Ada' } },
      { id: 2, author_id: 8, author: { id: 8, name: 'Alan' } },
    ]);
    // The routing key the RUNTIME produced (not a fixture switch): the op's own connection name.
    expect(seen).toEqual([{ write: false, db: 'analytics' }]);

    // LAZY: the prototype getter fires the SAME op through the SAME target, so it routes identically.
    seen.length = 0;
    const lazy = buildResultSet(parents, { author: op }, ctx) as Record<string, unknown>[];
    expect(await lazy[0].author).toEqual({ id: 7, name: 'Ada' });
    expect(seen).toEqual([{ write: false, db: 'analytics' }]);

    dbA.close();
    dbB.close();
  });

  it('NEGATIVE CONTROL — with the name dropped, the SAME batch lands on the parent DB and cannot see the table', () => {
    const { dbA, dbB } = twoDatabases();
    // The identical relation, compiled WITHOUT the connection tag: the only difference is the name.
    const untagged = compileRelationOp(authorDecl());
    expect('connection' in untagged).toBe(false);

    const seen: StatementIntent[] = [];
    const ctx = routingContext(seen, { analytics: connectionForDriver(dbB) }, connectionForDriver(dbA));
    const parents = dbA.prepare('SELECT id, author_id FROM posts ORDER BY id').all() as Record<string, unknown>[];
    expect(() => buildResultSet(parents, { author: untagged }, ctx, { with: { author: true } })).toThrow(
      /no such table: users/,
    );
    // It was routed to the DEFAULT (parent) connection — `db` unspelled, exactly as before the tag.
    expect(seen).toEqual([{ write: false }]);

    dbA.close();
    dbB.close();
  });

  it('a NON-ROUTED target REJECTS a tagged relation instead of running it on the one DB it holds', () => {
    const { dbA, dbB } = twoDatabases();
    const op = compileRelationOp(authorDecl('analytics'));
    const parents = dbA.prepare('SELECT id, author_id FROM posts ORDER BY id').all() as Record<string, unknown>[];
    // A raw driver is a single-connection target with no registry to resolve 'analytics' against.
    // Running the batch on it anyway is the silent wrong-database execution the tag exists to prevent.
    expect(() => buildResultSet(parents, { author: op }, dbA, { with: { author: true } })).toThrow(
      /a statement names connection 'analytics'.*no connection registry/s,
    );
    dbA.close();
    dbB.close();
  });

  it('an UNTAGGED (same-DB) relation is NOT loud on a single-connection target', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL)');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec('INSERT INTO posts VALUES (1, 7)');
    db.exec("INSERT INTO users VALUES (7, 'Ada')");
    const op = compileRelationOp(authorDecl());
    const parents = db.prepare('SELECT id, author_id FROM posts').all() as Record<string, unknown>[];
    // The default connection IS the single-connection case: it runs, on the driver it was handed.
    expect(buildResultSet(parents, { author: op }, db, { with: { author: true } })).toEqual([
      { id: 1, author_id: 7, author: { id: 7, name: 'Ada' } },
    ]);
    db.close();
  });
});
