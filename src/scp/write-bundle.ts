/**
 * litedbmodel v2 SCP — the WRITE bundle surface (spec §6 / §8 / §13 / §14).
 *
 * A write compiles (SYMBOLICALLY — no concrete input) to a {@link SqlBundle}: the base write
 * statement plus the derived, gate-first {@link TransactionPlan} the tx runtime executes. The bundle
 * is pure serializable JSON, so ALL FIVE language runtimes execute the SAME plan through the SAME
 * per-statement tx loop.
 *
 * Two shapes, one plan derivation:
 *  - **Command** ({@link compileWriteBundle} / {@link compileCompositeWriteBundle}) — one (or several
 *    named) base write(s) + an `entityWrites` save contract; `deriveTransactionPlan` lowers the §6
 *    effect arrays around them into the ordered, gate-first statement list.
 *  - **Batch** ({@link compileCreateManyBundle} / {@link compileUpdateManyBundle} /
 *    {@link compileDeleteManyBundle}) — ONE logical op producing N grouped statements, lowered to a
 *    gate-free plan by `deriveBatchPlan`. The batch SQL is byte-copied from the v1 builders.
 *
 * READS are NOT here. A read is declared on the `@behavior` / `@leaf` authoring surface and lowered by
 * `bc generate` into a native module per language; the TS runtime seam for such a module is
 * `bind(leafHandlers(ctx))` (see `./leaves`). There is no runtime read-compile.
 */

import type { Scope } from 'behavior-contracts/runtime';
import type { SqliteDriver } from './exec-context';
import { SqlFailure } from './errors';
import type { DialectName } from './dialect';
import type { ColumnTypeResolver } from './coltype';
import {
  deriveTransactionPlan,
  deriveBatchPlan,
  executeTransaction,
  type BaseWrite,
  type TxOp,
  type TransactionPlan,
  type TransactionResult,
} from './makesql/tx';
import {
  compileInsertMany,
  compileUpdateMany,
  compileDeleteMany,
  type InsertManyBuildOptions,
} from './makesql/compile-crud';
import { mysqlPkHint } from './makesql/mysql-returning';
import { assembleMakeSQL, type MakeSQL } from './makesql/makesql';
import { annotateWriteBundleOutType } from './makesql/writeouttype';
import type { UpdateManyBuildOptions } from '../drivers/types';
import {
  lifecycleFor,
  type EntityWritesDefinition,
  type LifecycleContract,
  type WriteLifecyclePhase,
} from './writes';

/** The minimal synchronous SQLite driver surface the write runtime needs (better-sqlite3 `Database`). */
export type SqliteDb = SqliteDriver;

/** Execute options for a bundle's transaction plan: the synchronous driver. */
export interface ExecuteOptions {
  /** The synchronous SQLite driver (better-sqlite3 `Database`). */
  readonly db: SqliteDb;
  /** The target SQL dialect (spec §4/§10). Defaults to `'sqlite'` (the in-process runtime seam). */
  readonly dialect?: DialectName;
}

/**
 * The compiled write bundle of ONE logical operation (spec §8) — pure serializable JSON a thin
 * per-language runtime can execute WITHOUT re-implementing litedbmodel's compile.
 *
 * `dialect` is the target SQL dialect (compiled ONCE, TS-side); a PG bundle's `?`→`$N` conversion is
 * the render-time final pass, so the bundle stays uniform and dialect-tagged.
 */
export interface SqlBundle {
  readonly dialect: DialectName;
  /** The operation (component) name. */
  readonly name: string;
  /** The base-write statement template (the plan's first body statement). */
  readonly statement: TxOp;
  /** The derived transaction plan — gate-first for a Command, gate-free for a batch. */
  readonly transaction: TransactionPlan;
  /**
   * Codegen typed-de-box `outputType` (spec §4.1 / §9): the bc portable type of the write's
   * {@link TransactionResult} (entity / returnedRows rows typed via the schema SoT). Present ONLY when
   * a column-type resolver was supplied at compile (additive: absent → un-annotated).
   */
  readonly outputType?: unknown;
}

/** Diagnostics label for a base write (its SQL verb). */
function writeLabelOf(sql: string): string {
  const m = /^\s*(INSERT|UPDATE|DELETE)/i.exec(sql);
  return m === null ? 'Write' : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
}

// ── Write-time relations: the Command bundle (WS5, #25 — spec §6) ──────────────

/**
 * Compile a base write + its `entityWrites` save contract into a {@link SqlBundle} carrying the
 * derived, gate-first write-time-relations {@link TransactionPlan} (spec §6/§8). `base` is the
 * complete tuned write statement the `makesql` write compiler ({@link
 * import('./makesql/tx').compileWriteNode}) emits; {@link deriveTransactionPlan} lowers the
 * lifecycle's §6 effect arrays around it into the ordered statement list. Pure JSON; a per-language
 * runtime honors the SAME plan.
 */
export function compileWriteBundle(
  name: string,
  base: TxOp,
  writes: EntityWritesDefinition,
  phase: WriteLifecyclePhase,
  dialectName: DialectName = 'sqlite',
  resolveColumnType?: ColumnTypeResolver,
): SqlBundle {
  const lifecycle = lifecycleFor(writes, phase);
  if (lifecycle === undefined) {
    throw new Error(`scp write: the '${phase}' lifecycle is not declared in the entityWrites save contract`);
  }
  const plan = deriveTransactionPlan(phase, [{ op: base, label: writeLabelOf(base.sql) }], lifecycle, dialectName);
  const bundle: SqlBundle = { dialect: dialectName, name, statement: base, transaction: plan };
  // Codegen typed de-box (spec §4.1/§9): when the schema/DDL column-type SoT is supplied, annotate the
  // bundle with the TransactionResult `outputType` so the typed emitters materialize a concrete struct
  // for the result. Fail-closed inside `annotateWriteBundleOutType`.
  return resolveColumnType === undefined ? bundle : annotateWriteBundleOutType(bundle, resolveColumnType);
}

/**
 * One member of a COMPOSITE (multi-write) Command (WS8a, #28 — spec §6 nested write / §14 tx-DAG):
 * a named base write carrying its OWN save-contract `effects`. A later member references an earlier
 * member's RETURNING row via `$.ref.<name>.<field>`.
 */
export interface CompositeWriteEntry {
  /** The member name a later member references as `$.ref.<name>.<field>`. */
  readonly name: string;
  /** The member's complete tuned base write statement. */
  readonly base: TxOp;
  /** The member's own save-contract effects. */
  readonly lifecycle: LifecycleContract;
}

/**
 * Compile a COMPOSITE (multi-write) Command into a {@link SqlBundle} carrying ONE derived, gate-first,
 * TOPOLOGICALLY-ORDERED transaction plan (spec §6 nested write / §14). Each entry contributes a named
 * base write + its effects; a later member depends on an earlier via `$.ref.<name>.*`.
 * {@link deriveTransactionPlan} builds the DAG + gate-first constraint and derives the ordered plan; a
 * cycle / dangling ref is ESCALATED. Pure JSON.
 */
export function compileCompositeWriteBundle(
  entries: readonly CompositeWriteEntry[],
  phase: WriteLifecyclePhase,
  dialectName: DialectName = 'sqlite',
): SqlBundle {
  if (entries.length < 2) {
    throw new Error('scp write: a composite write bundle needs at least 2 named write members (use compileWriteBundle for a single write).');
  }
  const bases: BaseWrite[] = entries.map((e) => ({ op: e.base, label: `${writeLabelOf(e.base.sql)} ${e.name}`, name: e.name, effects: e.lifecycle.effects }));
  const plan = deriveTransactionPlan(phase, bases, { effects: {} }, dialectName);
  return { dialect: dialectName, name: entries[0].name, statement: entries[0].base, transaction: plan };
}

// ── Batch writes: createMany / updateMany / deleteMany ─────────────────────────
//
// A batch write is ONE LOGICAL operation that produces N grouped SQL statements (createMany with a
// heterogeneous column-set groups records into one INSERT per group, mirroring `DBModel._insert`;
// updateMany is one UNNEST/JSON/CASE statement; deleteMany is a PK-set IN-list DELETE). The batch
// compilers (`compileInsertMany`/`compileUpdateMany`/`compileDeleteMany`) copy the v1 builders
// byte-for-byte; here they are lowered into a gate-free {@link TransactionPlan} of body statements
// ({@link deriveBatchPlan}), so ALL FIVE runtimes execute the multi-statement batch through the SAME
// per-statement tx loop with no runtime change.

/** Flatten a batch compiler's `MakeSQL` component to a concrete `{ sql, params }` op. */
function flattenBatchOp(node: MakeSQL, label: string): { sql: string; params: readonly unknown[]; label: string } {
  const assembled = assembleMakeSQL(node);
  return { sql: assembled.sql, params: assembled.params, label };
}

/**
 * Compile a `createMany` into a batch write {@link SqlBundle} carrying a gate-free
 * {@link TransactionPlan}. Heterogeneous column-set groups become MULTIPLE ordered INSERT statements —
 * byte-identical to what `DBModel._insert` emits per group (via `compileInsertMany`).
 *
 * `pk` (the target PK descriptor) is REQUIRED when the createMany carries a RETURNING clause on the
 * MySQL dialect: a batch INSERT persists N rows, so the MySQL RETURNING emulation must re-select ALL
 * N (a range on the AUTO_INCREMENT column, or the client-supplied PK values), not a single `id`.
 */
export function compileCreateManyBundle(
  name: string,
  options: InsertManyBuildOptions & { pk?: { columns: readonly string[]; autoInc: string | null } },
  dialectName: DialectName = 'sqlite',
  resolveColumnType?: ColumnTypeResolver,
): SqlBundle {
  const components = compileInsertMany(dialectName, options);
  const ops = components.map((c, i) => {
    const flat = flattenBatchOp(c, `createMany group ${i}`);
    // On MySQL, annotate a RETURNING batch INSERT with the PK hint so the driver emulation re-selects
    // every inserted row of the group by the real PK.
    if (dialectName === 'mysql' && options.pk !== undefined && options.returning !== undefined) {
      // The batch TxOp carries no writeMeta, so pass the upsert conflict key (upsertMany) explicitly —
      // the driver re-selects the upserted rows by it (the AUTO_INCREMENT range is wrong on a conflict).
      const onConflict = options.onConflict !== undefined && options.onConflict.length > 0 ? options.onConflict.join(',') : undefined;
      return { ...flat, ...mysqlPkHint({ sql: flat.sql, params: flat.params, pk: options.pk }, onConflict) };
    }
    return flat;
  });
  const plan = deriveBatchPlan('create', ops);
  // `ops` is never empty here: `deriveBatchPlan` throws on zero ops, and a `createMany` always groups
  // into >=1 INSERT. Fail LOUDLY rather than emitting an empty `sql` fallback (an empty-ops batch bundle
  // is a compile bug, not a default — 'defaults in schema, not code').
  const head = ops[0];
  if (head === undefined) {
    throw new Error(`scp write: compileCreateManyBundle('${name}') produced no INSERT statements (empty createMany grouping) — an empty-ops batch bundle is a compile bug, not a silent empty-SQL default.`);
  }
  const bundle: SqlBundle = { dialect: dialectName, name, statement: { sql: head.sql, params: head.params }, transaction: plan };
  return resolveColumnType === undefined ? bundle : annotateWriteBundleOutType(bundle, resolveColumnType);
}

/**
 * Compile an `updateMany` into a batch write {@link SqlBundle} (one UNNEST/JSON/CASE statement,
 * byte-identical to `compileUpdateMany` driving the v1 `buildUpdateMany` / JSON-batch builder).
 */
export function compileUpdateManyBundle(
  name: string,
  options: UpdateManyBuildOptions,
  dialectName: DialectName = 'sqlite',
): SqlBundle {
  const op = flattenBatchOp(compileUpdateMany(dialectName, options), 'updateMany');
  const plan = deriveBatchPlan('update', [op]);
  return { dialect: dialectName, name, statement: { sql: op.sql, params: op.params }, transaction: plan };
}

/**
 * Compile a `deleteMany` into a batch write {@link SqlBundle} — a PK-set IN-list DELETE (single-key)
 * or one DELETE per composite-key group, driven by the v1 `DBConditions` builder (`compileDeleteMany`).
 * An EMPTY key set produces an empty plan (nothing to delete), never a synthesized always-false DELETE.
 */
export function compileDeleteManyBundle(
  name: string,
  options: { tableName: string; keyColumns: string[]; keys: Record<string, unknown>[]; returning?: string },
  dialectName: DialectName = 'sqlite',
): SqlBundle {
  const components = compileDeleteMany({ dialect: dialectName, ...options });
  const ops = components.map((c, i) => flattenBatchOp(c, `deleteMany group ${i}`));
  if (ops.length === 0) {
    return { dialect: dialectName, name, statement: { sql: '', params: [] }, transaction: { phase: 'remove', entityFrom: null, statements: [], onIdempotentHit: 'rollback' } };
  }
  const plan = deriveBatchPlan('remove', ops);
  return { dialect: dialectName, name, statement: { sql: ops[0].sql, params: ops[0].params }, transaction: plan };
}

/**
 * Execute a {@link SqlBundle}'s derived transaction plan (spec §6/§8) as ONE real SQLite transaction.
 * The SAME code path a thin per-language runtime follows: it consumes ONLY the serialized
 * {@link TransactionPlan} (pure JSON) + a SQL driver, never re-deriving the plan.
 *
 * @throws {SqlFailure} on a driver failure (the transaction ROLLBACKs first).
 */
export function executeTransactionBundle(bundle: SqlBundle, input: Scope, options: ExecuteOptions): TransactionResult {
  return executeTransaction(options.db, bundle.transaction, input, bundle.dialect);
}

export { SqlFailure };
