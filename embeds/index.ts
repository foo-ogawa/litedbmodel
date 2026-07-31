import type { DefineEmbedFn, QueryResult } from 'embedoc';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORM_SERIES, SUBJECT_SERIES } from '../benchmark/orm-series.js';

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
      const winsHere = SUBJECT_SERIES.some((o) => {
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

// ── package_version: the release the published numbers belong to ─────────────
//
// The benchmark pages declare their numbers machine-derived — and "which version was measured" is
// just as much a factual claim about the data as the medians are. Hand-typed, it went stale silently
// (the tables were re-run while the prose still said an older release), because the drift gate only
// regenerates embed REGIONS and prose outside the markers is invisible to it. So the version is read
// from package.json — the release SSoT that scripts/sync-versions.mjs propagates to every language
// runtime — and rendered inside a region the gate covers.
//
// Only the version and package name are generated. The measurement ENVIRONMENT (DB version, CPU) is
// recorded nowhere in the repo — not in the CSV, whose columns are Operation/ORM/Median/IQR/StdDev/
// Min/Max/Iterations — so it stays hand-written prose outside the markers rather than being dressed
// up as machine-derived by hard-coding it here.
//
// Params (marker attributes):
//   label  lead-in shown before the version (default: `Version`)
const packageVersion = defineEmbed({
  async render(ctx) {
    const params = ctx.params as Record<string, string | undefined>;
    const label = params['label'] ?? 'Version';
    const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const name = (pkg as { name?: unknown }).name;
    const version = (pkg as { version?: unknown }).version;
    // A missing/blank field must never render as `undefined` or an empty bold run that reads like a
    // version — an unreadable SSoT is a build failure, not a plausible-looking string.
    if (typeof name !== 'string' || name === '' || typeof version !== 'string' || version === '') {
      throw new Error('package_version: package.json has no usable `name` / `version`');
    }
    return { content: `**${label}:** ${name} **${version}**` };
  },
});

// embedoc expects `embeds` export
export const embeds = {
  benchmark_table: benchmarkTable,
  benchmark_summary: benchmarkSummary,
  code_snippet: codeSnippet,
  package_version: packageVersion,
};

// For direct import compatibility
export default { embeds };
