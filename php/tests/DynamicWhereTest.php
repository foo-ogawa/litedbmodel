<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime\Tests;

use LiteDbModel\Runtime\Leaves;
use PHPUnit\Framework\TestCase;

/**
 * The DYNAMIC (SKIP) WHERE assembled by the `executeSQL` leaf (#192), over a real in-memory sqlite.
 *
 * The PHP leg of "the same behaviour in all five languages" — the twin of the rust
 * `dynamic_where_continues_a_bounded_where`, the go `TestExecuteSQL_DynamicWhereContinuesBoundedWhere`,
 * the python `test_dynamic_where.py` and the TS `leaves.test.ts` SKIP tests.
 *
 * CLAUDE.md §2: the emitter lowers a read's BOUNDED predicates into the statement's own static WHERE and
 * carries ONLY the actually-optional ones as `{skipped, sql, params}` fragments, so the leaf has to
 * CONTINUE that WHERE with `AND` (a second `WHERE` is a syntax error) and bind the survivors' params at
 * the slot their `?`s occupy — after the bounded values, before the page tail's counts.
 */
final class DynamicWhereTest extends TestCase
{
    /**
     * A MIXED read exactly as the emitter now lowers it: the bounded `id > ?` IS the statement's WHERE
     * and the page count binds after it.
     */
    private const BASE_SQL = 'SELECT id FROM t WHERE id > ? ORDER BY id LIMIT ?';

    /** @var callable */
    private $executeSQL;

    protected function setUp(): void
    {
        $pdo = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
        $pdo->exec("INSERT INTO t (id, v) VALUES (1,'a'), (2,'b'), (3,'c')");
        $this->executeSQL = Leaves::makeHandlers($pdo, 'sqlite')['executeSQL'];
    }

    /**
     * @param list<array{skipped: bool, sql: string, params: list<mixed>}> $frags
     * @return list<int>
     */
    private function ids(array $frags): array
    {
        // Everything besides the statement rides in the ONE `opts` control record (#193) — the object
        // the generated module builds (bc's php emitter renders a struct literal as a stdClass).
        $out = ($this->executeSQL)([
            'sql' => self::BASE_SQL,
            'params' => [1, 2],
            'opts' => (object) [
                'write' => null,
                'whereDynamic' => (object) ['frags' => $frags],
                'guard' => null,
            ],
        ], ['nodeId' => 'n0', 'component' => 'executeSQL']);
        return array_map(static fn ($r): int => (int) ((array) $r)['id'], $out['ok']);
    }

    public function testTheSurvivorsContinueTheBoundedWhere(): void
    {
        // `id > 1 AND v = 'c' ORDER BY id LIMIT 2` selects exactly row 3. Any other assembly fails loud
        // or empty: a second ` WHERE ` is a syntax error, any other param order binds `id > 'c'`.
        self::assertSame([3], $this->ids([['skipped' => false, 'sql' => 'v = ?', 'params' => ['c']]]));
    }

    public function testASkippedFragmentIsDroppedFromTextAndBinding(): void
    {
        // The skipped fragment's param is never bound (else the bind count would not match the `?`s).
        self::assertSame([3], $this->ids([
            ['skipped' => true, 'sql' => 'v = ?', 'params' => [null]],
            ['skipped' => false, 'sql' => 'v <> ?', 'params' => ['b']],
        ]));
    }

    public function testEveryFragmentSkippedRunsTheStatementAsCompiled(): void
    {
        // No survivor ⇒ the emitted statement is untouched: its OWN bounded WHERE + page tail still apply.
        self::assertSame([2, 3], $this->ids([['skipped' => true, 'sql' => 'v = ?', 'params' => [null]]]));
    }

    /**
     * #205 — a field ABSENT from a PRESENT struct is an ABI BREAK, never an absent VALUE. bc types a
     * port by the literal wired into it and REJECTS a partial struct, so a generated module always
     * spells every field of every struct it wires (`null` is how absence is spelled). A key that is not
     * there did not come from one, and defaulting it would silently downgrade a write to a read, drop a
     * relation cap, or erase a SKIP predicate. The five languages must agree; this is the php leg.
     */
    public function testAMissingFieldOfAPresentStructIsLoud(): void
    {
        $ctx = ['nodeId' => 'n0', 'component' => 'executeSQL'];
        $sql = 'SELECT id, v FROM t ORDER BY id';
        $nulls = (object) ['write' => null, 'whereDynamic' => null, 'guard' => null];
        // Ports whose control record carries a `whereDynamic` plan of ONE fragment (the #209 cases).
        $plan = static fn (object $frag): array => [
            'sql' => 'SELECT id, v FROM t ORDER BY id',
            'params' => [],
            'opts' => (object) ['write' => null, 'whereDynamic' => (object) ['frags' => [$frag]], 'guard' => null],
        ];

        // Each case drops exactly ONE declared field of a struct that is present.
        $cases = [
            [['params' => []], "'sql' field"],
            [['sql' => $sql], "'params' field"],
            [['sql' => $sql, 'params' => [], 'opts' => (object) ['whereDynamic' => null, 'guard' => null]], "'write' field"],
            [['sql' => $sql, 'params' => [], 'opts' => (object) ['write' => null, 'guard' => null]], "'whereDynamic' field"],
            [['sql' => $sql, 'params' => [], 'opts' => (object) ['write' => null, 'whereDynamic' => null]], "'guard' field"],
            [['sql' => $sql, 'params' => [], 'opts' => (object) ['write' => (object) [], 'whereDynamic' => null, 'guard' => null]], "'returning' field"],
            [
                ['sql' => $sql, 'params' => [], 'opts' => (object) [
                    'write' => null, 'whereDynamic' => null,
                    'guard' => (object) ['limit' => 2, 'relation' => 'things'],
                ]],
                "'model' field",
            ],
            // …and the PLAN and its FRAGMENTS, one level further down (#209).
            [
                ['sql' => $sql, 'params' => [], 'opts' => (object) ['write' => null, 'whereDynamic' => (object) [], 'guard' => null]],
                "'frags' field",
            ],
            [$plan((object) ['sql' => 'v = ?', 'params' => ['zzz']]), "'skipped' field"],
            [$plan((object) ['skipped' => false, 'params' => ['zzz']]), "'sql' field"],
            [$plan((object) ['skipped' => false, 'sql' => 'v = ?']), "'params' field"],
            // A SKIPPED fragment is unboxed too — it is spelled in full like any other.
            [$plan((object) ['skipped' => true, 'params' => ['zzz']]), "'sql' field"],
        ];
        foreach ($cases as [$ports, $want]) {
            // The assertions live OUTSIDE the catch on purpose: PHPUnit's own AssertionFailedError
            // extends \RuntimeException, so a `self::fail()` inside the try would be swallowed by the
            // catch below and its message ("a missing 'sql' field …") would even satisfy the
            // assertStringContainsString — a gate that passes while the transport runs on SILENTLY.
            $caught = null;
            try {
                ($this->executeSQL)($ports, $ctx);
            } catch (\RuntimeException $e) {
                $caught = $e;
            }
            self::assertNotNull($caught, "a missing {$want} must be loud, but the statement ran");
            self::assertStringContainsString($want, $caught->getMessage());
        }

        // The LEGAL absences stay silent: an omitted record is a plain read, and a null FIELD is how an
        // absent write mode / plan / cap is spelled.
        self::assertCount(3, ($this->executeSQL)(['sql' => $sql, 'params' => []], $ctx)['ok']);
        self::assertCount(3, ($this->executeSQL)(['sql' => $sql, 'params' => [], 'opts' => $nulls], $ctx)['ok']);

        // A WELL-FORMED plan still assembles: the surviving fragment applies, the skipped one does not.
        $survived = ($this->executeSQL)($plan((object) ['skipped' => false, 'sql' => 'v = ?', 'params' => ['c']]), $ctx);
        self::assertSame([3], array_map(static fn ($r): int => (int) ((array) $r)['id'], $survived['ok']));
        self::assertCount(3, ($this->executeSQL)($plan((object) ['skipped' => true, 'sql' => 'v = ?', 'params' => [null]]), $ctx)['ok']);

        // …and a cap that IS spelled still trips (the fail-closed reads did not disarm it).
        $capped = ['sql' => $sql, 'params' => [], 'opts' => (object) [
            'write' => null, 'whereDynamic' => null,
            'guard' => (object) ['limit' => 2, 'model' => 't', 'relation' => 'things'],
        ]];
        $this->expectException(\LiteDbModel\Runtime\LimitExceededError::class);
        ($this->executeSQL)($capped, $ctx);
    }

}
