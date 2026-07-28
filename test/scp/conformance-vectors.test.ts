/**
 * WS7a (#30) — the TS reference conformance runner (the multi-language baseline).
 *
 * This is the "TS runner green" bar of the conformance harness: it loads the FROZEN vector corpus
 * (`conformance/vectors/*.json`, generated from the declarations by `conformance/gen-vectors.ts`)
 * and re-runs the live pipeline — decorated models + declared endpoints → `emitBehaviorModule` →
 * `bc generate` → `bindTyped(leafHandlers(ctx))` → SQLite / live PostgreSQL / live MySQL — against
 * every vector, asserting the identical statements (render axis), the identical materialized result
 * and DB state (exec axis), the identical typed throw (guard axis), the identical transaction
 * outcome (tx axis) and the identical dialect primitive (dialect axis).
 *
 * ## Not faked
 *
 * The corpus is captured from that pipeline, and this runner RE-DERIVES it and asserts equality —
 * a genuine round-trip, not a stubbed pass. The drift gate below also proves the on-disk corpus is
 * exactly what the current declarations + emitter + bc produce.
 *
 * ## Content, never counts (#154, the #150 lesson)
 *
 * #150 was a real defect — typed-native relation ops returned children as EMPTY STRUCTS — and every
 * test passed it because conformance only ever compared ROW COUNTS. So the relation assertions here
 * are field-level (`checkRelationContent`), and the last describe block is a NEGATIVE CONTROL: it
 * reconstructs the #150 symptom out of the frozen expected value and proves the checker rejects it.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORPUS_VERSION,
  checkRelationContent,
  closeLiveConnections,
  runVector,
  type ExecVector,
  type Suite,
} from '../../conformance/harness';
import { checkCorpus } from '../../conformance/gen-vectors';

const VECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'conformance', 'vectors');

function loadSuites(): Suite[] {
  return readdirSync(VECTORS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(VECTORS_DIR, f), 'utf8')) as Suite);
}

const suites = loadSuites();
const execVectors = suites.flatMap((s) => s.vectors).filter((v): v is ExecVector => v.kind === 'exec');
const relationVectors = execVectors.filter((v) => v.relationFields !== undefined);

describe('WS7a conformance — the declared endpoints over the frozen vector corpus', () => {
  afterAll(closeLiveConnections);

  it('the on-disk corpus is byte-true to the current pipeline (drift gate)', async () => {
    // If this fails: the declarations, the emitter, `makesql` or bc changed. Regenerate with
    //   npx vitest run --config conformance/vitest.config.ts
    // review the diff, and re-commit.
    expect(await checkCorpus()).toEqual([]);
  }, 300_000);

  it('every suite declares the supported corpus version (fail-closed)', () => {
    expect(suites.length).toBeGreaterThan(0);
    for (const s of suites) expect(s.corpusVersion).toBe(CORPUS_VERSION);
  });

  for (const suite of suites) {
    describe(`suite: ${suite.suite} (${suite.vectors.length} vectors)`, () => {
      for (const v of suite.vectors) {
        it(`${v.kind}: ${v.name}`, async () => {
          const r = await runVector(v);
          expect(r.ok, r.detail).toBe(true);
        }, 60_000);
      }
    });
  }
});

// ── §10: the SAME declaration + input yields the SAME result on every dialect ─────────────────

describe('WS7a conformance — dialect invariance (§10), re-asserted from the frozen corpus', () => {
  const byCase = new Map<string, ExecVector[]>();
  for (const v of execVectors) byCase.set(v.case, [...(byCase.get(v.case) ?? []), v]);

  it('every exec case is captured on all three dialects', () => {
    expect(byCase.size).toBeGreaterThan(0);
    for (const [id, vs] of byCase) {
      expect(vs.map((v) => v.dialect).sort(), `case '${id}'`).toEqual(['mysql', 'postgres', 'sqlite']);
    }
  });

  for (const [id, vs] of byCase) {
    // A write's driver counters are dialect-specific (`lastInsertRowid`), so a write case's
    // invariant is its resulting DB STATE; a read's is the whole materialized result.
    const isWrite = vs[0].expectedDbState !== undefined;
    it(`case '${id}': ${isWrite ? 'DB state' : 'result'} is identical on sqlite / postgres / mysql`, () => {
      const key = (v: ExecVector): string => JSON.stringify(isWrite ? v.expectedDbState : v.expectedResult);
      for (const v of vs) expect(key(v), `${v.dialect} diverged`).toBe(key(vs[0]));
    });
  }
});

// ── Content-level relation assertions: a row count is NOT a check (#150) ──────────────────────

describe('WS7a conformance — relation CONTENT (#150: a count-only assertion is not an assertion)', () => {
  it('the corpus actually carries relation-bearing vectors (else there is nothing to check)', () => {
    expect(relationVectors.length).toBeGreaterThan(0);
    // Both nesting shapes must be covered: a hasMany list and a belongsTo single child.
    const paths = new Set(relationVectors.flatMap((v) => Object.keys(v.relationFields!)));
    expect(paths).toContain('posts');
    expect(paths).toContain('posts.tags');
    expect(paths).toContain('author');
  });

  for (const v of relationVectors) {
    it(`${v.name}: every nested child carries its declared FIELDS (not just a count)`, () => {
      expect(checkRelationContent(v.expectedResult, v.relationFields!)).toEqual([]);
    });
  }

  it('the frozen values are concrete, not placeholders — a two-level graph reads end to end', () => {
    const v = relationVectors.find((x) => x.entry === 'usersWithPosts' && x.dialect === 'sqlite');
    expect(v, 'the two-level relation vector is missing from the corpus').toBeDefined();
    expect(v!.expectedResult).toEqual([
      {
        id: 1,
        name: 'Ada',
        posts: [
          {
            id: 10,
            author_id: 1,
            title: 'a1',
            status: 'live',
            created_at: '2026-02-01',
            tags: [
              { id: 100, post_id: 10, label: 'greeting' },
              { id: 101, post_id: 10, label: 'first' },
            ],
          },
          { id: 11, author_id: 1, title: 'a2', status: 'draft', created_at: '2026-03-01', tags: [] },
        ],
      },
      {
        id: 2,
        name: 'Bob',
        posts: [
          {
            id: 12,
            author_id: 2,
            title: 'b1',
            status: 'live',
            created_at: '2026-01-15',
            tags: [{ id: 102, post_id: 12, label: 'world' }],
          },
        ],
      },
      { id: 3, name: 'Cy', posts: [] },
    ]);
  });
});

// ── NEGATIVE CONTROL: rebuild the #150 symptom and prove the checker rejects it ───────────────

describe('WS7a conformance — the relation content checker CATCHES the #150 defect', () => {
  const source = (): ExecVector => {
    const v = relationVectors.find((x) => x.entry === 'usersWithPosts' && x.dialect === 'sqlite');
    if (v === undefined) throw new Error('the two-level relation vector is missing from the corpus');
    return v;
  };

  /** Deep-map every object at the relation `path` of a frozen expected value. */
  const mapChildren = (rows: unknown, path: readonly string[], f: (c: Record<string, unknown>) => unknown): unknown =>
    (rows as Record<string, unknown>[]).map((row) => {
      const [seg, ...rest] = path;
      const child = row[seg];
      const next = Array.isArray(child)
        ? rest.length === 0
          ? child.map((c) => f(c as Record<string, unknown>))
          : mapChildren(child, rest, f)
        : child === null
          ? null
          : rest.length === 0
            ? f(child as Record<string, unknown>)
            : mapChildren([child], rest, f);
      return { ...row, [seg]: next };
    });

  it('EMPTY child structs (the exact #150 symptom) FAIL — a row count would still have passed', () => {
    const v = source();
    const broken = mapChildren(v.expectedResult, ['posts'], () => ({}));
    // The count is untouched: 2 + 1 + 0 posts, exactly as the good value has.
    const count = (rows: unknown): number => (rows as { posts: unknown[] }[]).reduce((n, r) => n + r.posts.length, 0);
    expect(count(broken)).toBe(count(v.expectedResult));
    // ...and yet the content check rejects it.
    expect(checkRelationContent(broken, v.relationFields!).length).toBeGreaterThan(0);
  });

  it('a child with the right SHAPE but all-null values FAILS', () => {
    const v = source();
    const nulled = mapChildren(v.expectedResult, ['posts', 'tags'], (c) =>
      Object.fromEntries(Object.keys(c).map((k) => [k, null])),
    );
    const problems = checkRelationContent(nulled, v.relationFields!);
    expect(problems.join('\n')).toMatch(/field '(id|post_id|label)' is absent\/null in EVERY child/);
  });

  it('a DROPPED field on one child FAILS (the shape contract is exact, not a subset)', () => {
    const v = source();
    const dropped = mapChildren(v.expectedResult, ['posts', 'tags'], (c) => {
      const { label: _label, ...rest } = c;
      return rest;
    });
    expect(checkRelationContent(dropped, v.relationFields!).join('\n')).toMatch(/fields \{id, post_id\} != declared/);
  });

  it('a relation that materialized NOTHING anywhere FAILS (an all-empty graph is not evidence)', () => {
    const v = source();
    const emptied = (v.expectedResult as Record<string, unknown>[]).map((r) => ({ ...r, posts: [] }));
    expect(checkRelationContent(emptied, v.relationFields!).join('\n')).toMatch(/no child object materialized/);
  });

  it('the UNMODIFIED frozen value passes (the checker is not vacuously failing)', () => {
    const v = source();
    expect(checkRelationContent(v.expectedResult, v.relationFields!)).toEqual([]);
  });
});
