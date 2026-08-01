// ════════════════════════════════════════════════════════════════════════════
// Cross-language benchmark CASE/DIALECT CONSTANTS — the axis SSoT
// ════════════════════════════════════════════════════════════════════════════
//
// SINGLE source of truth for the axes every language runs: the 19 ORM-comparison
// ops (== the v1 SQL golden == v2 SCP parity == benchmark.ts litedbmodel
// column) × the three real dialects. Each language executes the SAME ops driver-
// included on all three real DBs (SQLite in-proc, MySQL :3307, PostgreSQL :5433).
//
// There is NO wire protocol. Each language is a STANDALONE process that runs all 19
// ops × 3 dialects, self-measures, and writes a flat CSV
// (`cell,dialect,op,iter,us,rows`) to benchmark/crosslang/results/. `run-cells.sh` is
// the reproducible run; `results/aggregate.mjs` renders the report from those CSVs.
//
// This file is pure constants — the op/dialect axes only. It carries NO SQL and NO
// artifact: the per-op, per-dialect SQL is emitted by BC codegen as native literals
// (see benchmark/crosslang/REBUILD.md, epic #107). It must never import a baked-SQL
// plan artifact.

// ── Dialects (the three real targets) ─────────────────────────────────────────
export const ORM_DIALECTS = ['sqlite', 'mysql', 'postgres'] as const;
export type OrmDialect = (typeof ORM_DIALECTS)[number];

// ── Op INPUTS — the constants every cell binds ────────────────────────────────
//
// SQL is a property of the dialect and comes from the generated module (`ops`, captured by
// `lm_orm_native sql`). The INPUTS are the other half of "the same work": a statement bound to a
// different value reads different rows, or the same rows for a different reason. They cannot be
// captured — they are what the cells SUPPLY — so they are DECLARED here, beside the op identity they
// belong to, and `emit-setup.ts` writes them into `.setup/<dialect>.json` as `inputs`. Every cell
// binds those; none declares its own.
//
// Before this, nine cells each spelled them out (5 languages × native/sdk, TypeScript sharing one
// across its three modes) and two had already drifted apart with every gate green (#172):
//   - `findUnique` ran on `user500@example.com` in go/TypeScript and `user1@example.com` in
//     rust-native/python/php — and rust's own two cells disagreed with EACH OTHER;
//   - `updateMany` sent `Many 1…Many 10` from every native cell and `Many 0…Many 9` from every SDK
//     cell but TypeScript's.
// Both move the same NUMBER of rows, so rows/op parity — the only cross-cell check there was —
// passed on every one of them.
//
// Values are JSON scalars and records; `{it}` is the ONE substitution a cell makes (the iteration
// number), so an op with a UNIQUE column stays insertable in a timed loop. It is a token, not an
// expression: the cells hold no template language.

/** One batch record — the column→value map a batch write's `rows` input carries. */
export interface OrmOpInputRecord {
  readonly [column: string]: string | number;
}
/** One named input: a scalar, or a batch write's record set. */
export type OrmOpInputValue = string | number | readonly OrmOpInputRecord[];
/** One op's whole input scope, keyed by the parameter names `native-model.ts` declares. */
export interface OrmOpInput {
  readonly [name: string]: OrmOpInputValue;
}

/** The 10 records `createMany` / `upsertMany` write. `stable` reuses fixed emails, so `upsertMany`
 *  conflict-updates the SAME rows every iteration; otherwise the email varies by iteration and a
 *  plain INSERT stays insertable under `UNIQUE(email)`. */
const userRows = (stable: boolean): readonly OrmOpInputRecord[] =>
  Array.from({ length: 10 }, (_, i) => ({
    email: stable ? `many${i}@bench.com` : `many{it}_${i}@bench.com`,
    name: `Many ${i}`,
  }));

/** The 10 records `updateMany` writes — keyed on the seeded users 1..10 (`orm-domain.ts` seeds them). */
const userPatches = (): readonly OrmOpInputRecord[] =>
  Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `Many ${i + 1}` }));

// ── The 19 ORM ops (== benchmark.ts testCategories) ─
// Order + labels mirror benchmark/benchmark.ts exactly. `write` marks the ops whose
// logical op mutates (they run inside a transaction: BEGIN … COMMIT).
export interface OrmOpMeta {
  readonly id: string; // stable slug (protocol id)
  readonly label: string; // the human label (== benchmark.ts / golden op key)
  readonly write: boolean;
  /**
   * The values every cell binds for this op, keyed by the parameter names the authored `@behavior`
   * declares (`native-model.ts`) — which is also the input Scope the literal emitters take. A read
   * with no input ports declares `{}`.
   */
  readonly input: OrmOpInput;
}

export const ORM_OPS: readonly OrmOpMeta[] = [
  { id: 'findAll', label: 'Find all (limit 100)', write: false, input: {} },
  { id: 'filterPaginateSort', label: 'Filter, paginate & sort', write: false, input: { published: 1 } },
  { id: 'nestedFindAll', label: 'Nested find all (include posts)', write: false, input: {} },
  { id: 'findFirst', label: 'Find first', write: false, input: { name: 'User%' } },
  { id: 'nestedFindFirst', label: 'Nested find first (include posts)', write: false, input: { name: 'User%' } },
  // `user500@example.com` is the value the fixture is BUILT to answer — `orm-domain.ts` seeds user 500
  // for it by name ("the ops' fixed inputs (`id = 1`, `user500@example.com`, ids 1..10 …) always
  // resolve") and the ORM-vs-ORM column this op is compared against reads the same row
  // (`benchmark/benchmark.ts`, "Find unique (by email)"). go and TypeScript already bound it; rust's
  // native cell, python and php had drifted to `user1@example.com`.
  { id: 'findUnique', label: 'Find unique (by email)', write: false, input: { email: 'user500@example.com' } },
  // The NESTED read takes user 1, not user 500: only users 1..`nestedUsers` carry the deep post+comment
  // graph this op exists to traverse (`orm-domain.ts` seedTables), so user 500 would measure a
  // five-post user through a relation path built for ten posts plus their comments.
  { id: 'nestedFindUnique', label: 'Nested find unique (include posts)', write: false, input: { email: 'user1@example.com' } },
  { id: 'create', label: 'Create', write: true, input: { email: 'new{it}@bench.com', name: 'New' } },
  { id: 'nestedCreate', label: 'Nested create (with post)', write: true, input: { email: 'nc{it}@bench.com', name: 'NC', title: 'NC Post' } },
  { id: 'update', label: 'Update', write: true, input: { id: 1, name: 'Updated 1' } },
  { id: 'nestedUpdate', label: 'Nested update (update user + post)', write: true, input: { id: 1, name: 'NU', title: 'NU Post' } },
  { id: 'upsert', label: 'Upsert', write: true, input: { email: 'user1@example.com', name: 'Upserted One' } },
  { id: 'nestedUpsert', label: 'Nested upsert (user + post)', write: true, input: { email: 'user1@example.com', name: 'NUp', title: 'NUp Post' } },
  { id: 'delete', label: 'Delete', write: true, input: { email: 'del{it}@bench.com', name: 'Del' } },
  { id: 'createMany', label: 'Create Many (10 records)', write: true, input: { rows: userRows(false) } },
  { id: 'upsertMany', label: 'Upsert Many (10 records)', write: true, input: { rows: userRows(true) } },
  { id: 'updateMany', label: 'Update Many (10 different values)', write: true, input: { rows: userPatches() } },
  { id: 'nestedRelations', label: 'Nested relations (100->1000->10000)', write: false, input: {} },
  { id: 'compositeRelations', label: 'Nested relations (composite key, 5 tenants)', write: false, input: {} },
] as const;

export const ORM_OP_IDS: readonly string[] = ORM_OPS.map((o) => o.id);
export const ORM_WRITE_OP_IDS: ReadonlySet<string> = new Set(ORM_OPS.filter((o) => o.write).map((o) => o.id));
export const ORM_OP_LABEL: Record<string, string> = Object.fromEntries(ORM_OPS.map((o) => [o.id, o.label]));
/** Every op's input scope — what `emit-setup.ts` writes into `.setup/<dialect>.json` as `inputs`. */
export const ORM_OP_INPUT: Record<string, OrmOpInput> = Object.fromEntries(ORM_OPS.map((o) => [o.id, o.input]));

// ── The op axis — the 19 ORM-comparison ops (no subset) ──────────────────────
export const CROSSLANG_CASE_IDS = ORM_OP_IDS;
export type CrosslangCaseId = string;
export const CROSSLANG_CASE_LABELS: Record<string, string> = ORM_OP_LABEL;

// Ops whose logical op is a WRITE (the report tags these `W`, reads `R`).
export const CROSSLANG_WRITE_CASES: ReadonlySet<string> = ORM_WRITE_OP_IDS;

// ── The dialect axis (the three real targets) ────────────────────────────────
export const CROSSLANG_DIALECTS = ORM_DIALECTS;
export type CrosslangDialect = OrmDialect;
