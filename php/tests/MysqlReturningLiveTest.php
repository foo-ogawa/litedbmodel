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
}
