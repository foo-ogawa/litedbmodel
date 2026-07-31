<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime\Tests;

use LiteDbModel\Bench\OrmBench;
use LiteDbModel\Runtime\Context;
use PHPUnit\Framework\TestCase;

use function LiteDbModel\Runtime\withTransaction;

/**
 * ORM-bench native (ir-exec) conformance (#141 / epic #123, php leg) — ALL 19 ops.
 *
 * Proves the litedbmodel php runtime runs the full covered surface (reads, single writes, batch writes,
 * RETURNING-chained transactions) through the bc-GENERATED ir-exec module
 * (`orm_bench/behaviors_generated.php`, verbatim `bc generate --lang php`) bound to the op-agnostic leaf
 * transport ({@see \LiteDbModel\Runtime\Leaves::makeHandlers}) — the php literal path (ts/go/rust =
 * native de-box; py/php = literal). Pins: every op executes; batched relations are N+1-free; batch
 * writes are ONE statement; the RETURNING-chained transactions run through the runtime tx boundary
 * (BEGIN + 2 body + COMMIT = 4 statements) and are ATOMIC (a mid-tx error commits nothing).
 * Schema/seed/harness/safety-counter are the SAME {@see OrmBench} the CSV cell measures (no duplicated
 * setup). Rows are `\stdClass` (php FETCH_OBJ — the record IS the wire).
 */
final class OrmBenchNativeTest extends TestCase
{
    private \PDO $driver;
    /** @var array<string,callable> */
    private array $fns;

    protected function setUp(): void
    {
        $this->driver = OrmBench::openDriver('sqlite');
        OrmBench::seed($this->driver);
        $this->fns = OrmBench::boundOps($this->driver, 'sqlite');
    }

    /** Direct read off the PDO (off-seam) for assertions. @return list<\stdClass> */
    private function users(): array
    {
        $stmt = $this->driver->prepare('SELECT email, name FROM benchmark_users ORDER BY id');
        $stmt->execute([]);
        return array_values($stmt->fetchAll(\PDO::FETCH_OBJ));
    }

    private function op(string $op, int $it = 0): mixed
    {
        return OrmBench::runOp($this->fns, $this->driver, $op, $it);
    }

    // ── every op executes ───────────────────────────────────────────────────────────

    public function testEveryOpExecutes(): void
    {
        $this->assertCount(19, OrmBench::OPS);
        foreach (OrmBench::OPS as $op) {
            OrmBench::seed($this->driver); // clean fixture per op (writes mutate)
            $this->assertNotNull($this->op($op), "op {$op} returned null");
        }
    }

    // ── reads + relations ─────────────────────────────────────────────────────────

    public function testFindOpsReturnExpectedRows(): void
    {
        $this->assertCount(100, $this->op('findAll')); // the op's LIMIT 100 over the seed SSoT
        $unique = $this->op('findUnique');
        $this->assertCount(1, $unique);
        $this->assertSame('user1@example.com', $unique[0]->email);
        $this->assertCount(1, $this->op('findFirst'));
    }

    public function testNestedRelationsHydrateChildren(): void
    {
        $users = $this->op('nestedFindAll');
        $byId = [];
        foreach ($users as $u) {
            $byId[$u->id] = $u;
        }
        // The children are batch-loaded (N+1-free) and grouped onto the RIGHT parent: user 1 owns the
        // seed's first contiguous run of posts. The fan-out is the fixture's, which the scale knob varies
        // (#170), so the assertion pins the SHAPE — the empty-children bug (#150) still fails it.
        $posts = $byId[1]->posts;
        $this->assertNotEmpty($posts);
        $this->assertSame(
            array_map(static fn (int $i) => "Post {$i}", range(1, count($posts))),
            array_map(static fn ($p) => $p->title, $posts),
        );

        $deep = $this->op('nestedRelations');
        $u1 = $this->firstWhere($deep, static fn ($u) => $u->id === 1);
        $comments = $u1->posts[0]->comments; // 3-level chain
        $this->assertNotEmpty($comments);
        $this->assertSame(range(1, count($comments)), array_map(static fn ($c) => $c->id, $comments));
    }

    public function testCompositeRelationsGroupByFullTuple(): void
    {
        $tenants = $this->op('compositeRelations');
        $tu1 = $this->firstWhere($tenants, static fn ($t) => $t->user_id === 1);
        // post_id / comment_id RESTART per tenant, so tenant 1 user 1 owns post_ids 1..n and post 1 owns
        // comment_ids 1..m — grouping on the FULL tuple keeps other tenants' identical ids out.
        $posts = $tu1->posts;
        $this->assertNotEmpty($posts);
        $this->assertSame(range(1, count($posts)), array_map(static fn ($p) => $p->post_id, $posts));
        $comments = $posts[0]->comments;
        $this->assertNotEmpty($comments);
        $this->assertSame(range(1, count($comments)), array_map(static fn ($c) => $c->comment_id, $comments));
    }

    // ── single writes (executeSQL write path: summary for INSERT, RETURNING rows for upsert) ────────

    public function testSingleWritesPersist(): void
    {
        // create: INSERT (write, no returning) → one-row summary; the row persists.
        $summary = $this->op('create', 7);
        $this->assertSame(1, $summary[0]->changes);
        $this->assertTrue($this->anyEmail('new7@bench.com'));
        // update: SET name WHERE id=1 → summary; the row is updated.
        $this->op('update');
        $this->assertSame('Updated 1', $this->nameOfUser(1));
        // upsert: INSERT ... ON CONFLICT DO UPDATE RETURNING id (existing email) → the RETURNING row.
        $returning = $this->op('upsert');
        // Loose numeric equality (mirror of python's `==`): the literal ir-exec path surfaces the
        // IR-declared `float` outType for the RETURNING id, so it arrives as float(1) — byte-parity
        // with python (which also returns 1.0). user1 conflict-updated, RETURNING its id.
        $this->assertEquals(1, $returning[0]->id);
        $this->assertSame('Upserted One', $this->nameOfUser(1));
    }

    // ── batch writes: ONE json_each statement for N records ─────────────────────────────────────────

    public function testBatchWritesApplyAllRows(): void
    {
        $this->op('createMany'); // 10 fresh rows
        $emails = array_map(static fn ($r) => $r->email, $this->users());
        for ($i = 0; $i < 10; $i++) {
            $this->assertContains("many0_{$i}@bench.com", $emails);
        }
        $this->op('updateMany'); // keyed on id 1..10
        $this->assertSame('Many 1', $this->nameOfUser(1));
    }

    // ── RETURNING-chained transactions through the runtime tx boundary ──────────────────────────────

    public function testNestedCreateTxPersistsUserAndPost(): void
    {
        $this->op('nestedCreate', 3); // INSERT user RETURNING id → INSERT post(author_id=id)
        $stmt = $this->driver->prepare("SELECT id FROM benchmark_users WHERE email='nc3@bench.com'");
        $stmt->execute([]);
        $user = $stmt->fetchAll(\PDO::FETCH_OBJ);
        $this->assertCount(1, $user);
        $ps = $this->driver->prepare('SELECT title FROM benchmark_posts WHERE author_id=?');
        $ps->execute([$user[0]->id]);
        $posts = $ps->fetchAll(\PDO::FETCH_OBJ);
        $this->assertSame(['NC Post'], array_map(static fn ($p) => $p->title, $posts)); // dependent write committed together
    }

    public function testTxAtomicityRollsBackOnError(): void
    {
        // Mirror rust/python: a mid-tx error commits NOTHING. The write runs through the GENERATED
        // `create` op + the leaf on the tx-pinned connection; the body then throws, so `withTransaction`
        // ROLLs back — the inserted row must be absent.
        $before = count($this->users());
        $fns = $this->fns;

        // The assertions live OUTSIDE the catch on purpose: PHPUnit's own AssertionFailedError extends
        // \RuntimeException, so a `fail()` inside the try would be swallowed by the catch below — the
        // gate would go green (or fail for the wrong reason) while the tx silently committed.
        $caught = null;
        try {
            withTransaction(Context::of($this->driver), static function () use ($fns): void {
                $fns['create'](['email' => 'rollback@bench.com', 'name' => 'RB']); // insert on the pinned tx conn
                throw new \RuntimeException('boom'); // mid-tx failure → ROLLBACK
            });
        } catch (\RuntimeException $e) {
            $caught = $e;
        }
        $this->assertNotNull($caught, 'expected the mid-tx throw to propagate');
        $this->assertSame('boom', $caught->getMessage());

        $this->assertCount($before, $this->users()); // nothing committed
        $this->assertFalse($this->anyEmail('rollback@bench.com')); // the insert was rolled back

        // COMMIT path (control): the same op through the boundary DOES persist.
        withTransaction(Context::of($this->driver), static fn () => $fns['create'](['email' => 'committed@bench.com', 'name' => 'OK']));
        $this->assertTrue($this->anyEmail('committed@bench.com'));
    }

    // ── safety statement counts (via the runtime middleware seam) ───────────────────────────────────

    public function testSafetyStatementCounts(): void
    {
        $expected = OrmBench::RELATION_QUERY_COUNTS + OrmBench::BATCH_QUERY_COUNTS + OrmBench::TX_STMT_COUNTS;
        $counts = [];
        foreach (array_keys($expected) as $op) {
            $counts[$op] = OrmBench::probe($this->driver, $this->fns, 'sqlite', $op)['stmts'];
        }
        $this->assertSame($expected, $counts); // relations 2/2/2/3/3, batch 1/1/1, tx 4/4/4/4
    }

    public function testProbeReportsTheRowsARelationOpMoves(): void
    {
        // The per-row denominator the report divides by (#170): a relation op reads a 100-parent window
        // AND both child levels under it, so its row total dwarfs its 3 statements.
        $deep = OrmBench::probe($this->driver, $this->fns, 'sqlite', 'nestedRelations')['rows'];
        $flat = OrmBench::probe($this->driver, $this->fns, 'sqlite', 'findAll')['rows'];
        $this->assertGreaterThan($flat, $deep);
    }

    // ── helpers ─────────────────────────────────────────────────────────────────────

    /** @param list<\stdClass> $rows */
    private function firstWhere(array $rows, callable $pred): \stdClass
    {
        foreach ($rows as $r) {
            if ($pred($r)) {
                return $r;
            }
        }
        $this->fail('no row matched the predicate');
    }

    private function anyEmail(string $email): bool
    {
        foreach ($this->users() as $r) {
            if ($r->email === $email) {
                return true;
            }
        }
        return false;
    }

    private function nameOfUser(int $id): string
    {
        $stmt = $this->driver->prepare('SELECT name FROM benchmark_users WHERE id=?');
        $stmt->execute([$id]);
        return (string) $stmt->fetchAll(\PDO::FETCH_OBJ)[0]->name;
    }
}
