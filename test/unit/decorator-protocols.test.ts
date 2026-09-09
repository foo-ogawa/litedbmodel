/**
 * The SAME model source must register the SAME model under every decorator protocol (issue #287).
 *
 * The decorator layer used to be legacy-only: `registerColumn` read `target.constructor`, which is
 * `undefined` under TC39 standard decorators (TypeScript 5's default), so a model crashed at import
 * with `Cannot read properties of undefined (reading 'constructor')`. It also inferred a bare
 * `@column()`'s type from `design:type` — metadata that exists only under legacy decorators AND
 * `emitDecoratorMetadata`, which esbuild (tsx / vite / vitest) never emits — so the same source
 * produced DIFFERENT models on different toolchains, silently (issue #286).
 *
 * This compiles one fixture four ways — esbuild and tsc, each under standard and legacy decorators —
 * runs each, and requires the four to agree. The `tsc` legs matter on their own: TypeScript only
 * creates the standard protocol's `context.metadata` bag when `Symbol.metadata` exists, which is why
 * `src/decorators.ts` defines it on import.
 *
 * Negative control: restore `const constructor = target.constructor` in `registerColumn` and both
 * standard-decorator legs throw; drop the `Symbol.metadata` definition and the tsc standard leg does.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const FIXTURE = resolve(ROOT, 'test/fixtures/decorator-protocols/model-fixture.ts');
const ESBUILD = resolve(ROOT, 'node_modules/.bin/esbuild');
const TSC = resolve(ROOT, 'node_modules/.bin/tsc');
/** Scratch inside the repo so Node resolves `node_modules` from the emitted files. */
const CACHE = resolve(ROOT, 'node_modules/.cache');

/**
 * `behavior-contracts` publishes its runtime tier under the `import` condition only, so a CommonJS
 * `require` of it does not resolve — the published bundle inlines it (`scripts/build-scp.mjs`), and
 * these aliases do the same for a test build. The repo's own tsconfig carries the types-side shim.
 */
const ALIASES = [
  `--alias:behavior-contracts/runtime=${resolve(ROOT, 'node_modules/behavior-contracts/dist/runtime.js')}`,
  `--alias:behavior-contracts=${resolve(ROOT, 'node_modules/behavior-contracts/dist/index.js')}`,
];
const EXTERNALS = ['--external:pg', '--external:mysql2', '--external:better-sqlite3'];

interface Protocol { readonly name: string; readonly legacy: boolean }
const PROTOCOLS: readonly Protocol[] = [
  { name: 'standard (TC39, the TypeScript 5 default)', legacy: false },
  { name: 'legacy (experimentalDecorators)', legacy: true },
];

function scratch(prefix: string): string {
  mkdirSync(CACHE, { recursive: true });
  return mkdtempSync(join(CACHE, prefix));
}

/** Bundle + run the fixture with esbuild — the emit behind tsx, vite and vitest. */
function runEsbuild(p: Protocol): string {
  const dir = scratch('proto-esbuild-');
  try {
    const out = join(dir, 'out.cjs');
    execFileSync(ESBUILD, [
      FIXTURE, '--bundle', '--platform=node', '--format=cjs', '--target=es2022',
      ...EXTERNALS, ...ALIASES, `--outfile=${out}`, '--log-level=error',
      // esbuild does not implement `emitDecoratorMetadata` at all — asking for it is exactly how a
      // consumer ends up depending on metadata that never arrives.
      `--tsconfig-raw=${JSON.stringify({ compilerOptions: {
        target: 'ES2022', experimentalDecorators: p.legacy, emitDecoratorMetadata: p.legacy } })}`,
    ], { cwd: ROOT, encoding: 'utf8' });
    return execFileSync(process.execPath, [out], { cwd: ROOT, encoding: 'utf8' }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Compile with tsc — the only emit `emitDecoratorMetadata` exists in — then link and run it. */
function runTsc(p: Protocol): string {
  const dir = scratch('proto-tsc-');
  try {
    const cfg = join(dir, 'tsconfig.json');
    writeFileSync(cfg, JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'CommonJS', moduleResolution: 'node', strict: true,
        skipLibCheck: true, esModuleInterop: true, outDir: join(dir, 'out'), baseUrl: ROOT,
        paths: { 'behavior-contracts/runtime': ['./node_modules/behavior-contracts/dist/runtime.d.ts'] },
        experimentalDecorators: p.legacy, emitDecoratorMetadata: p.legacy,
      },
      files: [FIXTURE],
    }));
    execFileSync(TSC, ['-p', cfg], { cwd: ROOT, encoding: 'utf8' });
    // tsc has already lowered the decorators; esbuild only resolves the module graph here.
    const emitted = join(dir, 'out/test/fixtures/decorator-protocols/model-fixture.js');
    const linked = join(dir, 'run.cjs');
    execFileSync(ESBUILD, [
      emitted, '--bundle', '--platform=node', '--format=cjs',
      ...EXTERNALS, ...ALIASES, `--outfile=${linked}`, '--log-level=error',
    ], { cwd: ROOT, encoding: 'utf8' });
    return execFileSync(process.execPath, [linked], { cwd: ROOT, encoding: 'utf8' }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The model the fixture declares, spelled out: `prop:column:cast:sqlCast:baseSqlType:pk:autoIncrement`. */
const EXPECTED = {
  userColumns: [
    'id:id:cast:-:-:pk:ai',
    'name:name:-:-:TEXT:-:-',
    'email:mail_addr:-:-:TEXT:-:-',
    'is_active:is_active:cast:boolean:-:-:-',
    'created_at:created_at:cast:timestamp:-:-:-',
    'big:big:cast:bigint:-:-:-',
    'ext_id:ext_id:cast:uuid:-:-:-',
  ],
  userStatics: ['id->id', 'name->name', 'email->mail_addr', 'created_at->created_at'],
  relations: ['posts:hasMany'],
  relationGetterOnPrototype: true,
  // A subclass must not see its sibling's columns through the base they share.
  aColumns: ['created_at:created_at:cast:timestamp:-:-:-', 'a_only:a_only:-:-:TEXT:-:-'],
  bColumns: ['created_at:created_at:cast:timestamp:-:-:-', 'b_only:b_only:-:-:TEXT:-:-'],
  tableNames: ['proto_users', 'proto_a'],
};

describe('one model source, every decorator protocol (#287)', () => {
  const runs = new Map<string, Record<string, unknown>>();

  for (const p of PROTOCOLS) {
    for (const [tool, run] of [['esbuild', runEsbuild], ['tsc', runTsc]] as const) {
      it(`${tool} — ${p.name}`, () => {
        const model = JSON.parse(run(p)) as Record<string, unknown>;
        runs.set(`${tool}:${p.legacy ? 'legacy' : 'standard'}`, model);
        // A protocol that registers something else — an untyped column, a lost relation, a leaked
        // base column, a `name` clobbered by the bundler's keep-names — fails HERE.
        for (const [k, v] of Object.entries(EXPECTED)) expect(model[k], k).toEqual(v);
        // The relation field: `declare posts` emits nothing, but standard decorators REJECT a
        // decorated `declare` field (TS1206), so the fixture writes `posts!:` — which under
        // `useDefineForClassFields` defines an own `undefined` that would shadow the prototype
        // getter. The standard protocol's initializer removes it; legacy has no instance hook, which
        // is why `declare` remains the documented legacy form.
        expect(model.relationReachableOnInstance).toBe(!p.legacy);
      }, 120_000);
    }
  }

  it('all four toolchain × protocol runs register the same model', () => {
    const entries = [...runs.entries()];
    expect(entries.length).toBe(4);
    const strip = (m: Record<string, unknown>) => {
      const { relationReachableOnInstance: _ignored, ...rest } = m;
      return rest;
    };
    for (const [label, model] of entries) {
      expect(strip(model), `${label} differs from ${entries[0][0]}`).toEqual(strip(entries[0][1]));
    }
  });
});
