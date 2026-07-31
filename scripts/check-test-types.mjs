#!/usr/bin/env node
// Guard: every TypeScript file under test/ is TYPECHECKED (#224).
//
// Why: `tsconfig.json` emits from `src` and excludes `test`; `npm run lint` is `eslint src`; and vitest
// transpiles with esbuild, which does not typecheck. So nothing ever compiled the test tree, and a test
// DOUBLE of a production interface could silently stop matching it while the suite stayed green. That is
// not a hypothetical: pointing tsc at the tree the first time reported 175 diagnostics, including a
// `DBModel.use(DBModel.createMiddleware(…))` — the pairing README:993 documents — that never typechecked,
// and two suites whose own type expressions had collapsed to `DBModel` and erased their type safety.
//
// This is not a bare `tsc -p`, for the same reason check-go-test-skips.mjs is not a bare `go test`: a
// compiler reports the errors it found, never the files it FAILED to look at. An `include` that stops
// matching (a new directory, a renamed extension, an `exclude` that grows) would leave a passing gate
// guarding nothing. So the check asserts BOTH halves:
//
//   1. COVERAGE — every `test/**/*.ts` on disk is in the program tsc actually built (`--listFilesOnly`).
//   2. CLEANLINESS — that program reports zero diagnostics.
//
// The project file (tsconfig.test.json) extends the root one, so the doubles are checked against exactly
// the types production is compiled with. It overrides only what it must: `rootDir` (the root project
// emits from `src`, so `test/**` would trip TS6059) and `module` (a test imports the ESM-only
// `conformance/harness`, whose `import.meta` is illegal under CommonJS). `moduleResolution` is NOT
// changed — `bundler` resolves to a different type universe than the one the library ships.
//
// Usage: node scripts/check-test-types.mjs   (exit 1 on an unchecked file or any diagnostic)

import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PROJECT = 'tsconfig.test.json';

/** Run tsc for this project, returning {status, stdout}. A type error is an expected outcome, not a crash. */
function tsc(...args) {
  try {
    return { status: 0, out: execFileSync('npx', ['tsc', '-p', PROJECT, ...args], { cwd: ROOT, encoding: 'utf8' }) };
  } catch (e) {
    if (e.stdout === undefined) throw e; // tsc could not be launched at all
    return { status: e.status ?? 1, out: e.stdout };
  }
}

// ── 1. COVERAGE: is every test file actually in the program? ───────────────────
const onDisk = globSync('test/**/*.ts', { cwd: ROOT }).sort();
if (onDisk.length === 0) {
  console.error('❌ check-test-types: no test/**/*.ts found at all — this gate is looking at the wrong tree.');
  process.exit(1);
}
const listed = tsc('--listFilesOnly');
if (listed.status !== 0) {
  console.error('❌ check-test-types: tsc could not build the program to list its files:\n' + listed.out);
  process.exit(1);
}
const inProgram = new Set(
  listed.out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((abs) => relative(ROOT, abs)),
);
const unchecked = onDisk.filter((f) => !inProgram.has(f));
if (unchecked.length > 0) {
  console.error(
    `❌ check-test-types: ${unchecked.length} of ${onDisk.length} test/**/*.ts files are NOT in the ` +
      `typechecked program, so nothing would have caught a stale double in them:\n` +
      unchecked.map((f) => `      ${f}`).join('\n') +
      `\n\n      Widen "include" in ${PROJECT} (or narrow its "exclude") so it covers them.`,
  );
  process.exit(1);
}

// ── 2. CLEANLINESS: does that program typecheck? ───────────────────────────────
const checked = tsc();
if (checked.status !== 0) {
  const diagnostics = checked.out.split('\n').filter((l) => /error TS\d+/.test(l));
  console.error(
    `❌ check-test-types: ${diagnostics.length} type error(s) in the test tree.\n` +
      `      A test double that no longer matches its production interface fails HERE — vitest would ` +
      `still be green, because esbuild does not typecheck.\n\n` +
      checked.out.trimEnd(),
  );
  process.exit(1);
}

console.log(
  `✅ check-test-types: all ${onDisk.length} test/**/*.ts files were IN the program tsc built (not merely ` +
    `unreported), and it typechecks clean against the same types production is compiled with.`,
);
