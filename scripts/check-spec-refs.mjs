#!/usr/bin/env node
// Guard: every code reference the formal spec (docs/architecture.md) makes must RESOLVE, and every
// `spec §N` a source file cites must resolve back to a spec heading (#229).
//
// Why: the spec was left to rot once because nothing tied its prose to the code — deleted symbols and
// renamed files kept being "described" long after they were gone, and code that cites `spec §4.1` had
// no check that §4.1 still exists. This gate closes both directions with checks that are FINITE and
// DECIDABLE — it verifies that a named file/symbol EXISTS and that a cited §N is a HEADING. It does NOT
// (and must not) judge whether the prose is complete or correct: symbol/file existence is a closed
// question the tree answers; "is the description right" is not, and a gate that pretended to decide it
// would be noise (see #217).
//
// Three checks:
//   (A) spec → code, symbol:  every `` `symbol` (`path`) `` reference — the file exists AND contains the symbol.
//   (B) spec → code, file:    every bare `` `path` `` reference to a repo source file — the file exists.
//   (C) code → spec, section: every `spec §N` cited under src/** — §N is a heading in the spec.
//                             (and every internal `§N` cross-ref in the spec resolves to a spec heading.)
//
// Runs as a CI gate. Usage: node scripts/check-spec-refs.mjs   (exit 1 on any dangling reference)

import { readFileSync, existsSync, globSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const SPEC = 'docs/architecture.md';
const findings = [];
const flag = (why) => findings.push(why);

const specAbs = join(ROOT, SPEC);
if (!existsSync(specAbs)) {
  console.error(`✗ check-spec-refs: the spec ${SPEC} does not exist.`);
  process.exit(1);
}
const specText = readFileSync(specAbs, 'utf8');

// ── the spec's section headings (`## 4. …`, `### 4.1 …`, `## 0. …`) → the set of valid §numbers ──
const headings = new Set();
for (const line of specText.split('\n')) {
  const m = /^#{1,4}\s+(\d+(?:\.\d+)?)\.?\s/.exec(line);
  if (m) headings.add(m[1]);
}

// ── (A) spec → code: `symbol` (`path`) — file exists AND contains the symbol ──────────────────────
// `\s+` (not a literal space) so a reference that wraps across a line still matches.
for (const m of specText.matchAll(/`([A-Za-z_]\w*)`\s+\(`([^`\n]+\.\w+)`\)/g)) {
  const [, sym, file] = m;
  const abs = join(ROOT, file);
  if (!existsSync(abs)) {
    flag(`spec cites symbol \`${sym}\` in \`${file}\` — the FILE does not exist`);
  } else if (!readFileSync(abs, 'utf8').includes(sym)) {
    flag(`spec cites symbol \`${sym}\` in \`${file}\` — the file exists but does NOT contain that symbol`);
  }
}

// ── (B) spec → code: bare `path` references to a repo source file — the file exists ───────────────
for (const m of specText.matchAll(/`((?:src|scripts|test|conformance|benchmark|python|go|rust|php)\/[^`\n]+\.\w+)`/g)) {
  const file = m[1].replace(/:\d+$/, ''); // tolerate an optional :line suffix
  if (!existsSync(join(ROOT, file))) flag(`spec cites file \`${m[1]}\` — it does not exist`);
}

// ── (C) code → spec: every `spec §N` cited in src/** resolves to a spec heading ───────────────────
for (const rel of globSync('src/**/*.ts', { cwd: ROOT })) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  for (const m of text.matchAll(/spec §(\d+(?:\.\d+)?)/g)) {
    if (!headings.has(m[1])) flag(`${rel} cites \`spec §${m[1]}\` — no such section heading in ${SPEC}`);
  }
}

// … and the spec's own internal `§N` cross-refs resolve to a heading (skip refs to OTHER docs). ──────
for (const m of specText.matchAll(/§(\d+(?:\.\d+)?)/g)) {
  const before = specText.slice(Math.max(0, m.index - 20), m.index);
  if (/CLAUDE\.md\s*$|contracts\s*$/.test(before)) continue; // a §ref into another doc, not this spec
  if (!headings.has(m[1])) flag(`${SPEC} has an internal cross-ref \`§${m[1]}\` — no such section heading`);
}

// ── report ────────────────────────────────────────────────────────────────────────────────────────
if (findings.length === 0) {
  console.log(`✓ check-spec-refs: every ${SPEC} code reference resolves, and every \`spec §N\` cited in src/** exists (${headings.size} sections).`);
  process.exit(0);
}
console.error(`\n✗ check-spec-refs: ${findings.length} dangling reference(s):\n`);
for (const f of findings) console.error(`  - ${f}`);
console.error(`\nFix the reference or the code it points at. Prefer embedoc for quoted signatures so they cannot drift.`);
process.exit(1);
