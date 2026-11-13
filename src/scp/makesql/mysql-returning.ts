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
 *  | createMany       | the AUTO_INCREMENT ids from LAST_INSERT_ID up that this transaction | after     |
 *  |                  | can see (a bulk INSERT's ids need not be consecutive), or the      |           |
 *  |                  | client-supplied PK tuples read back out of the SAME JSON payload    |           |
 *  | upsert / …Many   | EVERY column of the CONFLICT key (MySQL does not report the         | after     |
 *  |                  | conflicted-row id, so the AUTO_INCREMENT range is wrong when a row  |           |
 *  |                  | was UPDATED) — one column of a composite key names other rows too   |           |
 *  | insert-or-ignore | as create, and ONLY the row it inserted (`;action=ignore`): it runs | after     |
 *  |                  | as the PLAIN INSERT, and a duplicate-key error is the conflict it   |           |
 *  |                  | skipped — it wrote nothing, so it returns nothing                   |           |
 *  | update           | the PK of every row its WHERE names, read and LOCKED (FOR UPDATE)  | lock      |
 *  |                  | before the write; the rows re-selected by those keys after it      | + after   |
 *  | updateMany       | EVERY batch JOIN key column, re-bound from the SAME JSON payload   | after     |
 *  | delete/deleteMany| the write's OWN WHERE predicate, read and LOCKED (FOR UPDATE) —     | BEFORE    |
 *  |                  | **before** the write; it must remove exactly those rows (affected) |           |
 *
 * The recovering SELECT runs on the SAME connection as the write, and the steps run ATOMICALLY: inside
 * the caller's transaction when the connection is in one, else inside their own `BEGIN … COMMIT` (a
 * failed recovery rolls its own write back). So the SELECT sees the not-yet-committed rows, and a
 * `DELETE`'s pre-image SELECT is inside the same transaction as the delete it describes.
 *
 * Wherever the recovery cannot be exact it FAILS CLOSED: an INSERT knows how many rows it wrote
 * ({@link WrittenRows}), and the recovered set must be exactly that many ({@link checkRecovered}).
 *
 * This module is the TypeScript member of a 5-language SSoT: `rust/litedbmodel_runtime/src/livedb.rs`
 * (`build_mysql_reselect`), `go/litedbmodel_runtime/livedb.go`, `python/litedbmodel_runtime/driver.py`
 * and `php/src/LiveDb.php` derive the identical write/select/bind triple. Every TS execution path —
 * the generated (codegen) leaf `executeSQL`, the mode-2 transaction plan, and the v1 MySQL driver
 * (`src/drivers/mysql.ts`, DBModel with a v1 middleware registered) — runs it through the ONE executor
 * (`pool-executor.mysqlReturning`), so they cannot return different rows.
 */

// TYPE-only (erased at compile time), so the tx module can import this one back without a cycle.
import type { TxOp } from './tx';

/** MySQL's duplicate-key error (`ER_DUP_ENTRY`): the conflict a {@link MysqlReselect.duplicateIsSkip} write skipped. */
export const MYSQL_ER_DUP_ENTRY = 1062;

/** The strip-before-execute PK-hint comment marker. */
const MYSQL_PK_HINT_RE = /\s*\/\*scp:pk=[^*]*\*\//;

/**
 * Serialize a {@link TxOp.pk} descriptor into a strip-before-execute SQL comment appended to an
 * INSERT…RETURNING op, so the MySQL driver emulation can re-select by the REAL primary key. The
 * comment is STRIPPED (with the RETURNING clause) before the write executes, so the executed SQL
 * stays byte-clean; it is emitted ONLY into the mysql-dialect bundle (PG/SQLite keep native
 * RETURNING and never see it). Format:
 * ` /*scp:pk=col1,col2;ai=<autoIncCol|>[;conflict=<cols>[;action=ignore]]* /`.
 *
 * `conflict` (the upsert conflict-target column list) is added when the write is an upsert — the mysql
 * driver re-selects the upserted row(s) by that key. `action=ignore` marks an insert-or-ignore: MySQL
 * spells it `ON DUPLICATE KEY UPDATE c = c`, which reads exactly like an upsert, but it WRITES NOTHING
 * on a conflict — so its RETURNING is only the row it inserted, never the conflicting row. Their source
 * is `op.writeMeta.onConflict` / `.onConflictAction` (single writes carry them); an ad-hoc TxOp built
 * without writeMeta (the batch createMany/upsertMany path) passes them via `onConflict` / `action`.
 */
export function mysqlPkHint(op: TxOp, onConflict?: string, action?: 'ignore'): TxOp {
  if (op.pk === undefined) return op;
  if (!/\breturning\b/i.test(op.sql)) return op;
  if (MYSQL_PK_HINT_RE.test(op.sql)) return op; // idempotent: never append a second hint
  const conflict = onConflict ?? op.writeMeta?.onConflict;
  const ignore = (action ?? op.writeMeta?.onConflictAction) === 'ignore';
  const conflictPart = conflict !== undefined && conflict.length > 0 ? `;conflict=${conflict}${ignore ? ';action=ignore' : ''}` : '';
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

/**
 * How many rows an INSERT wrote — the count its recovered rows must equal (else the recovery FAILS
 * CLOSED: it would be describing rows the write did not write). `null` for a write whose rows are not
 * countable from its result (an upsert counts an updated row twice; an UPDATE / DELETE).
 *
 *  - `affected` — the affected-row count. A plain INSERT and an `INSERT IGNORE` never update a row,
 *    so `CLIENT_FOUND_ROWS` cannot change it: it IS the number of rows inserted.
 */
export type WrittenRows = 'affected';

/** The MySQL RETURNING recovery derived from a write's baked SQL + its `/*scp:pk=…* /` hint. */
export interface MysqlReselect {
  /** The write to execute — RETURNING clause and hint removed, byte-clean for the prepared protocol. */
  readonly writeSql: string;
  /** `SELECT <returning cols> FROM <table> WHERE <key predicate>[ ORDER BY <pk>]`. */
  readonly selectSql: string;
  /** How to bind {@link selectSql}'s `?`s. */
  readonly binds: readonly ReselectBind[];
  /** How many rows the write wrote — see {@link WrittenRows}; `null` ⇒ not countable. */
  readonly written: WrittenRows | null;
  /**
   * A consistent read to run BEFORE the write, in the same transaction (`''` ⇒ none). A bulk INSERT's
   * AUTO_INCREMENT ids are NOT consecutive (`innodb_autoinc_lock_mode=2`): rows other sessions insert
   * meanwhile can take ids between and after ours. Anchoring the transaction's read view before the
   * write makes those rows — committed after it — invisible to the recovering SELECT (under REPEATABLE
   * READ), while our own uncommitted rows stay visible; the {@link checkRecovered} count check fails
   * anything else (another isolation level) closed.
   */
  readonly anchorSql: string;
  /**
   * An UPDATE's lock-and-key step, run BEFORE the write (`''` ⇒ none): `SELECT <pk> … WHERE <where>
   * … FOR UPDATE` names — and locks — exactly the rows the UPDATE is about to write, bound by
   * {@link lockBinds}. The UPDATE then cannot be told apart from its own WHERE re-evaluated afterwards
   * (an UPDATE that changes a WHERE column no longer matches it; one that runs in autocommit could
   * match rows another session wrote meanwhile), so its rows are recovered by THESE keys:
   * {@link selectSql} is then the head `SELECT <cols> FROM <table> WHERE (<pk>) IN ` that
   * {@link keyedSelectSql} completes with one tuple per locked row.
   */
  readonly lockSql: string;
  /** How to bind {@link lockSql}'s `?`s. */
  readonly lockBinds: readonly ReselectBind[];
  /** The key columns {@link lockSql} reads, in order (the declared PK). */
  readonly keyCols: readonly string[];
  /**
   * A single-row insert-or-ignore: {@link writeSql} is the PLAIN INSERT — its no-op `ON DUPLICATE KEY
   * UPDATE c = c` tail removed — so a conflict on ANY unique key raises MySQL's duplicate-key error
   * ({@link MYSQL_ER_DUP_ENTRY}) instead of silently doing nothing. That error IS the skipped conflict:
   * MySQL rolls back only the statement, the transaction goes on, and the write returns `[]`. A write that
   * succeeds inserted the row, which is recovered by its key like a create. Nothing reads an affected
   * count (CLIENT_FOUND_ROWS counts a no-op conflict like an insert) and nothing takes a lock, so it
   * holds under every isolation level — a lock taken before the write leaves no gap lock under READ
   * COMMITTED, and another session's row of the same key inserted in between would be read back as ours.
   */
  readonly duplicateIsSkip: boolean;
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

/**
 * How many rows a `VALUES (?, …), (?, …)` INSERT writes when EVERY value is a bare `?` (each tuple then
 * binds its `ncols` params in column order, so row `r`'s column `c` is param `r * ncols + c`), else `null`:
 * a value that is an SQL expression (`NOW()`, a cast) moves every `?` after it, so no column's param
 * position is known.
 */
function valuesRows(writeSql: string, ncols: number): number | null {
  const m = /\)\s*VALUES\s*(\(\s*\?(?:\s*,\s*\?)*\s*\)(?:\s*,\s*\(\s*\?(?:\s*,\s*\?)*\s*\))*)\s*(?:ON\s+DUPLICATE\s+KEY\s+UPDATE\b|$)/i.exec(writeSql);
  if (m === null) return null;
  const tuples = m[1].match(/\([^)]*\)/g) ?? [];
  return tuples.every((t) => placeholders(t) === ncols) ? tuples.length : null;
}

/**
 * How a BATCH write reads its rows out of its ONE JSON payload: its `JSON_TABLE(?, '$[*]' COLUMNS(…))`
 * source with the alias it gives it, verbatim, and the expression it reads each key-able column with —
 * an updateMany's `ON u.<k> = <expr>` (`json-batch.ts` `mysqlUpdateManyJson`), an INSERT's SELECT list by
 * INSERT column position (`mysqlInsertJson`). The recovering SELECT reuses both as they are, so it
 * compares every key EXACTLY as the write did: a `COLUMNS` declaration alone does not say how (a `JSON`
 * column is read both as unquoted text and as a JSON value). `null` when the write reads no JSON_TABLE.
 * A conjunct / select item that does not parse leaves its column out — the caller fails it closed.
 */
function batchReads(writeSql: string): { source: string; reads: Map<string, string> } | null {
  const lower = writeSql.toLowerCase();
  const jt = lower.indexOf('json_table(');
  if (jt < 0) return null;
  // The JSON_TABLE(…) call: its own parentheses at depth 0, skipping quoted paths.
  let depth = 0;
  let quoted = false;
  let end = -1;
  for (let i = jt + 'json_table'.length; i < writeSql.length && end < 0; i++) {
    const ch = writeSql[i];
    if (quoted) {
      if (ch === "'") quoted = false;
    } else if (ch === "'") {
      quoted = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) end = i;
    }
  }
  const alias = end < 0 ? null : /^\s+(?:AS\s+)?([A-Za-z0-9_]+)/i.exec(writeSql.slice(end + 1));
  if (alias === null) return null;
  const source = `${writeSql.slice(jt, end + 1)} AS ${alias[1]}`;
  const reads = new Map<string, string>();
  if (lower.startsWith('update')) {
    const on = /\sON\s+([\s\S]*?)\s+SET\s/i.exec(writeSql);
    for (const conj of on === null ? [] : on[1].split(/\s+AND\s+/i)) {
      const m = /^[A-Za-z0-9_]*\.?([A-Za-z0-9_]+)\s*=\s*([\s\S]+)$/.exec(conj.trim());
      if (m !== null) reads.set(m[1], m[2].trim());
    }
  } else {
    const select = /\)\s*SELECT\s+/i.exec(writeSql);
    const from = lower.indexOf(' from json_table(');
    if (select !== null && from > select.index) {
      const items = splitTopLevel(writeSql.slice(select.index + select[0].length, from));
      const columns = insertCols(writeSql);
      if (items.length === columns.length) columns.forEach((c, i) => reads.set(c, items[i]));
    }
  }
  return { source, reads };
}

/** Split a comma list on the commas at its own depth (outside parentheses and quotes); entries trimmed. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quoted) {
      if (ch === "'") quoted = false;
    } else if (ch === "'") {
      quoted = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out;
}

/** The target table — the identifier after `INSERT INTO` / `UPDATE` / `DELETE FROM`. */
function tableOf(writeSql: string): string | null {
  const m = /\b(?:INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z0-9_."`]+)/i.exec(writeSql);
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
  const m = /;conflict=([^;*]*)/i.exec(hintRegion);
  if (m === null) return [];
  return m[1].split(',').map((c) => c.trim()).filter((c) => c.length > 0);
}

/** The hint's `action=ignore` (an insert-or-ignore). */
function parseIgnoreHint(hintRegion: string): boolean {
  return /;action=ignore[;*]/i.test(hintRegion);
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
  const stripped = stripMysqlPkHint(sql.slice(0, retPos)).trim();
  // An insert-or-ignore is spelled `ON DUPLICATE KEY UPDATE c = c` — it reads like an upsert, but it writes
  // NOTHING on a conflict. It runs as the plain INSERT instead, so the conflict it skips is a duplicate-key
  // error rather than a no-op that reports like an insert ({@link MysqlReselect.duplicateIsSkip}).
  const odku = stripped.toLowerCase().indexOf(' on duplicate key update ');
  const duplicateIsSkip = parseIgnoreHint(hintRegion) && odku >= 0;
  const writeSql = duplicateIsSkip ? stripped.slice(0, odku).trim() : stripped;
  const lower = writeSql.toLowerCase();

  const table = tableOf(writeSql);
  if (table === null) throw new Error(`scp write(mysql): cannot parse the target table of '${writeSql.slice(0, 60)}…'`);
  // Order by the DECLARED pk so MySQL matches the pg/sqlite RETURNING order (§10 all-dialect parity).
  const orderBy = pk.length > 0 ? ` ORDER BY ${pk.join(', ')}` : '';
  const isBatch = lower.includes('json_table(');
  const done = (selectSql: string, binds: readonly ReselectBind[], written: WrittenRows | null = null, before = false, anchorSql = ''): MysqlReselect =>
    ({ writeSql, selectSql, binds, written, before, anchorSql, lockSql: '', lockBinds: [], keyCols: [], duplicateIsSkip });
  const writeCols = insertCols(writeSql);
  /**
   * Recover a BATCH write's rows by reading its key TUPLES back out of the SAME JSON payload it bound —
   * every key column, never the first alone (a composite key's first column names other rows too) —
   * through the write's OWN `JSON_TABLE` source and the write's OWN read expression of each key
   * ({@link batchReads}), so each key compares EXACTLY as the write compared or wrote it. Any other read
   * can compare differently: a key the write reads as a JSON value (`v.k`) or as a BIGINT, re-read as the
   * `JSON_UNQUOTE` string, is compared with a BIGINT column as DOUBLE, which past 2^53 matches the
   * neighbouring keys too — rows the write never touched. A key with no read expression in the write is
   * not one the write keyed by: that fails closed.
   */
  const jsonSelect = (keys: readonly string[], what: string, written: WrittenRows | null): MysqlReselect => {
    const batch = batchReads(writeSql);
    if (batch === null) throw new Error(`scp write(mysql): cannot parse the JSON_TABLE source of '${writeSql.slice(0, 60)}…'`);
    const reads = keys.map((k) => {
      const read = batch.reads.get(k);
      if (read === undefined) throw new Error(`scp write(mysql): ${what} column '${k}' has no read expression in '${writeSql.slice(0, 60)}…', so its rows cannot be matched the way it wrote them`);
      return read;
    });
    return done(`SELECT ${cols} FROM ${table} WHERE (${keys.join(', ')}) IN (SELECT ${reads.join(', ')} FROM ${batch.source})${orderBy}`, [{ kind: 'json' }], written);
  };
  /**
   * Recover a VALUES INSERT's rows by EVERY key column of EVERY row, each bound from its own param —
   * row `r`'s column `c` (its INSERT column position) is param `r * ncols + c` ({@link valuesRows}). Keying
   * a multi-row INSERT by its first row alone would drop the rest.
   */
  const keyedByInsertParams = (keys: readonly string[], what: string, written: WrittenRows | null): MysqlReselect => {
    const positions = keys.map((k) => {
      const index = writeCols.indexOf(k);
      if (index < 0) throw new Error(`scp write(mysql): ${what} column '${k}' is not among the INSERT columns of '${writeSql.slice(0, 60)}…'`);
      return index;
    });
    const rows = valuesRows(writeSql, writeCols.length);
    if (rows === null) {
      throw new Error(`scp write(mysql): the ${what} of '${writeSql.slice(0, 60)}…' cannot be bound from its params — a VALUES value that is not a bare \`?\` moves the param of every column after it`);
    }
    const binds: ReselectBind[] = [];
    for (let r = 0; r < rows; r++) for (const c of positions) binds.push({ kind: 'param', index: r * writeCols.length + c });
    const where = rows === 1
      ? keys.map((k) => `${k} = ?`).join(' AND ')
      : `(${keys.join(', ')}) IN (${Array.from({ length: rows }, () => `(${keys.map(() => '?').join(', ')})`).join(', ')})`;
    return done(`SELECT ${cols} FROM ${table} WHERE ${where}${orderBy}`, binds, written);
  };
  const upsert = lower.includes('on duplicate key update');
  if (duplicateIsSkip && isBatch) {
    throw new Error(`scp write(mysql): a batch insert-or-ignore…RETURNING is an INSERT IGNORE, not an ON DUPLICATE KEY UPDATE ('${writeSql.slice(0, 60)}…')`);
  }

  // upsert / upsertMany — by EVERY column of the CONFLICT key. MySQL does not report which row an ON
  // DUPLICATE KEY UPDATE touched, so the AUTO_INCREMENT range is wrong as soon as a row was updated.
  if (lower.startsWith('insert') && upsert) {
    if (conflict.length === 0) {
      throw new Error(`scp write(mysql): an upsert…RETURNING needs its conflict key in the pk hint ('${writeSql.slice(0, 60)}…')`);
    }
    return isBatch ? jsonSelect(conflict, 'conflict key', null) : keyedByInsertParams(conflict, 'conflict key', null);
  }

  // create / createMany / insert-or-ignore — by the AUTO_INCREMENT range [LAST_INSERT_ID, +affected),
  // or by the client-supplied PK values pulled from the INSERT params by column position (UUID /
  // composite). Recovered only when it wrote a row, and only as many rows as it wrote (WrittenRows).
  if (lower.startsWith('insert')) {
    if (autoInc !== '' && pk.length === 1 && pk[0] === autoInc && isBatch) {
      // createMany (a bulk INSERT…SELECT): its ids start at LAST_INSERT_ID but need not be consecutive,
      // so the bare range would name other sessions' rows and miss our own. Every id it allocated is
      // ≥ LAST_INSERT_ID; the anchored read view hides other sessions' rows; the count check fails the
      // rest closed.
      return done(`SELECT ${cols} FROM ${table} WHERE ${autoInc} >= ?${orderBy}`, [{ kind: 'lastId' }], 'affected', false, `SELECT 1 FROM ${table} LIMIT 1`);
    }
    if (autoInc !== '' && pk.length === 1 && pk[0] === autoInc) {
      // A single-row / multi-VALUES INSERT reserves its ids up front, so they ARE consecutive.
      return done(`SELECT ${cols} FROM ${table} WHERE ${autoInc} >= ? AND ${autoInc} < ?${orderBy}`, [
        { kind: 'lastId' },
        { kind: 'highId' },
      ], 'affected');
    }
    if (pk.length === 0) {
      throw new Error(
        `scp write(mysql): an INSERT…RETURNING carries no pk hint, so its written rows cannot be identified ` +
          `('${writeSql.slice(0, 60)}…'). The producer must pass the model's declared primary key.`,
      );
    }
    // createMany with a CLIENT-supplied key: the statement binds ONE JSON payload, not one param per
    // key, so the key tuples are read back out of that SAME payload — as the upsertMany arm does. A
    // batch `INSERT IGNORE` reads back pre-existing rows too, so its count check fails it closed.
    return isBatch ? jsonSelect(pk, 'PK', 'affected') : keyedByInsertParams(pk, 'PK', 'affected');
  }

  // updateMany — by EVERY batch JOIN key column (each conjunct of its `ON`), re-selected from the SAME
  // JSON payload the write bound.
  if (lower.startsWith('update') && isBatch) {
    const on = /\sON\s+([\s\S]*?)\s+SET\s/i.exec(writeSql);
    const keys = (on === null ? [] : on[1].split(/\s+AND\s+/i)).map((conj) => /^[A-Za-z0-9_]*\.?([A-Za-z0-9_]+)\s*=/.exec(conj.trim())?.[1] ?? '');
    if (keys.length === 0 || keys.includes('')) throw new Error(`scp write(mysql): cannot parse the batch JOIN key of '${writeSql.slice(0, 60)}…'`);
    return jsonSelect(keys, 'JOIN key', null);
  }

  // update / delete — the rows the write's OWN WHERE predicate names, bound from the write's own
  // params. The DELETE re-selects BEFORE it (afterwards there is nothing left to describe).
  const wherePos = lower.lastIndexOf(' where ');
  if (wherePos < 0) {
    throw new Error(`scp write(mysql): a ${lower.startsWith('delete') ? 'DELETE' : 'UPDATE'}…RETURNING needs a WHERE to recover its rows ('${writeSql.slice(0, 60)}…')`);
  }
  const whereSql = writeSql.slice(wherePos + ' where '.length).trim();
  const before = placeholders(writeSql.slice(0, wherePos));
  const binds: ReselectBind[] = [];
  for (let i = 0; i < placeholders(whereSql); i++) binds.push({ kind: 'param', index: before + i });
  // The DELETE: its pre-image is a LOCKING read — it reads the latest committed rows (not an older
  // snapshot) and holds them, so no other session can remove them first — and the DELETE must remove
  // exactly those rows: its affected count is checked against the pre-image ('affected').
  if (lower.startsWith('delete')) return done(`SELECT ${cols} FROM ${table} WHERE ${whereSql}${orderBy} FOR UPDATE`, binds, 'affected', true);
  // The UPDATE: lock the rows its WHERE names and read their keys BEFORE the write, then recover the
  // written rows (carrying their new values) by those keys — never by the WHERE re-evaluated after it.
  if (pk.length === 0) {
    throw new Error(
      `scp write(mysql): an UPDATE…RETURNING carries no pk hint, so the rows it writes cannot be keyed ` +
        `('${writeSql.slice(0, 60)}…'). The producer must pass the model's declared primary key.`,
    );
  }
  return {
    ...done(`SELECT ${cols} FROM ${table} WHERE (${pk.join(', ')}) IN `, []),
    lockSql: `SELECT ${pk.join(', ')} FROM ${table} WHERE ${whereSql}${orderBy} FOR UPDATE`,
    lockBinds: binds,
    keyCols: pk,
  };
}

/**
 * {@link MysqlReselect.selectSql} completed for `rows` locked keys: one `(?, …)` tuple per row, in the
 * declared PK order. Bind the locked rows' key values, row by row, in {@link MysqlReselect.keyCols} order.
 */
export function keyedSelectSql(reselect: MysqlReselect, rows: number): string {
  const tuple = `(${reselect.keyCols.map(() => '?').join(', ')})`;
  return `${reselect.selectSql}(${Array.from({ length: rows }, () => tuple).join(', ')}) ORDER BY ${reselect.keyCols.join(', ')}`;
}

/** How many rows the write wrote ({@link WrittenRows}), from its own result — `null` when not countable. */
export function writtenRowCount(written: WrittenRows | null, affected: number): number | null {
  return written === null ? null : affected;
}

/**
 * The recovered rows, checked against the count the write wrote: a mismatch means the SELECT named rows
 * the write did not write (or missed ones it did) — FAIL CLOSED rather than return them.
 */
export function checkRecovered<R>(rows: readonly R[], written: number | null, writeSql: string): readonly R[] {
  if (written !== null && rows.length !== written) {
    throw new Error(
      `scp write(mysql): the write wrote ${written} row(s) but its RETURNING recovery found ${rows.length} — ` +
        `refusing to return rows it cannot attribute to this write ('${writeSql.slice(0, 60)}…')`,
    );
  }
  return rows;
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
        // A write that wrote no row is never re-selected (writtenRowCount 0 ⇒ []), so `affected` ≥ 1 here.
        return lastInsertId + affected;
      case 'json':
        return params[0];
      case 'param':
        return params[b.index];
    }
  });
}
