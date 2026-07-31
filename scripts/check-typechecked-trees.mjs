#!/usr/bin/env node
// Guard: every TypeScript file the ROOT project does not compile is TYPECHECKED anyway (#224, #232).
//
// Why: `tsconfig.json` emits from `src` and excludes everything else; `npm run lint` is `eslint src`;
// vitest transpiles with esbuild and tsx runs the benchmark, and neither typechecks. So whole trees
// were compiled nowhere:
//
//   test/**              a test DOUBLE of a production interface could silently stop matching it while
//                        the suite stayed green. Pointing tsc at the tree the first time reported 175
//                        diagnostics, including a `DBModel.use(DBModel.createMiddleware(…))` — the
//                        pairing README:993 documents — that never typechecked, and two suites whose
//                        own type expressions had collapsed to `DBModel` and erased their type safety.
//   benchmark/, embeds/  the doc generators. A bench series with no colour rendered `fill="undefined"`
//                        bars, an `orm:` label matching no series wrote an unreadable row into the
//                        results CSV, and the embeds cast embedoc's `Record<string, unknown>` rows
//                        straight to a row interface — all at exit 0.
//
// This is not a bare `tsc -p`, for the same reason check-go-test-skips.mjs is not a bare `go test`: a
// compiler reports the errors it found, never the files it FAILED to look at. An `include` that stops
// matching (a new directory, a renamed extension, an `exclude` that grows) would leave a passing gate
// guarding nothing. So for each project the check asserts BOTH halves:
//
//   1. COVERAGE — every source file on disk is in the program tsc actually built (`--listFilesOnly`).
//   2. CLEANLINESS — that program reports zero diagnostics.
//
// Each project file extends the config of the tree it belongs to, so the sources are checked against
// exactly the types they run with. tsconfig.test.json extends the root one and overrides only what it
// must: `rootDir` (the root project emits from `src`, so `test/**` would trip TS6059) and `module` (a
// test imports the ESM-only `conformance/harness`, whose `import.meta` is illegal under CommonJS).
// `moduleResolution` is NOT changed — `bundler` resolves to a different type universe than the one the
// library ships. tsconfig.tools.json extends benchmark/tsconfig.json, the config tsx already runs the
// benchmark under.
//
// The tooling tree needs `dist/` (the benchmark imports `litedbmodel`, a `file:..` dependency whose
// types ARE the build output) and `benchmark/node_modules` including a generated `@prisma/client`, so
// CI builds and installs those before this runs.
//
// Usage: node scripts/check-typechecked-trees.mjs   (exit 1 on an unchecked file or any diagnostic)

import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

/** The TS trees `tsconfig.json` leaves uncompiled, and the project file that covers each. */
const PROJECTS = [
  { project: 'tsconfig.test.json', tree: 'test tree', globs: ['test/**/*.ts'] },
  {
    project: 'tsconfig.tools.json',
    tree: 'tooling tree (benchmark + doc embeds)',
    globs: ['benchmark/**/*.ts', 'embeds/**/*.ts'],
  },
];

/** Run tsc for a project, returning {status, out}. A type error is an expected outcome, not a crash. */
function tsc(project, ...args) {
  try {
    return { status: 0, out: execFileSync('npx', ['tsc', '-p', project, ...args], { cwd: ROOT, encoding: 'utf8' }) };
  } catch (e) {
    if (e.stdout === undefined) throw e; // tsc could not be launched at all
    return { status: e.status ?? 1, out: e.stdout };
  }
}

let checkedTotal = 0;
for (const { project, tree, globs } of PROJECTS) {
  // ── 1. COVERAGE: is every source file actually in the program? ─────────────────
  const onDisk = globs
    .flatMap((g) => globSync(g, { cwd: ROOT, exclude: (p) => p.includes('node_modules') || p.includes('dist/') }))
    .sort();
  if (onDisk.length === 0) {
    console.error(
      `❌ check-typechecked-trees: ${project} — no ${globs.join(' / ')} on disk at all; this gate is looking at the wrong tree.`,
    );
    process.exit(1);
  }
  const listed = tsc(project, '--listFilesOnly');
  if (listed.status !== 0) {
    console.error(`❌ check-typechecked-trees: ${project} — tsc could not build the program to list its files:\n${listed.out}`);
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
      `❌ check-typechecked-trees: ${unchecked.length} of ${onDisk.length} file(s) in the ${tree} are NOT in the ` +
        `typechecked program, so nothing would have caught a type error in them:\n` +
        unchecked.map((f) => `      ${f}`).join('\n') +
        `\n\n      Widen "include" in ${project} (or narrow its "exclude") so it covers them.`,
    );
    process.exit(1);
  }

  // ── 2. CLEANLINESS: does that program typecheck? ───────────────────────────────
  const checked = tsc(project);
  if (checked.status !== 0) {
    const diagnostics = checked.out.split('\n').filter((l) => /error TS\d+/.test(l));
    console.error(
      `❌ check-typechecked-trees: ${diagnostics.length} type error(s) in the ${tree} (${project}).\n` +
        `      Nothing else in this repo compiles these files — vitest, tsx and esbuild all strip types ` +
        `without checking them.\n\n` +
        checked.out.trimEnd(),
    );
    process.exit(1);
  }

  console.log(
    `✅ ${tree}: all ${onDisk.length} file(s) were IN the program tsc built (not merely unreported), and it typechecks clean.`,
  );
  checkedTotal += onDisk.length;
}

console.log(
  `✅ check-typechecked-trees: ${checkedTotal} file(s) across ${PROJECTS.length} project(s) that \`tsconfig.json\` does not compile.`,
);
