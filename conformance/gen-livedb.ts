/**
 * The LIVE-DB cross-language conformance leg (#36 WS7g; leaf/emitter cutover #144).
 *
 * A leaf-executed module CANNOT be replayed from a serialized bundle — the leaf needs a live,
 * in-process database handle — so the recorder-era "compile a bundle, ship it in the corpus, replay
 * it in every language" model is exactly what the leaf cutover retires. What each language runs now
 * is its OWN GENERATED MODULE, lowered from the SAME declaration the TS leg runs:
 *
 * ```
 * conformance/harness.ts fixtures  →  emitSpecFor(dialect)      the ONE declaration (no SQL)
 *   → emitBehaviorModule                                        the library's lowering
 *   → tsc --strict                                              bc's authoring requirement
 *   → bc generate --lang python | php | go-typed-native         the real CLI, per live dialect
 *   → <lang> runtime binds the leaf transport to a LIVE pg / mysql connection
 * ```
 *
 * So this module owns exactly two things, and NEITHER of them re-declares a fixture or re-executes
 * a query:
 *
 *  1. {@link generateLanguageModules} — lower the harness declaration for `postgres` + `mysql` and
 *     run `bc generate` (or, in `check` mode, `bc check`) for every non-TS language leg. The authored
 *     SCP TS is an intermediate: it is regenerated from the emitter on both paths, so `check` is a
 *     true drift gate over the COMMITTED language modules.
 *  2. {@link buildLivedbCorpus} — PROJECT the frozen `conformance/vectors/exec.json` onto the live
 *     dialects. The expected statements / results / DB state are the ones `harness.ts` already
 *     captured by executing the generated TS module against live PostgreSQL + MySQL; this file
 *     re-captures nothing, so a language leg is byte-compared against the SAME reference the TS leg
 *     is, by construction rather than by a cross-check.
 *
 * A vector carrying a `config` (a per-vector `findHardLimit`) is EXCLUDED: the cap is baked into the
 * emitted SQL, so such a vector belongs to a DIFFERENT generated module than the one the language
 * legs hold. The TS leg (`test/scp/conformance-vectors.test.ts`) re-emits per config and covers them.
 *
 * Run (via vitest's ESM resolver, like gen-vectors):
 *   npm run conformance:gen:livedb                          # regenerate the modules + the corpus
 *   LIVEDB_GEN_MODE=check npm run conformance:gen:livedb    # drift-gate them instead
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitBehaviorModule, type DialectName } from '../src/scp/index';
import { CORPUS_VERSION, SCHEMA, emitSpecFor, type EncodedStatement, type EncodedValue, type Suite } from './harness';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

export const LIVEDB_DIR = join(HERE, 'vectors-livedb');
export const LIVEDB_CORPUS = join(LIVEDB_DIR, 'livedb.json');
const EXEC_SUITE = join(HERE, 'vectors', 'exec.json');

/** Where the emitted SCP TS lands before `bc generate` reads it (regenerated; gitignored). */
const AUTHORED_DIR = join(HERE, '.generated-livedb');

/** The dialects a language leg runs against a REAL server. */
const LIVE_DIALECTS: readonly DialectName[] = ['postgres', 'mysql'] as const;

/** The emitted `@behavior` class name — the `bc generate --behavior` argument (harness SSoT). */
const BEHAVIOR = 'Conformance';

// ══════════════════════════════════════════════════════════════════════════════
// 1. The language modules — `bc generate` over the harness declaration.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * NO go / rust leg. Both TYPED-NATIVE emitters fail closed on the SKIP endpoint's `whereDynamic`
 * port — the dynamic-WHERE fragment list the leaf assembles at execution time (CLAUDE.md §2). The
 * declaration is legal and `typescript-native` lowers it; the typed-native emitters do not cover the
 * shape yet. Reproduce, verbatim, from the emitted source this module writes:
 *
 * ```
 * npx vitest run --config conformance/vitest.livedb.config.ts   # writes .generated-livedb/*.ts
 * node_modules/.bin/bc generate --lang go-typed-native \
 *   --from conformance/.generated-livedb/postgres.authored.ts --behavior Conformance --out /tmp/x.go \
 *   --runtime-import github.com/foo-ogawa/litedbmodel/go/litedbmodel_runtime \
 *   --shared-types-import github.com/foo-ogawa/litedbmodel/go/litedbmodel_runtime/wire \
 *   --leaf-transport executeSQL=ExecuteSQL pluck=PluckKeys group=GroupChildren \
 *   --leaf-transport-import github.com/foo-ogawa/litedbmodel/go/litedbmodel_runtime
 * # bc: go typed-native (native codegen) surface: 1 component(s) are NOT a covered native read:
 * #   - component 'feed': node 'n0' port 'whereDynamic' is not statically resolvable
 * ```
 *
 * `--lang rust-typed-native` fails identically; `--lang typescript-native` succeeds. Adding the go
 * leg here is one entry in {@link LANG_TARGETS} plus a call table in the go runner — nothing else —
 * once bc covers the port.
 */

/**
 * One non-TS language leg: where its generated module lands and the emitter flags it takes. The flag
 * sets mirror `benchmark/crosslang/gen-native.sh` (the same bc CLI, the same leaf-transport symbol
 * map) because there is ONE leaf catalog and ONE set of transport symbols per language.
 */
interface LangTarget {
  readonly lang: string;
  /** The generated module path for one dialect. */
  out(dialect: DialectName): string;
  /** Emitter-specific flags (runtime / shared-types / leaf-transport symbol map). */
  readonly flags: readonly string[];
}

const LANG_TARGETS: readonly LangTarget[] = [
  {
    lang: 'python',
    out: (d) => join(ROOT, 'python', 'conformance', `behaviors_${d}.py`),
    flags: [],
  },
  {
    lang: 'php',
    out: (d) => join(ROOT, 'php', 'conformance', `behaviors_${d}.php`),
    // The php bc runtime-core is VENDORED (bc php is unpublished — `npm run vendor:bc-php`), so the
    // generated module's require-time gates + `runBehavior` call resolve to that namespace.
    flags: ['--runtime-import', 'LiteDbModel\\Runtime\\BehaviorContracts'],
  },
];

/** Lower the harness declaration for one dialect and write the authored SCP TS bc will read. */
function authoredSource(dialect: DialectName): string {
  mkdirSync(AUTHORED_DIR, { recursive: true });
  const file = join(AUTHORED_DIR, `${dialect}.authored.ts`);
  writeFileSync(file, emitBehaviorModule(emitSpecFor(dialect)).source, 'utf8');
  // The emitted source must be ORDINARY strict TypeScript — bc's authoring requirement, and the
  // reason bc's type extraction sees the declared row types at all.
  execFileSync(
    join(ROOT, 'node_modules/.bin/tsc'),
    ['--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler',
     '--experimentalDecorators', file],
    { cwd: ROOT, stdio: 'pipe' },
  );
  return file;
}

/**
 * `bc generate` (or `bc check`) every language leg × live dialect over the emitted source. Returns
 * the module paths. `check` re-generates in memory and byte-diffs the committed module — the drift
 * gate that makes the committed artifacts trustworthy.
 */
export function generateLanguageModules(mode: 'generate' | 'check' = 'generate'): string[] {
  const written: string[] = [];
  for (const dialect of LIVE_DIALECTS) {
    const from = authoredSource(dialect);
    for (const target of LANG_TARGETS) {
      const out = target.out(dialect);
      mkdirSync(dirname(out), { recursive: true });
      execFileSync(
        join(ROOT, 'node_modules/.bin/bc'),
        [mode, '--lang', target.lang, '--from', from, '--behavior', BEHAVIOR, '--out', out, ...target.flags],
        { cwd: ROOT, stdio: 'pipe' },
      );
      written.push(out);
    }
  }
  return written;
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. The corpus — the frozen exec suite, projected onto the live dialects.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * One live-DB vector: an endpoint of the GENERATED module, its input, and everything the TS leg
 * observed when it ran that endpoint against the real server for this dialect. A language leg calls
 * the SAME endpoint on its own generated module and must reproduce all three.
 */
export interface LivedbVector {
  readonly name: string;
  readonly dialect: DialectName;
  /** The generated module's method name. */
  readonly entry: string;
  readonly input: EncodedValue;
  /** Every statement the leaf transport handed the driver, in order, in the driver-bound form. */
  readonly expectedStatements: readonly EncodedStatement[];
  /** The FULL materialized result — nested relation children and their field VALUES included. */
  readonly expectedResult: EncodedValue;
  /** DB state after a write, queried through the same connection. */
  readonly expectedDbState?: readonly { readonly query: string; readonly rows: EncodedValue }[];
}

export interface LivedbSuite {
  readonly suite: 'livedb';
  readonly corpusVersion: number;
  readonly note: string;
  /** The DDL + seed each language leg applies in its OWN namespace before every vector. */
  readonly schema: readonly string[];
  readonly vectors: readonly LivedbVector[];
}

/** The frozen exec suite (the harness's live capture) — read, never re-derived. */
function frozenExecSuite(): Suite {
  if (!existsSync(EXEC_SUITE)) {
    throw new Error(`livedb: ${EXEC_SUITE} is missing — run \`npm run conformance:gen\` first`);
  }
  const suite = JSON.parse(readFileSync(EXEC_SUITE, 'utf8')) as Suite;
  if (suite.corpusVersion !== CORPUS_VERSION) {
    throw new Error(`livedb: exec.json corpusVersion ${suite.corpusVersion} != ${CORPUS_VERSION}`);
  }
  return suite;
}

/** Project the frozen exec suite onto the live dialects (the language legs' corpus). */
export function buildLivedbCorpus(): LivedbSuite {
  const vectors: LivedbVector[] = [];
  for (const v of frozenExecSuite().vectors) {
    // `config` bakes a different cap into the SQL ⇒ a different module than the language legs hold.
    if (v.kind !== 'exec' || v.dialect === 'sqlite' || v.config !== undefined) continue;
    vectors.push({
      name: v.name,
      dialect: v.dialect,
      entry: v.entry,
      input: v.input,
      expectedStatements: v.expectedStatements,
      expectedResult: v.expectedResult,
      ...(v.expectedDbState !== undefined ? { expectedDbState: v.expectedDbState } : {}),
    });
  }
  if (vectors.length === 0) throw new Error('livedb: the exec suite yielded no live-dialect vectors');
  return {
    suite: 'livedb',
    corpusVersion: CORPUS_VERSION,
    note:
      "The declared endpoints of conformance/harness.ts, executed by each language runtime's OWN " +
      'bc-generated module against live PostgreSQL + MySQL. Every expected field is the one the TS ' +
      'leg captured from the same declaration on the same server (conformance/vectors/exec.json) — ' +
      'a language leg is byte-compared against the TS reference, statements and full nested result ' +
      'alike.',
    schema: SCHEMA,
    vectors,
  };
}

/** Stable, pretty JSON so the corpus diffs cleanly and freezes deterministically. */
function serialize(suite: LivedbSuite): string {
  return JSON.stringify(suite, null, 2) + '\n';
}

/**
 * (Re)generate the language modules AND write the live-DB corpus. Returns the corpus path.
 * `mode: 'check'` drift-gates the modules and the corpus instead of writing them.
 */
export function writeLivedbCorpus(mode: 'generate' | 'check' = 'generate'): string {
  generateLanguageModules(mode);
  const serialized = serialize(buildLivedbCorpus());
  if (mode === 'check') {
    if (!existsSync(LIVEDB_CORPUS)) throw new Error(`livedb: ${LIVEDB_CORPUS} is missing`);
    if (readFileSync(LIVEDB_CORPUS, 'utf8') !== serialized) {
      throw new Error(`livedb: ${LIVEDB_CORPUS} has drifted from the frozen exec suite — regenerate it`);
    }
    return LIVEDB_CORPUS;
  }
  mkdirSync(LIVEDB_DIR, { recursive: true });
  writeFileSync(LIVEDB_CORPUS, serialized, 'utf8');
  return LIVEDB_CORPUS;
}
