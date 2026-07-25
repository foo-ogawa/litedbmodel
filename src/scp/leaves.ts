/**
 * litedbmodel v2 SCP — the op-INDEPENDENT leaf transport IMPLEMENTATION (the TS runtime side).
 *
 * The three leaves are DECLARED once in {@link import('./leaf-transport').Db} (`@leaf static`, read by
 * `bc generate --from`). THIS module carries their executable bodies and hands them to a generated
 * module as a behavior-contracts handler map — the boundary injection a `bind(handlers)` /
 * `bindAsync(handlers)` facade expects. Declaration and implementation are separate modules on
 * purpose: a `--from` typecheck of an authored model must pull in the signature only, never the
 * driver stack.
 *
 *   - {@link executeSQL} — the SOLE SQL transport. Binds params and runs one statement through the
 *     central {@link import('./exec-context') execute/run seam} (the ONLY driver contact). Read
 *     (`write:false`) → rows; write (`write:true`) → a one-row `[{changes,lastInsertRowid}]` summary
 *     (RETURNING writes return their rows via `execute`). It owns the transport-level param shaping a
 *     relation key-set needs — the dialect array encoding + deferred PG cast resolution + `?`→`$N`
 *     render.
 *   - {@link pluck} — rows + the ordered key-column tuple → the deduped, non-null key array (the
 *     `= ANY($1)` / `json_each(?)` batch key set).
 *   - {@link group} — parents + a flat child list + `pk`/`fk`/`into` → each parent with its matching
 *     children nested under `into` (`hasMany` → list, single → the one child or null). This is the
 *     in-memory grouping that makes the child fetch ONE query (N+1-free).
 *
 * The environment (connection seam + dialect) is captured by the handler FACTORY, never carried on
 * the IR (C4): {@link leafHandlers} closes over a sync {@link LeafContext} and {@link
 * leafHandlersAsync} over an {@link AsyncLeafContext}. The same three symbols are what the native
 * codegen calls directly ({@link LEAF_TRANSPORT_SYMBOLS}).
 */

import type { Handlers, AsyncHandlers, Value, ExecOutcome } from 'behavior-contracts/runtime';
import {
  type ExecutionContext,
  type AsyncExecutionContext,
  execute as seamExecute,
  executeSafe as seamExecuteSafe,
  run as seamRun,
  executeAsync as seamExecuteAsync,
  runAsync as seamRunAsync,
  type StatementIntent,
  type RunInfo,
} from './exec-context';
import { renderPlaceholders, type Dialect } from './makesql/handler';
import { encodeJsonArrayParam } from './makesql/json-array';
import { resolvePgArrayCast } from './makesql/compile-relation';
import { dedupeKeyTuples, groupByKey, attachToParent } from './grouping';

/**
 * The environment boundary the handler factory captures (C4 — never on the IR). `exec` is the SYNC
 * connection/middleware/tx seam (better-sqlite3, run via a generated module's `bind`); `dialect`
 * selects the transport-level param encoding + placeholder render. The native ports carry the SAME facts.
 */
export interface LeafContext {
  /** The central sync execute/run seam (connection provider + middleware + tx pin). */
  readonly exec: ExecutionContext;
  /** The target SQL dialect (drives array-param encoding + `?`→`$N` render). */
  readonly dialect: Dialect;
}

/**
 * The ASYNC environment boundary (live PG / MySQL, run via a generated module's `bindAsync`). Carries
 * the async execute/run seam ({@link AsyncExecutionContext}) instead of the sync one.
 */
export interface AsyncLeafContext {
  /** The central async execute/run seam (pooled per-execution connection ownership). */
  readonly execAsync: AsyncExecutionContext;
  /** The target SQL dialect. */
  readonly dialect: Dialect;
}

/** The evaluated `executeSQL` ports a generated module hands the transport. */
interface ExecuteSqlPorts {
  readonly sql: string;
  readonly params: unknown[];
  readonly write: boolean;
  readonly returning: boolean;
  readonly bigint: boolean;
  /** The DYNAMIC WHERE plan (absent on a fully-bounded statement). See {@link assembleDynamicWhere}. */
  readonly whereDynamic?: DynamicWherePlan | null;
}

// ── the DYNAMIC (SKIP) WHERE: assembled by the transport, at execution time ────────────────────

/**
 * The SQL keywords that may follow a WHERE clause. The WHERE must be spliced BEFORE the first of
 * them, so a dynamic WHERE lands at exactly the position a bounded one occupies.
 */
const WHERE_TAIL_RE = /\s+(GROUP BY|ORDER BY|LIMIT|OFFSET|FOR UPDATE|RETURNING)\b/i;

/** Splice a ` WHERE …` clause (leading space included, or `''`) into `baseSql` before its first tail keyword. */
export function spliceWhere(baseSql: string, whereSql: string): string {
  if (whereSql === '') return baseSql;
  const tail = WHERE_TAIL_RE.exec(baseSql);
  return tail === null ? baseSql + whereSql : baseSql.slice(0, tail.index) + whereSql + baseSql.slice(tail.index);
}

/**
 * ONE evaluated WHERE fragment of a dynamic plan. bc has ALREADY evaluated the fragment's params and
 * its SKIP guard against the input: a fragment whose guard was false evaluated LAZILY to `null` (bc's
 * `cond` only evaluates the taken branch, so a dropped fragment's params are never evaluated).
 */
export interface DynamicWhereFrag {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** The evaluated dynamic-WHERE plan: the fragment list, holes (skipped fragments) included. */
export interface DynamicWherePlan {
  readonly frags?: readonly (DynamicWhereFrag | null)[];
}

/**
 * Assemble the effective statement from a DYNAMIC WHERE plan: drop the absent (`null`) fragments,
 * join the survivors with ` WHERE ` / ` AND `, splice the clause into the base `sql` before its first
 * tail keyword ({@link spliceWhere}) — the exact position a bounded WHERE occupies — and bind the
 * surviving fragments' params BEFORE the base params (the WHERE `?`s precede the tail's).
 *
 * A SKIP predicate's presence is per-CALL, so the FINAL statement can only be determined here, at
 * execution time — which is also why `?`→`$N` is rendered after this ({@link prepareSql}), never at
 * emit time. A statement with NO optional predicate carries no plan at all: its WHERE is spliced into
 * the static `sql` at emit time and it never reaches this function.
 */
export function assembleDynamicWhere(p: { sql: string; params: unknown[]; whereDynamic: DynamicWherePlan }): { sql: string; params: unknown[] } {
  const frags = (p.whereDynamic.frags ?? []).filter((f): f is DynamicWhereFrag => f != null);
  let whereSql = '';
  const whereParams: unknown[] = [];
  frags.forEach((f, i) => {
    whereSql += (i === 0 ? ' WHERE ' : ' AND ') + f.sql;
    whereParams.push(...f.params);
  });
  return { sql: spliceWhere(p.sql, whereSql), params: [...whereParams, ...p.params] };
}

/**
 * The effective `{sql, params}` a statement executes: the dynamic plan assembled when one is present,
 * the ports verbatim otherwise. The ONE place the two shapes converge — both transports consume it.
 */
function effectiveStatement(p: ExecuteSqlPorts): { sql: string; params: unknown[]; write: boolean } {
  if (p.whereDynamic == null) return p;
  return { ...assembleDynamicWhere({ sql: p.sql, params: p.params, whereDynamic: p.whereDynamic }), write: p.write };
}

/** Normalize a driver integer (number|bigint) to bc's `int` value model (BigInt). */
function toBcInt(v: number | bigint): bigint {
  return typeof v === 'bigint' ? v : BigInt(v);
}

// ── executeSQL — the sole op-independent SQL transport ─────────────────────────

/**
 * Encode a value list for the driver: a bound scalar passes through; an ARRAY element (a key set or a
 * batch record list bound as ONE param — `= ANY(?)` / `json_each(?)` / `JSON_TABLE(?)`) binds as the
 * raw array on PostgreSQL and as a single JSON string on MySQL/SQLite (the `makesql` locked model).
 *
 * The JSON encoding is the SHARED one ({@link encodeJsonArrayParam}) — the same encoder the imperative
 * `inListJson` path uses, so the generated and imperative paths cannot drift on bigint / boolean
 * element handling.
 */
function encodeParams(params: readonly unknown[], dialect: Dialect): unknown[] {
  return params.map((p) => (Array.isArray(p) ? (dialect === 'postgres' ? p : encodeJsonArrayParam(dialect, p)) : p));
}

/** Prepare a statement for the seam: resolve deferred PG cast(s), render `?`→`$N`, encode params. */
export function prepareSql(p: { sql: string; params: unknown[]; write: boolean }, dialect: Dialect): { sql: string; bound: unknown[]; intent: StatementIntent } {
  let sql = p.sql;
  if (dialect === 'postgres') {
    for (const param of p.params) if (Array.isArray(param)) sql = resolvePgArrayCast(sql, param);
  }
  sql = renderPlaceholders(sql, dialect);
  const bound = encodeParams(p.params, dialect);
  const intent: StatementIntent = { write: p.write === true };
  return { sql, bound, intent };
}

/**
 * The affected-write summary row a non-returning write yields (uniform `items` output shape).
 *
 * BOTH fields are integers, so both are normalized to bc's `int` value model (BigInt) — the shape a
 * declared `{changes: Int, lastInsertRowid: Int}` contract conforms against, and the shape the rust /
 * go / python / php transports return. Leaving `changes` a JS number made the SAME generated IR
 * conform in one language and fail `expected int, got float` in another.
 */
function writeSummary(info: RunInfo): Array<Record<string, unknown>> {
  return [{ changes: toBcInt(info.changes), lastInsertRowid: toBcInt(info.lastInsertRowid) }];
}

/**
 * The SYNC `executeSQL` body. `write` selects `run` (INSERT/UPDATE/DELETE) vs `execute` (SELECT /
 * RETURNING); a non-returning write returns the one-row `[{changes,lastInsertRowid}]` summary so the
 * leaf output shape is uniform. `bigint` runs the read in exact-integer mode (better-sqlite3
 * `safeIntegers`) so a 64-bit column arrives as an exact `BigInt` — the value bc's `int` scalar
 * declares. It is a sqlite-only driver toggle; PG/MySQL (and the rust/go transports) return BIGINT
 * natively and ignore it.
 */
export function executeSQL(p: ExecuteSqlPorts, ctx: LeafContext): Array<Record<string, unknown>> {
  const prepared = prepareSql(effectiveStatement(p), ctx.dialect);
  if (p.write === true && p.returning !== true) return writeSummary(seamRun(ctx.exec, prepared.sql, prepared.bound, prepared.intent));
  const exec = p.bigint === true ? seamExecuteSafe : seamExecute;
  return exec(ctx.exec, prepared.sql, prepared.bound, prepared.intent) as Array<Record<string, unknown>>;
}

/** The ASYNC (live PG / MySQL) `executeSQL` body — the twin of {@link executeSQL} over the async seam. */
export async function executeSQLAsync(p: ExecuteSqlPorts, ctx: AsyncLeafContext): Promise<Array<Record<string, unknown>>> {
  const prepared = prepareSql(effectiveStatement(p), ctx.dialect);
  if (p.write === true && p.returning !== true) return writeSummary(await seamRunAsync(ctx.execAsync, prepared.sql, prepared.bound, prepared.intent));
  return (await seamExecuteAsync(ctx.execAsync, prepared.sql, prepared.bound, prepared.intent)) as Array<Record<string, unknown>>;
}

// ── pluck — rows + key columns → the deduped key array (the `= ANY($1)` batch key set) ──

/**
 * Extract the deduped, non-null key set from `rows` over the ordered key-column tuple `col` — the
 * batch key set a relation child fetch binds. Insertion order preserved; a row missing any key column
 * is dropped (no partial keys). A single-key tuple yields a flat scalar array (`json_each` scalar
 * `value`); a composite tuple yields an array-of-tuples (`json_each` per-ordinal `$[i]`). Dedupe is
 * the shared grouping core ({@link dedupeKeyTuples}) — the SAME SSoT the lazy-relation path uses.
 */
export function pluck(p: { rows: Array<Record<string, unknown>>; col: string[] }): unknown[] {
  const tuples = dedupeKeyTuples(p.rows, p.col);
  return p.col.length === 1 ? tuples.map((t) => t[0]) : tuples.map((t) => [...t]);
}

// ── group — parents + flat children → each parent with its children nested ─────

/**
 * Distribute a flat `children` list onto `parents` by matching `child[fk]` to `parent[pk]`, nesting
 * the result under `into`. `single:true` (belongsTo/hasOne) nests the one matching child (or `null`);
 * otherwise (hasMany) nests the child list (`[]` when none). `pk`/`fk` are the ordered key-column
 * tuples, so a composite relation nests by the WHOLE key (no `''`-collapse cartesian). Grouping is the
 * shared core ({@link groupByKey}/{@link attachToParent}) — the SAME SSoT the lazy-relation path uses.
 */
export function group(p: { parents: Array<Record<string, unknown>>; children: Array<Record<string, unknown>>; pk: string[]; fk: string[]; into: string; single: boolean }): Array<Record<string, unknown>> {
  const byKey = groupByKey(p.children, p.fk);
  return p.parents.map((par) => ({ ...par, [p.into]: attachToParent(par, p.pk, byKey, p.single === true) }));
}

// ── handler maps: the boundary injection a generated module's bind()/bindAsync() consumes ──

/** Read the declared `executeSQL` ports off the evaluated port record (the generated module's Values). */
function executeSqlPorts(ports: Record<string, Value>): ExecuteSqlPorts {
  return {
    sql: ports.sql as unknown as string,
    params: ports.params as unknown as unknown[],
    write: ports.write === true,
    returning: ports.returning === true,
    bigint: ports.bigint === true,
    whereDynamic: (ports.whereDynamic ?? null) as unknown as DynamicWherePlan | null,
  };
}

/**
 * The two ENVIRONMENT-FREE relation handlers. `pluck`/`group` are pure in-memory shaping, so the sync
 * and async maps share this ONE definition (never a second copy per environment).
 */
const shapingHandlers: Handlers = {
  pluck: (ports): ExecOutcome => ({ ok: pluck({ rows: ports.rows as unknown as Array<Record<string, unknown>>, col: ports.col as unknown as string[] }) as unknown as Value }),
  group: (ports): ExecOutcome => ({
    ok: group({
      parents: ports.parents as unknown as Array<Record<string, unknown>>,
      children: ports.children as unknown as Array<Record<string, unknown>>,
      pk: ports.pk as unknown as string[],
      fk: ports.fk as unknown as string[],
      into: ports.into as unknown as string,
      single: ports.single === true,
    }) as unknown as Value,
  }),
};

/**
 * The SYNC handler map for a generated module's `bind(handlers)` — catalog name → the transport body,
 * closed over the sync environment. This is the ONLY place the three leaves are wired to the TS
 * runtime; a generated module never carries an implementation.
 */
export function leafHandlers(ctx: LeafContext): Handlers {
  return {
    ...shapingHandlers,
    executeSQL: (ports): ExecOutcome => ({ ok: executeSQL(executeSqlPorts(ports), ctx) as unknown as Value }),
  };
}

/**
 * The ASYNC handler map for a generated module's `bindAsync(handlers)` (live PG / MySQL). Only the SQL
 * transport differs — the shaping leaves are the SAME implementations.
 */
export function leafHandlersAsync(ctx: AsyncLeafContext): AsyncHandlers {
  return {
    ...shapingHandlers,
    executeSQL: async (ports): Promise<ExecOutcome> => ({ ok: (await executeSQLAsync(executeSqlPorts(ports), ctx)) as unknown as Value }),
  };
}

/**
 * The native-codegen transport symbol table (`bc generate --leaf-transport`): each op-independent leaf
 * → the runtime symbol the covered native module calls directly. The consumer supplies these
 * (litedbmodel = a fixed set of ops, not one method per node).
 */
export const LEAF_TRANSPORT_SYMBOLS: Readonly<Record<string, string>> = {
  executeSQL: 'execute_sql',
  pluck: 'pluck_keys',
  group: 'group_children',
};
