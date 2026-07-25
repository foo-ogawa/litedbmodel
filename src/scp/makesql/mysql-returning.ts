/**
 * litedbmodel v2 SCP — **MySQL has no `RETURNING`**: the one place that knowledge lives.
 *
 * A write compiled for the `mysql` dialect carries the SAME ` RETURNING <cols>` tail as the PG /
 * SQLite bundles (the compilers are dialect-neutral about it), plus a strip-before-execute
 * `/*scp:pk=…;ai=…[;conflict=…]* /` comment naming the target's REAL primary key. MySQL parses
 * neither, so the driver seam STRIPS both and recovers the written rows with a SELECT keyed on
 * whatever identifies them:
 *
 *  | write            | the rows are recovered by                                          | when      |
 *  |------------------|--------------------------------------------------------------------|-----------|
 *  | create           | the AUTO_INCREMENT range `[LAST_INSERT_ID, +affected)`, or the      | after     |
 *  |                  | client-supplied PK values pulled from the INSERT params by position |           |
 *  | createMany       | the same AUTO_INCREMENT range (N consecutive ids)                  | after     |
 *  | upsert / …Many   | the CONFLICT key (MySQL does not report the conflicted-row id, so   | after     |
 *  |                  | the AUTO_INCREMENT range is wrong when a row was UPDATED)          |           |
 *  | update           | the write's OWN WHERE predicate                                    | after     |
 *  | updateMany       | the batch JOIN key, re-bound from the SAME JSON payload            | after     |
 *  | delete/deleteMany| the write's OWN WHERE predicate — **before** the write, since the   | BEFORE    |
 *  |                  | rows no longer exist once the DELETE has run                       |           |
 *
 * The recovering SELECT runs on the SAME connection as the write, so inside a transaction it sees
 * the not-yet-committed rows — and a `DELETE`'s pre-image SELECT is inside the same transaction as
 * the delete it describes.
 *
 * This module is the TypeScript member of a 5-language SSoT: `rust/litedbmodel_runtime/src/livedb.rs`
 * (`build_mysql_reselect`), `go/litedbmodel_runtime/livedb.go`, `python/litedbmodel_runtime/driver.py`
 * and `php/src/LiveDb.php` derive the identical write/select/bind triple. Both TS execution paths —
 * the generated (codegen) leaf `executeSQL` and the mode-2 transaction plan — reach it through the
 * ONE mysql connection adapter (`pool-executor.mysqlConnection`), so they cannot return different rows.
 */

// TYPE-only (erased at compile time), so the tx module can import this one back without a cycle.
import type { TxOp } from './tx';

/** The strip-before-execute PK-hint comment marker. */
const MYSQL_PK_HINT_RE = /\s*\/\*scp:pk=[^*]*\*\//;

/**
 * Serialize a {@link TxOp.pk} descriptor into a strip-before-execute SQL comment appended to an
 * INSERT…RETURNING op, so the MySQL driver emulation can re-select by the REAL primary key. The
 * comment is STRIPPED (with the RETURNING clause) before the write executes, so the executed SQL
 * stays byte-clean; it is emitted ONLY into the mysql-dialect bundle (PG/SQLite keep native
 * RETURNING and never see it). Format: ` /*scp:pk=col1,col2;ai=<autoIncCol|>[;conflict=<cols>]* /`.
 *
 * `conflict` (the upsert conflict-target column list) is added when the write is an upsert — the mysql
 * driver re-selects the upserted row(s) by that key. Its source is `op.writeMeta.onConflict` (single
 * writes carry it); an ad-hoc TxOp built without writeMeta (the batch createMany/upsertMany path)
 * passes the columns via `onConflict`.
 */
export function mysqlPkHint(op: TxOp, onConflict?: string): TxOp {
  if (op.pk === undefined) return op;
  if (!/\breturning\b/i.test(op.sql)) return op;
  if (MYSQL_PK_HINT_RE.test(op.sql)) return op; // idempotent: never append a second hint
  const conflict = onConflict ?? op.writeMeta?.onConflict;
  const conflictPart = conflict !== undefined && conflict.length > 0 ? `;conflict=${conflict}` : '';
  const hint = ` /*scp:pk=${op.pk.columns.join(',')};ai=${op.pk.autoInc ?? ''}${conflictPart}*/`;
  return { ...op, sql: op.sql + hint };
}

/** Strip a trailing MySQL PK-hint comment from a rendered SQL (defensive; runtimes strip too). */
export function stripMysqlPkHint(sql: string): string {
  return sql.replace(MYSQL_PK_HINT_RE, '');
}

// ── the reselect derivation ───────────────────────────────────────────────────

/** How ONE `?` of the recovering SELECT is bound. */
export type ReselectBind =
  /** `LAST_INSERT_ID()` — the FIRST AUTO_INCREMENT id the INSERT allocated. */
  | { readonly kind: 'lastId' }
  /** `LAST_INSERT_ID() + affected` — the EXCLUSIVE upper bound of the inserted id range. */
  | { readonly kind: 'highId' }
  /** The batch JSON payload (`params[0]`) re-bound to the SELECT's own `JSON_TABLE(?)`. */
  | { readonly kind: 'json' }
  /** The write's own bound param at this index (a WHERE value, or a conflict/PK value by column position). */
  | { readonly kind: 'param'; readonly index: number };

/** The MySQL RETURNING recovery derived from a write's baked SQL + its `/*scp:pk=…* /` hint. */
export interface MysqlReselect {
  /** The write to execute — RETURNING clause and hint removed, byte-clean for the prepared protocol. */
  readonly writeSql: string;
  /** `SELECT <returning cols> FROM <table> WHERE <key predicate>[ ORDER BY <pk>]`. */
  readonly selectSql: string;
  /** How to bind {@link selectSql}'s `?`s. */
  readonly binds: readonly ReselectBind[];
  /**
   * Run the SELECT BEFORE the write instead of after. Only a DELETE needs this: its rows are gone
   * once it has run, so the pre-image IS the written row set (the same rows the DELETE removes).
   */
  readonly before: boolean;
}

/** The `,`-separated INSERT column list (`INSERT [IGNORE] INTO t (a, b, c)` → `['a','b','c']`). */
function insertCols(writeSql: string): string[] {
  const m = /\bINSERT\s+(?:IGNORE\s+)?INTO\s+[A-Za-z0-9_."`]+\s*\(([^)]*)\)/i.exec(writeSql);
  return m === null ? [] : m[1].split(',').map((c) => c.trim());
}

/** The target table — the identifier after `INSERT INTO` / `UPDATE` / `DELETE FROM`. */
function tableOf(writeSql: string): string | null {
  const m = /\b(?:INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z0-9_."`]+)/i.exec(writeSql);
  return m === null ? null : m[1];
}

/** The JOIN key column of an updateMany (`ON <alias>.<col> = JSON_UNQUOTE(…)`). */
function updateBatchKey(writeSql: string): string | null {
  const m = /\sON\s+[A-Za-z0-9_]*\.?([A-Za-z0-9_]+)\s*=/i.exec(writeSql);
  return m === null ? null : m[1];
}

/** The hint's `pk=` columns + `ai=` AUTO_INCREMENT column (absent hint ⇒ `[]` / `''`). */
function parsePkHint(hintRegion: string): { pk: string[]; autoInc: string } {
  const m = /\/\*scp:pk=([^;*]*);ai=([^;*]*)/i.exec(hintRegion);
  if (m === null) return { pk: [], autoInc: '' };
  return { pk: m[1].split(',').map((c) => c.trim()).filter((c) => c.length > 0), autoInc: m[2].trim() };
}

/** The hint's `conflict=` columns (the upsert conflict target). Empty ⇒ not an upsert. */
function parseConflictHint(hintRegion: string): string[] {
  const m = /;conflict=([^*]*)\*\//i.exec(hintRegion);
  if (m === null) return [];
  return m[1].split(',').map((c) => c.trim()).filter((c) => c.length > 0);
}

/** The `?` count of a SQL fragment (the write's params are positional, so a count IS an index). */
function placeholders(fragment: string): number {
  return (fragment.match(/\?/g) ?? []).length;
}

/**
 * Derive the MySQL RETURNING recovery for `sql`, or `null` when the statement declares no RETURNING
 * (a plain write / a SELECT — the caller runs it unchanged).
 *
 * Fail-closed: a RETURNING write whose key cannot be identified (an upsert with no `conflict=` hint,
 * an INSERT whose declared PK column is not in its column list, an UPDATE/DELETE with no WHERE)
 * THROWS rather than silently returning no rows — returning `[]` for a write the caller asked to
 * describe is exactly the defect this module exists to remove.
 */
export function buildMysqlReselect(sql: string): MysqlReselect | null {
  const retPos = sql.toLowerCase().lastIndexOf(' returning ');
  if (retPos < 0) return null;

  const hintRegion = sql.slice(retPos);
  const cols = stripMysqlPkHint(sql.slice(retPos + ' returning '.length)).trim();
  const { pk, autoInc } = parsePkHint(hintRegion);
  const conflict = parseConflictHint(hintRegion);
  const writeSql = stripMysqlPkHint(sql.slice(0, retPos)).trim();
  const lower = writeSql.toLowerCase();

  const table = tableOf(writeSql);
  if (table === null) throw new Error(`scp write(mysql): cannot parse the target table of '${writeSql.slice(0, 60)}…'`);
  // Order by the DECLARED pk so MySQL matches the pg/sqlite RETURNING order (§10 all-dialect parity).
  const orderBy = pk.length > 0 ? ` ORDER BY ${pk.join(', ')}` : '';
  const isBatch = lower.includes('json_table(');
  const done = (selectSql: string, binds: readonly ReselectBind[], before = false): MysqlReselect =>
    ({ writeSql, selectSql, binds, before });

  // upsert / upsertMany — by the CONFLICT key. MySQL does not report which row an ON DUPLICATE KEY
  // UPDATE touched, so the AUTO_INCREMENT range is wrong as soon as a row was updated, not inserted.
  if (lower.startsWith('insert') && lower.includes('on duplicate key update')) {
    const key = conflict[0];
    if (key === undefined) {
      throw new Error(`scp write(mysql): an upsert…RETURNING needs its conflict key in the pk hint ('${writeSql.slice(0, 60)}…')`);
    }
    if (isBatch) {
      return done(
        `SELECT ${cols} FROM ${table} WHERE ${key} IN (SELECT JSON_UNQUOTE(jt.${key}) FROM JSON_TABLE(?, '$[*]' COLUMNS(${key} JSON PATH '$.${key}')) jt)${orderBy}`,
        [{ kind: 'json' }],
      );
    }
    const index = insertCols(writeSql).indexOf(key);
    if (index < 0) throw new Error(`scp write(mysql): conflict key '${key}' is not among the INSERT columns of '${writeSql.slice(0, 60)}…'`);
    return done(`SELECT ${cols} FROM ${table} WHERE ${key} = ?${orderBy}`, [{ kind: 'param', index }]);
  }

  // create / createMany — by the AUTO_INCREMENT range [LAST_INSERT_ID, +affected), or by the
  // client-supplied PK values pulled from the INSERT params by column position (UUID / composite).
  if (lower.startsWith('insert')) {
    if (autoInc !== '' && pk.length === 1 && pk[0] === autoInc) {
      return done(`SELECT ${cols} FROM ${table} WHERE ${autoInc} >= ? AND ${autoInc} < ?${orderBy}`, [
        { kind: 'lastId' },
        { kind: 'highId' },
      ]);
    }
    if (pk.length === 0) {
      throw new Error(
        `scp write(mysql): an INSERT…RETURNING carries no pk hint, so its written rows cannot be identified ` +
          `('${writeSql.slice(0, 60)}…'). The producer must pass the model's declared primary key.`,
      );
    }
    const cols4 = insertCols(writeSql);
    const binds: ReselectBind[] = [];
    const conds: string[] = [];
    for (const c of pk) {
      const index = cols4.indexOf(c);
      if (index < 0) throw new Error(`scp write(mysql): PK column '${c}' is not among the INSERT columns of '${writeSql.slice(0, 60)}…'`);
      conds.push(`${c} = ?`);
      binds.push({ kind: 'param', index });
    }
    return done(`SELECT ${cols} FROM ${table} WHERE ${conds.join(' AND ')}${orderBy}`, binds);
  }

  // updateMany — by the batch JOIN key, re-selected from the SAME JSON payload the write bound.
  if (lower.startsWith('update') && isBatch) {
    const key = updateBatchKey(writeSql);
    if (key === null) throw new Error(`scp write(mysql): cannot parse the batch JOIN key of '${writeSql.slice(0, 60)}…'`);
    return done(
      `SELECT ${cols} FROM ${table} WHERE ${key} IN (SELECT JSON_UNQUOTE(jt.${key}) FROM JSON_TABLE(?, '$[*]' COLUMNS(${key} JSON PATH '$.${key}')) jt)${orderBy}`,
      [{ kind: 'json' }],
    );
  }

  // update / delete — by the write's OWN WHERE predicate, bound from the write's own params. The
  // UPDATE re-selects AFTER the write (the rows carry their new values); the DELETE re-selects
  // BEFORE it (afterwards there is nothing left to describe).
  const wherePos = lower.lastIndexOf(' where ');
  if (wherePos < 0) {
    throw new Error(`scp write(mysql): a ${lower.startsWith('delete') ? 'DELETE' : 'UPDATE'}…RETURNING needs a WHERE to recover its rows ('${writeSql.slice(0, 60)}…')`);
  }
  const whereSql = writeSql.slice(wherePos + ' where '.length).trim();
  const before = placeholders(writeSql.slice(0, wherePos));
  const binds: ReselectBind[] = [];
  for (let i = 0; i < placeholders(whereSql); i++) binds.push({ kind: 'param', index: before + i });
  return done(`SELECT ${cols} FROM ${table} WHERE ${whereSql}${orderBy}`, binds, lower.startsWith('delete'));
}

/** Bind {@link MysqlReselect.binds} against the write's params + the write's own result. */
export function bindReselect(
  binds: readonly ReselectBind[],
  params: readonly unknown[],
  lastInsertId: number,
  affected: number,
): unknown[] {
  return binds.map((b) => {
    switch (b.kind) {
      case 'lastId':
        return lastInsertId;
      case 'highId':
        return lastInsertId + Math.max(1, affected);
      case 'json':
        return params[0];
      case 'param':
        return params[b.index];
    }
  });
}
