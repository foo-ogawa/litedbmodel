// ════════════════════════════════════════════════════════════════════════════
// Cross-lang ORM-bench OP-SQL DERIVATION — everything a cell would otherwise GUESS about a statement.
// ════════════════════════════════════════════════════════════════════════════
//
//   npx tsx benchmark/crosslang/derive-ops.ts <dialect>
//
// Runs immediately after `lm_orm_native sql` has merged the captured `ops` into
// `.setup/<dialect>.json` (benchmark/crosslang/run-cells.sh), and completes that artifact with the two
// facts the SDK baselines used to hand-write per language (#172):
//
//   recover       the MySQL RETURNING recovery — MySQL cannot parse RETURNING, so the runtime's
//                 connection adapter strips the clause and re-SELECTs the written rows by the declared
//                 primary key (docs/architecture.md §6). That SELECT is issued BELOW the seam the
//                 capture listens on (`scpMysqlConn.QueryContext` → `queryViaStmt`,
//                 go/litedbmodel_runtime/livedb.go), so it cannot be captured — it is DERIVED here,
//                 from the captured write, by the library's own `buildMysqlReselect`
//                 (src/scp/makesql/mysql-returning.ts, "the one place this knowledge lives").
//
//                 Deriving it is not a convenience. All five SDK cells had hand-copied it, and all
//                 five were wrong against the runtime they are the baseline FOR: they issued
//                 `SELECT id FROM benchmark_users WHERE id = LAST_INSERT_ID()` where the runtime
//                 issues `… WHERE id >= ? AND id < ? ORDER BY id` over the AUTO_INCREMENT range, and
//                 dropped the `ORDER BY id` from the other two. Every one of them returns ONE row, so
//                 the rows/op check — the only cross-cell gate there was — passed on all of it.
//
//   batchColumns  the columns a BATCH write's statement reads, IN ITS OWN ORDER. PostgreSQL's
//                 `UNNEST(?::int[], ?::text[]) AS v(id, name)` takes one array PER COLUMN, so the
//                 order is load-bearing; go was sorting its record keys alphabetically and rust was
//                 relying on a fixed tuple position, both of which agree with the statement only by
//                 coincidence. The column list is a property of the SQL, so it is read off the SQL.
//
// Both are written back into the ONE artifact every language already loads. No cell parses a
// statement to decide how to bind it, and no cell holds a statement of its own.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildMysqlReselect, type ReselectBind } from '../../src/scp/makesql/mysql-returning.js';
import { ORM_DIALECTS, type OrmDialect } from './contract';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * One statement's MySQL RETURNING recovery, as the cells execute it: run `writeSql` (the write with
 * the RETURNING clause and the `/*scp:pk=…* /` hint removed), then fetch `selectSql` bound per
 * {@link ReselectBind}. Both statements together are ONE logical statement — which is what the
 * runtime's seam counts, so a cell tallies the recovered rows without bumping its statement count.
 */
export interface OpRecovery {
  readonly writeSql: string;
  readonly selectSql: string;
  readonly binds: readonly ReselectBind[];
}

/**
 * The bind kinds the cells implement, straight from `ReselectBind`:
 *   param   the write's own bound param at that index
 *   lastId  `LAST_INSERT_ID()` — the first AUTO_INCREMENT id the INSERT allocated
 *   highId  that id plus `max(1, affectedRows)` — the exclusive top of the inserted range
 *
 * `json` (a BATCH write's RETURNING, re-selected from the same JSON payload) is deliberately absent:
 * no op in `native-model.ts` declares RETURNING on a batch write, so no cell implements it. Meeting
 * one here is a HARD failure rather than a silent mis-bind — the whole point of this file is that a
 * cell never has to know what a statement wanted.
 */
const SUPPORTED_BINDS: ReadonlySet<ReselectBind['kind']> = new Set(['param', 'lastId', 'highId']);

/** The recovery for one captured statement, or null when it declares no RETURNING (most of them). */
function recoveryFor(sql: string): OpRecovery | null {
  const r = buildMysqlReselect(sql);
  if (r === null) return null;
  for (const b of r.binds) {
    if (!SUPPORTED_BINDS.has(b.kind)) {
      throw new Error(
        `derive-ops: the recovery for '${sql.slice(0, 70)}…' binds '${b.kind}', which no bench cell implements.\n` +
          `  Implement it in every cell's bind switch (they mirror ReselectBind), or the baselines will\n` +
          `  bind the recovery differently from the runtime they are the baseline for.`,
      );
    }
  }
  if (r.before) {
    throw new Error(
      `derive-ops: the recovery for '${sql.slice(0, 70)}…' must run BEFORE its write (a DELETE's rows are\n` +
        `  gone once it has run). Every cell issues the recovery AFTER the write, so this statement would\n` +
        `  silently recover nothing. Teach the cells the pre-image order before declaring it.`,
    );
  }
  return { writeSql: r.writeSql, selectSql: r.selectSql, binds: r.binds };
}

/**
 * The columns a batch write's statement reads, in the order the statement names them — or null when
 * the statement is not a batch record write.
 *
 * Two spellings, because the three dialects have two: PostgreSQL names them in the `UNNEST` alias
 * list, MySQL's `JSON_TABLE` and SQLite's `json_each` read each one by its OBJECT path (`'$.email'`).
 * A relation KEY set rides the same constructs but addresses `'$'` or `'$[0]'` — an array element,
 * never a named field — which is exactly what tells the two apart without naming any op here.
 *
 * ORDER is contractual only where the statement binds ONE ARRAY PER COLUMN, which is PostgreSQL's
 * `UNNEST` and nothing else — there the Nth array must be the Nth alias, and getting it from the
 * statement is the whole point. MySQL and SQLite bind the record set as a single JSON payload read
 * BY NAME, so for them this is a set and the order it happens to come out in means nothing: SQLite's
 * `updateMany` mentions `'$.name'` before `'$.id'` because its SET subquery precedes its WHERE.
 */
function batchColumns(sql: string): string[] | null {
  const unnest = /\bUNNEST\s*\([^)]*\)\s*AS\s+\w+\s*\(([^)]*)\)/i.exec(sql);
  if (unnest !== null) {
    const cols = unnest[1].split(',').map((c) => c.trim()).filter((c) => c.length > 0);
    if (cols.length > 0) return cols;
  }
  const cols: string[] = [];
  for (const [, col] of sql.matchAll(/'\$\.([A-Za-z_][A-Za-z0-9_]*)'/g)) if (!cols.includes(col)) cols.push(col);
  return cols.length > 0 ? cols : null;
}

/** Derive both maps for one dialect's captured `ops`. Exported so the unit gate can run it dry. */
export function derive(
  ops: Record<string, readonly string[]>,
  dialect: OrmDialect,
): { recover: Record<string, (OpRecovery | null)[]>; batchColumns: Record<string, string[]> } {
  const recover: Record<string, (OpRecovery | null)[]> = {};
  const batch: Record<string, string[]> = {};
  for (const [op, statements] of Object.entries(ops)) {
    // Only MySQL recovers: PostgreSQL and SQLite execute the declared `RETURNING id` as written, so a
    // recovery there would be a second statement the runtime never issues.
    if (dialect === 'mysql') {
      const rs = statements.map(recoveryFor);
      if (rs.some((r) => r !== null)) recover[op] = rs;
    }
    for (const sql of statements) {
      const cols = batchColumns(sql);
      if (cols !== null) batch[op] = cols;
    }
  }
  return { recover, batchColumns: batch };
}

/** Complete one dialect's artifact in place, preserving every field already in it. */
function main(argv: readonly string[]): void {
  const dialect = argv[0] as OrmDialect;
  if (!ORM_DIALECTS.includes(dialect)) {
    console.error(`usage: derive-ops.ts <${ORM_DIALECTS.join('|')}> (got ${argv[0] ?? 'nothing'})`);
    process.exit(1);
  }

  const path = join(HERE, '.setup', `${dialect}.json`);
  const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const ops = doc.ops as Record<string, string[]> | undefined;
  if (ops === undefined || Object.keys(ops).length === 0) {
    console.error(
      `✗ ${path} carries no captured \`ops\`, so there is nothing to derive from.\n` +
        `  Run the capture first: (cd go && go run -tags bench_${dialect} ./lm_bench/lm_orm_native/ sql)`,
    );
    process.exit(1);
  }

  const { recover, batchColumns: batch } = derive(ops, dialect);
  doc.recover = recover;
  doc.batchColumns = batch;
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  const recovered = Object.values(recover).reduce((n, rs) => n + rs.filter((r) => r !== null).length, 0);
  console.error(
    `  ✓ ${path} — ${recovered} recovery statement(s), ${Object.keys(batch).length} batch column list(s) derived`,
  );
}

// Run only when INVOKED, so the unit gate can import `derive` and exercise it against the committed
// generated modules with no artifact and no database in the picture.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2));
}
