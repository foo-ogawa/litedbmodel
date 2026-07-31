// ════════════════════════════════════════════════════════════════════════════
// ORM-comparison SERIES axis — the SSoT
// ════════════════════════════════════════════════════════════════════════════
//
// SINGLE source of truth for the series axis of the ORM-vs-ORM bench: the `ORM` values that appear in
// benchmark/results/benchmark-results.csv, the order the generated docs display them in, which of them
// are litedbmodel's own, and which one every other series is measured against.
//
// `benchmark.ts` labels its CSV rows from here, `generate-chart.ts` draws them and `embeds/index.ts`
// tabulates them — one edit renames a series everywhere. A series name that lives in more than one of
// those files is a name that can be renamed in one and left stale in the others.
//
// Pure constants — names, order and the baseline only. Colours belong to the chart renderer.

/** litedbmodel v2's imperative DBModel path: builds its SQL per call. */
export const LITEDBMODEL_RUNTIME = 'litedbmodel (runtime)';
/** litedbmodel v2's bc-generated static module: the same authored @behavior source, compiled. */
export const LITEDBMODEL_CODEGEN = 'litedbmodel (codegen)';

/** The ORMs litedbmodel is measured against. */
export const KYSELY = 'Kysely';
export const DRIZZLE = 'Drizzle';
export const TYPEORM = 'TypeORM';
export const PRISMA = 'Prisma';

/** Every measured series, in the order the generated table and chart display them. */
export const ORM_SERIES = [
  LITEDBMODEL_RUNTIME,
  LITEDBMODEL_CODEGEN,
  KYSELY,
  DRIZZLE,
  TYPEORM,
  PRISMA,
] as const;

export type OrmSeries = (typeof ORM_SERIES)[number];

/** litedbmodel's own series — its two v2 execution modes, both charted, never collapsed to one number. */
export const LITEDBMODEL_SERIES: readonly OrmSeries[] = [LITEDBMODEL_RUNTIME, LITEDBMODEL_CODEGEN];

/**
 * The series the chart normalises against: every bar is `median / baseline median` of the SAME
 * operation, so this series reads 1.00x in every operation and the others read as multiples of it.
 */
export const BASELINE_SERIES: OrmSeries = LITEDBMODEL_RUNTIME;
