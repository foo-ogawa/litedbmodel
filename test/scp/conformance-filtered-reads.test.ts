/**
 * The frozen conformance corpus answers ONLY the rows a read's conditions admit: a model's default filter
 * (`@model({ filter })`) on a declared read, and a relation's declared `where` and its target's default
 * filter on the relation batch — unlimited and per-parent `limit` alike.
 *
 * The corpus is captured FROM the pipeline, so it cannot by itself say whether a row should be there.
 * This test states the admitted ids independently (from the seed in `conformance/harness.ts`), so a
 * pipeline that drops a condition is caught on every dialect — and, since each language leg is
 * byte-compared against this same corpus, on every language.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Vector {
  readonly dialect: string;
  readonly entry: string;
  readonly input: Record<string, unknown>;
  readonly expectedResult: unknown;
}

const corpus = JSON.parse(readFileSync(join(__dirname, '../../conformance/vectors/exec.json'), 'utf8')) as {
  vectors: Vector[];
};

const idOf = (row: unknown): number => Number((row as { id: { $bigint: string } }).id.$bigint);
const vectorsOf = (entry: string): Vector[] => corpus.vectors.filter((v) => v.entry === entry);

describe('conformance corpus: filtered reads', () => {
  it('holds every filtered entry on all three dialects', () => {
    for (const entry of ['notes', 'notesByAuthor', 'usersWithFilteredRelations']) {
      expect(vectorsOf(entry).map((v) => v.dialect).sort()).toEqual(['mysql', 'postgres', 'sqlite']);
    }
  });

  it("a declared read applies the model's default filter", () => {
    for (const v of vectorsOf('notes')) expect((v.expectedResult as unknown[]).map(idOf)).toEqual([1, 3]);
    for (const v of vectorsOf('notesByAuthor')) expect((v.expectedResult as unknown[]).map(idOf)).toEqual([1]);
  });

  it("a relation batch applies its where and the target's default filter", () => {
    for (const v of vectorsOf('usersWithFilteredRelations')) {
      const users = v.expectedResult as Array<Record<string, unknown[]>>;
      const ids = (rel: string) => users.map((u) => u[rel].map(idOf));
      expect(ids('livePosts')).toEqual([[10], [12], []]);
      expect(ids('notes')).toEqual([[1], [3], []]);
      expect(ids('latestNote')).toEqual([[1], [3], []]);
    }
  });
});
