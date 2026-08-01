#!/usr/bin/env node
/**
 * Benchmark docs regeneration gate.
 *
 * The benchmark tables, the win count and the SVG chart are machine-generated from
 * benchmark/results/benchmark-results.csv. The gate that guards them regenerates and diffs, which
 * silently assumes regeneration happened: `embedoc build` reports a failed embed load as a *warning*
 * and exits 0, leaving every marker untouched. The tree is then clean, the diff passes, and the
 * published tables were never checked against the CSV at all.
 *
 * So "was not regenerated" has to be observable. This blanks the body of every embed region first and
 * regenerates into the empty regions: a region still empty afterwards was not rendered, and it fails
 * here. The `git diff --exit-code -- docs/` that follows then proves the committed content IS this
 * run's output instead of merely having survived it.
 *
 *   node scripts/check-bench-docs.mjs
 */
import { execFileSync } from 'node:child_process';
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = join(ROOT, 'embedoc.config.yaml');

/** `<!--@embedoc:name-->` … `<!--@embedoc:end-->`, capturing the generated body between them. */
const REGION = /^(<!--@embedoc:(?!end-->)(.*?)-->\n)([\s\S]*?)(^<!--@embedoc:end-->$)/gm;

/** The files embedoc writes into, straight from its own config — never a second copy of the pattern. */
function targetFiles() {
  const config = load(readFileSync(CONFIG, 'utf8'));
  const files = new Set();
  for (const target of config.targets ?? []) {
    for (const file of globSync(target.pattern, { cwd: ROOT, exclude: (p) => p.includes('node_modules') })) {
      files.add(join(ROOT, file));
    }
  }
  return [...files].sort();
}

/** Every embed region in a file, as `{ marker, body }`. */
function regionsOf(text) {
  return [...text.matchAll(REGION)].map((m) => ({ marker: m[2], body: m[3] }));
}

const files = targetFiles();
const withRegions = files.filter((file) => regionsOf(readFileSync(file, 'utf8')).length > 0);
if (withRegions.length === 0) {
  console.error(`❌ No embed regions found under the embedoc targets in ${relative(ROOT, CONFIG)}.`);
  console.error('   The gate would pass vacuously, which is the failure it exists to prevent.');
  process.exit(1);
}

const expected = withRegions.flatMap((file) => regionsOf(readFileSync(file, 'utf8')).map((r) => `${relative(ROOT, file)}:${r.marker}`));
console.log(`🧹 Blanking ${expected.length} embed region(s) so an unrendered one cannot pass unnoticed:`);
for (const id of expected) console.log(`   ${id}`);

// Blanking is destructive to TRACKED files, so the pre-blank text is held and written back on any
// failure: a developer whose run fails locally gets the diagnosis, not a gutted working tree. Nothing
// calls `process.exit` inside the `try` — that skips `finally` and would leave the files blanked.
const original = new Map(withRegions.map((file) => [file, readFileSync(file, 'utf8')]));
let empty = [];
let rendered = false;
try {
  for (const [file, text] of original) writeFileSync(file, text.replace(REGION, '$1$4'));

  execFileSync('npx', ['embedoc', 'build'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('npx', ['tsx', 'benchmark/generate-chart.ts'], { cwd: ROOT, stdio: 'inherit' });

  empty = withRegions.flatMap((file) =>
    regionsOf(readFileSync(file, 'utf8'))
      .filter((r) => r.body.trim() === '')
      .map((r) => `${relative(ROOT, file)}:${r.marker}`),
  );
  rendered = empty.length === 0;
} finally {
  if (!rendered) {
    // Only files that actually changed are written back. Writing every one would re-raise the very
    // error that aborted the run (an unwritable target), and a throw from `finally` replaces the
    // diagnosis with itself.
    const restored = [...original].filter(([file, text]) => readFileSync(file, 'utf8') !== text);
    for (const [file, text] of restored) writeFileSync(file, text);
    console.error(`\n   (restored ${restored.length} of ${original.size} file(s) to their pre-run content)`);
  }
}

if (empty.length > 0) {
  console.error(`\n❌ ${empty.length} embed region(s) were not rendered — embedoc reported success without running them:`);
  for (const id of empty) console.error(`   ${id}`);
  console.error('   Check the "Could not load embeds" / "Unknown embed" warnings above.');
  process.exit(1);
}

console.log(`\n✅ All ${expected.length} embed region(s) rendered, chart regenerated.`);
