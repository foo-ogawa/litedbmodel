import type { DefineEmbedFn } from 'embedoc';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ── code_snippet: embed a live region of a source file into the docs ──────────
//
// The formal spec (docs/architecture.md) QUOTES load-bearing signatures (the leaf
// transport, the Endpoint union). Those must never be hand-copied — they drift the
// moment the code changes. This embed reads the ACTUAL source and splices the region
// verbatim, so `npx embedoc build` (the bench-docs-drift CI job) regenerates it and
// fails on any divergence from the source. It THROWS when the file or the requested
// region is gone — so renaming/removing an embedded symbol is a loud build failure,
// a second line of defense alongside scripts/check-spec-refs.mjs.
//
// Params (marker attributes):
//   file        repo-relative source path (required)
//   grep        emit every line matching this regex (e.g. `@leaf static`)
//   block_start emit from the first line matching this regex …
//   block_end   … through the first subsequent line matching this regex (inclusive)
//   lang        fence language (default: ts)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Strip the common leading indentation from a set of lines (readability; drift-neutral). */
function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim().length > 0).map((l) => l.match(/^\s*/)![0].length);
  const min = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}

const codeSnippet = defineEmbed({
  async render(ctx) {
    const params = ctx.params as Record<string, string | undefined>;
    const file = params['file'];
    if (!file) throw new Error('code_snippet: `file` param is required');
    const lang = params['lang'] ?? 'ts';
    const abs = join(REPO_ROOT, file);
    const allLines = readFileSync(abs, 'utf8').split('\n'); // throws if the file is gone (loud)

    let selected: string[];
    if (params['grep']) {
      const re = new RegExp(params['grep']);
      selected = allLines.filter((l) => re.test(l));
      if (selected.length === 0) throw new Error(`code_snippet: /${params['grep']}/ matched no line in ${file}`);
    } else if (params['block_start']) {
      const startRe = new RegExp(params['block_start']);
      const endRe = new RegExp(params['block_end'] ?? params['block_start']);
      const start = allLines.findIndex((l) => startRe.test(l));
      if (start < 0) throw new Error(`code_snippet: block_start /${params['block_start']}/ not found in ${file}`);
      const end = allLines.findIndex((l, i) => i >= start && endRe.test(l));
      if (end < 0) throw new Error(`code_snippet: block_end /${params['block_end']}/ not found after block_start in ${file}`);
      selected = allLines.slice(start, end + 1);
    } else {
      throw new Error('code_snippet: one of `grep` / `block_start` is required');
    }

    return { content: ['```' + lang, ...dedent(selected), '```'].join('\n') };
  },
});

// embedoc expects `embeds` export
export const embeds = {
  benchmark_table: benchmarkTable,
  benchmark_summary: benchmarkSummary,
  code_snippet: codeSnippet,
};

// For direct import compatibility
export default { embeds };
