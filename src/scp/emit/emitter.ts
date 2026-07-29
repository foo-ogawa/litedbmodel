/**
 * litedbmodel v2 SCP — the decorator/metadata → SCP-restricted TS LOWERING EMITTER.
 *
 * This is the middle of the settled model (CLAUDE.md §1):
 *
 * ```
 * ORM user: decorated models + DECLARED endpoints (no SQL)      ← src/decorators.ts + ./endpoint
 *    ↓  emitBehaviorModule — THIS module
 * SCP-restricted TS: `@behavior static` methods calling the ONE `@leaf` catalog (`Db`), with the
 * dialect SQL already baked in by `makesql`
 *    ↓  bc generate --from
 * go / rust / py / php / ts native modules — bc wires the leaves automatically
 * ```
 *
 * ## It compiles nothing of its own
 *
 * Every artifact the emitter puts in the emitted source comes from an EXISTING aggregation point —
 * the emitter only RENDERS them as TypeScript:
 *
 *  | emitted thing                | comes from                                                      |
 *  |------------------------------|-----------------------------------------------------------------|
 *  | read SQL + param order       | `makesql/compile-select.compileSelect`                           |
 *  | WHERE text (whole / fragment)| `makesql/compile.compileWhere` → `DBConditions`                  |
 *  | static IN-list membership    | `makesql/json-array.inListPredicate` (PG `= ANY(?)`, #46)        |
 *  | write SQL + param order      | `makesql/tx.compileWriteNode` (INSERT/UPDATE/DELETE + batch)     |
 *  | relation batch SQL + keys    | `relation.compileRelationOp` (+ `parentKeyCols`/`targetKeyCols`) |
 *  | relation hard-limit guard    | `relation.relationGuard` (the compiled op's resolved cap)         |
 *  | row types                    | `makesql/outtype.deriveReadRow` over the model's `@column` SoT   |
 *  | column SQL types             | `decorator-adapter.deriveModelColumns` / `modelColumnResolver`   |
 *  | relation declarations        | `decorator-adapter.relationDeclOf`                               |
 *  | find hard-limit cap          | `limit-config.resolveFindHardLimit`                              |
 *  | the leaf catalog             | `leaf-transport.Db` (imported by the emitted module)             |
 *
 * ## How a parameter reaches the SQL
 *
 * The builders bind VALUES: they push whatever value a condition/port carried into `params` in the
 * exact order the `?`s appear. The emitter therefore hands them a {@link ParamRef} SENTINEL instead
 * of a value and reads the sentinels back out of `params` — so the emitted `params` array is the
 * builders' own binding order, with each slot rendered as the method parameter it stands for. A slot
 * that came back as a plain value (a QUERY view's own fragment params) renders as a literal.
 *
 * ## SKIP / dynamic WHERE (CLAUDE.md §2 — settled)
 *
 * A predicate declared `optional` is present-or-absent PER CALL, so the final SQL can only be
 * determined at execution time. A BOUNDED predicate is not — it is the same on every call — so it is
 * lowered into the static `sql` HERE, at emit time (native-clean), exactly as it is on a read that
 * declares no optional predicate at all. A read's WHERE therefore splits by that ONE property: the
 * bounded predicates ARE the emitted statement's WHERE, and only the ACTUALLY-optional ones accumulate
 * a plan — one `{skipped, sql, params}` FRAGMENT each, which the `executeSQL` leaf continues the static
 * WHERE with when it runs ({@link import('../leaves').assembleDynamicWhere}); the `?`→`$N` render
 * happens after that, on the final SQL. There is no intermediate IR vocabulary: a fragment is SQL text
 * + params + a SKIP FLAG (`skipped` = `param === null`). Every fragment is the SAME struct — never a
 * `cond`-to-null element — so the go/rust native-codegen emitters resolve the plan (a variant/nullable
 * array element is the one shape they reject).
 *
 * A read with NO optional predicate carries no plan at all. One statement, one plan holding exactly the
 * predicates that are optional.
 */

import type { PortableType } from 'behavior-contracts/runtime';
import { DBExists, DBSubquery, DBParentRef, type ColumnRef, type SubqueryCondition } from '../../DBValues';
import type { ConditionObject, ConditionValue } from '../../DBConditions';
import { compileSelect, type BoundCount, type SelectDesc } from '../makesql/compile-select';
import { compileWhere } from '../makesql/compile';
import { inListPredicate, tupleInPredicate } from '../makesql/json-array';
import { compileWriteNode, pgTypeSpecimen } from '../makesql/tx';
import { deriveReadRow } from '../makesql/outtype';
import { sqlTypeToBcScalar, type BcScalar, type ColumnTypeResolver } from '../coltype';
import { inferPgArrayType } from '../makesql/compile-relation';
import { compileRelationOp, parentKeyCols, relationGuard, targetKeyCols, type RelationDecl } from '../relation';
import { resolveFindHardLimit } from '../limit-config';
import {
  deriveModelColumns,
  modelColumnResolver,
  relationDeclOf,
  tableNameOf,
  type DeriveColumnsOptions,
  type ModelClassLike,
} from '../decorator-adapter';
import { getPrimaryKey, getRelationMeta } from '../../decorators';
import type { DialectName } from '../dialect';
import type {
  ComparePredicate,
  CorrelationTerm,
  CreateEndpoint,
  CreateManyEndpoint,
  DeleteEndpoint,
  DeleteManyEndpoint,
  Endpoint,
  EndpointSet,
  ExistsPredicate,
  InPredicate,
  PageBound,
  Predicate,
  ReadEndpoint,
  RelationSelection,
  SubqueryPredicate,
  TupleInPredicate,
  UpdateEndpoint,
  UpdateManyEndpoint,
  ValueBinding,
} from './endpoint';

// ── the emit request / result ─────────────────────────────────────────────────────────────────

/** What to emit. */
export interface EmitSpec {
  /** The emitted class name — the `bc generate --behavior` argument. */
  readonly behavior: string;
  /** The dialect whose SQL is baked into the emitted source. */
  readonly dialect: DialectName;
  /**
   * The module specifier the emitted source imports `Db` from — the ONE `@leaf` catalog
   * (`src/scp/leaf-transport`). It must resolve FROM the emitted file's own location, because
   * `bc generate --from` type-checks the emitted source.
   */
  readonly leafImport: string;
  /** The declared endpoints — one `@behavior static` method each, in declaration order. */
  readonly endpoints: EndpointSet;
  /** Model NAME → model class, for resolving a relation's target model (as `deriveRelationDecls` takes). */
  readonly models?: (modelName: string) => ModelClassLike;
  /** Per-column SQL-type overrides passed through to {@link deriveModelColumns}. */
  readonly columnOptions?: DeriveColumnsOptions;
}

/** One emitted endpoint's call contract — what a caller passes and what it gets back. */
export interface EmittedEndpoint {
  readonly name: string;
  /** The emitted method's parameters, in signature order (the generated module's input scope keys). */
  readonly params: readonly { readonly name: string; readonly type: string }[];
  /** The emitted method's declared return type. */
  readonly returnType: string;
  /**
   * The `findHardLimit` cap baked into this read's `LIMIT cap + 1` bounded fetch, when one was
   * configured and the endpoint declared no explicit limit. SCP has no throw, so the read boundary
   * enforces it post-fetch with {@link import('../limit-config').assertFindHardLimit} — the same
   * split the relation twin uses (`runRelationOp` throws off the op's baked `hardLimit`).
   */
  readonly findHardLimit?: number;
}

/** The emitter's output. */
export interface EmitResult {
  /** The SCP-restricted TypeScript source (what `bc generate --from` reads). */
  readonly source: string;
  /** Per-endpoint call contracts, in emission order. */
  readonly endpoints: readonly EmittedEndpoint[];
}

// ── parameter sentinels (what the builders bind instead of a value) ───────────────────────────

/**
 * A stand-in for a bound VALUE that renders as a TS expression in the emitted `params` array. The
 * builders treat it as an opaque scalar (it is not `null`, not an array, not a `DBToken`, not a
 * `DBConditions`), so every builder emits its ordinary single-`?` form and pushes this object into
 * `params` at exactly the slot the `?` occupies.
 */
class ParamRef {
  constructor(readonly expr: string) {}
}

/** The declared TS type of one emitted method parameter. */
interface ParamDecl {
  readonly name: string;
  readonly type: string;
}

// ── entry point ───────────────────────────────────────────────────────────────────────────────

/**
 * Lower a set of declared endpoints to SCP-restricted TypeScript. The result's `source` is ordinary
 * `tsc --strict` TypeScript (that is bc's authoring requirement) whose only imports are bc's
 * authoring markers and the library's ONE leaf catalog.
 */
export function emitBehaviorModule(spec: EmitSpec): EmitResult {
  const names = Object.keys(spec.endpoints);
  if (names.length === 0) throw new Error(`emit: behavior '${spec.behavior}' declares no endpoints`);
  const ctx = new EmitContext(spec);
  const methods = names.map((name) => ctx.method(name, spec.endpoints[name]));
  return { source: ctx.render(methods), endpoints: ctx.contracts };
}

// ── the emitter ───────────────────────────────────────────────────────────────────────────────

/** One emitted method: its signature + statement lines. */
interface Method {
  readonly name: string;
  readonly params: readonly ParamDecl[];
  readonly returnType: string;
  readonly lines: readonly string[];
}

class EmitContext {
  /** Emitted row interfaces, in declaration order (`name → body text`). */
  private readonly interfaces = new Map<string, string>();
  /** The per-endpoint call contracts, in emission order. */
  readonly contracts: EmittedEndpoint[] = [];

  constructor(private readonly spec: EmitSpec) {}

  // ── model metadata (all of it from the decorator SoT) ───────────────────────────────────────

  private resolver(model: ModelClassLike): ColumnTypeResolver {
    const r = modelColumnResolver(model, this.spec.columnOptions);
    if (r === undefined) {
      throw new Error(
        `emit: model '${model.name}' declares no @column metadata — the emitter types every projection ` +
          `and every bound parameter from the column SoT (no-assume, no-fallback).`,
      );
    }
    return r;
  }

  /** The model's declared columns (`column → SQL type`) — the ONE type SoT. */
  private columnsOf(model: ModelClassLike): Readonly<Record<string, string>> {
    const table = tableNameOf(model);
    const cols = deriveModelColumns(model, this.spec.columnOptions)[table];
    if (cols === undefined) {
      throw new Error(`emit: model '${model.name}' declares no @column metadata (table '${table}')`);
    }
    return cols;
  }

  private sqlTypeOf(model: ModelClassLike, column: string): string {
    const t = this.columnsOf(model)[column];
    if (t === undefined) {
      throw new Error(
        `emit: model '${model.name}' has no @column '${column}' — a declared endpoint may only name ` +
          `columns the model declares (no-assume, no-fallback).`,
      );
    }
    return t;
  }

  /** The TS type a BOUND parameter carries for a column (the bc scalar of its declared SQL type). */
  private bindTypeOf(model: ModelClassLike, column: string): string {
    return tsScalar(sqlTypeToBcScalar(this.sqlTypeOf(model, column)));
  }

  // ── methods ────────────────────────────────────────────────────────────────────────────────

  method(name: string, endpoint: Endpoint): Method {
    assertIdentifier(name, `endpoint name '${name}'`);
    const m = this.lower(name, endpoint);
    const cap = endpoint.kind === 'read' ? this.bakedFindCap(endpoint) : null;
    this.contracts.push({
      name,
      params: m.params.map((p) => ({ name: p.name, type: p.type })),
      returnType: m.returnType,
      ...(cap !== null ? { findHardLimit: cap } : {}),
    });
    return m;
  }

  private lower(name: string, endpoint: Endpoint): Method {
    switch (endpoint.kind) {
      case 'read':
        return this.read(name, endpoint);
      case 'create':
      case 'update':
      case 'delete':
        return this.write(name, endpoint);
      case 'createMany':
      case 'updateMany':
      case 'deleteMany':
        return this.batch(name, endpoint);
    }
  }

  // ── READ ───────────────────────────────────────────────────────────────────────────────────

  /**
   * The `findHardLimit` cap this read bakes: the configured cap when the endpoint declares NO explicit
   * limit (an authored LIMIT governs — v1's skip rule; a BOUND limit is authored too, the author
   * declared that this endpoint is paged), else `null`. Read from the config SSoT
   * ({@link resolveFindHardLimit}) at EMIT time, exactly as the retired compile-time bake did.
   */
  private bakedFindCap(endpoint: ReadEndpoint): number | null {
    if (endpoint.limit !== undefined) return null;
    return resolveFindHardLimit();
  }

  /**
   * Lower ONE declared page position to the `compileSelect` tail. A static count passes straight
   * through and inlines as the literal it always was; a `{ param }` position declares an `Int` method
   * parameter and binds through the SAME tail as a {@link BoundCount} sentinel, so the paged and the
   * bounded read are one statement builder and one param list.
   *
   * A count is an `Int` by SQL's own definition of `LIMIT` / `OFFSET` — it names no model column, so
   * there is no column type to resolve it from.
   */
  private page(p: PageBound | undefined, params: ParamDecl[]): number | BoundCount | undefined {
    if (p === undefined || typeof p === 'number') return p;
    assertIdentifier(p.param, `parameter '${p.param}'`);
    params.push({ name: p.param, type: tsScalar('int') });
    return { bind: new ParamRef(p.param) };
  }

  private read(name: string, endpoint: ReadEndpoint): Method {
    const model = endpoint.model;
    const resolve = this.resolver(model);
    const baseTable = tableNameOf(model);
    // A QUERY view-model reads from the derived CTE alias; the projection types resolve against the
    // model's declared columns either way (the CTE projects the model's own columns).
    const alias = endpoint.view?.alias ?? 'derived';
    const table = endpoint.view !== undefined ? alias : baseTable;
    const projection = endpoint.select ?? Object.keys(this.columnsOf(model));
    const readResolve: ColumnTypeResolver =
      endpoint.view !== undefined ? (t, c) => resolve(t === alias ? baseTable : t, c) : resolve;

    const cap = this.bakedFindCap(endpoint);
    const where = endpoint.where ?? [];
    // CLAUDE.md §2: the WHERE splits by ONE property — a BOUNDED predicate is lowered into the static
    // statement below, only an ACTUALLY-optional one accumulates a plan the leaf assembles per call.
    const optional = where.filter(isOptional);
    if (optional.length > 0 && endpoint.view !== undefined) {
      throw new Error(
        `emit: endpoint '${name}': a QUERY view-model's CTE is a statement of its own, and the leaf locates ` +
          `the dynamic WHERE by the FIRST tail keyword (GROUP BY / ORDER BY / LIMIT / …) — it cannot tell a ` +
          `tail inside the CTE from the outer statement's. Declare the view's own predicate inside the view ` +
          `query, or drop the optional predicate.`,
      );
    }

    const params: ParamDecl[] = [];
    for (const p of where) this.declareWhereParams(model, p, params);
    // The page tail binds AFTER the WHERE — the order its `?`s occupy in the finished statement, and
    // therefore the order the parameters are declared in.
    const limit = this.page(endpoint.limit ?? (cap !== null ? cap + 1 : undefined), params);
    const offset = this.page(endpoint.offset, params);

    const compiled = compileSelect({
      dialect: this.spec.dialect,
      tableName: table,
      select: projection.join(', '),
      // The BOUNDED predicates — this read's static WHERE, whatever else it declares. (An all-optional
      // read compiles an EMPTY condition set, which is the same no-WHERE statement it always was.)
      conditions: this.conditions(model, where.filter((p) => !isOptional(p))),
      ...(endpoint.view !== undefined ? { cte: cteOf(endpoint.view) } : {}),
      ...(endpoint.order !== undefined ? { order: endpoint.order } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(endpoint.lock === 'update' ? { forUpdate: true } : endpoint.lock === 'share' ? { forShare: true } : {}),
    } satisfies SelectDesc);

    const call = `${quote(compiled.sql)}, [${compiled.params.map(renderSlot).join(', ')}]${execOptions(
      optional.length > 0 ? { whereDynamic: this.dynamicWherePlan(model, optional) } : {},
    )}`;

    const rowObj = objOf(deriveReadRow(table, projection, readResolve, `endpoint '${name}'`).outType, name);
    const selections = normalizeSelections(endpoint.with ?? []);

    const fresh = freshNames(params.map((p) => p.name));
    if (selections.length === 0) {
      const rowType = this.declareInterface(`${cap1(name)}Row`, rowObj);
      const out = fresh('rows');
      return {
        name,
        params,
        returnType: `${rowType}[]`,
        lines: [`const ${out}: ${rowType}[] = Db.executeSQL(${call}) as ${rowType}[];`, `return ${out};`],
      };
    }

    // Relation graph: parents → (pluck → child executeSQL → group)*, ONE query per level (N+1-free).
    const lines: string[] = [];
    const parentVar = fresh('rows');
    lines.push(`const ${parentVar}: WireValue[] = Db.executeSQL(${call});`);
    const graph = this.relations(model, parentVar, rowObj, selections, lines, fresh, `endpoint '${name}'`);
    const rowType = this.declareInterface(`${cap1(name)}Row`, graph.obj);
    // The terminal binding is the SINGLE de-box point: the annotation is what bc reads, the one
    // assertion is what narrows the opaque wire value for tsc.
    lines[lines.length - 1] = `const ${graph.terminalVar}: ${rowType}[] = ${graph.terminalCall} as ${rowType}[];`;
    lines.push(`return ${graph.terminalVar};`);
    return { name, params, returnType: `${rowType}[]`, lines };
  }

  /**
   * The DYNAMIC WHERE plan expression: ONE fragment per OPTIONAL predicate — never a bounded one, which
   * is already in the static statement (CLAUDE.md §2) — every fragment the SAME struct
   * `{skipped, sql, params}`, with `sql`/`params` from the SAME `compileWhere` that produces a bounded
   * WHERE and `skipped` the per-call SKIP decision carried as DATA (`param === null`). That is the whole
   * fragment vocabulary (SQL + params + a SKIP flag). The array is HOMOGENEOUS — never a `cond`-to-null
   * element — so the go/rust native-codegen emitters resolve it (a variant/nullable array element is the
   * one shape they reject); the `executeSQL` leaf drops the `skipped` fragments at run and continues the
   * static WHERE with the survivors.
   */
  private dynamicWherePlan(model: ModelClassLike, optional: readonly OptionalPredicate[]): string {
    const frags = optional.map((p) => {
      const w = compileWhere(this.conditions(model, [p]), this.spec.dialect);
      return `{ skipped: ${p.param} === null, sql: ${quote(w.sql)}, params: [${w.params.map(renderSlot).join(', ')}] }`;
    });
    return `{ frags: [${frags.join(', ')}] }`;
  }

  /**
   * Emit ONE relation LEVEL: for each selected relation, pluck the parent key set, run the ONE batched
   * child SELECT (`compileRelationOp`'s static SQL) and nest the children under the parent. A nested
   * selection recurses FIRST, so a grandchild level is grouped into its own parent before that parent
   * is grouped into ours (one query per depth — never one per parent).
   */
  private relations(
    model: ModelClassLike,
    parentVar: string,
    parentObj: Record<string, PortableType>,
    selections: readonly { name: string; with: readonly RelationSelection[] }[],
    lines: string[],
    fresh: (base: string) => string,
    at: string,
  ): { obj: Record<string, PortableType>; terminalCall: string; terminalVar: string } {
    let acc = parentVar;
    const obj: Record<string, PortableType> = { ...parentObj };
    let terminalCall = '';
    let terminalVar = '';
    for (const sel of selections) {
      const { decl, targetModel } = this.relationDecl(model, sel.name, at);
      const op = compileRelationOp(decl, this.resolver(targetModel));
      const keysVar = fresh(`${sel.name}Keys`);
      lines.push(`const ${keysVar}: WireValue[] = Db.pluck(${acc}, ${jsonArray(parentKeyCols(op))});`);
      const childVar = fresh(sel.name);
      // The runaway guard the compiled op resolved (`hasManyHardLimit` / the per-relation override):
      // baked onto the child fetch so the `executeSQL` transport asserts the RAW child row count — the
      // only point they are visible, since `group` receives an already-nested graph. A relation batch
      // never carries a dynamic WHERE (its SQL is fully static), and it says so with the `whereDynamic:
      // null` FIELD of the option record — an uncapped batch carries no record at all.
      const guard = relationGuard(op);
      // The guard rides as a CONCRETE `CapGuard` struct (leaf-transport), so the native emitters build
      // it directly: `limit` is an `Int` LITERAL (a plain `number` would emit as a float and the wire
      // int-probe would miss the cap); `model` is omitted when the op resolved none.
      const guardExpr =
        guard !== null
          ? `{ limit: ${guard.limit} as Int, ${guard.model !== undefined ? `model: ${quote(guard.model)}, ` : ''}relation: ${quote(guard.relation)} }`
          : undefined;
      lines.push(
        `const ${childVar}: WireValue[] = Db.executeSQL(${quote(op.sql)}, [${keysVar}]${execOptions(guardExpr !== undefined ? { guard: guardExpr } : {})});`,
      );
      let childRows = childVar;
      let childObj = objOf(
        deriveReadRow(decl.targetTable, decl.select, this.resolver(targetModel), `${at} relation '${sel.name}'`).outType,
        `${at} relation '${sel.name}'`,
      );
      if (sel.with.length > 0) {
        const nested = this.relations(targetModel, childVar, childObj, normalizeSelections(sel.with), lines, fresh, `${at}.${sel.name}`);
        childObj = nested.obj;
        childRows = nested.terminalVar;
      }
      const single = decl.kind !== 'hasMany';
      obj[sel.name] = single ? { opt: { obj: childObj } } : { arr: { obj: childObj } };
      terminalVar = fresh(`${sel.name}Graph`);
      terminalCall = `Db.group(${acc}, ${childRows}, ${jsonArray(parentKeyCols(op))}, ${jsonArray(targetKeyCols(op))}, ${quote(sel.name)}, ${single})`;
      lines.push(`const ${terminalVar}: WireValue[] = ${terminalCall};`);
      acc = terminalVar;
    }
    return { obj, terminalCall, terminalVar };
  }

  /** The model's `@hasMany`/`@belongsTo`/`@hasOne` declaration for `name` (the decorator SoT). */
  private relationDecl(model: ModelClassLike, name: string, at: string): { decl: RelationDecl; targetModel: ModelClassLike } {
    const rel = getRelationMeta(model).find((r) => r.propertyKey === name);
    if (rel === undefined) {
      throw new Error(`emit: ${at}: model '${model.name}' declares no relation '${name}' (@hasMany/@belongsTo/@hasOne)`);
    }
    const models = this.spec.models;
    if (models === undefined) {
      throw new Error(`emit: ${at}: relation '${name}' needs the model registry (EmitSpec.models) to resolve its target model`);
    }
    return relationDeclOf(rel, models, this.spec.dialect);
  }

  // ── WRITE (single-row INSERT / UPDATE / DELETE) ─────────────────────────────────────────────

  private write(name: string, endpoint: CreateEndpoint | UpdateEndpoint | DeleteEndpoint): Method {
    const model = endpoint.model;
    const table = tableNameOf(model);
    const params: ParamDecl[] = [];
    const returning = endpoint.returning;
    const ports: Record<string, unknown> = { table };
    this.returningPorts(model, returning, ports);

    let component: 'Insert' | 'Update' | 'Delete';
    if (endpoint.kind === 'create') {
      component = 'Insert';
      this.valuePorts(model, endpoint.values, 'values', ports, params);
      if (endpoint.onConflict !== undefined) {
        ports.onConflict = endpoint.onConflict.join(', ');
        ports.onConflictAction = endpoint.onConflictAction ?? 'update';
      }
    } else if (endpoint.kind === 'update') {
      component = 'Update';
      this.valuePorts(model, endpoint.set, 'set', ports, params);
      ports.where = this.wherePort(model, endpoint.where, params, `endpoint '${name}'`);
    } else {
      component = 'Delete';
      ports.where = this.wherePort(model, endpoint.where, params, `endpoint '${name}'`);
    }

    const op = compileWriteNode({ component, ports } as Parameters<typeof compileWriteNode>[0], this.spec.dialect, this.resolver(model));
    const rowType = this.writeRowType(name, model, returning);
    const out = freshNames(params.map((p) => p.name))('rows');
    return {
      name,
      params,
      returnType: `${rowType}[]`,
      lines: [
        `const ${out}: ${rowType}[] = Db.executeSQL(${quote(op.sql)}, [${op.params.map(renderSlot).join(', ')}]${execOptions({ write: { returning: returning !== undefined } })}) as ${rowType}[];`,
        `return ${out};`,
      ],
    };
  }

  /** Declare the `<family>.<column>` ports for a VALUES / SET list, binding each to a method parameter. */
  private valuePorts(
    model: ModelClassLike,
    bindings: readonly ValueBinding[],
    family: 'values' | 'set',
    ports: Record<string, unknown>,
    params: ParamDecl[],
  ): void {
    if (bindings.length === 0) throw new Error(`emit: a write needs at least one '${family}' binding`);
    for (const b of bindings) {
      assertIdentifier(b.param, `parameter '${b.param}'`);
      params.push({ name: b.param, type: this.bindTypeOf(model, b.column) });
      ports[`${family}.${b.column}`] = new ParamRef(b.param);
    }
  }

  /**
   * The write path's `where` port — the `{arr:[…]}` Expression-IR member list `compileWriteNode`
   * lowers (`lowerWherePort`). Only that compiler's declared vocabulary is lowerable there; anything
   * else is a loud reject rather than a second WHERE compiler.
   */
  private wherePort(model: ModelClassLike, where: readonly Predicate[], params: ParamDecl[], at: string): unknown {
    if (where.length === 0) throw new Error(`emit: ${at}: an UPDATE / DELETE endpoint must declare a WHERE`);
    const members = where.map((p) => {
      if (p.kind === 'isNull') return { eq: [{ ref: [p.column] }, null] };
      if (p.kind === 'isNotNull') return { ne: [{ ref: [p.column] }, null] };
      if (p.kind !== undefined && p.kind !== 'compare') {
        throw new Error(
          `emit: ${at}: the write compiler's WHERE vocabulary is eq/ne/lt/le/gt/ge and IS [NOT] NULL ` +
            `(compileWriteNode.lowerWhereMember) — '${p.kind}' is not lowerable on a write.`,
        );
      }
      const cmp = p as ComparePredicate;
      if (cmp.optional === true) {
        throw new Error(`emit: ${at}: a SKIP (optional) predicate is a READ construct — a write's WHERE is fixed.`);
      }
      if (cmp.op === 'like') throw new Error(`emit: ${at}: LIKE is not part of the write compiler's WHERE vocabulary`);
      assertIdentifier(cmp.param, `parameter '${cmp.param}'`);
      params.push({ name: cmp.param, type: this.bindTypeOf(model, cmp.column) });
      return { [cmp.op]: [{ ref: [cmp.column] }, new ParamRef(cmp.param)] };
    });
    return { arr: members };
  }

  // ── BATCH writes ───────────────────────────────────────────────────────────────────────────

  private batch(name: string, endpoint: CreateManyEndpoint | UpdateManyEndpoint | DeleteManyEndpoint): Method {
    if (endpoint.kind === 'deleteMany') return this.deleteMany(name, endpoint);
    const model = endpoint.model;
    assertIdentifier(endpoint.param, `parameter '${endpoint.param}'`);
    const pg = this.spec.dialect === 'postgres';
    const params: ParamDecl[] = [];
    const ports: Record<string, unknown> = { table: tableNameOf(model), batch: 'true' };
    this.returningPorts(model, endpoint.returning, ports);

    // The bind SHAPE is the builder's own: PG's `UNNEST(?::t[], …)` binds ONE ARRAY PER COLUMN, so each
    // column gets its own array parameter; MySQL/SQLite expand ONE record-array JSON param server-side.
    const columnParam = (column: string): ParamRef => {
      if (!pg) return new ParamRef(endpoint.param);
      const p = `${endpoint.param}_${column}`;
      params.push({ name: p, type: `${this.bindTypeOf(model, column)}[]` });
      return new ParamRef(p);
    };

    const columns = endpoint.kind === 'createMany' ? endpoint.columns : [...endpoint.keyColumns, ...endpoint.columns];
    if (endpoint.kind === 'createMany') {
      for (const c of endpoint.columns) ports[`values.${c}`] = columnParam(c);
      if (endpoint.onConflict !== undefined) {
        ports.onConflict = endpoint.onConflict.join(', ');
        ports.onConflictAction = endpoint.onConflictAction ?? 'update';
      }
    } else {
      for (const c of endpoint.keyColumns) ports[`key.${c}`] = columnParam(c);
      for (const c of endpoint.columns) ports[`set.${c}`] = columnParam(c);
    }
    if (!pg) params.push({ name: endpoint.param, type: `${this.recordType(name, model, columns)}[]` });

    const component = endpoint.kind === 'createMany' ? 'Insert' : 'Update';
    const op = compileWriteNode({ component, ports } as Parameters<typeof compileWriteNode>[0], this.spec.dialect, this.resolver(model));
    const rowType = this.writeRowType(name, model, endpoint.returning);
    const slots = op.params.map((p) => (isBatchRowsMarker(p) ? endpoint.param : renderSlot(p)));
    const out = freshNames(params.map((p) => p.name))('rows');
    return {
      name,
      params,
      returnType: `${rowType}[]`,
      lines: [
        `const ${out}: ${rowType}[] = Db.executeSQL(${quote(op.sql)}, [${slots.join(', ')}]${execOptions({ write: { returning: endpoint.returning !== undefined } })}) as ${rowType}[];`,
        `return ${out};`,
      ],
    };
  }

  /**
   * `deleteMany` — a key-set DELETE. Its WHERE is the `in` member of the write compiler's own WHERE
   * vocabulary, which lowers to the SAME static single-param membership predicate a read IN-list uses
   * (`json-array.inListPredicate`) — so the statement text, the RETURNING tail and the mysql pk hint
   * all come from `compileWriteNode`, not from here.
   */
  private deleteMany(name: string, endpoint: DeleteManyEndpoint): Method {
    const model = endpoint.model;
    assertIdentifier(endpoint.param, `parameter '${endpoint.param}'`);
    const params: ParamDecl[] = [{ name: endpoint.param, type: `${this.bindTypeOf(model, endpoint.keyColumn)}[]` }];
    const ports: Record<string, unknown> = {
      table: tableNameOf(model),
      where: { arr: [{ in: [{ ref: [endpoint.keyColumn] }, new ParamRef(endpoint.param)] }] },
    };
    this.returningPorts(model, endpoint.returning, ports);
    const op = compileWriteNode({ component: 'Delete', ports } as Parameters<typeof compileWriteNode>[0], this.spec.dialect, this.resolver(model));
    const rowType = this.writeRowType(name, model, endpoint.returning);
    const out = freshNames(params.map((p) => p.name))('rows');
    return {
      name,
      params,
      returnType: `${rowType}[]`,
      lines: [
        `const ${out}: ${rowType}[] = Db.executeSQL(${quote(op.sql)}, [${op.params.map(renderSlot).join(', ')}]${execOptions({ write: { returning: endpoint.returning !== undefined } })}) as ${rowType}[];`,
        `return ${out};`,
      ],
    };
  }

  /**
   * Declare the `returning` + `pk` ports a RETURNING write needs. The key is the model's DECLARATION
   * (`@column({ primaryKey, autoIncrement })`) — a dialect with no native RETURNING recovers the
   * written rows from it. ONE place, shared by the single-row and batch write paths.
   */
  private returningPorts(model: ModelClassLike, returning: readonly string[] | undefined, ports: Record<string, unknown>): void {
    if (returning === undefined) return;
    ports.returning = returning.join(', ');
    const pkey = getPrimaryKey(model);
    ports.pk = pkey.columns.join(',');
    if (pkey.autoInc !== null) ports.autoInc = pkey.autoInc;
  }

  /** A write's row type: the uniform transport summary, or the declared RETURNING projection. */
  private writeRowType(name: string, model: ModelClassLike, returning: readonly string[] | undefined): string {
    if (returning === undefined) return this.writeSummaryType();
    return this.declareInterface(
      `${cap1(name)}Row`,
      objOf(deriveReadRow(tableNameOf(model), returning, this.resolver(model), `endpoint '${name}' RETURNING`).outType, name),
    );
  }

  /** The record type a MySQL/SQLite batch write's JSON param carries (one field per bound column). */
  private recordType(name: string, model: ModelClassLike, columns: readonly string[]): string {
    const obj: Record<string, PortableType> = {};
    for (const c of columns) obj[c] = sqlTypeToBcScalar(this.sqlTypeOf(model, c));
    return this.declareInterface(`${cap1(name)}Record`, obj);
  }

  // ── WHERE → the builders' ConditionObject ──────────────────────────────────────────────────

  /** Declare the method parameters ONE predicate contributes (in declaration order). */
  private declareWhereParams(model: ModelClassLike, p: Predicate, params: ParamDecl[]): void {
    if (p.kind === 'exists' || p.kind === 'subquery') {
      for (const m of p.match) {
        if (m.param === undefined) continue;
        assertIdentifier(m.param, `parameter '${m.param}'`);
        params.push({ name: m.param, type: this.bindTypeOf(p.model, m.column) });
      }
      return;
    }
    if (p.kind === 'tupleIn') {
      params.push(...this.tupleInParams(model, p));
      return;
    }
    if (!isParameterised(p)) return; // IS [NOT] NULL binds nothing
    assertIdentifier(p.param, `parameter '${p.param}'`);
    const base = this.bindTypeOf(model, p.column);
    const type = p.kind === 'in' ? `${base}[]` : base;
    params.push({ name: p.param, type: p.optional === true ? `${type} | null` : type });
  }

  /**
   * Build the `ConditionObject` the surviving compilers consume. Every member is v1 condition
   * vocabulary — a bare column key (equality / IS NULL), a custom-operator key carrying its own `?`
   * (the comparison + membership forms), or a `DBExists` / `DBSubquery` token — so the WHERE text is
   * produced by `DBConditions` exactly as the imperative path produces it.
   */
  private conditions(model: ModelClassLike, where: readonly Predicate[]): ConditionObject {
    const out: Record<string, ConditionValue> = {};
    let n = 0;
    const put = (key: string, value: ConditionValue): void => {
      // The condition object is keyed BY THE SQL FRAGMENT, so two identical fragments would collapse
      // into one. A repeat gets trailing spaces, which `DBConditions` emits verbatim (SQL-insignificant).
      let k = key;
      while (k in out) k = `${key}${' '.repeat(++n)}`;
      out[k] = value;
    };
    for (const p of where) {
      if (p.kind === 'isNull') {
        put(p.column, null);
        continue;
      }
      if (p.kind === 'isNotNull') {
        put(`${p.column} IS NOT NULL`, true);
        continue;
      }
      if (p.kind === 'exists') {
        put('__exists__', new DBExists(tableNameOf(p.model), this.correlation(p, model), p.not === true) as unknown as ConditionValue);
        continue;
      }
      if (p.kind === 'subquery') {
        const parentTable = tableNameOf(model);
        const sub = new DBSubquery(
          p.columns.map((c) => ({ tableName: parentTable, columnName: c })),
          tableNameOf(p.model),
          p.select.map((c) => ({ tableName: tableNameOf(p.model), columnName: c })),
          this.correlation(p, model),
          p.not === true ? 'NOT IN' : 'IN',
        );
        put('__subquery__', sub as unknown as ConditionValue);
        continue;
      }
      if (p.kind === 'in') {
        put(inListPredicate(this.spec.dialect, p.column), new ParamRef(p.param) as unknown as ConditionValue);
        continue;
      }
      if (p.kind === 'tupleIn') {
        // The predicate carries its own `?`s (one per array param on PG, one JSON param elsewhere), so
        // it rides `DBConditions`' custom-operator route: the value list fills them positionally.
        put(
          tupleInPredicate(this.spec.dialect, tableNameOf(model), p.columns, this.pgElementTypes(model, p.columns)),
          this.tupleInParams(model, p).map((d) => new ParamRef(d.name)) as unknown as ConditionValue,
        );
        continue;
      }
      const cmp = p as ComparePredicate;
      const ref = new ParamRef(cmp.param) as unknown as ConditionValue;
      if (cmp.op === 'eq') put(cmp.column, ref);
      else put(`${cmp.column} ${SQL_OPS[cmp.op]} ?`, ref);
    }
    return out as ConditionObject;
  }

  /**
   * The PG `UNNEST` element type of each key column, derived from the model's DECLARED column type via
   * the SAME schema specimen the batch writes use (`pgTypeSpecimen` → `inferPgArrayType`) — never from
   * the values, which are unknown at emit time and empty at call time often enough to matter.
   */
  private pgElementTypes(model: ModelClassLike, columns: readonly string[]): readonly string[] | undefined {
    if (this.spec.dialect !== 'postgres') return undefined;
    return columns.map((c) => inferPgArrayType([pgTypeSpecimen(this.sqlTypeOf(model, c))]));
  }

  /**
   * A composite `tupleIn`'s parameters, in bind order — the ONE derivation both the signature and the
   * condition value consume. PostgreSQL's `UNNEST(?::T1, ?::T2)` binds ONE ARRAY PER KEY COLUMN;
   * MySQL / SQLite bind ONE JSON array of tuples.
   */
  private tupleInParams(model: ModelClassLike, p: TupleInPredicate): ParamDecl[] {
    assertIdentifier(p.param, `parameter '${p.param}'`);
    if (p.columns.length < 2) {
      throw new Error(`emit: a 'tupleIn' predicate needs at least two key columns (got ${p.columns.length}) — use 'in' for a single column`);
    }
    if (this.spec.dialect === 'postgres') {
      return p.columns.map((c) => ({ name: `${p.param}_${c}`, type: `${this.bindTypeOf(model, c)}[]` }));
    }
    const elements = [...new Set(p.columns.map((c) => this.bindTypeOf(model, c)))];
    const element = elements.length === 1 ? elements[0] : `(${elements.join(' | ')})`;
    return [{ name: p.param, type: `${element}[][]` }];
  }

  /** The subquery / EXISTS correlation terms: a parent-column ref (`parentRef` sugar) or a bound param. */
  private correlation(p: ExistsPredicate | SubqueryPredicate, parent: ModelClassLike): SubqueryCondition[] {
    const subTable = tableNameOf(p.model);
    const parentTable = tableNameOf(parent);
    return p.match.map((m: CorrelationTerm) => {
      const column: ColumnRef = { tableName: subTable, columnName: m.column };
      // Fail closed on an unknown column on either side (the correlation must name declared columns).
      this.sqlTypeOf(p.model, m.column);
      if (m.parentColumn !== undefined) {
        this.sqlTypeOf(parent, m.parentColumn);
        return { column, value: new DBParentRef({ tableName: parentTable, columnName: m.parentColumn }) };
      }
      return { column, value: new ParamRef(m.param as string) };
    });
  }

  // ── type declarations ──────────────────────────────────────────────────────────────────────

  /** The uniform non-RETURNING write summary the `executeSQL` transport returns. */
  private writeSummaryType(): string {
    return this.declareInterface('WriteSummary', { changes: 'int', lastInsertRowid: 'int' });
  }

  /** Declare (or reuse) a row interface. Two declarations of the same name must be structurally equal. */
  private declareInterface(name: string, obj: Record<string, PortableType>): string {
    const body = Object.entries(obj)
      .map(([k, t]) => `  ${propName(k)}: ${this.tsType(t, `${name}_${k}`)};`)
      .join('\n');
    const existing = this.interfaces.get(name);
    if (existing !== undefined && existing !== body) {
      throw new Error(`emit: two different row shapes both want the interface name '${name}'`);
    }
    this.interfaces.set(name, body);
    return name;
  }

  /** A `PortableType` → its TS type text, declaring a nested interface for an embedded object. */
  private tsType(t: PortableType, nameHint: string): string {
    if (typeof t === 'string') return tsScalar(t as BcScalar);
    if ('opt' in t) return `${this.tsType(t.opt as PortableType, nameHint)} | null`;
    if ('arr' in t) return `${this.tsType(t.arr as PortableType, nameHint)}[]`;
    if ('obj' in t) return this.declareInterface(cap1(nameHint), t.obj as Record<string, PortableType>);
    throw new Error(`emit: portable type ${JSON.stringify(t)} has no TS rendering`);
  }

  // ── module rendering ───────────────────────────────────────────────────────────────────────

  render(methods: readonly Method[]): string {
    const text = [...this.interfaces.values(), ...methods.flatMap((m) => [...m.lines, ...m.params.map((p) => p.type)])].join('\n');
    const typeImports = ['Int', 'Float', 'WireValue'].filter((s) => new RegExp(`\\b${s}\\b`).test(text));
    const head = [
      `// GENERATED by litedbmodel \`emitBehaviorModule\` — the decorator → SCP lowering. DO NOT EDIT.`,
      `//`,
      `// Read by \`bc generate --from\`: each \`@behavior static\` method is one declared endpoint, its`,
      `// parameters are the input ports and its return type is the output contract. The SQL is the`,
      `// ${this.spec.dialect} text the litedbmodel \`makesql\` builders produced; the transports are the`,
      `// library's ONE \`@leaf\` catalog (\`Db\`).`,
      `import { behavior${typeImports.length > 0 ? `, type ${typeImports.join(', type ')}` : ''} } from 'behavior-contracts';`,
      `import { Db } from ${quote(this.spec.leafImport)};`,
      ``,
    ];
    const decls = [...this.interfaces].map(([name, body]) => `interface ${name} {\n${body}\n}`);
    const body = methods.map((m) => {
      const sig = m.params.map((p) => `${p.name}: ${p.type}`).join(', ');
      return `  @behavior static ${m.name}(${sig}): ${m.returnType} {\n${m.lines.map((l) => `    ${l}`).join('\n')}\n  }`;
    });
    return `${head.join('\n')}${decls.join('\n\n')}\n\nexport class ${this.spec.behavior} {\n${body.join('\n\n')}\n}\n`;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

/** The SQL comparison text of each declared comparison operator (the v1 custom-operator key form). */
const SQL_OPS: Readonly<Record<Exclude<ComparePredicate['op'], 'eq'>, string>> = {
  ne: '!=',
  lt: '<',
  le: '<=',
  gt: '>',
  ge: '>=',
  like: 'LIKE',
};

/** A predicate that BINDS a parameter of its own (so it can be a SKIP member). */
function isParameterised(p: Predicate): p is ComparePredicate | InPredicate {
  return p.kind === undefined || p.kind === 'compare' || p.kind === 'in';
}

/** A SKIP member: a parameterised predicate declared `optional` — present-or-absent PER CALL. */
type OptionalPredicate = (ComparePredicate | InPredicate) & { readonly optional: true };

/** A predicate is a SKIP member when it declares `optional` (only a parameterised member can be one). */
function isOptional(p: Predicate): p is OptionalPredicate {
  return isParameterised(p) && p.optional === true;
}

/**
 * Render the OPTIONAL `opts` argument of `Db.executeSQL` — the ONE place the option record
 * ({@link import('../leaf-transport').ExecOptions}) is spelled, for every emitted statement of every op.
 *
 * A statement that carries NO option at all (a bounded read, an uncapped relation child) renders
 * NOTHING: the port is omitted and the payload stays `sql` + `params` (native-clean). Any other
 * statement spells the WHOLE record — bc types a port by the literal wired into it and rejects a
 * partial one — so each absent fact is the `null` VALUE of its own NAMED field. That is what removed
 * the positional filler #193 is about: nothing has to be passed to reach the field after it.
 *
 * `write` carries the write's own `returning`, so "returns rows but is not a write" is not
 * expressible at the only place the record is built.
 */
function execOptions(o: {
  /** The statement WRITES, and whether that write yields ROWS (absent ⇒ a read). */
  readonly write?: { readonly returning: boolean };
  /** The rendered DYNAMIC (SKIP) plan expression (absent ⇒ the read declares no optional predicate). */
  readonly whereDynamic?: string;
  /** The rendered relation cap expression (absent ⇒ the fetch is uncapped). */
  readonly guard?: string;
}): string {
  if (o.write === undefined && o.whereDynamic === undefined && o.guard === undefined) return '';
  return `, { write: ${o.write !== undefined}, returning: ${o.write?.returning === true}, whereDynamic: ${o.whereDynamic ?? 'null'}, guard: ${o.guard ?? 'null'} }`;
}

/**
 * Render ONE bound slot: a parameter sentinel becomes its identifier, anything else a TS literal.
 *
 * A batch write's slot is one of `compileWriteNode`'s BATCH MARKERS rather than a bare sentinel: the
 * PostgreSQL `UNNEST` form binds one `{__batchArray:{column, ref}}` per column (the sentinel is its
 * `ref`), the MySQL/SQLite JSON form binds the SAME `{__batchRows:{…}}` to every `?` (see
 * {@link batchRowsSlot}). Both are unwrapped to the parameter they stand for.
 */
function renderSlot(slot: unknown): string {
  if (slot instanceof ParamRef) return slot.expr;
  const ref = (slot as { __batchArray?: { ref?: unknown } })?.__batchArray?.ref;
  if (ref instanceof ParamRef) return ref.expr;
  return JSON.stringify(slot);
}

/** The MySQL/SQLite batch marker `compileWriteNode` binds to every `?` of a batch statement. */
function isBatchRowsMarker(p: unknown): boolean {
  return typeof p === 'object' && p !== null && '__batchRows' in (p as Record<string, unknown>);
}

/** A QUERY view-model's CTE (v1 `WITH <alias> AS (<query>)`, its own params bound FIRST). */
function cteOf(view: NonNullable<ReadEndpoint['view']>): SelectDesc['cte'] {
  const alias = view.alias ?? 'derived';
  const q = view.query;
  return typeof q === 'string' ? { name: alias, sql: q, params: [] } : { name: alias, sql: q.sql, params: [...q.params] };
}

/** The row `obj` of a `{arr:{obj:…}}` read row type. */
function objOf(t: PortableType, at: string): Record<string, PortableType> {
  const arr = typeof t === 'object' && t !== null && 'arr' in t ? (t.arr as PortableType) : undefined;
  const obj = arr !== undefined && typeof arr === 'object' && arr !== null && 'obj' in arr ? (arr.obj as Record<string, PortableType>) : undefined;
  if (obj === undefined) throw new Error(`emit: ${at}: expected a row type {arr:{obj:…}}, got ${JSON.stringify(t)}`);
  if (Object.keys(obj).length === 0) {
    throw new Error(`emit: ${at}: the projection resolved to an EMPTY row type — every projected column must be a declared @column`);
  }
  return obj;
}

/** bc scalar → TS type text (`Int`/`Float` are bc's branded numeric declarations). */
function tsScalar(s: BcScalar): string {
  switch (s) {
    case 'int':
      return 'Int';
    case 'float':
      return 'Float';
    case 'bool':
      return 'boolean';
    case 'null':
      return 'null';
    case 'string':
      return 'string';
  }
}

function normalizeSelections(sels: readonly RelationSelection[]): { name: string; with: readonly RelationSelection[] }[] {
  return sels.map((s) => (typeof s === 'string' ? { name: s, with: [] } : { name: s.name, with: s.with ?? [] }));
}

/**
 * A body-binding name allocator. `reserved` holds the method's PARAMETER names: a `const` that shadowed
 * a parameter would be a TDZ error the moment the parameter is also bound (`const rows = f(rows)`), so
 * the allocator never hands one out.
 */
function freshNames(reserved: readonly string[] = []): (base: string) => string {
  const used = new Map<string, number>(reserved.map((r) => [r, 1]));
  return (base) => {
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}${n}`;
  };
}

function quote(s: string): string {
  return JSON.stringify(s);
}

function jsonArray(items: readonly string[]): string {
  return `[${items.map(quote).join(', ')}]`;
}

function cap1(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/[^A-Za-z0-9_]/g, '_');
}

/** An object-literal property name: bare when it is an identifier, quoted otherwise. */
function propName(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : quote(k);
}

function assertIdentifier(name: string, at: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`emit: ${at} is not a valid TypeScript identifier`);
  }
}
