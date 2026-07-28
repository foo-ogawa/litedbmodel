import type { DefineEmbedFn } from 'embedoc';

// NOTE: this embed is defined inline in index.ts (the embedoc entry file) and
// declares its own `defineEmbed` helper on purpose:
//
//  1. Single file — embedoc loads embeds via tsx `tsImport`, and in this
//     environment a transitively-imported `.ts` file (e.g.
//     `import x from './benchmark_table.ts'`) is NOT transpiled by tsx on the
//     ESM->CJS bridge path — node then parses the raw TypeScript and fails on
//     TS-only syntax ("Unexpected strict mode reserved word" on `interface`).
//     Keeping the single embed in the entry file (which tsx DOES transform)
//     makes the drift gate load.
//
//  2. Local `defineEmbed` — importing the *value* `defineEmbed` from the
//     `embedoc` package fails under tsx's resolver ("No exports main defined").
//     `defineEmbed` is just an identity/typing helper (`(d) => d`), so we
//     inline it and pull only the *type* from embedoc (type imports are erased,
//     no runtime resolution).

const defineEmbed: DefineEmbedFn = (definition) => definition;

interface BenchmarkRow {
  Operation: string;
  ORM: string;
  Median: string;
  IQR: string;
  StdDev: string;
  Min: string;
  Max: string;
  Iterations: string;
}

// The ORM columns, in display order. The CSV carries litedbmodel's two v2 execution modes as separate
// series (runtime = the imperative DBModel path; codegen = the bc-generated static module), so BOTH are
// shown — never collapsed to a hand-picked single number. Header labels are keyed to the CSV `ORM` values.
const ORM_ORDER = [
  'litedbmodel (runtime)',
  'litedbmodel (codegen)',
  'Kysely',
  'Drizzle',
  'TypeORM',
  'Prisma',
] as const;
const LITEDBMODEL_ORMS = ['litedbmodel (runtime)', 'litedbmodel (codegen)'];

/** Group the CSV rows by operation → (ORM → median ms). */
function groupByOperation(rows: BenchmarkRow[]): Map<string, Map<string, number>> {
  const byOperation = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!byOperation.has(row.Operation)) byOperation.set(row.Operation, new Map());
    byOperation.get(row.Operation)!.set(row.ORM, parseFloat(row.Median));
  }
  return byOperation;
}

/** The fastest median in an operation (ties resolved by the caller within 0.01ms). */
function fastestValue(orms: Map<string, number>): number {
  return Math.min(...orms.values());
}

const benchmarkTable = defineEmbed({
  dependsOn: ['benchmark_results'],

  async render(ctx) {
    const rows = await ctx.datasources['benchmark_results']!.query('') as BenchmarkRow[];
    const byOperation = groupByOperation(rows);

    const tableRows: string[][] = [];
    for (const [op, orms] of byOperation) {
      const min = fastestValue(orms);
      const row: string[] = [op];
      for (const orm of ORM_ORDER) {
        const val = orms.get(orm);
        if (val === undefined) {
          row.push('N/A');
        } else {
          const formatted = `${val.toFixed(2)}ms`;
          // Mark the fastest cell (ties within 0.01ms share the trophy).
          row.push(Math.abs(val - min) < 0.01 ? `**${formatted}** 🏆` : formatted);
        }
      }
      tableRows.push(row);
    }

    const markdown = ctx.markdown.table(['Operation', ...ORM_ORDER], tableRows);
    return { content: markdown };
  },
});

const benchmarkSummary = defineEmbed({
  dependsOn: ['benchmark_results'],

  // The "fastest in N of M ops" headline — COMPUTED from the same CSV, never hand-written (a hand-typed
  // count drifts out of sync the moment the data is re-run). litedbmodel "wins" an op when either of its
  // two modes (runtime/codegen) has the fastest median (ties within 0.01ms count as a win).
  async render(ctx) {
    const rows = await ctx.datasources['benchmark_results']!.query('') as BenchmarkRow[];
    const byOperation = groupByOperation(rows);

    let wins = 0;
    const total = byOperation.size;
    for (const orms of byOperation.values()) {
      const min = fastestValue(orms);
      const winsHere = LITEDBMODEL_ORMS.some((o) => {
        const v = orms.get(o);
        return v !== undefined && Math.abs(v - min) < 0.01;
      });
      if (winsHere) wins++;
    }

    return { content: `litedbmodel is the fastest ORM in **${wins} of ${total}** benchmarked operations.` };
  },
});

// embedoc expects `embeds` export
export const embeds = {
  benchmark_table: benchmarkTable,
  benchmark_summary: benchmarkSummary,
};

// For direct import compatibility
export default { embeds };
