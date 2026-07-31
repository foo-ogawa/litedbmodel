import type { DefineEmbedFn, QueryResult } from 'embedoc';
import { ORM_SERIES, LITEDBMODEL_SERIES } from '../benchmark/orm-series.js';

// NOTE: two things this directory needs to load at all, both load-bearing for the bench-docs drift gate:
//
//  1. `embeds/package.json` (`"type": "module"`) — embedoc loads embeds via tsx `tsImport`. Without the
//     ESM marker tsx takes the ESM->CJS bridge, which cannot reach `../benchmark/orm-series` — the series
//     SSoT this file and the chart renderer both read. There the `.js` specifier fails to resolve at all
//     ("Cannot find module '../benchmark/orm-series.js'", require stack embeds/index.ts), and dropping the
//     extension resolves the `.ts` file but hands it to node untranspiled ("Unexpected identifier 'as'" on
//     `as const`). On the ESM path tsx transpiles the whole graph and the import loads.
//
//  2. Local `defineEmbed` — importing the *value* `defineEmbed` from the `embedoc` package fails under
//     tsx's resolver ("No exports main defined"). `defineEmbed` is just an identity/typing helper
//     (`(d) => d`), so we inline it and pull only the *type* from embedoc (type imports are erased, no
//     runtime resolution).

const defineEmbed: DefineEmbedFn = (definition) => definition;

/**
 * The benchmark CSV, grouped by operation → (series → median ms). A datasource record is untyped, so
 * every cell this reads is checked: a missing or unparseable Operation / ORM / Median is a broken CSV
 * and stops the build. The published numbers are machine-derived, so an unreadable cell must never be
 * allowed to become a plausible-looking zero.
 */
function groupByOperation(records: QueryResult): Map<string, Map<string, number>> {
  const byOperation = new Map<string, Map<string, number>>();
  records.forEach((record, index) => {
    const operation = record['Operation'];
    const orm = record['ORM'];
    const medianCell = record['Median'];
    const median = typeof medianCell === 'string' && medianCell.trim() !== '' ? Number(medianCell) : NaN;
    if (typeof operation !== 'string' || typeof orm !== 'string' || !Number.isFinite(median)) {
      throw new Error(`benchmark_results row ${index + 1} is not a benchmark row: ${JSON.stringify(record)}`);
    }
    if (!byOperation.has(operation)) byOperation.set(operation, new Map());
    byOperation.get(operation)!.set(orm, median);
  });
  return byOperation;
}

/** The fastest median in an operation (ties resolved by the caller within 0.01ms). */
function fastestValue(orms: Map<string, number>): number {
  return Math.min(...orms.values());
}

const benchmarkTable = defineEmbed({
  dependsOn: ['benchmark_results'],

  async render(ctx) {
    const byOperation = groupByOperation(await ctx.datasources['benchmark_results']!.query(''));

    const tableRows: string[][] = [];
    for (const [op, orms] of byOperation) {
      const min = fastestValue(orms);
      const row: string[] = [op];
      for (const orm of ORM_SERIES) {
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

    const markdown = ctx.markdown.table(['Operation', ...ORM_SERIES], tableRows);
    return { content: markdown };
  },
});

const benchmarkSummary = defineEmbed({
  dependsOn: ['benchmark_results'],

  // The "fastest in N of M ops" headline — COMPUTED from the same CSV, never hand-written (a hand-typed
  // count drifts out of sync the moment the data is re-run). litedbmodel "wins" an op when either of its
  // two modes (runtime/codegen) has the fastest median (ties within 0.01ms count as a win).
  async render(ctx) {
    const byOperation = groupByOperation(await ctx.datasources['benchmark_results']!.query(''));

    let wins = 0;
    const total = byOperation.size;
    for (const orms of byOperation.values()) {
      const min = fastestValue(orms);
      const winsHere = LITEDBMODEL_SERIES.some((o) => {
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
