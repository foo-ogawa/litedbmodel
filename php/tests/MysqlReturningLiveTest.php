<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime\Tests;

use LiteDbModel\Runtime\LiveDb;
use LiteDbModel\Runtime\MysqlLivePdo;
use LiteDbModel\Runtime\MysqlReturningStatement;
use PHPUnit\Framework\TestCase;

/**
 * MySQL has no RETURNING: the PDO emulation (`LiveDb.php` `MysqlReturning::build` +
 * `MysqlReturningStatement`) must return EXACTLY the rows the write wrote — the set PG / SQLite native
 * RETURNING returns — and fail closed where it cannot know that set. Each statement below is the TS
 * compiler's own mysql output (compileWriteNode / the batch bundles), run through the shipped PDO.
 *
 * Runs by default; LITEDBMODEL_SKIP_LIVE=1 skips it (the inverted gate of the other php live suites).
 */
final class MysqlReturningLiveTest extends TestCase
{
    private \PDO $db;
    private string $t;

    protected function setUp(): void
    {
        if (getenv('LITEDBMODEL_SKIP_LIVE') === '1') {
            $this->markTestSkipped('LITEDBMODEL_SKIP_LIVE=1 — live-DB RETURNING test skipped');
        }
        $this->db = self::mysql();
        $this->t = 'scp_myret_php_' . getmypid();
    }

    protected function tearDown(): void
    {
        if (isset($this->db)) {
            $this->db->exec("DROP TABLE IF EXISTS {$this->t}");
        }
    }

    private static function mysql(): \PDO
    {
        return LiveDb::mysql(
            getenv('TEST_MYSQL_HOST') ?: '127.0.0.1',
            (int) (getenv('TEST_MYSQL_PORT') ?: '3307'),
            getenv('TEST_MYSQL_USER') ?: 'testuser',
            getenv('TEST_MYSQL_PASSWORD') ?: 'testpass',
            getenv('TEST_MYSQL_DB') ?: 'testdb',
        );
    }

    /** The shipped RETURNING-emulating PDO, opened WITH `CLIENT_FOUND_ROWS` (what mysql2 / sqlx always do). */
    private static function mysqlFoundRows(): \PDO
    {
        $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s', getenv('TEST_MYSQL_HOST') ?: '127.0.0.1', (int) (getenv('TEST_MYSQL_PORT') ?: '3307'), getenv('TEST_MYSQL_DB') ?: 'testdb');
        $pdo = new MysqlLivePdo($dsn, getenv('TEST_MYSQL_USER') ?: 'testuser', getenv('TEST_MYSQL_PASSWORD') ?: 'testpass', [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_EMULATE_PREPARES => false,
            \Pdo\Mysql::ATTR_FOUND_ROWS => true,
        ]);
        $pdo->setAttribute(\PDO::ATTR_STATEMENT_CLASS, [MysqlReturningStatement::class, [$pdo]]);
        return $pdo;
    }

    private function table(string $ddl, string ...$seed): void
    {
        $this->db->exec("DROP TABLE IF EXISTS {$this->t}");
        $this->db->exec("CREATE TABLE {$this->t} {$ddl}");
        foreach ($seed as $s) {
            $this->db->exec($s);
        }
    }

    /** @param list<mixed> $params @return list<array<string, mixed>> */
    private function rows(string $sql, array $params): array
    {
        $st = $this->db->prepare($sql);
        $st->execute($params);
        return array_map(static fn (object $r): array => array_map(static fn ($v) => $v === null ? null : (string) $v, (array) $r), $st->fetchAll(\PDO::FETCH_OBJ));
    }

    /** #358 — a composite key is matched on EVERY column, never the first alone. */
    public function testCompositeKeyMatchesEveryColumn(): void
    {
        $t = $this->t;
        $ddl = '(id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(64) NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64), UNIQUE KEY uq (email, tenant_id))';
        $victim = "INSERT INTO {$t} (email, tenant_id, name) VALUES ('a@x', 2, 'victim')";
        $mine = [['email' => 'a@x', 'tenant_id' => '1', 'name' => 'mine']];

        $this->table($ddl, $victim);
        self::assertSame($mine, $this->rows("INSERT INTO {$t} (email, name, tenant_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email, tenant_id*/", ['a@x', 'mine', 1]), 'upsert');

        // A multi-row VALUES upsert: every row's key tuple, never the first row's alone.
        $this->table($ddl, $victim);
        self::assertSame([...$mine, ['email' => 'b@x', 'tenant_id' => '1', 'name' => 'mine']], $this->rows("INSERT INTO {$t} (email, name, tenant_id) VALUES (?, ?, ?), (?, ?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email, tenant_id*/", ['a@x', 'mine', 1, 'b@x', 'mine', 1]), 'multi-row upsert');

        $this->table($ddl, $victim);
        self::assertSame($mine, $this->rows("INSERT INTO {$t} (email, name, tenant_id) SELECT JSON_UNQUOTE(jt.email), JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '\$[*]' COLUMNS(email JSON PATH '\$.email', name JSON PATH '\$.name', tenant_id BIGINT PATH '\$.tenant_id')) jt ON DUPLICATE KEY UPDATE email = VALUES(email), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING email, tenant_id, name /*scp:pk=id;ai=id;conflict=email,tenant_id*/", ['[{"email":"a@x","name":"mine","tenant_id":1}]']), 'upsertMany');

        // ON u.id = … AND u.tenant_id = …: the victim shares the FIRST key column (id) only.
        $this->table('(tenant_id INT NOT NULL, id INT NOT NULL, name VARCHAR(64), PRIMARY KEY (tenant_id, id))', "INSERT INTO {$t} (tenant_id, id, name) VALUES (2, 7, 'victim')");
        self::assertSame([], $this->rows("UPDATE {$t} AS u JOIN JSON_TABLE(?, '\$[*]' COLUMNS(id BIGINT PATH '\$.id', tenant_id BIGINT PATH '\$.tenant_id', name JSON PATH '\$.name')) AS v ON u.id = v.id AND u.tenant_id = v.tenant_id SET u.name = JSON_UNQUOTE(v.name) RETURNING tenant_id, id, name", ['[{"id":7,"tenant_id":1,"name":"hijack"}]']), 'updateMany');
    }

    /** #359 — an insert-or-ignore returns only the row it inserted, never the conflicting row. */
    public function testInsertIgnoreReturnsOnlyTheInsertedRow(): void
    {
        $t = $this->t;
        // AUTO_INCREMENT key: inserted ⇔ the insert id is not 0.
        $this->table('(id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(64) NOT NULL, name VARCHAR(64), UNIQUE KEY uq (email))', "INSERT INTO {$t} (email, name) VALUES ('a@x', 'victim')");
        $ignoreAutoInc = "INSERT INTO {$t} (email, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE email = email RETURNING email, name /*scp:pk=id;ai=id;conflict=email;action=ignore*/";
        self::assertSame([], $this->rows($ignoreAutoInc, ['a@x', 'mine']), 'autoinc conflict');
        self::assertSame([['email' => 'b@x', 'name' => 'mine']], $this->rows($ignoreAutoInc, ['b@x', 'mine']), 'autoinc insert');

        // Client-supplied key: decided by its PK lock, never by the affected count — so the same on a
        // connection with CLIENT_FOUND_ROWS (a no-op conflict and an insert both report 1) as without it.
        $clientDdl = '(code VARCHAR(16) PRIMARY KEY, owner VARCHAR(64))';
        $victim = "INSERT INTO {$t} (code, owner) VALUES ('X1', 'victim')";
        $ignoreClient = "INSERT INTO {$t} (code, owner) VALUES (?, ?) ON DUPLICATE KEY UPDATE code = code RETURNING code, owner /*scp:pk=code;ai=;conflict=code;action=ignore*/";
        $uniqueDdl = '(id VARCHAR(36) PRIMARY KEY, email VARCHAR(64) NOT NULL, owner VARCHAR(64), UNIQUE KEY uq (email))';
        $uniqueVictim = "INSERT INTO {$t} (id, email, owner) VALUES ('u-1', 'a@x', 'victim')";
        $ignoreUnique = "INSERT INTO {$t} (email, id, owner) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE email = email RETURNING id, email, owner /*scp:pk=id;ai=;conflict=email;action=ignore*/";
        $default = $this->db;
        $foundRows = self::mysqlFoundRows();
        foreach (['default' => $default, 'foundRows' => $foundRows] as $name => $conn) {
            $this->db = $conn;
            $this->table($clientDdl, $victim);
            self::assertSame([['code' => 'X2', 'owner' => 'mine']], $this->rows($ignoreClient, ['X2', 'mine']), "{$name}: client insert");
            self::assertSame([], $this->rows($ignoreClient, ['X1', 'mine']), "{$name}: client conflict");
            // A conflict on another unique key — the conflict key taken, or the PK taken — returns nothing.
            $this->table($uniqueDdl, $uniqueVictim);
            self::assertSame([], $this->rows($ignoreUnique, ['a@x', 'u-2', 'mine']), "{$name}: conflict key taken");
            self::assertSame([], $this->rows($ignoreUnique, ['b@x', 'u-1', 'mine']), "{$name}: PK taken");
            self::assertSame([['id' => 'u-3', 'email' => 'b@x', 'owner' => 'mine']], $this->rows($ignoreUnique, ['b@x', 'u-3', 'mine']), "{$name}: unique insert");
        }
        $this->db = $default;

        // READ COMMITTED: another session inserts the same key while ours is in flight — its row is never
        // returned. A BEFORE INSERT trigger parks OUR insert (owner 'mine') on a row another session
        // holds, so the other session's insert of the same key lands exactly between a lock and the write.
        $this->insertIgnoreRace($clientDdl, $ignoreClient);

        // Batch (INSERT IGNORE) on a client-supplied key: the pre-existing row read back fails it closed.
        $this->table($clientDdl, $victim);
        $batch = "INSERT IGNORE INTO {$t} (code, owner) SELECT JSON_UNQUOTE(jt.code), JSON_UNQUOTE(jt.owner) FROM JSON_TABLE(?, '\$[*]' COLUMNS(code JSON PATH '\$.code', owner JSON PATH '\$.owner')) jt RETURNING code, owner /*scp:pk=code;ai=;conflict=code;action=ignore*/";
        try {
            $this->rows($batch, ['[{"code":"X1","owner":"mine"},{"code":"X2","owner":"mine"}]']);
            self::fail('batch ignore with a conflict must fail closed');
        } catch (\RuntimeException $e) {
            self::assertStringContainsString('wrote 1 row(s) but its RETURNING recovery found 2', $e->getMessage());
        }
        self::assertSame([['code' => 'X3', 'owner' => 'mine']], $this->rows($batch, ['[{"code":"X3","owner":"mine"}]']), 'batch ignore insert');
    }

    /**
     * Run the insert-or-ignore `$ignore` (code, owner) for key K1 under READ COMMITTED while another
     * session (a forked process — PHP has no threads) inserts K1 — ours parked by a trigger until that
     * other row is committed — and check that the other session's row is never returned as ours.
     */
    private function insertIgnoreRace(string $ddl, string $ignore): void
    {
        $t = $this->t;
        $gate = "{$t}_gate";
        $this->table($ddl);
        $this->db->exec("DROP TABLE IF EXISTS {$gate}");
        $this->db->exec("CREATE TABLE {$gate} (id INT PRIMARY KEY)");
        $this->db->exec("INSERT INTO {$gate} (id) VALUES (1)");
        $this->db->exec("CREATE TRIGGER {$t}_park BEFORE INSERT ON {$t} FOR EACH ROW BEGIN "
            . "IF NEW.owner = 'mine' THEN SELECT id INTO @scp_park FROM {$gate} WHERE id = 1 FOR UPDATE; END IF; END");
        [$parentEnd, $childEnd] = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP);
        $pid = pcntl_fork();
        if ($pid === 0) {
            fclose($parentEnd);
            $other = self::mysql();
            $other->exec('BEGIN');
            $other->query("SELECT id FROM {$gate} WHERE id = 1 FOR UPDATE")->fetchAll();
            fwrite($childEnd, "locked\n");
            for ($i = 0; $i < 200; $i++) {
                $st = $other->prepare('SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE INFO LIKE ?');
                $st->execute(['SELECT id INTO @scp_park %']);
                if ((int) $st->fetchColumn() > 0) {
                    usleep(300_000); // ours: parked in its trigger, before its row
                    break;
                }
                usleep(20_000);
            }
            $other->exec("INSERT INTO {$t} (code, owner) VALUES ('K1', 'victim')");
            $other->exec('COMMIT');
            // Die without destructors: the inherited copy of the parent's connection must not be closed.
            posix_kill(posix_getpid(), SIGKILL);
        }
        fclose($childEnd);
        self::assertSame("locked\n", fgets($parentEnd));
        $this->db->exec('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
        try {
            $got = $this->rows($ignore, ['K1', 'mine']);
        } finally {
            pcntl_waitpid($pid, $status);
            $this->db->exec('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            $this->db->exec("DROP TABLE IF EXISTS {$gate}");
        }
        self::assertSame([], $got, 'READ COMMITTED race');
    }

    /** #360 — a bulk INSERT…RETURNING returns its own rows, not the ids another session took between them. */
    public function testBulkAutoIncReturnsOnlyItsOwnRows(): void
    {
        $t = $this->t;
        $createMany = "INSERT INTO {$t} (tenant_id, uk) SELECT jt.tenant_id, JSON_UNQUOTE(jt.uk) FROM JSON_TABLE(?, '\$[*]' COLUMNS(tenant_id BIGINT PATH '\$.tenant_id', uk JSON PATH '\$.uk')) jt RETURNING uk, tenant_id /*scp:pk=id;ai=id*/";
        $payload = '[{"tenant_id":1,"uk":"k1"},{"tenant_id":1,"uk":"k2"},{"tenant_id":1,"uk":"k3"},{"tenant_id":1,"uk":"k4"}]';
        $mine = array_map(static fn (string $uk): array => ['uk' => $uk, 'tenant_id' => '1'], ['k1', 'k2', 'k3', 'k4']);

        // A bounded two-connection schedule (PHP has no threads, so the other session is a forked
        // process): it holds a gap lock the bulk insert must wait on, inserts its own row (taking the
        // next id) while the bulk insert is blocked mid-way, and commits.
        $this->table('(id INT AUTO_INCREMENT PRIMARY KEY, uk VARCHAR(32) NOT NULL, tenant_id INT NOT NULL, UNIQUE KEY uq (uk))', "INSERT INTO {$t} (uk, tenant_id) VALUES ('seed', 0)");
        [$parentEnd, $childEnd] = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP);
        $pid = pcntl_fork();
        if ($pid === 0) {
            fclose($parentEnd);
            $other = self::mysql();
            $other->exec('BEGIN');
            $other->query("SELECT id FROM {$t} WHERE uk = 'k3' FOR UPDATE")->fetchAll();
            fwrite($childEnd, "locked\n");
            for ($i = 0; $i < 200; $i++) {
                $st = $other->prepare('SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE INFO LIKE ?');
                $st->execute(["INSERT INTO {$t} %"]);
                if ((int) $st->fetchColumn() > 0) {
                    usleep(300_000); // past the id allocation and waiting on the lock
                    break;
                }
                usleep(20_000);
            }
            $other->exec("INSERT INTO {$t} (uk, tenant_id) VALUES ('zz', 2)");
            $other->exec('COMMIT');
            // Die without destructors: the inherited copy of the parent's connection must not be closed.
            posix_kill(posix_getpid(), SIGKILL);
        }
        fclose($childEnd);
        self::assertSame("locked\n", fgets($parentEnd));
        try {
            $got = $this->rows($createMany, [$payload]);
        } finally {
            pcntl_waitpid($pid, $status);
        }
        self::assertSame($mine, $got, 'interleaved createMany');
        $order = array_column($this->rows("SELECT uk FROM {$t} ORDER BY id", []), 'uk');
        self::assertSame(['seed', 'k1', 'zz', 'k2', 'k3', 'k4'], $order, 'the foreign row landed between the bulk insert\'s ids');

        // A non-concurrent createMany keeps returning exactly its rows.
        $this->table('(id INT AUTO_INCREMENT PRIMARY KEY, uk VARCHAR(32) NOT NULL, tenant_id INT NOT NULL)');
        self::assertSame($mine, $this->rows($createMany, [$payload]), 'plain createMany');
    }

    /** #361 — an UPDATE…RETURNING returns the rows it updated, keyed before the write. */
    public function testUpdateReturnsTheRowsItUpdated(): void
    {
        $t = $this->t;
        $this->table('(id INT PRIMARY KEY, state VARCHAR(16) NOT NULL)', "INSERT INTO {$t} (id, state) VALUES (1, 'open'), (2, 'open'), (3, 'done')");
        // A state transition: the SET changes the WHERE column, so the WHERE no longer matches afterwards.
        self::assertSame(
            [['id' => '1', 'state' => 'claimed'], ['id' => '2', 'state' => 'claimed']],
            $this->rows("UPDATE {$t} SET state = ? WHERE state = ? RETURNING id, state /*scp:pk=id;ai=*/", ['claimed', 'open']),
            'state transition',
        );
    }

    /** #362 — a DELETE…RETURNING returns only the rows it deleted. */
    public function testDeleteReturnsOnlyTheRowsItDeleted(): void
    {
        $t = $this->t;
        $delete = "DELETE FROM {$t} WHERE id = ? RETURNING id, state /*scp:pk=id;ai=*/";
        $this->table('(id INT PRIMARY KEY, state VARCHAR(16) NOT NULL)', "INSERT INTO {$t} (id, state) VALUES (8, 'open'), (5, 'open')");
        // Another session deletes the row after OUR snapshot: a plain pre-image still sees it.
        $this->db->exec('START TRANSACTION WITH CONSISTENT SNAPSHOT');
        self::mysql()->exec("DELETE FROM {$t} WHERE id = 8");
        self::assertSame([], $this->rows($delete, [8]), 'deleted after our snapshot');
        $this->db->exec('COMMIT');
        // A row it did delete is returned.
        self::assertSame([['id' => '5', 'state' => 'open']], $this->rows($delete, [5]), 'own delete');
    }
    /**
     * #379 — a batch RETURNING compares its keys the way the write did: through the write's own
     * JSON_TABLE declaration (`k BIGINT PATH`). Re-read as the JSON_UNQUOTE string, a BIGINT key compares
     * as DOUBLE, and past 2^53 every neighbouring key in the same double matches. Each key column is
     * UNINDEXED, so the re-select scans (an index lookup would compare exactly and hide it).
     */
    public function testBatchReturningComparesBigintKeysAsTheWriteDid(): void
    {
        $t = $this->t;
        // Our two keys 2^60+1 / 2^60+14, among 38 other-tenant rows whose keys round to the same doubles.
        $seed = function (string $ddl, bool $ours) use ($t): void {
            $rows = [];
            for ($i = 1; $i <= 40; $i++) {
                $mine = $i === 1 || $i === 14;
                if ($mine && !$ours) {
                    continue;
                }
                $tenant = $mine ? 1 : 2;
                $rows[] = "INSERT INTO {$t} (k, tenant_id, name) VALUES (1152921504606846976 + {$i}, {$tenant}, 'theirs')";
            }
            $this->table($ddl, ...$rows);
        };
        $payload = '[{"k":1152921504606846977,"name":"mine","tenant_id":1},{"k":1152921504606846990,"name":"mine","tenant_id":1}]';
        $failures = [];
        $count = function (string $what, string $sql) use ($payload, &$failures): void {
            try {
                $got = count($this->rows($sql, [$payload]));
                if ($got !== 2) {
                    $failures[] = "{$what}: RETURNING returned {$got} rows, want the 2 it wrote";
                }
            } catch (\RuntimeException $e) {
                $failures[] = "{$what}: " . $e->getMessage();
            }
        };

        $seed('(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))', true);
        $count('updateMany', "UPDATE {$t} AS u JOIN JSON_TABLE(?, '\$[*]' COLUMNS(k BIGINT PATH '\$.k', name JSON PATH '\$.name')) AS v ON u.k = v.k SET u.name = JSON_UNQUOTE(v.name) RETURNING k, tenant_id");

        $seed('(id INT AUTO_INCREMENT PRIMARY KEY, k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))', false);
        $count('upsertMany', "INSERT INTO {$t} (k, name, tenant_id) SELECT jt.k, JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '\$[*]' COLUMNS(k BIGINT PATH '\$.k', name JSON PATH '\$.name', tenant_id BIGINT PATH '\$.tenant_id')) jt ON DUPLICATE KEY UPDATE k = VALUES(k), name = VALUES(name), tenant_id = VALUES(tenant_id) RETURNING k, tenant_id /*scp:pk=id;ai=id;conflict=k*/");

        $seed('(k BIGINT NOT NULL, tenant_id INT NOT NULL, name VARCHAR(64))', false);
        $count('createMany', "INSERT INTO {$t} (k, name, tenant_id) SELECT jt.k, JSON_UNQUOTE(jt.name), jt.tenant_id FROM JSON_TABLE(?, '\$[*]' COLUMNS(k BIGINT PATH '\$.k', name JSON PATH '\$.name', tenant_id BIGINT PATH '\$.tenant_id')) jt RETURNING k, tenant_id /*scp:pk=k;ai=*/");

        self::assertSame([], $failures);
    }
}
