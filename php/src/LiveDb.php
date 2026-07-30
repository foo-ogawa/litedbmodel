<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime;

/**
 * litedbmodel v2 SCP — LIVE PostgreSQL / MySQL PDO drivers (WS7g, #36).
 *
 * The PHP leg of the coordinated cross-language live-DB validation pass. The leaf transport
 * ({@see Leaves::makeHandlers}) handler seam already takes ANY `\PDO`; this file supplies two live `\PDO`
 * SUBCLASSES that adapt the two dialect divergences a raw PDO can't absorb, so the runtime stays
 * UNCHANGED:
 *
 *   - Postgres ({@see PgLivePdo}): the `postgres`-tagged bundle renders `$N` placeholders (the
 *     Render final-pass), but PDO_pgsql binds `?` positionally (it does NOT translate `$N`). This
 *     subclass rewrites `$N`→`?` in `prepare()`/`exec()` before handing SQL to the real driver.
 *     RETURNING is native on PG, so a RETURNING row comes back through the normal fetch.
 *
 *   - MySQL ({@see MysqlLivePdo} + {@see MysqlReturningStatement}): the `mysql`-tagged bundle
 *     renders `?` (native to PDO_mysql — no rewrite), but MySQL 8.0 has NO `RETURNING`. The
 *     statement subclass emulates it at the seam (strip RETURNING → run the INSERT → re-select the
 *     AUTO_INCREMENT PK's columns) — the dialect-behavior-by-convention the WS6 TS ScpDialect uses.
 *
 * Both run with PDO autocommit ON so the runtime's explicit `BEGIN`/`COMMIT`/`ROLLBACK` envelope
 * (issued by the tx combinator through the seam) drives a REAL transaction on the live DB.
 */
final class LiveDb
{
    /** Connect to a live Postgres, returning a placeholder-adapting `\PDO`. */
    public static function postgres(string $host, int $port, string $user, string $password, string $dbname): \PDO
    {
        $dsn = "pgsql:host={$host};port={$port};dbname={$dbname}";
        return new PgLivePdo($dsn, $user, $password, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
        ]);
    }

    /** Connect to a live MySQL, returning a RETURNING-emulating `\PDO`. */
    public static function mysql(string $host, int $port, string $user, string $password, string $dbname): \PDO
    {
        // 127.0.0.1 (not "localhost") forces a TCP connection to the published container port.
        $dsn = "mysql:host={$host};port={$port};dbname={$dbname}";
        // Native prepares (emulate OFF) so an integer param binds over the binary protocol as an
        // integer — MySQL rejects a QUOTED `LIMIT '20'`, which emulated prepares would produce.
        $pdo = new MysqlLivePdo($dsn, $user, $password, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        $pdo->setAttribute(\PDO::ATTR_STATEMENT_CLASS, [MysqlReturningStatement::class, [$pdo]]);
        return $pdo;
    }
}

/**
 * A `\PDO` that rewrites Postgres `$N` placeholders to `?` before the real driver sees them.
 * Render numbers `$1..$N` left-to-right, so a plain positional `?` swap preserves bind order.
 */
final class PgLivePdo extends \PDO
{
    private static function rewrite(string $sql): string
    {
        // Every `$<digits>` on the compiled surface is a bound param position (the render pipeline
        // never emits a `$N` inside a string literal), so a global replace is safe.
        return preg_replace('/\$\d+/', '?', $sql) ?? $sql;
    }

    #[\ReturnTypeWillChange]
    public function prepare(string $query, array $options = []): \PDOStatement|false
    {
        return parent::prepare(self::rewrite($query), $options);
    }

    #[\ReturnTypeWillChange]
    public function exec(string $statement): int|false
    {
        return parent::exec(self::rewrite($statement));
    }
}

/**
 * How ONE `?` of a recovering SELECT is bound: `lastId` = LAST_INSERT_ID(), `highId` = that plus the
 * affected count (the exclusive upper bound of the inserted id range), `json` = the batch payload
 * (`params[0]`) re-bound to the SELECT's own JSON_TABLE, `param` = the write's own bound param at
 * {@see ReselectBind::$index}.
 */
final class ReselectBind
{
    public function __construct(public readonly string $kind, public readonly int $index = 0)
    {
    }
}

/** The MySQL RETURNING recovery derived from a write's baked SQL + its PK hint. */
final class MysqlReselect
{
    /**
     * @param string             $writeSql  the write to execute — RETURNING clause and hint removed
     * @param string             $selectSql the recovering SELECT
     * @param list<ReselectBind> $binds     how to bind {@see $selectSql}'s `?`s
     * @param bool               $before    run the SELECT BEFORE the write (a DELETE's pre-image)
     */
    public function __construct(
        public readonly string $writeSql,
        public readonly string $selectSql,
        public readonly array $binds,
        public readonly bool $before = false,
    ) {
    }
}

/**
 * **MySQL has no `RETURNING`**: the one place in the PHP runtime that knows it.
 *
 * A write compiled for the `mysql` dialect carries the SAME ` RETURNING <cols>` tail as the PG /
 * SQLite bundles (the compilers are dialect-neutral about it), plus a strip-before-execute
 * block-comment hint naming the target's REAL primary key. MySQL parses neither, so this seam
 * STRIPS both and recovers the written rows with a SELECT keyed on whatever identifies them:
 *
 *  | write             | the rows are recovered by                                          | when   |
 *  |-------------------|--------------------------------------------------------------------|--------|
 *  | create            | the AUTO_INCREMENT range `[LAST_INSERT_ID, +affected)`, or the      | after  |
 *  |                   | client-supplied PK values pulled from the INSERT params by position |        |
 *  | createMany        | the same AUTO_INCREMENT range (N consecutive ids)                   | after  |
 *  | upsert / …Many    | the CONFLICT key (MySQL does not report the conflicted-row id, so   | after  |
 *  |                   | the AUTO_INCREMENT range is wrong when a row was UPDATED)           |        |
 *  | update            | the write's OWN WHERE predicate                                     | after  |
 *  | updateMany        | the batch JOIN key, re-bound from the SAME JSON payload             | after  |
 *  | delete/deleteMany | the write's OWN WHERE predicate — **before** the write, since the   | BEFORE |
 *  |                   | rows no longer exist once the DELETE has run                        |        |
 *
 * The recovering SELECT runs on the SAME connection as the write, so inside a transaction it sees
 * the not-yet-committed rows — and a DELETE's pre-image SELECT is inside the same transaction as
 * the delete it describes.
 *
 * This class is the PHP member of a 5-language SSoT: `src/scp/makesql/mysql-returning.ts`
 * (`buildMysqlReselect`), `rust/litedbmodel_runtime/src/livedb.rs` (`build_mysql_reselect`),
 * `go/litedbmodel_runtime/livedb.go` (`buildMysqlReselect`) and
 * `python/litedbmodel_runtime/driver.py` (`_build_mysql_reselect`) derive the identical
 * write/select/bind triple, so no dialect leg can return a different row set.
 */
final class MysqlReturning
{
    /** The strip-before-execute PK-hint comment marker. */
    private const PK_HINT_RE = '#\s*/\*scp:pk=[^*]*\*/#';

    /** Strip a PK-hint comment from a rendered SQL. */
    public static function stripPkHint(string $sql): string
    {
        return preg_replace(self::PK_HINT_RE, '', $sql) ?? $sql;
    }

    /** Split a comma list into trimmed, non-empty entries. @return list<string> */
    private static function splitTrim(string $s): array
    {
        $out = [];
        foreach (explode(',', $s) as $c) {
            $t = trim($c);
            if ($t !== '') {
                $out[] = $t;
            }
        }
        return $out;
    }

    /**
     * Derive the RETURNING recovery for `$sql`, or `null` when the statement declares no RETURNING
     * (a plain write / a SELECT — the caller runs it unchanged).
     *
     * Fail-closed: a RETURNING write whose key cannot be identified (an upsert with no conflict
     * hint, an INSERT whose declared PK column is not in its column list, an UPDATE/DELETE with no
     * WHERE) THROWS rather than silently returning no rows — returning `[]` for a write the caller
     * asked to describe is exactly the defect this class exists to remove.
     */
    public static function build(string $sql): ?MysqlReselect
    {
        $lower = strtolower($sql);
        $retPos = strrpos($lower, ' returning ');
        if ($retPos === false) {
            return null;
        }
        $hintRegion = substr($sql, $retPos);
        $cols = trim(self::stripPkHint(substr($sql, $retPos + strlen(' returning '))));
        $pkCols = [];
        $autoInc = '';
        if (preg_match('#/\*scp:pk=([^;*]*);ai=([^;*]*)#i', $hintRegion, $hm) === 1) {
            $pkCols = self::splitTrim($hm[1]);
            $autoInc = trim($hm[2]);
        }
        $conflict = [];
        if (preg_match('#;conflict=([^*]*)\*/#i', $hintRegion, $cfm) === 1) {
            $conflict = self::splitTrim($cfm[1]);
        }
        $writeSql = trim(self::stripPkHint(substr($sql, 0, $retPos)));
        $wl = strtolower($writeSql);

        if (preg_match('/\b(?:INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z0-9_."`]+)/i', $writeSql, $tm) !== 1) {
            throw new \RuntimeException("scp write(mysql): cannot parse the target table of '{$writeSql}'");
        }
        $table = $tm[1];
        // Order by the DECLARED pk so MySQL matches the pg/sqlite RETURNING order (§10 all-dialect parity).
        $orderBy = count($pkCols) > 0 ? ' ORDER BY ' . implode(', ', $pkCols) : '';
        $isBatch = str_contains($wl, 'json_table(');
        $insertCols = [];
        if (preg_match('/\bINSERT\s+(?:IGNORE\s+)?INTO\s+[A-Za-z0-9_."`]+\s*\(([^)]*)\)/i', $writeSql, $cm) === 1) {
            $insertCols = self::splitTrim($cm[1]);
        }
        $jsonSelect = static fn (string $key): string => "SELECT {$cols} FROM {$table} WHERE {$key} IN "
            . "(SELECT JSON_UNQUOTE(jt.{$key}) FROM JSON_TABLE(?, '\$[*]' COLUMNS({$key} JSON PATH '\$.{$key}')) jt){$orderBy}";

        // upsert / upsertMany — by the CONFLICT key. MySQL does not report which row an ON DUPLICATE
        // KEY UPDATE touched, so the AUTO_INCREMENT range is wrong as soon as a row was updated.
        if (str_starts_with($wl, 'insert') && str_contains($wl, 'on duplicate key update')) {
            if (count($conflict) === 0) {
                throw new \RuntimeException("scp write(mysql): an upsert…RETURNING needs its conflict key in the pk hint ('{$writeSql}')");
            }
            $key = $conflict[0];
            if ($isBatch) {
                return new MysqlReselect($writeSql, $jsonSelect($key), [new ReselectBind('json')]);
            }
            $idx = array_search($key, $insertCols, true);
            if ($idx === false) {
                throw new \RuntimeException("scp write(mysql): conflict key '{$key}' is not among the INSERT columns of '{$writeSql}'");
            }
            return new MysqlReselect($writeSql, "SELECT {$cols} FROM {$table} WHERE {$key} = ?{$orderBy}", [new ReselectBind('param', $idx)]);
        }

        // create / createMany — by the AUTO_INCREMENT range [LAST_INSERT_ID, +affected), or by the
        // client-supplied PK values pulled from the INSERT params by column position (UUID / composite).
        if (str_starts_with($wl, 'insert')) {
            if ($autoInc !== '' && $pkCols === [$autoInc]) {
                return new MysqlReselect($writeSql, "SELECT {$cols} FROM {$table} WHERE {$autoInc} >= ? AND {$autoInc} < ?{$orderBy}", [new ReselectBind('lastId'), new ReselectBind('highId')]);
            }
            if (count($pkCols) === 0) {
                throw new \RuntimeException("scp write(mysql): an INSERT…RETURNING carries no pk hint, so its written rows cannot be identified ('{$writeSql}'). The producer must pass the model's declared primary key.");
            }
            if ($isBatch) {
                // createMany with a CLIENT-supplied key: the statement binds ONE JSON payload, not one
                // param per key, so the keys are read back out of that SAME payload (as upsertMany does).
                if (count($pkCols) !== 1) {
                    throw new \RuntimeException("scp write(mysql): a batch INSERT…RETURNING on the COMPOSITE key (" . implode(', ', $pkCols) . ") cannot be recovered from its JSON payload ('{$writeSql}')");
                }
                return new MysqlReselect($writeSql, $jsonSelect($pkCols[0]), [new ReselectBind('json')]);
            }
            $conds = [];
            $binds = [];
            foreach ($pkCols as $pk) {
                $idx = array_search($pk, $insertCols, true);
                if ($idx === false) {
                    throw new \RuntimeException("scp write(mysql): PK column '{$pk}' is not among the INSERT columns of '{$writeSql}'");
                }
                $conds[] = "{$pk} = ?";
                $binds[] = new ReselectBind('param', $idx);
            }
            return new MysqlReselect($writeSql, "SELECT {$cols} FROM {$table} WHERE " . implode(' AND ', $conds) . $orderBy, $binds);
        }

        // updateMany — by the batch JOIN key, re-selected from the SAME JSON payload the write bound.
        if (str_starts_with($wl, 'update') && $isBatch) {
            if (preg_match('/\sON\s+[A-Za-z0-9_]*\.?([A-Za-z0-9_]+)\s*=/i', $writeSql, $km) !== 1) {
                throw new \RuntimeException("scp write(mysql): cannot parse the batch JOIN key of '{$writeSql}'");
            }
            return new MysqlReselect($writeSql, $jsonSelect($km[1]), [new ReselectBind('json')]);
        }

        // update / delete — by the write's OWN WHERE predicate, bound from the write's own params. The
        // UPDATE re-selects AFTER the write (the rows carry their new values); the DELETE re-selects
        // BEFORE it, since afterwards there is nothing left to describe.
        $wherePos = strrpos($wl, ' where ');
        if ($wherePos === false) {
            throw new \RuntimeException("scp write(mysql): a write…RETURNING needs a WHERE to recover its rows ('{$writeSql}')");
        }
        $whereSql = trim(substr($writeSql, $wherePos + strlen(' where ')));
        $leading = substr_count(substr($writeSql, 0, $wherePos), '?');
        $binds = [];
        for ($i = 0, $n = substr_count($whereSql, '?'); $i < $n; $i++) {
            $binds[] = new ReselectBind('param', $leading + $i);
        }
        return new MysqlReselect($writeSql, "SELECT {$cols} FROM {$table} WHERE {$whereSql}{$orderBy}", $binds, str_starts_with($wl, 'delete'));
    }

    /**
     * Bind the recovering SELECT's `?`s against the write's params + the write's own result.
     *
     * @param  list<ReselectBind> $binds
     * @param  list<mixed>        $params
     * @return list<mixed>
     */
    public static function bind(array $binds, array $params, int $lastInsertId, int $affected): array
    {
        $at = static fn (int $i): mixed => array_key_exists($i, $params) ? $params[$i] : null;
        $out = [];
        foreach ($binds as $b) {
            $out[] = match ($b->kind) {
                'lastId' => $lastInsertId,
                'highId' => $lastInsertId + max(1, $affected),
                'json' => $at(0),
                default => $at($b->index),
            };
        }
        return $out;
    }
}

/**
 * A `\PDO` for MySQL that emulates `… RETURNING`. With native prepares (emulate OFF) a server-side
 * prepare of a RETURNING statement fails at `prepare()` time — BEFORE any statement override could
 * run. So `prepare()` itself intercepts: it derives the recovery ({@see MysqlReturning::build}),
 * stashes it in {@see $pendingReturning}, and server-prepares the RETURNING-stripped write. The
 * {@see MysqlReturningStatement} its statements are reads that pending slot on `execute()`.
 * Statements in the gate-first tx run sequentially, so a single pending slot is race-free.
 */
final class MysqlLivePdo extends \PDO
{
    /** The recovery for the NEXT execute() (null = a statement that returns no written rows). */
    public ?MysqlReselect $pendingReturning = null;

    #[\ReturnTypeWillChange]
    public function prepare(string $query, array $options = []): \PDOStatement|false
    {
        $this->pendingReturning = MysqlReturning::build($query);
        return parent::prepare($this->pendingReturning?->writeSql ?? $query, $options);
    }
}

/**
 * A `\PDOStatement` that, when its owning {@see MysqlLivePdo} derived a recovery at prepare time,
 * runs the (RETURNING-stripped) write and the recovering SELECT as the coordinated pair
 * {@see MysqlReturning::build} describes — the SELECT first for a DELETE (its pre-image IS the
 * written row set), after the write otherwise. A plain statement behaves normally.
 */
final class MysqlReturningStatement extends \PDOStatement
{
    private MysqlLivePdo $pdo;
    /** @var list<\stdClass>|null cached re-selected RETURNING rows (null = passthrough). */
    private ?array $returningRows = null;
    /** Captured at construction from the PDO's slot. */
    private ?MysqlReselect $returning;

    protected function __construct(MysqlLivePdo $pdo)
    {
        $this->pdo = $pdo;
        // The PDO set its pending slot in prepare() immediately before constructing this statement.
        $this->returning = $pdo->pendingReturning;
        $pdo->pendingReturning = null;
    }

    #[\ReturnTypeWillChange]
    public function execute(?array $params = null): bool
    {
        $bound = $params === null ? null : array_values($params);
        if ($this->returning === null) {
            $this->returningRows = null;
            return parent::execute($bound);
        }
        if ($this->returning->before) {
            // DELETE…RETURNING: the pre-image IS the written row set — capture it, THEN delete.
            $this->returningRows = $this->reselect($bound ?? [], 0, 0);
            return parent::execute($bound);
        }
        $ok = parent::execute($bound); // the RETURNING-stripped write
        $this->returningRows = $this->reselect($bound ?? [], (int) $this->pdo->lastInsertId(), $this->rowCount());
        return $ok;
    }

    /**
     * Run the recovering SELECT on THIS connection (so it sees the write's uncommitted rows).
     *
     * @param  list<mixed> $bound
     * @return list<\stdClass>
     */
    private function reselect(array $bound, int $lastInsertId, int $affected): array
    {
        $sel = $this->pdo->prepare($this->returning->selectSql);
        $sel->execute(MysqlReturning::bind($this->returning->binds, $bound, $lastInsertId, $affected));
        $rows = $sel->fetchAll(\PDO::FETCH_OBJ);
        return is_array($rows) ? array_values($rows) : [];
    }

    #[\ReturnTypeWillChange]
    public function fetchAll(int $mode = \PDO::FETCH_DEFAULT, ...$args): array
    {
        if ($this->returningRows !== null) {
            return $this->returningRows;
        }
        return parent::fetchAll($mode, ...$args);
    }
}
