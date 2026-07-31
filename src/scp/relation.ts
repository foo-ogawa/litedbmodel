/**
 * litedbmodel v2 SCP — Read relations: pre-compiled batch op + staged batch resolution (WS4,
 * #24; makeSQL re-expression, epic #43/#45 Phase B).
 *
 * Relations are NOT SQL JOINs by default (spec §5). They are the staged-batch
 * query-composition + object-assembly shape v1's `LazyRelation` uses: collect the parent key
 * set of a result page, run ONE batched child SELECT keyed by the deduped parent keys, then
 * distribute the child rows back to their parents. One batched query per relation edge, NEVER
 * one-per-parent (no N+1).
 *
 * ## The relation op is a STATIC makeSQL artifact (design #45)
 *
 * A {@link RelationOp} is compiled ONCE from a model {@link RelationDecl} into a STATIC
 * `makeSQL` batch SELECT via the makeSQL relation builders (`./makesql/compile-relation`) —
 * byte-identical to the ORIGINAL `LazyRelation` SQL for PostgreSQL (`= ANY(?::type[])`,
 * `CROSS JOIN LATERAL`, `UNNEST`), and the single-JSON-param server-side form for MySQL/SQLite
 * (`json_each` / `JSON_TABLE`). The deduped key array binds as ONE param with STATIC text (no
 * placeholder-count expansion), so `op.sql` is fixed and value-independent — pure JSON, lands
 * in the bundle, a per-language runtime executes it directly. The REDUCED
 * `CompiledOperation`/`renderOperation`/`IN (?)`-expansion forms are GONE.
 *
 * ## ONE relation op, TWO surfaces (spec §5)
 *
 * Both read surfaces trigger the IDENTICAL compiled op via {@link runRelationOp}:
 *   - **Declarative select** (`with: { author: true }`): batch-prefetched over the page.
 *   - **Lazy** (`await post.author`): a prototype getter fires the SAME op over the sibling set.
 */

import { assembleMakeSQL, type MakeSQL } from './makesql/makesql';
import { renderPlaceholders, type Dialect } from './makesql/handler';
import {
  type ExecutionContext,
  type SqliteDriver,
  executeSafe as seamExecuteSafe,
  contextForDriver,
} from './exec-context';
import { materializeCell, sqlTypeToMaterializeClass, type MaterializeClass, type ColumnTypeResolver } from './coltype';
import { parseProjectionColumn } from './makesql/outtype';
import { assertRelationHardLimit, resolveHasManyHardLimit, type RelationGuard } from './limit-config';
import { dedupeKeyTuples, groupByKey, attachToParent } from './grouping';
import { encodeJsonParam } from './makesql/json-array';
import {
  compileSingleKeyUnlimited,
  compileSingleKeyLimited,
  compileCompositeKeyStaticUnlimited,
  compileCompositeKeyStaticLimited,
  inferPgElementType,
  resolvePgArrayCast,
} from './makesql/compile-relation';
import { pgTypeSpecimen } from './makesql/tx';

/** A read relation cardinality (v1 parity). `belongsTo`/`hasOne` are single; `hasMany` many. */
export type RelationKind = 'belongsTo' | 'hasMany' | 'hasOne';

/**
 * A model's read-relation declaration (the authored/decorated relation metadata, spec §4).
 * Mirrors v1's `@belongsTo`/`@hasMany`/`@hasOne` config (source/target key + optional
 * per-parent order/limit), reduced to the fields the batch SQL needs.
 */
export interface RelationDecl {
  /** Relation name (the property attached on the parent object). */
  readonly name: string;
  /** Cardinality. */
  readonly kind: RelationKind;
  /** The child (target) table name. */
  readonly targetTable: string;
  /** Child columns to project (the child typed-object own props). */
  readonly select: readonly string[];
  /** The PARENT column whose value is the batch key (single-key relations). */
  readonly parentKey?: string;
  /** The CHILD column matched against the parent key (single-key relations). */
  readonly targetKey?: string;
  /**
   * COMPOSITE-key relations (#47 item 1): the ORDERED parent columns whose tuple is the batch key.
   * Mutually exclusive with {@link parentKey}. Pairs positionally with {@link targetKeys}.
   */
  readonly parentKeys?: readonly string[];
  /** COMPOSITE-key relations: the ORDERED child columns matched against the parent-key tuple. */
  readonly targetKeys?: readonly string[];
  /** Optional per-parent ORDER BY body (dialect-neutral text). */
  readonly order?: string;
  /** Optional per-parent row limit (`hasMany` only). */
  readonly limit?: number;
  /**
   * Per-relation hard-limit override (Phase E-2, epic #74; v1 `@hasMany({ hardLimit })`): the
   * batch-total cap for THIS relation, winning over the global `hasManyHardLimit`. `null` DISABLES
   * the check for this relation even when the global is set; `undefined` ⇒ use the global. `hasMany`
   * only (a single-cardinality relation fetches at most one child per parent). A relation with an
   * intrinsic per-parent {@link limit} window skips the batch-total check regardless (its fanout is
   * already bounded). See {@link import('./limit-config').resolveHasManyHardLimit}.
   */
  readonly hardLimit?: number | null;
  /** The target SQL dialect the batch SELECT is compiled for (default `'sqlite'`). */
  readonly dialect?: Dialect;
  /**
   * CHAINED relations (nested `with`, e.g. users→posts→comments): the relations declared ON THIS
   * relation's CHILD rows — a grandchild batch keyed by this relation's own result rows (level ≥ 3).
   * Each is a normal {@link RelationDecl} whose parent is THIS relation's target table. The batch stays
   * N+1-free per level (one query per depth): a per-language codegen lowers the chain as a batched map
   * off the parent relation's node; the runtime resolves the flattened child keys once per level. Absent
   * for a leaf (2-level) relation — additive, so existing single-level relations are byte-unchanged.
   */
  readonly childRelations?: readonly RelationDecl[];
  /**
   * CROSS-DB relations (V0 R1): the NAME of the connection the batch SELECT must execute against —
   * the TARGET model's DB, which may differ from the parent's (v1 `LazyRelation.ts:236` runs a
   * relation on `TargetClass.getDriverType()`'s driver/connection). Derived from the target model by
   * {@link import('./decorator-adapter').relationDeclOf}. Absent ⇒ the DEFAULT connection (the
   * same-DB case, which is every single-DB deployment). The SQL is v1-identical either way; the tag
   * only ROUTES the statement — a per-language runtime with a connection registry picks the pooled
   * driver by name.
   */
  readonly connection?: string;
}

/**
 * A pre-compiled relation batch op (spec §8). Pure JSON — it carries the STATIC batch SELECT
 * `sql` (makeSQL text with ONE `?` for the deduped-key array param) plus the grouping metadata
 * the runtime needs to distribute child rows to parents. No functions, no reduced IR.
 */
export interface RelationOp {
  readonly name: string;
  readonly kind: RelationKind;
  /** Parent column supplying the batch key values (dedup key) — single-key relations. */
  readonly parentKey?: string;
  /** Child column the batch groups rows by (matches the parent key) — single-key relations. */
  readonly targetKey?: string;
  /**
   * COMPOSITE-key relations (#47 item 1): the ORDERED parent columns whose tuple is the dedup key.
   * Present iff the op is composite (mutually exclusive with {@link parentKey}).
   */
  readonly parentKeys?: readonly string[];
  /** COMPOSITE-key relations: the ORDERED child columns the batch groups rows by (the key tuple). */
  readonly targetKeys?: readonly string[];
  /** The target SQL dialect the batch SELECT text is compiled for. */
  readonly dialect: Dialect;
  /**
   * CROSS-DB relations (V0 R1): the connection NAME the batch executes against (the TARGET model's
   * DB — v1 `LazyRelation` parity). Present iff the target model declares one; absent ⇒ the DEFAULT
   * connection. The SQL text and `dialect`-driven placeholder/bind are already correct for the target;
   * the name only ROUTES the statement, and it reaches the router as the
   * {@link import('./exec-context').StatementIntent}'s `db` on BOTH read surfaces — the codegen one
   * through the child fetch's `db` control field ({@link import('./leaf-transport').ExecOptions}) the
   * emitter bakes, the typed-object/lazy one through {@link runRelationOp}. The registry that resolves
   * the name is the ctx's ({@link import('./connection-routing').ConnectionRegistry}); an unresolvable
   * name is LOUD, never a silent same-DB fallback.
   */
  readonly connection?: string;
  /**
   * The batched child SELECT as STATIC makeSQL text. ONE `?` binds the deduped parent-key set on
   * every dialect and arity: single-key as the scalar set (PG `= ANY(?::t[])` / MySQL·SQLite
   * single-JSON), composite as the ONE array-of-tuples JSON param every dialect expands server-side
   * (PG `json_array_elements`, MySQL `JSON_TABLE`, SQLite `json_each`). Value-length-independent, so
   * `sql` is fixed — and the key set is exactly the ONE array the `pluck` leaf yields.
   */
  readonly sql: string;
  /**
   * The child (target) table + projected columns (issue #59) — carried for diagnostics, as the basis
   * of the baked `materializers` map, and as the capped relation's IDENTITY in {@link relationGuard}.
   * Both are ALWAYS set: {@link compileRelationOp} is the only constructor of a `RelationOp` and it
   * copies them from the decl's own required fields. They were once typed optional, which is what let
   * the emitter grow a "no target table ⇒ omit `model`" branch that could not run — and would have
   * emitted a module `bc generate` rejects if it had (#208).
   */
  readonly targetTable: string;
  readonly select: readonly string[];
  /**
   * CHAINED relations (nested `with`): the COMPILED grandchild relation ops keyed off THIS relation's
   * child rows (level ≥ 3). Present iff the decl carried {@link RelationDecl.childRelations}. A codegen
   * lowering injects each as a batched map off this relation's node (N+1-free per level); the mode-2
   * flat-batch runtime does not recurse into it (single-level). Additive — absent for leaf relations.
   */
  readonly childRelations?: readonly RelationOp[];
  /**
   * The child columns' STATIC materialize classes (issue #59): `column → MaterializeClass`, baked
   * at compile from the model's DDL resolver (only non-passthrough entries). The relation batch runs
   * these over its child rows so a BIGINT/DATE/BOOLEAN child de-boxes identically to the primary
   * read — with ZERO per-read DB introspection. Absent ⇒ the child rows stay raw (no schema).
   */
  readonly materializers?: Readonly<Record<string, MaterializeClass>>;
  /**
   * Hard-limit runaway cap (Phase E-2, epic #74; v1 `_selectForRelation` `hasManyHardLimit`): the
   * effective per-batch row cap RESOLVED at compile (per-relation override → global). When the batch
   * fetches MORE than this TOTAL, {@link import('./errors').LimitExceededError} is raised
   * (`context: 'relation'`, EXACT count) — by {@link runRelationOp} on the typed-object / lazy
   * surface, and by the `executeSQL` leaf on the CODEGEN surface, where the emitter bakes this cap
   * into the child fetch's `guard` port (the raw child rows are only visible there, before `group`).
   * BOTH read it through {@link relationGuard} + `assertRelationHardLimit`, so neither the cap nor the
   * error identity can drift between surfaces or languages. Absent ⇒ no check (disabled, or a relation
   * with an intrinsic per-parent `limit` window whose fanout is already bounded).
   * See {@link import('./limit-config').resolveHasManyHardLimit}.
   */
  readonly hardLimit?: number;
}

/** The reserved input head the relation batch query binds its deduped key array to. */
export const RELATION_KEYS_HEAD = '__keys';

/**
 * Compile ONE {@link RelationDecl} into a STATIC {@link RelationOp} via the makeSQL relation
 * builders. The batch query selects the child rows whose {@link RelationDecl.targetKey} is in
 * the deduped parent-key set. PG stays byte-identical to v1's `LazyRelation`; MySQL/SQLite use
 * the single-JSON-param server-side form. A `hasMany` with `limit` compiles to the per-parent
 * LATERAL (PG) / ROW_NUMBER (MySQL·SQLite) form. The SQL text is FIXED (the array binds as one
 * param regardless of length), so it needs no per-input recompile.
 */
export function compileRelationOp(decl: RelationDecl, resolveColumnType?: ColumnTypeResolver): RelationOp {
  if (decl.kind !== 'hasMany' && decl.limit !== undefined) {
    throw new Error(`relation '${decl.name}': a per-parent 'limit' is only valid for hasMany (got ${decl.kind})`);
  }
  if (decl.limit !== undefined && (!Number.isInteger(decl.limit) || decl.limit < 0)) {
    throw new Error(`relation '${decl.name}': per-parent limit must be a non-negative integer (got ${String(decl.limit)})`);
  }
  if (decl.limit !== undefined && decl.order === undefined) {
    throw new Error(
      `relation '${decl.name}': a per-parent 'limit' requires an explicit 'order' (the per-parent window needs a deterministic ordering to decide which ${decl.limit} rows each parent keeps)`,
    );
  }
  const dialect: Dialect = decl.dialect ?? 'sqlite';
  const composite = isCompositeDecl(decl);
  const sql = compiledBatchSql(decl, dialect, resolveColumnType);
  // CROSS-DB (V0 R1): carry the target connection tag ONLY when set (a same-DB relation stays
  // untagged, so existing bundles are byte-unchanged — the field is additive/optional).
  const conn = decl.connection !== undefined ? { connection: decl.connection } : {};
  // Carry the child table + projection AND bake the STATIC child materializers (issue #59) using the
  // SHARED `parseProjectionColumn` + the SINGLE column-type resolver — the SAME resolution the primary
  // read uses (no separate bare-regex pass). Every projection shape (bare / qualified `t.col` /
  // aliased `col AS b`) resolves + fail-closes identically; a `*` / computed / undeclared column
  // THROWS. The batch's child rows then de-box with ZERO per-read introspection.
  const materializers: Record<string, MaterializeClass> = {};
  if (resolveColumnType !== undefined) {
    const at = `relation '${decl.name}'`;
    for (const c of decl.select) {
      const entry = parseProjectionColumn(c, decl.targetTable, at); // `*`/computed → throw
      if (entry.kind === 'computed') continue; // a relation child rarely projects computed; leave raw
      const sqlType = resolveColumnType(entry.qualifier ?? decl.targetTable, entry.underlying); // undeclared → throw
      const klass = sqlTypeToMaterializeClass(sqlType);
      if (klass !== 'passthrough') materializers[entry.outputKey] = klass;
    }
  }
  // CHAINED relations (nested `with`): compile each grandchild relation recursively, inheriting THIS
  // relation's dialect. The SAME single compiler — a child is just another RelationDecl whose parent is
  // this relation's target rows; no separate nested-relation path. Absent ⇒ a leaf (byte-unchanged).
  const childRelations =
    decl.childRelations !== undefined && decl.childRelations.length > 0
      ? decl.childRelations.map((c) => compileRelationOp({ ...c, dialect: c.dialect ?? dialect }, resolveColumnType))
      : undefined;
  const target = {
    targetTable: decl.targetTable,
    select: [...decl.select],
    ...(Object.keys(materializers).length > 0 ? { materializers } : {}),
    ...(childRelations !== undefined ? { childRelations } : {}),
  };
  // Hard-limit runaway cap (Phase E-2, epic #74; v1 `_selectForRelation`): resolve the effective
  // batch-total cap ONCE at compile (per-relation override → global) and bake it onto the op as a
  // plain number the native ports read. Only a `hasMany` is capped (single-cardinality fetches ≤1
  // child per parent). A relation with an INTRINSIC per-parent `limit` window SKIPS the check — its
  // fanout is already bounded per parent (v1 raw-SQL-with-LIMIT skip). `null` (per-relation or global)
  // ⇒ disabled ⇒ the field is omitted (op stays byte-unchanged for the uncapped path).
  const effectiveHardLimit =
    decl.kind === 'hasMany' && decl.limit === undefined ? resolveHasManyHardLimit(decl.hardLimit) : null;
  const guard = effectiveHardLimit !== null ? { hardLimit: effectiveHardLimit } : {};
  if (composite) {
    return {
      name: decl.name,
      kind: decl.kind,
      parentKeys: [...(decl.parentKeys as readonly string[])],
      targetKeys: [...(decl.targetKeys as readonly string[])],
      dialect,
      ...conn,
      sql,
      ...target,
      ...guard,
    };
  }
  return {
    name: decl.name,
    kind: decl.kind,
    parentKey: decl.parentKey,
    targetKey: decl.targetKey,
    dialect,
    ...conn,
    sql,
    ...target,
    ...guard,
  };
}

/**
 * A relation decl is COMPOSITE iff it carries `parentKeys`/`targetKeys` arrays. Validates the two
 * are present together, equal-length (paired positionally), and non-empty; and that the single-key
 * `parentKey`/`targetKey` are NOT also set (mutually exclusive). Single-key iff both arrays absent.
 */
function isCompositeDecl(decl: RelationDecl): boolean {
  const hasArrays = decl.parentKeys !== undefined || decl.targetKeys !== undefined;
  if (!hasArrays) {
    if (decl.parentKey === undefined || decl.targetKey === undefined) {
      throw new Error(`relation '${decl.name}': a single-key relation requires 'parentKey' and 'targetKey'`);
    }
    return false;
  }
  if (decl.parentKeys === undefined || decl.targetKeys === undefined) {
    throw new Error(`relation '${decl.name}': a composite-key relation requires BOTH 'parentKeys' and 'targetKeys'`);
  }
  if (decl.parentKeys.length === 0 || decl.parentKeys.length !== decl.targetKeys.length) {
    throw new Error(`relation '${decl.name}': 'parentKeys' and 'targetKeys' must be non-empty and equal-length (got ${decl.parentKeys.length} vs ${decl.targetKeys.length})`);
  }
  if (decl.parentKey !== undefined || decl.targetKey !== undefined) {
    throw new Error(`relation '${decl.name}': cannot mix single-key ('parentKey'/'targetKey') with composite ('parentKeys'/'targetKeys')`);
  }
  return true;
}

/**
 * The PG element type of each COMPOSITE key column, from the CHILD column's DECLARED type — the same
 * schema-derived derivation the composite `tupleIn` predicate uses (`pgTypeSpecimen` →
 * `inferPgElementType`), so the two composite PG forms cast identically. The child column is the one
 * the key row is compared against, so its declared type is the type the key must carry.
 *
 * A composite PG batch cannot be compiled without them (the key rows come out of JSON as `text` and
 * `int = text` fails at plan time), so a missing resolver is a LOUD compile error, never a silent
 * `text` fallback.
 */
function pgKeyTypesOf(decl: RelationDecl, targetKeys: readonly string[], resolveColumnType?: ColumnTypeResolver): readonly string[] {
  if (resolveColumnType === undefined) {
    throw new Error(
      `relation '${decl.name}': a COMPOSITE-key relation on postgres needs the target model's column types ` +
        `(keys ${targetKeys.join(', ')} on '${decl.targetTable}') — pass a ColumnTypeResolver to compileRelationOp`,
    );
  }
  return targetKeys.map((k) => inferPgElementType([pgTypeSpecimen(resolveColumnType(decl.targetTable, k))]));
}

/**
 * Compile the STATIC batch SELECT text: the makeSQL relation builder emits complete tuned SQL
 * whose deduped-key array is ONE param. We compile against a single placeholder key array so
 * the text is fixed; the runtime re-binds the real deduped keys against the SAME text (the
 * single-JSON / `= ANY` forms are length-independent, so the text is stable).
 */
function compiledBatchSql(decl: RelationDecl, dialect: Dialect, resolveColumnType?: ColumnTypeResolver): string {
  // A COMPOSITE decl compiles to the STATIC composite form — ONE JSON array-of-tuples param on every
  // dialect, length-independent, so the text is fixed. A per-parent `limit` selects the STATIC
  // composite-LIMITED builder (PG LATERAL / MySQL·SQLite ROW_NUMBER window over the SAME static
  // key-set predicate — #47 last completeness gap).
  if (decl.parentKeys !== undefined) {
    const targetKeys = [...(decl.targetKeys as readonly string[])];
    const compositeBase = {
      dialect,
      tableName: decl.targetTable,
      select: decl.select.join(', '),
      order: decl.order,
      targetKeys,
      ...(dialect === 'postgres' ? { pgKeyTypes: pgKeyTypesOf(decl, targetKeys, resolveColumnType) } : {}),
    };
    const node =
      decl.limit !== undefined
        ? compileCompositeKeyStaticLimited({ ...compositeBase, limit: decl.limit })
        : compileCompositeKeyStaticUnlimited(compositeBase);
    return assembleMakeSQL(node).sql;
  }
  // A one-element placeholder key set fixes the SQL text (single-JSON-param / `= ANY` forms are
  // value-length-independent). The concrete keys are bound at execute time.
  const placeholderKeys: unknown[] = [null];
  // The PG `= ANY(?::<T>[])` element type comes from the target key COLUMN's DECLARED type — the same
  // schema-derived derivation the composite path uses (`pgKeyTypesOf`). It must NOT be inferred at
  // render from a bound value: the value's type differs by language (a bc int is a BigInt on the TS
  // plane → `bigint[]`, a native int in python/php → `int[]`), which broke cross-language byte-identity.
  // The column is the authority (an int column → `int[]`, byte-identical to v1's live-correct cast, and
  // never the #43 `text[]`). Only fall back to render-time inference when no resolver is available.
  const pgKeyCast =
    dialect === 'postgres' && resolveColumnType !== undefined
      ? inferPgElementType([pgTypeSpecimen(resolveColumnType(decl.targetTable, decl.targetKey as string))])
      : undefined;
  const base = {
    dialect,
    tableName: decl.targetTable,
    select: decl.select.join(', '),
    order: decl.order,
    targetKey: decl.targetKey as string,
    values: placeholderKeys,
    ...(pgKeyCast !== undefined
      ? { sqlCastMap: new Map([[decl.targetKey as string, pgKeyCast]]) }
      : { deferPgArrayCast: true }),
  };
  const node: MakeSQL =
    decl.limit !== undefined
      ? compileSingleKeyLimited({ ...base, limit: decl.limit })
      : compileSingleKeyUnlimited(base);
  // The builder emits the SQL with ONE `?` (the whole key array). Assemble to the flat text.
  return assembleMakeSQL(node).sql;
}

// ── Batch execution (the SINGLE code path both read surfaces share) ────────────

/** A minimal read-only driver surface (`prepare(sql).all(...params)`), the SQLite `Database`. */
export interface RelationDriver {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; safeIntegers?(v: boolean): unknown };
}

/** A relation batch runs against either a raw {@link RelationDriver} or a full {@link ExecutionContext}. */
export type RelationTarget = RelationDriver | ExecutionContext;

/**
 * Coerce a relation target to an {@link ExecutionContext}. A raw {@link RelationDriver} (read-only
 * `prepare`) is adapted to a full sync driver (its `run` is never reached on the read-only relation
 * path) and wrapped via {@link contextForDriver} — the backward-compat seam. So the relation batch
 * ALSO funnels through the central seam (middleware → connectionFor → execute), no direct driver.
 */
function relationContext(target: RelationTarget): ExecutionContext {
  if ('connectionFor' in target) return target;
  const driver: SqliteDriver = {
    prepare(sql: string) {
      const s = target.prepare(sql);
      return {
        all: (...p: unknown[]) => s.all(...p),
        // The read-only relation path never runs a write; a defensive stub keeps the driver shape total.
        run: () => {
          throw new Error('relation batch: unexpected write on a read-only relation driver');
        },
        safeIntegers: s.safeIntegers?.bind(s),
      };
    },
  };
  return contextForDriver(driver);
}

/** The child rows grouped for a batch: parent-key value (stringified) → child rows. */
export type RelationBatch = Map<string, Record<string, unknown>[]>;

/** The ordered PARENT key columns of an op (single-key → 1-element list; composite → the tuple). */
export function parentKeyCols(op: RelationOp): readonly string[] {
  return op.parentKeys ?? [op.parentKey as string];
}

/** The ordered CHILD key columns of an op (single-key → 1-element list; composite → the tuple). */
export function targetKeyCols(op: RelationOp): readonly string[] {
  return op.targetKeys ?? [op.targetKey as string];
}

/**
 * The op's RELATION RUNAWAY GUARD, or `null` when it baked none (disabled, or an intrinsic per-parent
 * `limit` window whose fanout is already bounded). The ONE projection of a compiled op onto the
 * {@link RelationGuard} record — read by BOTH consumers of the cap: {@link runRelationOp} (the
 * typed-object / lazy batch) and the emitter, which bakes this record into the generated child fetch's
 * `guard` port so the leaf enforces the SAME resolved cap. Nothing downstream re-derives it.
 *
 * TOTAL in `model`: a compiled op always carries its {@link RelationOp.targetTable}, so this side of
 * the cap never produces the "unknown model" case. Only the WIRE side does — the port is `opt(string)`
 * and {@link import('./leaves').leafHandlers}' reader still has to accept a `null` — which is why the
 * return type is narrower than {@link RelationGuard} itself: the emitter must be able to spell `model`
 * with NO branch (a branch that omits the key emits a module `bc generate` rejects, #208).
 */
export function relationGuard(op: RelationOp): (RelationGuard & { readonly model: string }) | null {
  if (op.hardLimit === undefined) return null;
  return { limit: op.hardLimit, model: op.targetTable, relation: op.name };
}

/**
 * Bind the deduped keys to the batch op's params — ONE param, every dialect and arity. A COMPOSITE
 * key set is the JSON array-of-tuples every dialect expands server-side (PG `json_array_elements`,
 * MySQL `JSON_TABLE`, SQLite `json_each`), so the key binding is dialect-INDEPENDENT: no key-tuple
 * transpose anywhere. A SINGLE-key set is the scalar array — bound raw on PG (`= ANY(?::t[])` takes a
 * native array) and JSON-encoded on MySQL/SQLite.
 *
 * The JSON encoding goes through {@link encodeJsonParam}, the one serializer every JSON param uses.
 * These keys came OFF a read, so an `int` key is a `BigInt` — a bare `JSON.stringify` here does not
 * "diverge subtly", it THROWS `Do not know how to serialize a BigInt` and takes every relation read
 * with an integer parent key down with it.
 */
function bindKeys(op: RelationOp, tuples: readonly unknown[][]): unknown[] {
  if (op.parentKeys !== undefined) return [encodeJsonParam(op.dialect, tuples.map((t) => [...t]))];
  const keys = tuples.map((t) => t[0]);
  return [op.dialect === 'postgres' ? keys : encodeJsonParam(op.dialect, keys)];
}

/**
 * Run ONE {@link RelationOp} for a set of parent rows: dedup the parent-key tuples, render the
 * STATIC batch SELECT once (dialect placeholder form) resolving the deferred PG array cast(s) from
 * the REAL keys, execute it with the keys bound (single array / per-column arrays / JSON tuples),
 * then group the child rows by their target-key identity. The single batch primitive BOTH the
 * declarative-select and the lazy surface invoke, single-key AND composite.
 *
 * Returns `{ sql, keys, batch }` (`keys` = the deduped parent-key tuples). An empty key set issues
 * NO query (the correct empty-set behavior — the membership over no keys selects nothing).
 */
export function runRelationOp(
  op: RelationOp,
  parents: readonly Record<string, unknown>[],
  db: RelationTarget,
): { sql: string; keys: unknown[][]; batch: RelationBatch } {
  const ctx = relationContext(db);
  const pCols = parentKeyCols(op);
  const keys = dedupeKeyTuples(parents, pCols);
  const batch: RelationBatch = new Map();
  // Resolve the deferred PG array cast (#46) from the REAL keys BEFORE the `?`→`$N` render: the
  // SINGLE-key `= ANY(?::<T>[])` is the only cast whose element type is value-derived. A composite
  // batch carries no token (its key rows are cast from the DECLARED column types at compile) and
  // MySQL/SQLite carry none at all.
  const cast =
    op.dialect === 'postgres' && op.parentKeys === undefined
      ? resolvePgArrayCast(op.sql, keys.map((t) => t[0]))
      : op.sql;
  const sql = renderPlaceholders(cast, op.dialect);
  if (keys.length === 0) return { sql, keys, batch };
  const tCols = targetKeyCols(op);
  // Materialize the child rows (issue #59) exactly like the primary read, using the STATIC
  // materializers baked onto the op at compile (from the model's DDL — ZERO per-read introspection).
  // A BIGINT/DATE/BOOL child column de-boxes identically to a top-level read (INT→number /
  // BIGINT→string / DATE→string / bool).
  const childCols = op.materializers;
  // The EXACT-integer seam, unconditionally — the same one the `executeSQL` leaf reads through. This
  // used to switch to the inexact seam unless a child column was declared `int64`, which made ONE
  // column read back as two different JS types depending on which surface fetched it: `1n` through
  // codegen, `1` through the lazy path. Exactness is not a per-endpoint choice; the DECLARED type
  // decides the consumer-facing shape, and that narrowing is `materializeCell`'s job below.
  const boundParams = bindKeys(op, keys);
  // The batch's own DATABASE: the compiled op names it ({@link RelationOp.connection} — the TARGET
  // model's), and the ctx owns the registry that resolves the name. They meet HERE, on the
  // {@link import('./exec-context').StatementIntent} — the only input `connectionFor` routes on, and
  // the SAME channel the `executeSQL` leaf uses on the codegen surface (`leaves.ts` `prepareSql`).
  // An untagged (same-DB) relation leaves `db` unspelled ⇒ the DEFAULT connection.
  const rawRows = seamExecuteSafe(ctx, sql, boundParams, {
    write: false,
    ...(op.connection !== undefined ? { db: op.connection } : {}),
  }) as Record<string, unknown>[];
  // Hard-limit runaway guard (Phase E-2, epic #74; v1 `_selectForRelation`): POST-fetch, if the batch
  // TOTAL exceeds the baked cap, throw with the EXACT count (the batch is fetched in full, no N+1).
  // The check itself is the SHARED relation primitive (`assertRelationHardLimit`) over the op's own
  // guard — the SAME two functions the codegen path runs in the `executeSQL` leaf, so the two read
  // surfaces cannot drift on the cap, the count or the error identity. Runs BEFORE grouping/hydration
  // so an over-cap read never assembles an unbounded result set.
  assertRelationHardLimit(rawRows, relationGuard(op));
  const rows = materializeChildRows(rawRows, childCols);
  // Group the child rows by their target-key identity — the shared grouping SSoT ({@link groupByKey}),
  // the SAME core the eager `group` leaf uses (no duplicated grouping).
  return { sql, keys, batch: groupByKey(rows, tCols) };
}

/** Materialize relation child rows (issue #59): same coercion as the primary read. */
function materializeChildRows(
  rows: Record<string, unknown>[],
  cols: Record<string, MaterializeClass> | undefined,
): Record<string, unknown>[] {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const klass = cols?.[key];
      if (klass !== undefined) { row[key] = materializeCell(row[key], klass); continue; }
      // An UNDECLARED integer column arrives as bigint from the exact seam — narrow it here. There is
      // no longer a mode in which it does not, so this is the normal path, not a defensive one.
      if (typeof row[key] === 'bigint') {
        const v = row[key] as bigint;
        row[key] = v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
      }
    }
  }
  return rows;
}

/**
 * Distribute a resolved {@link RelationBatch} onto ONE parent per the relation cardinality:
 * `hasMany` → the child list (`[]` when none); `belongsTo`/`hasOne` → the single child (or `null`).
 * A thin consumer over the shared grouping SSoT ({@link attachToParent}) — the SAME core the eager
 * `group` leaf uses (no duplicated grouping). `null`/`[]` is the declared cardinality's empty
 * representation, not an ad-hoc default.
 */
export function distributeToParent(
  op: RelationOp,
  parent: Record<string, unknown>,
  batch: RelationBatch,
): Record<string, unknown>[] | Record<string, unknown> | null {
  return attachToParent(parent, parentKeyCols(op), batch, op.kind !== 'hasMany');
}
