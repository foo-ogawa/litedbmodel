<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime\Tests;

use LiteDbModel\Runtime\Leaves;
use LiteDbModel\Runtime\LimitExceededError;
use PHPUnit\Framework\TestCase;

/**
 * The RELATION runaway guard (#160) inside the `executeSQL` leaf, over a real in-memory sqlite.
 *
 * The PHP leg of "the same behaviour in all five languages" — the twin of the rust
 * `relation_guard_trips_on_the_raw_child_rows`, the go `TestExecuteSQL_RelationGuardOnRawChildRows`,
 * the python `test_relation_guard_trips_on_the_raw_child_rows` and the TS conformance guard vectors.
 * The cap rides on the transport because the RAW child rows exist nowhere else: past `group` the graph
 * is already nested, and SCP itself has no throw.
 */
final class RelationGuardTest extends TestCase
{
    /** @var callable */
    private $executeSQL;

    protected function setUp(): void
    {
        $pdo = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
        $pdo->exec("INSERT INTO t (id, v) VALUES (1,'a'), (2,'b'), (3,'c')");
        $this->executeSQL = Leaves::makeHandlers($pdo, 'sqlite')['executeSQL'];
    }

    /** Run the read with (or without) the optional `guard` port the emitter bakes onto a capped fetch. */
    private function read(?\stdClass $guard): array
    {
        $ports = [
            'sql' => 'SELECT id, v FROM t ORDER BY id',
            'params' => [],
            'write' => false,
            'returning' => false,
            'bigint' => false,
        ];
        if ($guard !== null) {
            $ports['guard'] = $guard;
        }
        return ($this->executeSQL)($ports, ['nodeId' => 'n0', 'component' => 'executeSQL']);
    }

    private static function cap(int $limit): \stdClass
    {
        return (object) ['limit' => $limit, 'model' => 't', 'relation' => 'things'];
    }

    public function testOverTheCapThrowsWithTheExactBatchCount(): void
    {
        // A runaway is a typed litedbmodel policy error, not a mapped transport failure, so it THROWS
        // rather than returning `['error' => …]` (the TS leaf throws the same class).
        try {
            $this->read(self::cap(2));
            self::fail('a relation batch over its cap must throw');
        } catch (LimitExceededError $e) {
            self::assertSame(2, $e->limit);
            self::assertSame(3, $e->count);          // the EXACT batch total (the batch is fetched in full)
            self::assertSame('relation', $e->context);
            self::assertSame('t', $e->model);
            self::assertSame('things', $e->relation);
            self::assertStringContainsString(
                "relation 'things' on t returned 3 records, but limit is 2",
                $e->getMessage(),
            );
        }
    }

    public function testWithinTheCapReturnsTheRows(): void
    {
        self::assertCount(3, $this->read(self::cap(3))['ok']);
    }

    public function testAnUncappedStatementIsNeverChecked(): void
    {
        // No `guard` port at all — the byte-unchanged path every non-relation statement takes.
        self::assertCount(3, $this->read(null)['ok']);
    }
}
