/**
 * build-scp — dual ESM + CJS build of litedbmodel's published entry points (WS3 #23, root entry #169).
 *
 * ## The ESM/CJS seam
 *
 * behavior-contracts@0.2.0 is **ESM-only** (`"type":"module"`, exports only `import`), while
 * litedbmodel ships CommonJS (`main: dist/index.js`, `tsconfig module: CommonJS`). WS1/WS2
 * were compile-only (vitest's ESM loader resolved bc), so the seam was inert. WS3 EXECUTES
 * bc at runtime (`runBehavior` / `evaluateExpression`), so a plain `tsc` CJS build emitting
 * `require('behavior-contracts')` fails at runtime with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *
 * ## Chosen fix (clean, not a dynamic-import bodge)
 *
 * Build the SCP subsystem with esbuild (already a devDep) to **both** formats from the one
 * TS source of truth:
 *   - `dist/scp/index.mjs` — ESM, bc left EXTERNAL (a native ESM consumer imports bc directly).
 *   - `dist/scp/index.cjs` — CJS, bc **bundled IN** (esbuild transpiles bc's ESM into the CJS
 *     output), so `require('litedbmodel/scp')` works with zero runtime ESM/CJS friction.
 * `better-sqlite3` stays external in both (a native addon; the consumer supplies it).
 *
 * Each subpath export points `import` → the .mjs and `require` → the .cjs. Types come from `tsc`.
 *
 * The ROOT entry gets the same treatment (#169). It did not, originally: `dist/index.js` was plain
 * `tsc` output and that was fine while v1 never touched bc. Phase F-2 (#105) gave DBModel the SCP
 * runtime, so `dist/DBModel.js` now emits `require("behavior-contracts/runtime")` — and both
 * `require('litedbmodel')` and `import 'litedbmodel'` began throwing ERR_PACKAGE_PATH_NOT_EXPORTED on
 * a clean install. Nothing loaded the built package, so nothing noticed;
 * `scripts/check-package-entrypoints.mjs` is the gate that now does.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every published entry that reaches behavior-contracts: source → the two output basenames. */
const ENTRIES = [
  { src: 'src/index.ts', out: 'dist/index' },
  { src: 'src/scp/index.ts', out: 'dist/scp/index' },
];

/** External in every build: the native SQLite addon (consumer-supplied). */
const alwaysExternal = ['better-sqlite3'];

async function run() {
  for (const { src, out } of ENTRIES) {
    const entryPoints = [resolve(root, src)];
    const common = { entryPoints, bundle: true, platform: 'node', target: 'node18', logLevel: 'info' };
    // ESM: bc stays external (a native ESM consumer imports it directly).
    await build({
      ...common,
      outfile: resolve(root, `${out}.mjs`),
      format: 'esm',
      external: [...alwaysExternal, 'behavior-contracts'],
    });
    // CJS: bc is bundled IN so `require` works without touching bc's ESM-only exports.
    await build({
      ...common,
      outfile: resolve(root, `${out}.cjs`),
      format: 'cjs',
      external: alwaysExternal,
    });
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
