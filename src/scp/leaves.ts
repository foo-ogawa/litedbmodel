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
 *     (`write:null`) → rows; write (`write:{returning}`) → a one-row `[{changes,lastInsertRowid}]`
 *     summary (a RETURNING write returns its rows via `execute` instead). It owns the transport-level
 *     param shaping a relation key-set needs — the dialect array encoding + deferred PG cast
 *     resolution + `?`→`$N` render — and, when the statement is a GUARDED relation child fetch, the
 *     runaway check on its raw
 *     rows ({@link import('./limit-config').assertRelationHardLimit}): the RAW child rows exist only
 *     here, since `group` already sees a nested graph and SCP itself has no throw.
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
  executeSafe as seamExecuteSafe,
  run as seamRun,
  executeAsync as seamExecuteAsync,
  runAsync as seamRunAsync,
  type StatementIntent,
  type RunInfo,
} from './exec-context';
import { assertRelationHardLimit, type RelationGuard } from './limit-config';
import type { DynamicWhereFrag, DynamicWherePlan, ExecOptions, WriteMode } from './leaf-transport';
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

/**
 * The UNBOXED `executeSQL` ports the transport body runs on: the statement plus the facts its ONE
 * optional control record ({@link import('./leaf-transport').ExecOptions}) carries, already read out
 * ({@link executeSqlPorts}) — the same flattening the rust / go / python / php transports do after
 * probing the payload. The imperative tx runner ({@link import('./makesql/tx')}) hands this record
 * directly, since it holds the statement facts already and has no wire payload to decode.
 */
interface ExecuteSqlPorts {
  readonly sql: string;
  readonly params: unknown[];
  /**
   * How the statement RUNS: `null` ⇒ a READ; a {@link WriteMode} ⇒ a write carrying its OWN
   * `returning`. ONE field, three values — "returns rows but is not a write" is not representable.
   */
  readonly write: WriteMode | null;
  /** The DYNAMIC WHERE plan (absent on a fully-bounded statement — CLAUDE.md §2). See {@link assembleDynamicWhere}. */
  readonly whereDynamic?: DynamicWherePlan | null;
  /**
   * The RELATION runaway cap this statement's rows are asserted against (absent ⇒ uncapped). Carried
   * verbatim from the compiled relation op — see {@link assertRelationHardLimit}.
   */
  readonly guard?: RelationGuard | null;
}

// ── the DYNAMIC (SKIP) WHERE: assembled by the transport, at execution time ────────────────────

/**
 * The SQL keywords that may follow a WHERE clause. The WHERE must be spliced BEFORE the first of
 * them, so a dynamic WHERE lands at exactly the position a bounded one occupies.
 */
const WHERE_TAIL_RE = /\s+(GROUP BY|ORDER BY|LIMIT|OFFSET|FOR UPDATE|RETURNING)\b/i;

/**
 * The WHERE keyword itself — matched the SAME way {@link WHERE_TAIL_RE} matches a tail keyword, so the
 * five language ports share one lexical rule. A statement that carries it already has a (bounded) WHERE,
 * which a dynamic clause CONTINUES instead of opening a second one.
 */
const WHERE_RE = /\s+WHERE\b/i;

/**
 * Where a dynamic WHERE clause joins the base statement — the ONE scan {@link assembleDynamicWhere}
 * makes, and everything it needs to place both the text and the values:
 *
 *  - `at`      — the end of the statement's WHERE region: before the first tail keyword, or the end of
 *                the statement. The exact position a bounded WHERE occupies.
 *  - `keyword` — how the clause joins: ` AND ` when the statement already carries a WHERE (its BOUNDED
 *                predicates, lowered at emit — CLAUDE.md §2), ` WHERE ` when it carries none.
 *  - `tail`    — how many base params bind AFTER the clause. Every `?` past `at` is a page-tail bound
 *                count (`LIMIT ?` / `OFFSET ?`) — the only placeholders `compileSelect` emits after the
 *                WHERE — so the surviving fragments' params bind before exactly that many of the base
 *                params, which is the position their own `?`s occupy in the final statement. `tail`
 *                counts a SUBSTRING's placeholders and every placeholder binds one param, so it never
 *                exceeds `params.length` for a statement that can be bound at all.
 */
function whereSplice(baseSql: string): { at: number; keyword: string; tail: number } {
  const m = WHERE_TAIL_RE.exec(baseSql);
  const at = m === null ? baseSql.length : m.index;
  return {
    at,
    keyword: WHERE_RE.test(baseSql.slice(0, at)) ? ' AND ' : ' WHERE ',
    tail: baseSql.slice(at).split('?').length - 1,
  };
}

/**
 * Assemble the effective statement from a DYNAMIC WHERE plan: drop the SKIPPED fragments (`skipped`
 * true — the per-call SKIP decision the emitter carried as DATA), join the survivors with ` AND `,
 * splice the clause at the statement's WHERE position ({@link whereSplice}) — CONTINUING the bounded
 * WHERE the emitter already lowered, or opening one when there is none — and bind the survivors' params
 * at the slot their `?`s occupy: after the base params the clause follows, before the page tail's.
 *
 * A SKIP predicate's presence is per-CALL, so the FINAL statement can only be determined here, at
 * execution time — which is also why `?`→`$N` is rendered after this ({@link prepareSql}), never at
 * emit time. Only the ACTUALLY-optional predicates are in the plan (CLAUDE.md §2): a read with none
 * carries no plan at all and never reaches this function, and one whose fragments are all skipped
 * leaves the emitted statement exactly as it was compiled.
 */
export function assembleDynamicWhere(p: { sql: string; params: unknown[]; whereDynamic: DynamicWherePlan }): { sql: string; params: unknown[] } {
  const frags = dynamicWhereFrags(p.whereDynamic).filter((f) => !f.skipped);
  if (frags.length === 0) return { sql: p.sql, params: p.params };
  const { at, keyword, tail } = whereSplice(p.sql);
  const bind = p.params.length - tail;
  return {
    sql: p.sql.slice(0, at) + keyword + frags.map((f) => f.sql).join(' AND ') + p.sql.slice(at),
    params: [...p.params.slice(0, bind), ...frags.flatMap((f) => f.params), ...p.params.slice(bind)],
  };
}

/**
 * The effective `{sql, params}` a statement executes: the dynamic plan assembled when one is present,
 * the ports verbatim otherwise. The ONE place the two shapes converge — both transports consume it.
 */
function effectiveStatement(p: ExecuteSqlPorts): { sql: string; params: unknown[]; write: boolean } {
  // The seam's INTENT is the one boolean the statement's `write` mode reduces to (present ⇒ a write).
  const write = p.write !== null;
  if (p.whereDynamic == null) return { sql: p.sql, params: p.params, write };
  return { ...assembleDynamicWhere({ sql: p.sql, params: p.params, whereDynamic: p.whereDynamic }), write };
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
 * A TUPLE SET (an array whose elements are themselves arrays — the composite relation key set the
 * `pluck` leaf yields) binds as the single JSON array-of-tuples string on EVERY dialect, PostgreSQL
 * included: each dialect's composite batch expands that ONE param server-side
 * (`json_array_elements` / `JSON_TABLE` / `json_each`), which is what lets a composite relation ride
 * the same three-leaf transport as everything else instead of needing a per-column transpose (#159).
 *
 * The JSON encoding is the SHARED one ({@link encodeJsonArrayParam}) — the same encoder the imperative
 * `inListJson` path uses, so the generated and imperative paths cannot drift on bigint / boolean
 * element handling.
 */
function encodeParams(params: readonly unknown[], dialect: Dialect): unknown[] {
  return params.map((p) => {
    if (!Array.isArray(p)) return p;
    if (dialect === 'postgres' && !isTupleSet(p)) return p;
    return encodeJsonArrayParam(dialect, p);
  });
}

/**
 * A composite key set: a bound array whose elements are the key TUPLES (arrays). Total under the
 * library's type system — every OTHER array param is a list of SCALAR cells (a single-key set, an
 * IN-list, a batch write's per-column array), because every non-scalar column class (json / uuid /
 * decimal) de-boxes to a bc STRING ({@link import('./coltype').keyArrayElemScalar}), never a JS array.
 */
function isTupleSet(param: readonly unknown[]): boolean {
  return param.length > 0 && Array.isArray(param[0]);
}

/**
 * Prepare a statement for the seam: resolve deferred PG cast(s), render `?`→`$N`, encode params, and
 * carry the ONE {@link StatementIntent} both seams take. The intent is the statement's RUN MODE
 * ({@link effectiveStatement} — a write mode present ⇒ a write), NOT the branch: the branch picks the
 * SEAM (`returning` ⇒ the row seam), the intent picks the CONNECTION
 * ({@link import('./connection-routing').resolvePool}), so a RETURNING write runs on `execute` and
 * still routes to the WRITER. The four native transports derive it the same way (#207).
 */
export function prepareSql(p: { sql: string; params: unknown[]; write: boolean }, dialect: Dialect): { sql: string; bound: unknown[]; intent: StatementIntent } {
  let sql = p.sql;
  if (dialect === 'postgres') {
    for (const param of p.params) if (Array.isArray(param)) sql = resolvePgArrayCast(sql, param);
  }
  sql = renderPlaceholders(sql, dialect);
  const bound = encodeParams(p.params, dialect);
  const intent: StatementIntent = { write: p.write };
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
 * leaf output shape is uniform.
 *
 * A read ALWAYS runs in exact-integer mode (better-sqlite3 `safeIntegers`), so an INTEGER column
 * arrives as a `BigInt` — the value bc's `int` scalar declares. It is not conditional: the wire carries
 * int and float as DISTINCT kinds, so a column declared `Int` cannot be satisfied by a JS number on any
 * dialect, and gating exactness per endpoint made SQLite disagree with PostgreSQL and MySQL (whose
 * integer type parsers are unconditional — `configurePgDeboxTypeParsers`, `mysqlDeboxPoolOptions`),
 * which the conformance corpus rejects as dialect-variant. There is therefore no exactness port at all
 * (#193 deleted the `bigint` one, which no language read).
 */
export function executeSQL(p: ExecuteSqlPorts, ctx: LeafContext): Array<Record<string, unknown>> {
  const prepared = prepareSql(effectiveStatement(p), ctx.dialect);
  if (p.write !== null && !p.write.returning) return writeSummary(seamRun(ctx.exec, prepared.sql, prepared.bound, prepared.intent));
  const rows = seamExecuteSafe(ctx.exec, prepared.sql, prepared.bound, prepared.intent) as Array<Record<string, unknown>>;
  assertRelationHardLimit(rows, p.guard);
  return rows;
}

/** The ASYNC (live PG / MySQL) `executeSQL` body — the twin of {@link executeSQL} over the async seam. */
export async function executeSQLAsync(p: ExecuteSqlPorts, ctx: AsyncLeafContext): Promise<Array<Record<string, unknown>>> {
  const prepared = prepareSql(effectiveStatement(p), ctx.dialect);
  if (p.write !== null && !p.write.returning) return writeSummary(await seamRunAsync(ctx.execAsync, prepared.sql, prepared.bound, prepared.intent));
  const rows = (await seamExecuteAsync(ctx.execAsync, prepared.sql, prepared.bound, prepared.intent)) as Array<Record<string, unknown>>;
  assertRelationHardLimit(rows, p.guard);
  return rows;
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
  return p.parents.map((par) => ({ ...par, [p.into]: attachToParent(par, p.pk, byKey, p.single) }));
}

// ── handler maps: the boundary injection a generated module's bind()/bindAsync() consumes ──

/**
 * The DECLARED type of every leaf PORT and every field of every leaf struct, exactly as the catalog
 * spells it ({@link import('./leaf-transport')}) — the predicate {@link portTyped} confirms. A `|null`
 * suffix marks a NULLABLE field, whose `null` is the declared absence (no write mode / plan / cap /
 * model). `int` is bc's `int` value model, which on this plane is a BigInt and nothing else.
 * `string[]` is the ordered key-column TUPLE (`col` / `pk` / `fk`): every element must be a column
 * NAME, the same element check the go `portStrings` / rust `port_strings` probes make.
 */
const PORT_TYPES = {
  bool: (v: unknown) => typeof v === 'boolean',
  int: (v: unknown) => typeof v === 'bigint',
  string: (v: unknown) => typeof v === 'string',
  list: (v: unknown) => Array.isArray(v),
  'string[]': (v: unknown) => Array.isArray(v) && v.every((e) => typeof e === 'string'),
  record: (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v),
};

/**
 * A field's declared type as a reader spells it — one of {@link PORT_TYPES}, optionally `|null`. It is a
 * UNION rather than a `string` so a reader that names a type the catalog does not have fails to COMPILE,
 * which is the nearest this plane gets to go's and rust's typed probes.
 */
type Declared = keyof typeof PORT_TYPES | `${keyof typeof PORT_TYPES}|null`;

/**
 * Confirm ONE unboxed value against its DECLARED type — the ONE wrong-type failure on the TS plane, and
 * the twin of the go `portErr` wrong-variant half / rust `port_mismatch`. A field of the wrong type is
 * the same ABI break as a missing one, for the same reason: the generator emits the literal the port's
 * type says, so nothing else can arrive from a generated module. Coercing it instead ran an INSERT on
 * the read seam (`returning` not a bool), applied a predicate the call SKIPPED (`skipped` not a bool),
 * erased one entirely (`sql` not a string), or FLIPPED a relation's cardinality — `single` cast to a
 * bool turned the one nested child into a LIST, and `into` cast to a string nested it under `"42"`
 * (#213).
 */
function portTyped(value: unknown, what: string, declared: Declared): unknown {
  const kind = (declared.endsWith('|null') ? declared.slice(0, -'|null'.length) : declared) as keyof typeof PORT_TYPES;
  if (kind !== declared && value === null) return null;
  if (!PORT_TYPES[kind](value)) {
    // bc's `int` value model is a BigInt on this plane, so the rendering has to survive one appearing
    // where another type was declared — a bare JSON.stringify throws on it and would replace the port
    // failure with a serializer failure.
    const got = JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
    throw new Error(`scp leaf: ${what} must be ${declared}, got ${got}`);
  }
  return value;
}

/**
 * Read ONE DECLARED field out of a payload / struct that is PRESENT — the ONE fail-closed field read on
 * the TS plane, for all THREE leaves, and the twin of the go `optRowField` / rust `take_opt_row`
 * discipline. Presence and the DECLARED type are confirmed at the SAME read, exactly as go's and rust's
 * typed probes confirm both.
 *
 * `null` is a VALUE (the declared absence of a write mode / a plan / a cap / a model); a MISSING KEY is
 * an ABI BREAK. The two are not the same thing and must not collapse: bc types a port by the literal
 * wired into it and REJECTS a partial struct (an omitted field is a different type, not a default —
 * `bc: … the value wired into it has type obj{…}`), so a generated module ALWAYS spells every field of
 * every struct it wires. A key that is not there did not come from one, and reading it as its default
 * would silently downgrade a write to a read, drop a relation cap, erase a SKIP predicate (#205), or —
 * on `group` — nest the children under `"undefined"` so the relation vanishes from the graph (#213).
 */
function requiredField(record: Record<string, unknown>, name: string, at: string, declared: Declared): unknown {
  if (!(name in record)) {
    throw new Error(
      `scp leaf: ${at} is missing its '${name}' field — a generated module spells every ` +
        `field of every struct it wires, so an ABSENT key is an ABI break (a null VALUE is how an ` +
        `absent write mode / plan / cap is spelled)`,
    );
  }
  return portTyped(record[name], `${at}'s '${name}'`, declared);
}

/**
 * Unbox a plan's FRAGMENTS — every field of every fragment, fail-closed ({@link requiredField}), before
 * any of them is used. A fragment is a PRESENT struct like every other, and the generator spells it in
 * full, so a missing field is an ABI break and NOT a default: without `skipped` the statement applies a
 * predicate the call SKIPPED, without `sql` the predicate is erased entirely, and without `params` a
 * value binds where none belongs — each of them silently returning DIFFERENT ROWS (#209). Every
 * fragment is unboxed, skipped ones included, exactly as the go / rust transports unbox them.
 */
function dynamicWhereFrags(plan: DynamicWherePlan): DynamicWhereFrag[] {
  const frags = requiredField(plan as unknown as Record<string, unknown>, 'frags', `the 'whereDynamic' plan`, 'list') as unknown[];
  const at = `a 'whereDynamic' fragment`;
  return frags.map((frag) => {
    const f = portTyped(frag, at, 'record') as Record<string, unknown>;
    return {
      skipped: requiredField(f, 'skipped', at, 'bool') as boolean,
      sql: requiredField(f, 'sql', at, 'string') as string,
      params: requiredField(f, 'params', at, 'list') as DynamicWhereFrag['params'],
    };
  });
}

/**
 * Read the relation `guard` field of the control record. `null` ⇒ the statement is uncapped. The cap
 * arrives in bc's `int` value model, which on the TS plane is a BigInt, so it is normalized to the
 * `number` {@link RelationGuard} (and {@link import('./errors').LimitExceededError}) declare — the
 * SAME numeric type the rust/go/python/php transports hand their own check. `model` is the one NULLABLE
 * field: its key is always spelled and "no model" rides as `null`, which the error reports as "unknown".
 * A field that is missing or not the declared type is a LOUD port failure, never a silently dropped cap:
 * a guard that fails to unbox is a runaway that would otherwise sail through.
 */
function relationGuardPort(port: unknown): RelationGuard | null {
  if (port === null) return null;
  const g = port as Record<string, unknown>;
  const at = `the 'guard' cap`;
  const raw = requiredField(g, 'limit', at, 'int') as bigint;
  const model = requiredField(g, 'model', at, 'string|null') as string | null;
  return {
    limit: Number(raw),
    ...(model === null ? {} : { model }),
    relation: requiredField(g, 'relation', at, 'string') as string,
  };
}

/**
 * Read one DECLARED field of the control record — each of the three is a CONCRETE control struct or the
 * `null` that spells its absence. The name is `keyof ExecOptions`, so the reader is tied to the leaf
 * declaration at compile time: renaming a field there breaks HERE rather than silently reading a key the
 * generator no longer writes.
 */
function optsField(opts: Record<string, unknown>, name: keyof ExecOptions): unknown {
  return requiredField(opts, name, `the 'opts' control record`, 'record|null');
}

/**
 * Read the `write` field of the control record — the statement's RUN MODE. `null` ⇒ a READ; a
 * {@link WriteMode} ⇒ a write, carrying its own `returning`. The nesting is what makes "returns rows
 * but is not a write" unrepresentable, so this reader has three outcomes, not four.
 */
function writeModePort(port: unknown): WriteMode | null {
  if (port === null) return null;
  return { returning: requiredField(port as Record<string, unknown>, 'returning', `the 'write' mode`, 'bool') as boolean };
}

/** Read the declared `executeSQL` ports off the evaluated port record (the generated module's Values). */
function executeSqlPorts(ports: Record<string, Value>): ExecuteSqlPorts {
  const at = 'the executeSQL payload';
  const sql = requiredField(ports, 'sql', at, 'string') as string;
  const params = requiredField(ports, 'params', at, 'list') as unknown[];
  // The ONE legitimate absence: no control record at all ⇒ the plain READ a bounded statement declares
  // by OMITTING the port, so its payload is `sql` + `params` and nothing else. Once the port IS there it
  // is read exactly like every field below — its own `null` is the same plain read, anything that is not
  // an {@link ExecOptions} record is an ABI break.
  const opts = 'opts' in ports ? (requiredField(ports, 'opts', at, 'record|null') as Record<string, unknown> | null) : null;
  if (opts === null) return { sql, params, write: null };
  return {
    sql,
    params,
    write: writeModePort(optsField(opts, 'write')),
    whereDynamic: optsField(opts, 'whereDynamic') as DynamicWherePlan | null,
    guard: relationGuardPort(optsField(opts, 'guard')),
  };
}

/**
 * The two ENVIRONMENT-FREE relation handlers. `pluck`/`group` are pure in-memory shaping, so the sync
 * and async maps share this ONE definition (never a second copy per environment).
 *
 * Their ports are read through the SAME fail-closed reader the SQL transport uses
 * ({@link requiredField}) — the flat shape is not a reason to trust it. A raw index + cast turned a
 * MISTYPED `single` into a silently flipped relation CARDINALITY (a `hasOne` nesting a LIST, a `hasMany`
 * nesting one child), a mistyped `into` into a relation nested under `"42"`, and an absent `pk`/`col`
 * into a bare `Cannot read properties of undefined` that names no port at all (#213).
 */
const PLUCK_AT = 'the pluck payload';
const GROUP_AT = 'the group payload';
const shapingHandlers: Handlers = {
  pluck: (ports): ExecOutcome => ({
    ok: pluck({
      rows: requiredField(ports, 'rows', PLUCK_AT, 'list') as Array<Record<string, unknown>>,
      col: requiredField(ports, 'col', PLUCK_AT, 'string[]') as string[],
    }) as unknown as Value,
  }),
  group: (ports): ExecOutcome => ({
    ok: group({
      parents: requiredField(ports, 'parents', GROUP_AT, 'list') as Array<Record<string, unknown>>,
      children: requiredField(ports, 'children', GROUP_AT, 'list') as Array<Record<string, unknown>>,
      pk: requiredField(ports, 'pk', GROUP_AT, 'string[]') as string[],
      fk: requiredField(ports, 'fk', GROUP_AT, 'string[]') as string[],
      into: requiredField(ports, 'into', GROUP_AT, 'string') as string,
      single: requiredField(ports, 'single', GROUP_AT, 'bool') as boolean,
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
