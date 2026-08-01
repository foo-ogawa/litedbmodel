/**
 * litedbmodel v2 SCP — the write descriptor → makeSQL statement compiler ({@link compileWriteNode}),
 * the BATCH transaction-plan derivation ({@link deriveBatchPlan}), and the live async 1-tx runtime
 * ({@link executeTransactionAsync}). No reduced IR is emitted anywhere: every statement's SQL is
 * COMPLETE tuned text (byte-identical to what the v1 write path sends — `INSERT … ON CONFLICT DO
 * NOTHING`, `UPDATE … SET c = ?`, `DELETE FROM … WHERE …`), and its `params` are closed-set bc
 * Expression IR refs resolved at execute time against the transaction scope.
 *
 * A statement op is exactly a `makeSQL` template: `{ sql, params }` where `sql` carries `?`
 * placeholders and `params` are Expression IR (`{ref:[…]}` / a literal / a `{obj:{…}}` payload)
 * that bc evaluates per statement — then the concrete values assemble + render + bind through
 * the SAME `assembleMakeSQL` / `renderPlaceholders` the read path uses.
 *
 * A BATCH write (createMany / updateMany / deleteMany) is ONE logical op that produces N grouped
 * statements; {@link deriveBatchPlan} lowers those into a gate-free {@link TransactionPlan}
 * (`entityFrom` null, every statement `role:'body'`), run in the declared order as ONE transaction.
 * The single-row and read paths are lowered by `bc generate` into a native module per language and
 * never reach this runtime; there is no runtime read-compile and no runtime single-write compile.
 *
 * Every statement executes: a plan either commits or raises. There is no gate that inspects a
 * statement's result and short-circuits the rest — no plan in this repository ever carried one, so
 * the interpretation was removed rather than kept as a path nothing reaches (#256).
 */

import { evaluateExpression, type Scope, type Value } from 'behavior-contracts/runtime';
import { assembleMakeSQL } from './makesql';
import { sqliteInsertJson, mysqlInsertJson, sqliteUpdateManyJson, mysqlUpdateManyJson } from './json-batch';
import { encodeJsonParam, inListPredicate } from './json-array';
import { postgresSqlBuilder } from '../../drivers/PostgresSqlBuilder';
import { sqlTypeToBcScalar, sqlTypeToMaterializeClass, type ColumnTypeResolver } from '../coltype';
import { renderPlaceholders, type Dialect as MakeSQLDialect } from './handler';
import { formatterFor } from './compile';
import { mapSqliteError } from '../errors';
// The mysql pk-hint writer. `mysql-returning` imports `TxOp` from here TYPE-only (erased), so this
// runtime import closes no cycle.
import { mysqlPkHint } from './mysql-returning';
import {
  type AsyncExecutionContext,
  type PooledAsyncContext,
  withTransactionAsync,
} from '../exec-context';
import { executeSQLAsync, type AsyncLeafContext } from '../leaves';
import { type TransactionOptions, checkWriteAllowed } from '../tx-options';
import { isConnectionError } from '../../connection-errors';
import { DBConditions, type ConditionObject } from '../../DBConditions';

// ── Expression IR alias (a statement param is a closed-set bc Expression node) ──

/** A closed-set bc Expression IR node used as a `makeSQL` deferred param (ref / literal / obj). */
export type TxExpr = unknown;

/**
 * Encode a CONCRETE value into a bc Expression IR node that `evaluateExpression` returns VERBATIM.
 *
 * A batch-write op (createMany / updateMany / deleteMany) is compiled by driving the v1 builders
 * (compile-crud), so its `params` are already CONCRETE grouped values — NOT deferred Expression IR.
 * But the tx runtime renders every statement param through bc `evaluateExpression` (spec §6 /
 * `renderStatement`), which fail-closes on a BARE array ("bare array is not an expression") and on a
 * multi-key plain object. The batch INSERT on Postgres binds REAL arrays as single params
 * (`UNNEST($1::int[], …)` → `[[7,8], …]`), so those concrete params must be wrapped in the bc
 * literal-carrier ops so they survive evaluation unchanged:
 *   - array   → `{arr:[literalize(e)…]}`   (bc evaluates each element, so wrap recursively)
 *   - object  → `{obj:{k:literalize(v)…}}`  (a plain map, e.g. a JSON payload object)
 *   - scalar  → the value itself (null/bool/string/number pass through evaluateExpression verbatim;
 *               an integral number becomes a bigint, normalized back at the driver boundary).
 * This reuses ONLY vocabulary every language runtime's bc already implements (`{arr}`/`{obj}` — the
 * emit outbox payload already rides `{obj}` on live PG+MySQL), so a batch write executes through the
 * SAME per-statement tx loop in all five runtimes with NO runtime change.
 */
export function literalize(value: unknown): TxExpr {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return { arr: value.map((e) => literalize(e)) };
  // A bc `int` is a BigInt on the TS plane. `evaluateExpression` accepts an integer only as a plain
  // JS number (safe range) or the `{int:"…"}` literal — a RAW BigInt node is rejected ("invalid node").
  // A value read back from an integer column now arrives as a BigInt (bc's int model), and using it in a
  // later write (e.g. the id from a `create({returning:true})` fed to a nested `create`) sent that BigInt
  // straight into `evaluateExpression`, which threw. Encode it as bc's own canonical int literal
  // (`{int: v.toString()}`, exactly what bc emits for an out-of-safe-range int) — exact, no rounding,
  // and no value inference. MUST be before the `typeof === 'object'` branch would ever see it (a bigint
  // is a primitive, so it would fall through to the bare `return value`).
  if (typeof value === 'bigint') return { int: value.toString() };
  if (typeof value === 'object') {
    const obj: Record<string, TxExpr> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) obj[k] = literalize(v);
    return { obj };
  }
  return value;
}

/**
 * The compiled op of a transaction statement — a `makeSQL` template. `sql` is the COMPLETE
 * tuned SQL text (byte-parity with the v1 write path) with `?` placeholders; `params` are
 * closed-set Expression IR resolved at execute time against the tx scope. This is the makeSQL
 * re-expression of the reduced `CompiledOperation` for the write path (no fragment tree, no
 * `{where}` splice — the WHERE text is already complete).
 */
export interface TxOp {
  /** Complete tuned SQL text (`?` placeholders). */
  readonly sql: string;
  /** Deferred param slots — closed-set Expression IR (`{ref:…}` / literal / `{obj:…}`). */
  readonly params: readonly TxExpr[];
  /**
   * The target table's PRIMARY KEY descriptor, for the MySQL RETURNING emulation (MySQL has no
   * native RETURNING). Present ONLY on an INSERT…RETURNING op. `columns` are the real PK column(s);
   * `autoInc` is the single AUTO_INCREMENT column name (int identity), or null for a client-supplied
   * PK (UUID / composite / natural key). The mysql-dialect bundle serializes this into a strip-
   * before-execute SQL comment ({@link mysqlPkHint}) the driver emulation reads so it re-selects by
   * the REAL PK — not a hardcoded `WHERE id = ?` (which breaks for UUID / composite PKs).
   */
  readonly pk?: { readonly columns: readonly string[]; readonly autoInc: string | null };
  /**
   * NATIVE-CODEGEN typing metadata (E5/#120 — the RETURNING-chained tx chain). Additive: the runtime
   * tx ({@link executeTransaction}) IGNORES it; the bc native-codegen chain lowering
   * (bc's rust/go typed-native emitter) reads it to type each statement's
   * native param ports + its produced-row struct WITHOUT re-parsing the rendered SQL. The SHARED
   * {@link compileWriteNode} emits it from the structured ports it already has (one compiler feeds both
   * the runtime and the codegen chain). Present on a single-statement Insert/Update/Delete op; absent
   * on a batch op (its `?` binds a `{__batchRows}` marker, not a column). `bindColumns[i]` is the table
   * column the i-th `?` binds (parallel to `params`; `null` when the param is not a plain column value).
   */
  readonly writeMeta?: {
    readonly table: string;
    readonly bindColumns: readonly (string | null)[];
    readonly returning: readonly string[];
    /** The upsert conflict-target column list (`onConflict` port), when this write is an upsert — lets a
     * downstream mysql RETURNING re-select recover the upserted row by its conflict key. Absent otherwise. */
    readonly onConflict?: string;
    /** True for a batch op (createMany/updateMany/upsertMany — its `?` binds a `{__batchRows}` marker,
     * not per-column values). The native tx-chain lowering rejects a batch op (it types per-column); the
     * flag lets it detect batch even though the op now carries `pk`/`onConflict` for the mysql RETURNING
     * re-select (which the batch write, like the single write, must honor). */
    readonly batch?: boolean;
  };
}

/** The role a transaction statement plays (drives the runtime's §6 derivation order). */
export type StatementRole =
  | 'body'
  | 'derive'
  | 'edge'
  | 'emit';

/**
 * The write intent a {@link TransactionPlan} carries. It labels the plan the BATCH compilers derive
 * (`createMany` ⇒ `create`, `updateMany` ⇒ `update`, `deleteMany` ⇒ `remove`) so a consumer can tell
 * the three apart without re-reading the SQL.
 */
export type WriteLifecyclePhase = 'create' | 'update' | 'remove';

/**
 * The reserved scope key the tx runtime binds the plan's `entityFrom` row under, so a later statement
 * that references the written row resolves against it. Reserved: no input field may use this name.
 */
export const ENTITY_ROOT = '__entity';

/** One ordered statement of a transaction plan (pure JSON — a makeSQL template + its role). */
export interface TxStatement {
  /** Stable statement id (ordering key + diagnostics). */
  readonly id: string;
  /** The statement's role in the §6 derivation order. */
  readonly role: StatementRole;
  /** The compiled makeSQL op (complete `sql` + deferred Expression-IR `params`). */
  readonly op: TxOp;
  /** For a composite body statement: the name under which this RETURNING row is exposed. */
  readonly binds?: string;
  /** Human label (diagnostics; e.g. `requires users`, `derive users.post_count`). */
  readonly label: string;
}

/** A derived write-time-relations transaction plan (pure JSON — ordered statements). */
export interface TransactionPlan {
  readonly phase: WriteLifecyclePhase;
  readonly entityFrom: string | null;
  readonly statements: readonly TxStatement[];
}

export const IN_SENTINEL = '@in';

type WriteComponent = 'Insert' | 'Update' | 'Delete' | 'Select';
interface WriteNodeLike {
  readonly id?: string;
  readonly component: WriteComponent;
  readonly ports: Record<string, unknown>;
}

function stringPort(ports: Record<string, unknown>, name: string): string | undefined {
  const v = ports[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`compileWriteNode: port '${name}' must be a literal string in the IR (got ${JSON.stringify(v)})`);
  return v;
}

/** `<prefix>.<field>` ports → an ordered `Record<field, ExprNode>` (declaration order). */
function collectFamily(ports: Record<string, unknown>, prefix: string): Record<string, TxExpr> {
  const out: Record<string, TxExpr> = {};
  for (const k of Object.keys(ports)) {
    if (k.startsWith(`${prefix}.`)) out[k.slice(prefix.length + 1)] = ports[k];
  }
  return out;
}

/**
 * Collect the `sqlCast.<field>` port family → `Map<column, sqlCastType>` (the PG per-column cast
 * types, e.g. `jsonb`/`uuid`/`int[]`). This mirrors the `sqlCastMap` v1 `DBModel._insert`/`_update`
 * read from the column metadata (`getSqlCastMap`) to emit `?::<sqlCast>` on Postgres. A write node
 * that declares no cast ports yields an empty map (no cast columns — the common case).
 */
function collectSqlCast(ports: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  for (const k of Object.keys(ports)) {
    if (!k.startsWith('sqlCast.')) continue;
    const v = ports[k];
    if (typeof v !== 'string') {
      throw new Error(`compileWriteNode: port '${k}' (a sqlCast type) must be a literal string in the IR (got ${JSON.stringify(v)})`);
    }
    map.set(k.slice('sqlCast.'.length), v);
  }
  return map;
}

/**
 * The placeholder text for one written column's value, applying the v1 PER-COLUMN cast on Postgres.
 * Byte-identical to v1 `DBModel._insert` (`src/drivers/PostgresSqlBuilder.ts:289-296`) and `_update`
 * (`src/DBModel.ts:1058-1063`): a PG cast column emits `?::<sqlCast>` via the SAME dialect cast
 * formatter (`formatterFor('postgres')`), SKIPPING `timestamp`/`date` (the pg driver serializes Date
 * objects itself — an explicit cast interferes). MySQL/SQLite emit a bare `?` (v1's dialect-aware
 * `SqlCastFormatter` is identity there — the .rs `::type` leak is NOT reproduced). The tx-write path
 * targets a single dialect at compile, so the cast is resolved here, not deferred.
 */
function castPlaceholder(dialect: MakeSQLDialect, sqlCastMap: Map<string, string>, column: string): string {
  const sqlCast = sqlCastMap.get(column);
  if (dialect !== 'postgres' || sqlCast === undefined || sqlCast === 'timestamp' || sqlCast === 'date') return '?';
  return formatterFor('postgres')('?', sqlCast);
}

function opKey(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const keys = Object.keys(node as object);
  return keys.length === 1 ? keys[0] : undefined;
}

function columnOf(node: unknown, ctx: string): string {
  const op = opKey(node);
  if (op !== 'ref' && op !== 'refOpt') throw new Error(`compileWriteNode: ${ctx}: the column operand must be a {ref:[…]} path`);
  const path = (node as Record<string, unknown[]>)[op];
  if (!Array.isArray(path) || path.length === 0 || typeof path[path.length - 1] !== 'string') {
    throw new Error(`compileWriteNode: ${ctx}: column ref path must be a non-empty string path`);
  }
  return path[path.length - 1] as string;
}

function binOperands(node: unknown, op: string, at: string): [unknown, unknown] {
  const args = (node as Record<string, unknown[]>)[op];
  if (!Array.isArray(args) || args.length !== 2) throw new Error(`compileWriteNode: ${at}: '${op}' expects exactly 2 operands`);
  return [args[0], args[1]];
}

/** The comparison-operator SQL symbols, keyed by the bc operator name (drives the v1 custom-op key). */
const CMP_OPS: Record<string, string> = { lt: '<', le: '<=', gt: '>', ge: '>=', ne: '<>' };

/** A probe placeholder value fed to the v1 builder so it emits one `?` per bound slot. */
const PROBE = '__probe__';

/**
 * Produce a bare condition body's TEXT by driving the ORIGINAL v1 `DBConditions.compile()` — the
 * SAME builder the eager write path and `compile-crud` use, so the WHERE text is byte-identical
 * to v1 by construction (a v2 hand-roll would make the corpus tautological). The throwaway
 * `probe` array absorbs the probe values; the real runtime values are the caller's deferred
 * Expression-IR params. The write path targets a single dialect at render but the WHERE `= ?` /
 * `<op> ?` / `IS NULL` / `IS NOT NULL` forms are dialect-invariant in `DBConditions`.
 */
function v1ConditionText(conditions: ConditionObject): string {
  const probe: unknown[] = [];
  return new DBConditions(conditions).compile(probe);
}

/**
 * Lower one where-member Expression node → a `<sql, params, columns>` WHERE fragment (deferred
 * params). `columns[i]` is the table column the i-th emitted param binds — parallel to `params` — so
 * the native-codegen chain types each WHERE-bound `?` from its column (see {@link TxOp.writeMeta}).
 */
function lowerWhereMember(node: unknown, at: string, dialect: MakeSQLDialect): { sql: string; params: TxExpr[]; columns: string[] } {
  const op = opKey(node);
  if (op === undefined) throw new Error(`compileWriteNode: ${at}: a where member must be a single-operator Expression node`);
  if (op === 'in') {
    // Key-set membership — the SAME static single-param predicate the read IN-list uses
    // ({@link inListPredicate}: PG `= ANY(?)`, MySQL/SQLite a JSON subquery), so a `deleteMany`'s
    // statement comes from THIS compiler rather than being assembled by its caller.
    const [col, val] = binOperands(node, op, at);
    const column = columnOf(col, at);
    return { sql: v1ConditionText({ [inListPredicate(dialect, column)]: PROBE }), params: [val], columns: [column] };
  }
  if (op === 'eq') {
    const [col, val] = binOperands(node, op, at);
    const column = columnOf(col, at);
    if (val === null) return { sql: v1ConditionText({ [column]: null }), params: [], columns: [] };
    return { sql: v1ConditionText({ [column]: PROBE }), params: [val], columns: [column] };
  }
  if (op in CMP_OPS) {
    const [col, val] = binOperands(node, op, at);
    const column = columnOf(col, at);
    if (op === 'ne' && val === null) return { sql: v1ConditionText({ [`${column} IS NOT NULL`]: true }), params: [], columns: [] };
    return { sql: v1ConditionText({ [`${column} ${CMP_OPS[op]} ?`]: PROBE }), params: [val], columns: [column] };
  }
  throw new Error(`compileWriteNode: ${at}: unsupported where operator '${op}' (write path supports eq/ne/lt/le/gt/ge)`);
}

function lowerWherePort(ports: Record<string, unknown>, at: string, dialect: MakeSQLDialect): { sql: string; params: TxExpr[]; columns: string[] } {
  const v = ports.where;
  if (v === undefined) return { sql: '', params: [], columns: [] };
  if (typeof v !== 'object' || v === null || !('arr' in v) || !Array.isArray((v as { arr: unknown }).arr)) {
    throw new Error(`compileWriteNode: ${at}: 'where' must be an {arr:[…]} literal`);
  }
  const members = (v as { arr: unknown[] }).arr;
  const parts: string[] = [];
  const params: TxExpr[] = [];
  const columns: string[] = [];
  members.forEach((m, i) => {
    const f = lowerWhereMember(m, `${at}.where[${i}]`, dialect);
    parts.push(f.sql);
    params.push(...f.params);
    columns.push(...f.columns);
  });
  // Join with the SAME ` AND ` connector `DBConditions.compile` uses (parts.join(' AND ')).
  return { sql: parts.join(' AND '), params, columns };
}

/** The RETURNING column names (`['id','author_id']`), or `[]` when the op has no RETURNING clause. */
function returningColumns(ports: Record<string, unknown>): string[] {
  const r = stringPort(ports, 'returning');
  return r === undefined ? [] : r.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
}

function returningTail(ports: Record<string, unknown>): string {
  const r = stringPort(ports, 'returning');
  return r === undefined ? '' : ` RETURNING ${r}`;
}

/**
 * The upsert `ON CONFLICT` / `ON DUPLICATE KEY` tail of an `Insert`, from the `onConflict` (the
 * conflict-target column list) + `onConflictAction` (`'update'` default / `'ignore'`) ports. Absent
 * `onConflict` ⇒ a plain INSERT (no tail). Per-dialect verbs, byte-matching the JSON-batch upsert
 * form (`sqliteInsertJson`): pg/sqlite `ON CONFLICT (k) DO UPDATE SET c = excluded.c` / `DO NOTHING`;
 * mysql `ON DUPLICATE KEY UPDATE c = VALUES(c)` (mysql ignores the target list). The DO-UPDATE sets
 * every inserted column to its excluded value (`onConflictUpdate:'all'` — the v1 builder fallback);
 * setting the key column to itself is a harmless no-op. This shared compiler is what BOTH the runtime
 * (`executeStaticWrite`) and codegen read, so an authored upsert executes AND bakes identically.
 */
/** Map the `onConflict`/`onConflictAction` ports to the {@link JsonInsertOptions} upsert fields (the
 * batch json_each builder's own shape) — so a batch UPSERT (upsertMany) reuses the SAME conflict verbs
 * as the single upsert (E2). Absent `onConflict` ⇒ a plain batch INSERT. */
function onConflictJsonOpts(ports: Record<string, unknown>, cols: readonly string[]): { onConflict?: string[]; onConflictUpdate?: 'all'; onConflictIgnore?: boolean } {
  const conflict = stringPort(ports, 'onConflict');
  if (conflict === undefined) return {};
  const onConflict = conflict.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
  const action = stringPort(ports, 'onConflictAction') ?? 'update';
  void cols;
  return action === 'ignore' ? { onConflict, onConflictIgnore: true } : { onConflict, onConflictUpdate: 'all' };
}

function onConflictTail(dialect: MakeSQLDialect, ports: Record<string, unknown>, cols: readonly string[]): string {
  const conflict = stringPort(ports, 'onConflict');
  if (conflict === undefined) return '';
  const action = stringPort(ports, 'onConflictAction') ?? 'update';
  const conflictCols = conflict.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
  if (action === 'ignore') {
    return dialect === 'mysql'
      ? ` ON DUPLICATE KEY UPDATE ${conflictCols[0]} = ${conflictCols[0]}` // mysql no-op update = IGNORE-equivalent
      : ` ON CONFLICT (${conflictCols.join(', ')}) DO NOTHING`;
  }
  if (dialect === 'mysql') {
    return ` ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`;
  }
  return ` ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`;
}

/**
 * A per-column raw VALUE SPECIMEN whose {@link import('../../drivers/PostgresSqlBuilder').inferPgType}
 * matches the column's SCHEMA SQL type, so the PG batch UNNEST cast (`?::<pgType>[]`) the original
 * `buildInsert`/`buildUpdateMany` emits is derived from the schema SoT — NOT from the runtime values
 * the symbolic codegen path never sees. int32→number / int64→bigint / bool→boolean / date→Date /
 * float→non-integer number / string(+decimal/uuid/json)→string, reproducing each `inferPgType` branch.
 * Ambiguous only for a REAL column whose live value is integer-valued (v1 would infer `int`, not
 * `numeric`); the bench columns (text/int/bigint) are unambiguous. Unknown SQL types are a hard error
 * (fail-closed) via the §4.1 classifiers.
 */
export function pgTypeSpecimen(sqlType: string): unknown {
  const klass = sqlTypeToMaterializeClass(sqlType);
  if (klass === 'int32') return 0;
  if (klass === 'int64') return 0n;
  if (klass === 'bool') return false;
  if (klass === 'date') return new Date(0);
  // passthrough: float / decimal(→string) / text / uuid / json — split by the bc scalar.
  const scalar = sqlTypeToBcScalar(sqlType);
  if (scalar === 'float') return 0.5; // a non-integer number ⇒ inferPgType 'numeric'
  return ''; // string family (text / varchar / uuid / decimal / json) ⇒ inferPgType 'text'
}

/**
 * Compile a PG BATCH Insert/Update to its byte-identical v1 UNNEST form for the NATIVE codegen path,
 * by driving the ORIGINAL `postgresSqlBuilder` (never a re-roll) with schema-typed specimen records
 * (so the emitted `?::<pgType>[]` casts come from the schema SoT). Each `?` binds a per-column
 * {@link BatchArrayMarker} — the PG (v1) twin of the sqlite/mysql (v2) `{__batchRows}` JSON marker:
 * `refs[i]` is the WHOLE array for column `columns[i]`. codegen types the SAME array-input head off
 * both markers (one shared path); the per-driver seam binds each PG marker as a `<elem>[]` array.
 * Length-independent (the UNNEST text depends only on columns + types + onConflict/returning), so
 * FIXED and bakeable.
 */
function pgBatchArrayParams(cols: string[], refFor: (c: string) => TxExpr, dialect: MakeSQLDialect): TxExpr[] {
  return cols.map((c) => ({ __batchArray: { column: c, ref: refFor(c), dialect } }) as unknown as TxExpr);
}

function pgBatchInsert(table: string, sorted: string[], values: Record<string, TxExpr>, ports: Record<string, unknown>, resolve: ColumnTypeResolver, dialect: MakeSQLDialect): TxOp {
  const specimen = Object.fromEntries(sorted.map((c) => [c, pgTypeSpecimen(resolve(table, c))]));
  const records = [specimen, specimen]; // 2 rows ⇒ UNNEST branch (records.length > 1)
  const { sql } = postgresSqlBuilder.buildInsert({
    tableName: table, columns: sorted, records, rawRecords: records,
    ...onConflictJsonOpts(ports, sorted),
    ...(stringPort(ports, 'returning') !== undefined ? { returning: stringPort(ports, 'returning') } : {}),
  });
  return { sql, params: pgBatchArrayParams(sorted, (c) => values[c], dialect) };
}

function pgBatchUpdate(table: string, keyCols: string[], updateCols: string[], key: Record<string, TxExpr>, set: Record<string, TxExpr>, ports: Record<string, unknown>, resolve: ColumnTypeResolver, dialect: MakeSQLDialect): TxOp {
  const allCols = [...keyCols, ...updateCols];
  const specimen = Object.fromEntries(allCols.map((c) => [c, pgTypeSpecimen(resolve(table, c))]));
  const records = [specimen, specimen];
  // The pg batch UPDATE aliases the table `AS t` and the value source `AS v(keyCols…)`, so a BARE
  // RETURNING column that is also a key column (in `v`) is ambiguous. v1's `DBModel.updateMany`
  // qualifies RETURNING with the `t` alias via `buildReturning(table, cols, 't')` — reuse the SAME
  // builder so the qualified RETURNING is byte-identical to v1 (never a hand-roll).
  const returningPort = stringPort(ports, 'returning');
  const returning = returningPort === undefined
    ? undefined
    : postgresSqlBuilder.buildReturning(table, returningPort.split(',').map((c) => c.trim()).filter((c) => c.length > 0), 't');
  const { sql } = postgresSqlBuilder.buildUpdateMany({
    tableName: table, keyColumns: keyCols, updateColumns: updateCols, records, rawRecords: records,
    ...(returning !== undefined ? { returning } : {}),
  });
  // One array param per UNNEST column in [keyCols…, updateCols…] order (matches buildUpdateMany).
  const refFor = (c: string): TxExpr => (keyCols.includes(c) ? key[c] : set[c]);
  return { sql, params: pgBatchArrayParams(allCols, refFor, dialect) };
}

/**
 * Read the optional PRIMARY KEY descriptor ports of an Insert node (for the MySQL RETURNING
 * emulation). `pk` is a comma-separated column list (`'doc_id'` / `'order_id,line_no'`); `autoInc`
 * names the single AUTO_INCREMENT column, or is absent for a client-supplied PK. Absent `pk`
 * defaults to null (the emulation then keeps its legacy `WHERE id`/`LAST_INSERT_ID` path, so the
 * existing auto-increment-`id` corpus is unchanged).
 */
export function pkPort(ports: Record<string, unknown>): { columns: readonly string[]; autoInc: string | null } | undefined {
  const pk = stringPort(ports, 'pk');
  if (pk === undefined) return undefined;
  const columns = pk.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
  if (columns.length === 0) return undefined;
  const ai = stringPort(ports, 'autoInc');
  return { columns, autoInc: ai ?? null };
}

/**
 * Compile ONE authored catalog write node (`Insert`/`Update`/`Delete`) into a makeSQL {@link TxOp}
 * — complete tuned SQL text + DEFERRED Expression-IR params. This is the makeSQL re-expression of
 * the reduced bridge's `compileNode` for the write path (the tx-DAG base writes). INSERT columns
 * are CANONICAL (alphabetical) sorted — the v2 write-path SSoT (matches `DBModel._insert`).
 */
export function compileWriteNode(node: WriteNodeLike, dialect: MakeSQLDialect = 'sqlite', resolveColumnType?: ColumnTypeResolver): TxOp {
  const op = compileWriteNodeSql(node, dialect, resolveColumnType);
  // MySQL parses no RETURNING: the strip-before-execute pk hint rides the compiled SQL so the mysql
  // connection adapter can re-select the written rows by the REAL key. It is applied HERE, at the one
  // write compiler, rather than by each producer — the producers that forgot the ritual are exactly
  // how a UUID / client-supplied / composite PK came to return no rows at all.
  return dialect === 'mysql' ? mysqlPkHint(op) : op;
}

/** {@link compileWriteNode}'s SQL body — the dialect-neutral descriptor → statement compile. */
function compileWriteNodeSql(node: WriteNodeLike, dialect: MakeSQLDialect, resolveColumnType?: ColumnTypeResolver): TxOp {
  const { component, ports } = node;
  const table = stringPort(ports, 'table');
  if (table === undefined) throw new Error(`compileWriteNode: ${component} node requires a literal 'table' port`);
  // Per-column PG cast types (`sqlCast.<field>` ports) — drive the v1 `?::<sqlCast>` on Postgres.
  const sqlCastMap = collectSqlCast(ports);

  switch (component) {
    case 'Insert': {
      const values = collectFamily(ports, 'values');
      const cols = Object.keys(values);
      if (cols.length === 0) throw new Error(`compileWriteNode: Insert requires at least one 'values.<field>' port`);
      const sorted = [...cols].sort();
      // E3 (#118) BATCH insert (createMany / upsertMany): a `batch:'true'` marker means each
      // `values.<col>` port is a PARALLEL ARRAY of that column's values (bc has no Vec<struct>, so the
      // records ride as one scalar array per column). Reuse the EXISTING json_each batch f_sql (its
      // text depends only on the columns + onConflict/returning — value-length-independent, so FIXED
      // and bakeable); the ONE JSON `?` binds a `{__batchRows}` marker the runtime/codegen build from
      // the parallel arrays at execute time (NOT literalized). One statement for N records.
      if (stringPort(ports, 'batch') === 'true') {
        if (dialect === 'postgres') {
          if (resolveColumnType === undefined) throw new Error(`compileWriteNode: batch insert on postgres needs the column-type resolver (schema SoT) to derive the UNNEST element casts — pass it through compileCreateManyBundle (the decorator-adapter batch write path).`);
          return pgBatchInsert(table, sorted, values, ports, resolveColumnType, dialect);
        }
        const shapeOpts = { tableName: table, columns: sorted, records: [] as Record<string, unknown>[], ...onConflictJsonOpts(ports, sorted), ...(stringPort(ports, 'returning') !== undefined ? { returning: stringPort(ports, 'returning') } : {}) };
        const shape = dialect === 'mysql' ? mysqlInsertJson(shapeOpts) : sqliteInsertJson(shapeOpts);
        // The ONE json param = a deferred marker carrying the columns + their parallel array refs.
        const marker = { __batchRows: { columns: sorted, refs: sorted.map((c) => values[c]), dialect } };
        // Carry `pk` + `onConflict` (the SAME pkPort/onConflict SSoT the single INSERT path uses) so the
        // mysql RETURNING re-select recovers ALL N written rows by the real key (auto-inc range, or the
        // conflict key for upsertMany). `batch:true` keeps the native tx-chain lowering rejecting this op.
        const pk = pkPort(ports);
        const onConflictCols = stringPort(ports, 'onConflict');
        const writeMeta = { table, bindColumns: sorted, returning: returningColumns(ports), batch: true, ...(onConflictCols !== undefined ? { onConflict: onConflictCols } : {}) };
        return { sql: shape.sql, params: [marker], ...(pk !== undefined ? { pk } : {}), writeMeta };
      }
      // v1 `DBModel._insert` emits `?::<sqlCast>` PER COLUMN on Postgres (skipping timestamp/date);
      // the placeholder list is thus per-column, NOT a uniform `?` join (the latent H1 divergence).
      const placeholders = sorted.map((c) => castPlaceholder(dialect, sqlCastMap, c)).join(', ');
      const sql = `INSERT INTO ${table} (${sorted.join(', ')}) VALUES (${placeholders})${onConflictTail(dialect, ports, sorted)}${returningTail(ports)}`;
      const pk = pkPort(ports);
      // The `?`s bind the value columns in sorted order (the ON CONFLICT / RETURNING tails add no `?`).
      // `onConflict` (the conflict-target column list) rides on writeMeta ADDITIVELY (no SQL change) so a
      // downstream mysql RETURNING re-select can recover an upserted row by its conflict key (mysql does
      // not report the conflicted-row id) — used by the tx-chain codegen lowering.
      const onConflictCols = stringPort(ports, 'onConflict');
      const writeMeta = { table, bindColumns: sorted, returning: returningColumns(ports), ...(onConflictCols !== undefined ? { onConflict: onConflictCols } : {}) };
      return { sql, params: sorted.map((c) => values[c]), ...(pk !== undefined ? { pk } : {}), writeMeta };
    }
    case 'Update': {
      const set = collectFamily(ports, 'set');
      const setCols = Object.keys(set);
      if (setCols.length === 0) throw new Error(`compileWriteNode: Update requires at least one 'set.<field>' port`);
      // E3 (#118) BATCH update (updateMany): `batch:'true'` — the `key.<col>` family names the match
      // key(s) (parallel arrays), the `set.<col>` family the columns to set (parallel arrays). Reuse
      // the EXISTING json_each/JSON_TABLE batch UPDATE (`sqliteUpdateManyJson`): its text depends only
      // on the key + update columns, so it's FIXED and bakeable. It binds the ONE records-JSON to
      // MULTIPLE `?` (one per SET clause + the WHERE) — each is the SAME `__batchRows` marker, so the
      // runtime evalSpec (and the codegen seam) build the SAME JSON per `?`. ONE statement for N rows.
      if (stringPort(ports, 'batch') === 'true') {
        const key = collectFamily(ports, 'key');
        const keyCols = Object.keys(key).sort();
        if (keyCols.length === 0) throw new Error(`compileWriteNode: batch Update requires at least one 'key.<field>' port`);
        const updateCols = [...setCols].sort();
        if (dialect === 'postgres') {
          if (resolveColumnType === undefined) throw new Error(`compileWriteNode: batch update on postgres needs the column-type resolver (schema SoT) to derive the UNNEST element casts — pass it through compileCreateManyBundle (the decorator-adapter batch write path).`);
          return pgBatchUpdate(table, keyCols, updateCols, key, set, ports, resolveColumnType, dialect);
        }
        const shapeOpts = { tableName: table, keyColumns: keyCols, updateColumns: updateCols, records: [] as Record<string, unknown>[], ...(stringPort(ports, 'returning') !== undefined ? { returning: stringPort(ports, 'returning') } : {}) };
        const shape = dialect === 'mysql' ? mysqlUpdateManyJson(shapeOpts) : sqliteUpdateManyJson(shapeOpts);
        // The JSON carries BOTH the key + update columns (in that order); one marker per `?`.
        const columns = [...keyCols, ...updateCols];
        const refs = [...keyCols.map((c) => key[c]), ...updateCols.map((c) => set[c])];
        const nQ = (shape.sql.match(/\?/g) ?? []).length;
        const marker = { __batchRows: { columns, refs, dialect } };
        // Carry `pk` (the SAME pkPort SSoT) so the mysql RETURNING re-select orders the recovered rows by
        // the real key (matching pg/sqlite RETURNING order). `batch:true` keeps the tx-chain rejecting it.
        const pk = pkPort(ports);
        const writeMeta = { table, bindColumns: columns, returning: returningColumns(ports), batch: true };
        return { sql: shape.sql, params: Array.from({ length: nQ }, () => marker), ...(pk !== undefined ? { pk } : {}), writeMeta };
      }
      // An absent `where` port is an UNCONDITIONAL update — `UPDATE … SET …` with no tail. The port
      // carries the structured `{arr:[…]}` member list and is lowered INLINE here; nothing appends a
      // WHERE afterwards.
      const where = lowerWherePort(ports, 'Update', dialect);
      // v1 `DBModel._update` emits `<c> = ?::<sqlCast>` PER COLUMN on Postgres (skipping timestamp/date).
      const setClauses = setCols.map((c) => `${c} = ${castPlaceholder(dialect, sqlCastMap, c)}`).join(', ');
      const whereTail = where.sql === '' ? '' : ` WHERE ${where.sql}`;
      const sql = `UPDATE ${table} SET ${setClauses}${whereTail}${returningTail(ports)}`;
      // The `?`s bind the SET columns (in setCols order) then the WHERE columns (`where.columns`).
      // `pk` rides along (the SAME pkPort SSoT the INSERT paths use) so a dialect without native
      // RETURNING orders its recovered rows by the real key — without it a multi-row UPDATE…RETURNING
      // comes back in the re-select's own order, which need not match PG's.
      const writeMeta = { table, bindColumns: [...setCols, ...where.columns], returning: returningColumns(ports) };
      const pk = pkPort(ports);
      return { sql, params: [...setCols.map((c) => set[c]), ...where.params], ...(pk !== undefined ? { pk } : {}), writeMeta };
    }
    case 'Delete': {
      // As Update: the `where` port is lowered inline. Absent ⇒ an unconditional `DELETE FROM t`.
      const where = lowerWherePort(ports, 'Delete', dialect);
      const sql = `DELETE FROM ${table}${where.sql === '' ? '' : ` WHERE ${where.sql}`}${returningTail(ports)}`;
      // The `?`s bind the WHERE columns; a DELETE has no SET/VALUES params. `pk` rides along so the
      // pre-image re-select is ordered by the real key (as Update above).
      const writeMeta = { table, bindColumns: where.columns, returning: returningColumns(ports) };
      const pk = pkPort(ports);
      return { sql, params: where.params, ...(pk !== undefined ? { pk } : {}), writeMeta };
    }
    default:
      throw new Error(`compileWriteNode: catalog component '${component}' has no write compile (SQL writes: Insert/Update/Delete)`);
  }
}

type IdGen = (role: string) => string;
function makeIdGen(): IdGen {
  let n = 0;
  return (role: string) => `tx_${role}_${n++}`;
}

/**
 * Lower a list of CONCRETE batch-write ops (createMany / updateMany / deleteMany — each already
 * compiled by driving the v1 builders in `compile-crud`, so its `sql` is byte-identical to v1 and
 * its `params` are concrete grouped values) into a gate-free {@link TransactionPlan} of `body`
 * statements, run IN THE DECLARED ORDER as ONE transaction. This is the makeSQL re-expression of a
 * BATCH write: createMany with heterogeneous column-set groups is exactly a composition of several
 * INSERT statements (`_insert:928-975` grouping), and each group's SQL is one v1-copied statement.
 *
 * Each op's concrete params are {@link literalize}d into bc literal-carrier IR so they survive the
 * tx runtime's `evaluateExpression` render pass unchanged (a PG batch binds real arrays). The plan
 * carries NO gates and NO `$.entity`/`$.ref` bindings — a batch write is N independent grouped
 * statements, executed in order (the last statement's RETURNING rows, if any, are the `entity`).
 */
export function deriveBatchPlan(
  phase: WriteLifecyclePhase,
  ops: readonly { sql: string; params: readonly unknown[]; label?: string }[],
): TransactionPlan {
  if (ops.length === 0) {
    throw new Error('write-plan: a batch write must declare at least one statement (createMany/updateMany/deleteMany produced none).');
  }
  const nextId = makeIdGen();
  const statements: TxStatement[] = ops.map((op, i) => ({
    id: nextId('body'),
    role: 'body' as const,
    op: { sql: op.sql, params: op.params.map((p) => literalize(p)) },
    label: op.label ?? `batch[${i}]`,
  }));
  // A batch write has NO single `$.entity` row — it is N grouped statements, each possibly RETURNING
  // its own rows. `entityFrom` stays null; the runtime accumulates EVERY body statement's RETURNING
  // rows into `TransactionResult.returnedRows` (ordered by group), reproducing v1 `createMany`'s
  // "all created rows" result while `expectedDbState` proves the persisted state.
  return { phase, entityFrom: null, statements };
}

/** The structured outcome of executing a {@link TransactionPlan}. */
export interface TransactionResult {
  readonly committed: boolean;
  readonly entity: Record<string, unknown> | null;
  readonly executed: readonly string[];
  /**
   * For a BATCH write (createMany/updateMany/deleteMany — a gate-free plan with `entityFrom:null`):
   * the RETURNING rows of every body statement, ordered by statement. Present ONLY when a body
   * statement RETURNED rows and the plan has no `$.entity` (batch mode); absent for a gate-first
   * single/composite Command (which exposes its written row via `entity`). This carries v1
   * `createMany`'s "all created rows" result across the multi-statement batch.
   */
  readonly returnedRows?: readonly (readonly Record<string, unknown>[])[];
}

/** bc evaluates ints to bigint; convert a rendered param to a driver-bindable value. */
function toDriverParam(v: Value, dialect: MakeSQLDialect): unknown {
  if (typeof v === 'bigint') {
    if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
    return v;
  }
  // An emit payload evaluates to a plain object (`{obj:{…}}`); serialize it to the outbox JSON text
  // through the ONE JSON-param encoder, so a field that came off a read (a bc `int`, i.e. a BigInt that
  // `JSON.stringify` refuses) is handled the same way the batch and array params handle it.
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return encodeJsonParam(dialect, v);
  return v;
}

/**
 * Evaluate a statement's makeSQL op against the tx scope to RAW `?` SQL + driver-coerced params:
 * evaluate each deferred Expression-IR param to a concrete value (bc `evaluateExpression`), assemble
 * the concrete `makeSQL` (splice nested makeSQL), and coerce each param to the driver form
 * ({@link toDriverParam}). Placeholder render (`?`→`$N`) is NOT done here — it is the transport leaf's
 * job (`executeSQL`) so a tx body statement rides the SAME op-independent transport as every read/write.
 * This is the single eval/assemble/coerce for both the sync leaf exec ({@link execStatement}) and the
 * placeholder-rendered {@link renderStatement} (async path + golden export).
 */
function evalAssemble(op: TxOp, scope: Scope, dialect: MakeSQLDialect): { sql: string; params: unknown[] } {
  const concrete: unknown[] = op.params.map((p) => evaluateExpression(p, scope));
  const assembled = assembleMakeSQL({ sql: op.sql, params: concrete });
  return { sql: assembled.sql, params: assembled.params.map((p) => toDriverParam(p as Value, dialect)) };
}

/**
 * Render a statement's makeSQL op against the tx scope to the dialect placeholder form ({@link
 * evalAssemble} + `?`→`$N`). Used by the ASYNC tx path ({@link execStatementAsync}) and the golden
 * export {@link renderTxStatement}; the SYNC path renders via the transport leaf ({@link execStatement}).
 */
function renderStatement(op: TxOp, scope: Scope, dialect: MakeSQLDialect): { sql: string; params: unknown[] } {
  const { sql, params } = evalAssemble(op, scope, dialect);
  return { sql: renderPlaceholders(sql, dialect), params };
}

/** Render one statement op to its dialect SQL text + params (exposed for golden tests). */
export function renderTxStatement(op: TxOp, scope: Scope, dialect: MakeSQLDialect = 'sqlite'): { sql: string; params: unknown[] } {
  return renderStatement(op, scope, dialect);
}

// ============================================================================
// Phase A (#75) — ASYNC transaction runtime (live PG / MySQL) with PER-EXECUTION
// CONNECTION OWNERSHIP. The async twin of `executeTransaction`: it runs the derived
// TransactionPlan through `withTransactionAsync`, which acquires ONE pooled connection,
// pins it in the ALS ctx, and runs BEGIN…COMMIT on it. Concurrent transactions each own a
// DISTINCT connection ⇒ isolated (no shared-slot cross-talk). This is the production async
// write-tx path the concurrent-tx isolation test exercises.
// ============================================================================

/**
 * Run ONE rendered tx statement through the async seam — the SAME op-independent `executeSQL`
 * transport leaf every read/write rides. Returns `{ rows, changes }`.
 *
 * MySQL's missing RETURNING is NOT handled here: it is a property of the CONNECTION, and the mysql
 * connection adapter ({@link import('./pool-executor').mysqlConnectionPool}) owns it — so the mode-2
 * plan executor and a generated (codegen) write reach the identical write→re-select through one
 * seam, and cannot disagree about the rows a write returns.
 */
async function execStatementAsync(
  ctx: AsyncExecutionContext,
  op: TxOp,
  scope: Scope,
  dialect: MakeSQLDialect,
): Promise<{ rows: Record<string, unknown>[]; changes: number }> {
  // Eval value-specs + assemble to RAW `?` SQL + coerced params (the SSoT `evalAssemble`, shared with
  // the sync path). The leaf renders `?`→`$N` per dialect after the final SQL is assembled.
  const { sql, params } = evalAssemble(op, scope, dialect);

  // A SELECT/RETURNING reads rows; a bare write returns the `[{changes,…}]` summary.
  const hasReturn = /\bselect\b/i.test(sql.slice(0, 8)) || /\breturning\b/i.test(sql);
  const out = await executeSQLAsync({ sql, params, write: { returning: hasReturn } }, { execAsync: ctx, dialect } satisfies AsyncLeafContext);
  return hasReturn ? { rows: out, changes: out.length } : { rows: [], changes: Number(out[0]?.changes ?? 0) };
}

/**
 * Options for the live async write entry {@link executeTransactionAsync} — the tx {@link
 * TransactionOptions} plus the write=tx `guard` policy (#86).
 */
export interface WriteExecOptions extends TransactionOptions {
  /**
   * Enforce the write=tx guard (#86 / #81 `checkWriteAllowed`): a write issued OUTSIDE a user
   * `transaction(fn)` throws {@link WriteOutsideTransactionError}; a write in a {@link
   * import('../tx-options').withReadOnly} scope throws {@link WriteInReadOnlyContextError}. This is
   * the DEFAULT for the public write path — writes require an explicit transaction (v1 parity,
   * `DBModel.ts:886`). Set `false` ONLY for the internal per-execution-ownership plane (the Phase A
   * ownership proofs that drive the plan executor as its OWN auto-tx). @default true
   */
  readonly guard?: boolean;
}

/**
 * Execute a derived {@link TransactionPlan} on a live PG / MySQL connection with gate-first
 * short-circuit and **per-execution connection ownership** (§3). The live-DB WRITE entry (#86).
 *
 * ## Ambient-tx JOIN vs. its own envelope (the #86 core)
 *
 * `withTransactionAsync` (:495) decides the envelope:
 *   - **inside a user `transaction(fn)`** (an outer connection is pinned in the ALS) → the write
 *     JOINS the outer: its statements run on the outer's owned connection with NO new BEGIN/COMMIT,
 *     so N writes in one boundary are ONE physical transaction (one BEGIN, one COMMIT, one conn);
 *   - **outside any transaction** → it opens its OWN BEGIN…COMMIT on a freshly-acquired owned
 *     connection (the per-execution auto-tx; concurrent calls each own a DISTINCT connection ⇒
 *     isolated).
 *
 * ## write=tx guard (#86, wired here — fires at runtime, not a standalone helper)
 *
 * With `options.guard` (DEFAULT true), a write with NO ambient user tx is REJECTED via {@link
 * checkWriteAllowed} BEFORE any SQL: `WriteOutsideTransactionError` (no active tx) /
 * `WriteInReadOnlyContextError` (read-only scope). The check runs at ENTRY — before
 * `withTransactionAsync` would open the write's own envelope — so it sees the CALLER's scope, exactly
 * mirroring v1 `DBModel._checkWriteAllowed` (:886, called at the public write entry, not the plan
 * executor). Inside a `transaction(fn)` the ambient marker is set ⇒ the guard passes and the write
 * joins. The structured {@link TransactionResult} is identical to the sync {@link executeTransaction}.
 */
export function executeTransactionAsync(
  ctx: PooledAsyncContext,
  plan: TransactionPlan,
  input: Scope,
  dialect: MakeSQLDialect = 'sqlite',
  options: WriteExecOptions = {},
): Promise<TransactionResult> {
  // write=tx guard (#86), enforced at ENTRY so it sees the CALLER's scope — a write inside a user
  // `transaction(fn)` has the ambient "inside a tx" marker set (⇒ passes + JOINS the outer); a bare
  // write outside any boundary has no marker (⇒ WriteOutsideTransactionError). Reject as a REJECTED
  // promise (never a synchronous throw) since this entry is async. Tx-control statements the runtime
  // itself issues (BEGIN/COMMIT) never pass through here — only data-write plans do.
  if (options.guard !== false) {
    // Run the guard, then the plan, as a REJECTED promise on failure (never a synchronous throw).
    // `checkWriteAllowed` mirrors v1 ordering (:886): read-only is rejected FIRST
    // (`WriteInReadOnlyContextError`), then a missing active tx (`WriteOutsideTransactionError`).
    // Inside a user `transaction(fn)` the ambient marker is set ⇒ neither fires and the write JOINS
    // the outer; outside any boundary the no-active-tx branch throws.
    return Promise.resolve().then(() => {
      checkWriteAllowed('WRITE', plan.statements[0]?.id);
      return runTransactionPlanAsync(ctx, plan, input, dialect, options);
    });
  }
  return runTransactionPlanAsync(ctx, plan, input, dialect, options);
}

/** The plan-executor body of {@link executeTransactionAsync}, split so the guard runs at entry. */
function runTransactionPlanAsync(
  ctx: PooledAsyncContext,
  plan: TransactionPlan,
  input: Scope,
  dialect: MakeSQLDialect,
  options: TransactionOptions,
): Promise<TransactionResult> {
  const isBatch =
    plan.entityFrom === null && plan.statements.every((s) => s.binds === undefined && s.role === 'body');

  return withTransactionAsync(ctx, async (txCtx) => {
    const executed: string[] = [];
    const scope: Scope = { ...input };
    let entity: Record<string, unknown> | null = null;
    const returnedRows: Record<string, unknown>[][] = [];

    for (const stmt of plan.statements) {
      const result = await execStatementAsync(txCtx, stmt.op, scope, dialect);
      executed.push(stmt.id);

      if (stmt.id === plan.entityFrom) {
        entity = result.rows.length > 0 ? result.rows[0] : null;
        if (entity !== null) scope[ENTITY_ROOT] = entity as unknown as Value;
      }
      if (stmt.binds !== undefined && result.rows.length > 0) {
        scope[stmt.binds] = result.rows[0] as unknown as Value;
      }
      if (isBatch && stmt.role === 'body' && result.rows.length > 0) returnedRows.push(result.rows);
    }
    return { committed: true, entity, executed, ...(returnedRows.length > 0 ? { returnedRows } : {}) } as TransactionResult;
  }, options, dialect === 'sqlite' ? 'postgres' : dialect, isConnectionError).catch((e: unknown) => {
    // Every error here is a real driver failure (already rolled back by withTransactionAsync) — a plan
    // has no non-error way to not commit, so there is nothing to translate before re-surfacing.
    throw mapSqliteError(e);
  });
}
