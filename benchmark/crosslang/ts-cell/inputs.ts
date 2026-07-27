// The per-op INPUTS every TypeScript mode drives, in one place.
//
// The three modes (codegen / v1 / sdk) must issue the same logical work or their numbers are not
// comparable, and they must match what the go/rust/python/php cells do or the CROSS-language table is
// not comparable either. `go/lm_bench/lm_orm_native/main.go`'s `op()` is the reference; these are the
// same values, keyed by the parameter names the authored `@behavior` methods declare
// (benchmark/crosslang/native-model.ts), which is also the shape `bindTyped`'s input Scope takes.
//
// `it` is the iteration: ops with a UNIQUE column vary by it so a timed loop stays insertable;
// `upsertMany` deliberately does NOT (it conflict-updates the same 10 rows every time).

/** One batch record for createMany / upsertMany. */
export interface NewUser {
  email: string;
  name: string;
}
/** One batch record for updateMany (keyed on the seeded ids 1..10). */
export interface UserPatch {
  /**
   * `bigint`, not `number`: the authored model declares this column `Int`, and bc's `int` value model on
   * the TS plane is a BigInt — a JS number is classified as a FLOAT and the op fails its outType check
   * (`expected int, got float`). The other languages' harnesses pass a native int64 already.
   */
  id: bigint;
  name: string;
}

export function userRows(it: number, stable: boolean): NewUser[] {
  return Array.from({ length: 10 }, (_, i) => ({
    email: stable ? `many${i}@bench.com` : `many${it}_${i}@bench.com`,
    name: `Many ${i}`,
  }));
}

export function updateManyRows(): UserPatch[] {
  return Array.from({ length: 10 }, (_, i) => ({ id: BigInt(i + 1), name: `Many ${i + 1}` }));
}

/** The input Scope for one op at iteration `it` (empty for the no-argument reads). */
export function inputFor(op: string, it: number): Record<string, unknown> {
  switch (op) {
    case 'findAll':
    case 'nestedFindAll':
    case 'nestedRelations':
    case 'compositeRelations':
      return {};
    case 'filterPaginateSort':
      return { published: 1 };
    case 'findFirst':
    case 'nestedFindFirst':
      return { name: 'User%' };
    case 'findUnique':
      return { email: 'user500@example.com' };
    case 'nestedFindUnique':
      return { email: 'user1@example.com' };
    case 'create':
      return { email: `new${it}@bench.com`, name: 'New' };
    case 'update':
      return { id: 1, name: 'Updated 1' };
    case 'upsert':
      return { email: 'user1@example.com', name: 'Upserted One' };
    case 'createMany':
      return { rows: userRows(it, false) };
    case 'upsertMany':
      return { rows: userRows(it, true) };
    case 'updateMany':
      return { rows: updateManyRows() };
    case 'nestedCreate':
      return { email: `nc${it}@bench.com`, name: 'NC', title: 'NC Post' };
    case 'nestedUpsert':
      return { email: 'user1@example.com', name: 'NUp', title: 'NUp Post' };
    case 'nestedUpdate':
      return { id: 1, name: 'NU', title: 'NU Post' };
    case 'delete':
      return { email: `del${it}@bench.com`, name: 'Del' };
    default:
      throw new Error(`unknown op ${op}`);
  }
}

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
