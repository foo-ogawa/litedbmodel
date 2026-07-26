#!/usr/bin/env node
/**
 * Published-entry-point smoke (#169).
 *
 * `npm pack --dry-run` lists what goes in the tarball; it never loads any of it. So the package
 * shipped with a main entry that cannot be read AT ALL — `require('litedbmodel')` and
 * `import 'litedbmodel'` both threw ERR_PACKAGE_PATH_NOT_EXPORTED, because `dist/scp/index.js` does
 * `require("behavior-contracts")` and behavior-contracts publishes only an `import` condition. Nothing
 * caught it: vitest reads `src/` through its own ESM pipeline, and `benchmark/` reads `src/` too.
 *
 * This packs the real tarball, installs it into a clean throwaway project, and LOADS every declared
 * subpath both ways. A subpath that is deliberately one-format-only is declared below, so "CJS is not
 * supported here" stays an explicit decision rather than a surprise at a consumer's first require().
 *
 *   node scripts/check-package-entrypoints.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/**
 * subpath → the named export to touch, and which module systems must be able to load it.
 * `cjs: false` records a subpath whose only entry is ESM by design (its exports map has `import` and
 * no `require`), so a CJS consumer is expected to fail — that is a decision, not a defect.
 */
const SUBPATHS = [
  { path: '.', symbol: 'DBModel', cjs: true, esm: true },
  { path: './drivers', symbol: 'getSqlBuilder', cjs: true, esm: true },
  { path: './scp', symbol: 'leafHandlers', cjs: true, esm: true },
];

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Load `spec` in one module system inside `dir`; return null on success or the error's first line. */
function load(dir, spec, symbol, mode) {
  const src =
    mode === 'cjs'
      ? `const m = require(${JSON.stringify(spec)}); if (m.${symbol} === undefined) throw new Error('no export ${symbol}');`
      : `import * as m from ${JSON.stringify(spec)}; if (m.${symbol} === undefined && m.default?.${symbol} === undefined) throw new Error('no export ${symbol}');`;
  const file = join(dir, mode === 'cjs' ? 'probe.cjs' : 'probe.mjs');
  writeFileSync(file, src);
  try {
    run(process.execPath, [file], dir);
    return null;
  } catch (e) {
    // node echoes the offending SOURCE line before the message, and that line contains the word
    // `Error` too — match the message line's `SomeError: …` shape, not any line mentioning Error.
    const out = `${e.stderr ?? ''}${e.stdout ?? ''}`;
    return out.split('\n').find((l) => /^\s*(?:\w*Error)\b.*:/.test(l))?.trim() ?? 'failed with no error line';
  }
}

const dir = mkdtempSync(join(tmpdir(), 'litedbmodel-entrypoints-'));
const problems = [];
try {
  const tarball = run('npm', ['pack', '--silent', '--pack-destination', dir], ROOT).trim().split('\n').pop();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'entrypoint-smoke', private: true, version: '0.0.0' }));
  run('npm', ['install', '--silent', '--no-audit', '--no-fund', join(dir, tarball)], dir);

  for (const { path, symbol, cjs, esm } of SUBPATHS) {
    const spec = path === '.' ? PKG.name : `${PKG.name}/${path.slice(2)}`;
    for (const [mode, required] of [
      ['cjs', cjs],
      ['esm', esm],
    ]) {
      const err = load(dir, spec, symbol, mode);
      if (required && err) problems.push(`${mode.toUpperCase()} ${spec} — ${err}`);
      if (!required && !err) problems.push(`${mode.toUpperCase()} ${spec} loads, but SUBPATHS declares it unsupported — update the declaration.`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (problems.length === 0) {
  console.log(`✅ every published subpath loads (${SUBPATHS.length} × CJS/ESM, from a clean install of the real tarball)`);
  process.exit(0);
}
console.error('❌ the published package cannot be loaded as declared:\n');
for (const p of problems) console.error(`  ${p}`);
console.error('\nA tarball whose entry point throws on the consumer\'s first require() ships as broken as no tarball.');
process.exit(1);
