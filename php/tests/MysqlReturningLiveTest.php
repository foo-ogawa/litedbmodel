<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime\Tests;

use LiteDbModel\Runtime\LiveDb;
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

        // Client-supplied key (LiveDb::mysql opens without CLIENT_FOUND_ROWS): inserted ⇔ 1 affected row.
        $clientDdl = '(code VARCHAR(16) PRIMARY KEY, owner VARCHAR(64))';
        $victim = "INSERT INTO {$t} (code, owner) VALUES ('X1', 'victim')";
        $this->table($clientDdl, $victim);
        $ignoreClient = "INSERT INTO {$t} (code, owner) VALUES (?, ?) ON DUPLICATE KEY UPDATE code = code RETURNING code, owner /*scp:pk=code;ai=;conflict=code;action=ignore*/";
        self::assertSame([], $this->rows($ignoreClient, ['X1', 'mine']), 'client conflict');
        self::assertSame([['code' => 'X2', 'owner' => 'mine']], $this->rows($ignoreClient, ['X2', 'mine']), 'client insert');

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
}
