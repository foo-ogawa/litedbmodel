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
 * subpath → what to run against it, and which module systems must be able to load it.
 *
 * `exercise` is the point. Checking that a named export EXISTS proves almost nothing: the first
 * version of this gate did exactly that, went green, and shipped a `dist/index.mjs` that imported
 * perfectly and then threw `Dynamic require of "better-sqlite3" is not supported` at the first
 * connection — the drivers load with a bare require() the ESM output cannot perform. So the root
 * entry now OPENS A DATABASE AND RUNS A QUERY, and a subpath is only "loads" if it does its job.
 */
const SUBPATHS = [
  {
    path: '.',
    cjs: true,
    esm: true,
    // Drive the entry far enough to REACH the driver loader without installing a driver. The peer
    // deps are absent here on purpose, so the library must answer with ITS OWN message; a bundle that
    // cannot perform the require answers "Dynamic require of ... is not supported" instead — which is
    // exactly the defect that shipped when this gate only checked that a symbol existed.
    exercise: `
      if (typeof m.column !== 'function' || typeof m.model !== 'function') throw new Error('decorators missing');
      m.DBModel.setConfig({ database: ':memory:', driver: 'sqlite' });
      let reached = '';
      try { await m.DBModel.execute('SELECT 1'); reached = 'connected'; }
      catch (e) { reached = String(e && e.message || e); }
      if (/Dynamic require/.test(reached))
        throw new Error('the bundle cannot load its drivers — ' + reached);
      if (!/better-sqlite3/.test(reached) && reached !== 'connected')
        throw new Error('unexpected failure reaching the driver loader: ' + reached);
    `,
  },
  { path: './drivers', cjs: true, esm: true, exercise: `if (typeof m.getSqlBuilder('sqlite').buildInsert !== 'function') throw new Error('no sqlite SqlBuilder');` },
  { path: './scp', cjs: true, esm: true, exercise: `if (typeof m.leafHandlers !== 'function' || typeof m.contextForConnection !== 'function') throw new Error('scp surface missing');` },
];

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Load `spec` in one module system inside `dir`; return null on success or the error's first line. */
function load(dir, spec, exercise, mode) {
  const body = `(async () => {${exercise}})().catch((e) => { console.error(e); process.exit(1); });`;
  const src =
    mode === 'cjs'
      ? `const m = require(${JSON.stringify(spec)});\n${body}`
      : `import * as ns from ${JSON.stringify(spec)};\nconst m = ns.DBModel || ns.leafHandlers || ns.getSqlBuilder ? ns : ns.default;\n${body}`;
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

  for (const { path, exercise, cjs, esm } of SUBPATHS) {
    const spec = path === '.' ? PKG.name : `${PKG.name}/${path.slice(2)}`;
    for (const [mode, required] of [
      ['cjs', cjs],
      ['esm', esm],
    ]) {
      const err = load(dir, spec, exercise, mode);
      if (required && err) problems.push(`${mode.toUpperCase()} ${spec} — ${err}`);
      if (!required && !err) problems.push(`${mode.toUpperCase()} ${spec} loads, but SUBPATHS declares it unsupported — update the declaration.`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (problems.length === 0) {
  console.log(`✅ every published subpath LOADS AND WORKS (${SUBPATHS.length} × CJS/ESM, clean install of the real tarball; the root entry reaches its driver loader)`);
  process.exit(0);
}
console.error('❌ the published package cannot be loaded as declared:\n');
for (const p of problems) console.error(`  ${p}`);
console.error('\nA tarball whose entry point throws on the consumer\'s first require() ships as broken as no tarball.');
process.exit(1);
