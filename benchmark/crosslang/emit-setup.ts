// ════════════════════════════════════════════════════════════════════════════
// Cross-lang ORM-bench SETUP emitter — the SINGLE seed source for EVERY cell.
// ════════════════════════════════════════════════════════════════════════════
//
//   npx tsx benchmark/crosslang/emit-setup.ts [scale]
//
// Reads the ONE schema+seed SSoT (`orm-domain.ts`: ddl / deleteStatements / seedTables /
// dropStatements) and writes, per dialect, a `.setup/<dialect>.json` that ALL EIGHT bench cells
// (rust/go/python/php × native/sdk) load at runtime and exec VERBATIM. No cell hand-writes a seed:
// each execs the identical `schema` (once, at open) + `delete`+`insert` (the canonical fixture,
// re-applied per op). This is data, not codegen — one artifact, every language reads it.
//
// It also carries `inputs`: the per-op values every cell binds, from the axis SSoT (`contract.ts`).
// The per-op SQL is merged in later by `lm_orm_native sql` (the `ops` field, captured from the
// generated module) and `derive-ops.ts`; between them a cell holds neither the statements nor the
// values, so two cells cannot be running different work (#172).
//
// `scale` (default 1) multiplies the child fan-outs via `scaleSeed`: scale 1 is the ORM-vs-ORM bench's
// own fixture, and a smaller scale re-runs the SAME ops over fewer rows so the report can separate the
// fixed per-call overhead from the per-row cost (#170).
//
// The `insert` statements are the seed rows rendered to LITERAL multi-row INSERTs (`VALUES (…),(…),…`,
// `INSERT_BATCH_ROWS` rows per statement) so a cell needs ZERO param-binding to seed — it just execs
// strings — and so a fixture of tens of thousands of rows re-applies in ~150 statements rather than one
// statement per row. Rendering is deterministic + dialect-correct (strings single-quoted with `''`
// escape; `published` is SMALLINT on every dialect, so it goes in as 1/0).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ddl, deleteStatements, analyzeStatements, seedTables, dropStatements, pgSeqResetStatements, scaleSeed, ORM_SEED,
  type OrmDialect, type SeedTable,
} from './orm-domain';
import { ORM_OP_INPUT, type OrmOpInput } from './contract';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '.setup');
const DIALECTS: OrmDialect[] = ['sqlite', 'mysql', 'postgres'];

/**
 * Rows per multi-row INSERT. 500 keeps every emitted statement well inside MySQL's default
 * `max_allowed_packet` and PostgreSQL's parameter-free literal path while cutting the per-op re-seed
 * from ~72,000 statements to ~150.
 */
const INSERT_BATCH_ROWS = 500;

/** One seed value as a SQL literal. */
function literal(v: unknown): string {
  if (typeof v === 'number') return String(v);
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** One table's rows as literal multi-row INSERTs, `INSERT_BATCH_ROWS` rows per statement. */
function insertStatements(t: SeedTable): string[] {
  const head = `INSERT INTO ${t.table} (${t.columns.join(', ')}) VALUES `;
  const out: string[] = [];
  for (let i = 0; i < t.rows.length; i += INSERT_BATCH_ROWS) {
    const chunk = t.rows.slice(i, i + INSERT_BATCH_ROWS);
    out.push(head + chunk.map((r) => `(${r.map(literal).join(', ')})`).join(', '));
  }
  return out;
}

interface SetupDoc {
  readonly dialect: OrmDialect;
  /** The fan-out multiplier this fixture was emitted at (1 = the ORM-vs-ORM bench's own fixture). */
  readonly scale: number;
  /** The canonical user count — a self-describing proof knob for every cell. */
  readonly users: number;
  /** Seeded rows per table — what the fixture HOLDS (what each op READS is measured per cell). */
  readonly counts: Record<string, number>;
  /**
   * The values every cell binds, per op, from the axis SSoT (`contract.ts` `ORM_OPS[].input`). SQL
   * comes from the generated module (`ops`, merged in by `lm_orm_native sql`); this is the other half
   * of "the same work", and it is DECLARED rather than captured because it is what the cells supply.
   * `{it}` inside a string is the iteration number, the one substitution a cell makes.
   */
  readonly inputs: Record<string, OrmOpInput>;
  readonly schema: string[]; // drop + create, applied ONCE at open.
  readonly delete: string[]; // empty every table (child→parent), applied before each re-seed.
  readonly insert: string[]; // the canonical fixture as literal INSERTs (+ pg SERIAL fixups).
}

const scale = Number(process.argv[2] ?? '1');
if (!(scale > 0)) throw new Error(`scale must be a positive number (got ${process.argv[2]})`);
const shape = scaleSeed(ORM_SEED, scale);
const tables = seedTables(shape);

mkdirSync(OUT_DIR, { recursive: true });
for (const dialect of DIALECTS) {
  const inserts = tables.flatMap(insertStatements);
  if (dialect === 'postgres') inserts.push(...pgSeqResetStatements());
  // Refresh optimizer statistics AFTER the rows land (and after the pg SERIAL fixups). Freshly
  // bulk-loaded tables with an index built on the empty table have stale stats, and MySQL then ignores
  // the relation index — 3.5s on the composite comments child read, vs 17ms once analyzed. Part of the
  // `insert` group so it re-runs on every per-op re-seed, all of it in the untimed seed.
  inserts.push(...analyzeStatements(dialect));
  const doc: SetupDoc = {
    dialect,
    scale,
    users: shape.users,
    counts: Object.fromEntries(tables.map((t) => [t.table, t.rows.length])),
    inputs: ORM_OP_INPUT,
    schema: [...dropStatements(dialect), ...ddl(dialect)],
    delete: deleteStatements(dialect),
    insert: inserts,
  };
  const path = join(OUT_DIR, `${dialect}.json`);
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  const total = tables.reduce((n, t) => n + t.rows.length, 0);
  console.error(`  ✓ ${path} — scale=${scale}, rows=${total}, schema=${doc.schema.length}, insert=${doc.insert.length}`);
}
