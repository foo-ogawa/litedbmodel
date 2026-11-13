import { defineEmbed, renderApiIndex } from 'embedoc';
import benchmarkTable from './benchmark_table.ts';

// ── api_index: the index of the API reference (docs/api/README.md) ────────────
//
// The `api` datasource (embedoc.config.yaml) reads the public API from src/index.ts; its generator
// writes a page for every symbol whose kind is in its `pages`, and this writes the index: those symbols
// as links to their pages, every other one (type aliases, variables such as SKIP, re-exports) in full.
const apiIndex = defineEmbed({
  dependsOn: ['api'],
  async render(ctx) {
    const records = await ctx.datasources['api']!.getAll();
    return {
      content: renderApiIndex(records, {
        categoryOrder: ['Core', 'Decorators', 'Column', 'Values', 'Subquery', 'Middleware', 'Relations', 'Types', 'Errors', '*'],
      }),
    };
  },
});

// Note: embedoc expects module.embeds but tsImport returns module.default.embeds
// This is a workaround - also export at top level
export const embeds = {
  benchmark_table: benchmarkTable,
  api_index: apiIndex,
};

// For direct import compatibility
export default { embeds };
