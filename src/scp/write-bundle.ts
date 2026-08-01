/**
 * litedbmodel v2 SCP — the BATCH write bundle surface (spec §8 / §13 / §14).
 *
 * A batch write is ONE LOGICAL operation that produces N grouped SQL statements, compiled
 * SYMBOLICALLY (no concrete input) to a {@link SqlBundle}: the first statement plus the gate-free
 * {@link TransactionPlan} the tx runtime executes. The bundle is pure serializable JSON, so ALL FIVE
 * language runtimes execute the SAME plan through the SAME per-statement tx loop.
 *
 * `createMany` with a heterogeneous column-set groups records into one INSERT per group (mirroring
 * `DBModel._insert`); `updateMany` is one UNNEST/JSON/CASE statement; `deleteMany` is a PK-set IN-list
 * DELETE. The batch SQL is byte-copied from the v1 builders (`./makesql/compile-crud`), lowered into
 * the plan by `deriveBatchPlan`. The callers are the decorator write path
 * (`./decorator-adapter`'s `compileCreateBundle` / `compileUpdateBundle` / `compileDeleteBundle`),
 * and the bundle is executed by `./dbmodel-runtime`'s `executeWriteAsync` → `executeTransactionAsync`.
 *
 * SINGLE-ROW writes are NOT here, and READS are NOT here. Both are declared on the
 * `@behavior` / `@leaf` authoring surface and lowered by `bc generate` into a native module per
 * language; the TS runtime seam for such a module is `bind(leafHandlers(ctx))` (see `./leaves`).
 * There is no runtime read-compile and no runtime single-write compile.
 */

import type { DialectName } from './dialect';
import type { ColumnTypeResolver } from './coltype';
import { SqlFailure } from './errors';
import { deriveBatchPlan, type TxOp, type TransactionPlan } from './makesql/tx';
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
  /** The derived, gate-free batch transaction plan. */
  readonly transaction: TransactionPlan;
  /**
   * Codegen typed-de-box `outputType` (spec §4.1 / §9): the bc portable type of the write's
   * {@link import('./makesql/tx').TransactionResult} (entity / returnedRows rows typed via the schema
   * SoT). Present ONLY when a column-type resolver was supplied at compile (additive: absent →
   * un-annotated).
   */
  readonly outputType?: unknown;
}

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
    return { dialect: dialectName, name, statement: { sql: '', params: [] }, transaction: { phase: 'remove', entityFrom: null, statements: [] } };
  }
  const plan = deriveBatchPlan('remove', ops);
  return { dialect: dialectName, name, statement: { sql: ops[0].sql, params: ops[0].params }, transaction: plan };
}

export { SqlFailure };
