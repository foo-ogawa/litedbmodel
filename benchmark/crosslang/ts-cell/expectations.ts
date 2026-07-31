// What every TypeScript mode expects of a run — the statement counts the safety pass asserts.
//
// The op INPUTS are not here: they come from the artifact every language reads
// (`.setup/<dialect>.json` `inputs`, declared in `benchmark/crosslang/contract.ts` and resolved by
// `cell.ts` `resolveInput`), so the three TypeScript modes and the eight other cells bind the same
// values. What remains below is the per-op statement count, which each of the ten cells still
// declares for itself.

/**
 * The statement count each op must issue. Relations prove 1 parent + 1 batched child per LEVEL
 * (N+1-free) regardless of parent fan-out; a batch write is ONE statement; a RETURNING-chained
 * transaction is BEGIN + 2 body + COMMIT. Identical to the go/rust/python/php cells' expectations.
 */
export const EXPECTED_STATEMENTS: Readonly<Record<string, number>> = {
  findAll: 1,
  filterPaginateSort: 1,
  findFirst: 1,
  findUnique: 1,
  nestedFindAll: 2,
  nestedFindFirst: 2,
  nestedFindUnique: 2,
  nestedRelations: 3,
  compositeRelations: 3,
  create: 1,
  update: 1,
  upsert: 1,
  createMany: 1,
  upsertMany: 1,
  updateMany: 1,
  nestedCreate: 4,
  nestedUpsert: 4,
  nestedUpdate: 4,
  delete: 4,
};

/** The ops whose count is BEGIN + body + COMMIT rather than plain queries (labelling only). */
export const TX_OPS: ReadonlySet<string> = new Set(['nestedCreate', 'nestedUpsert', 'nestedUpdate', 'delete']);
