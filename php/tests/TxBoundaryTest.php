<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime\Tests;

use LiteDbModel\Runtime\ConnectionRegistry;
use LiteDbModel\Runtime\Context;
use LiteDbModel\Runtime\ExecutionContext;
use LiteDbModel\Runtime\IsolationLevel;
use LiteDbModel\Runtime\Leaves;
use LiteDbModel\Runtime\PdoDriver;
use LiteDbModel\Runtime\PlainPdoPool;
use LiteDbModel\Runtime\RoutingConfig;
use LiteDbModel\Runtime\RunInfo;
use LiteDbModel\Runtime\SqlFailure;
use LiteDbModel\Runtime\TransactionOptions;
use LiteDbModel\Runtime\WriteInReadOnlyContextError;
use LiteDbModel\Runtime\WriteOutsideTransactionError;
use LiteDbModel\Runtime\WriterStickyClock;
use PHPUnit\Framework\TestCase;

use function LiteDbModel\Runtime\currentContext;
use function LiteDbModel\Runtime\execute;
use function LiteDbModel\Runtime\isolationPrelude;
use function LiteDbModel\Runtime\isRetryableTxError;
use function LiteDbModel\Runtime\retryableByTypedCode;
use function LiteDbModel\Runtime\rollbackWith;
use function LiteDbModel\Runtime\routedTransaction;
use function LiteDbModel\Runtime\routingContext;
use function LiteDbModel\Runtime\runGuarded;
use function LiteDbModel\Runtime\runWithPinnedContext;
use function LiteDbModel\Runtime\transaction;
use function LiteDbModel\Runtime\withTransaction;
use function LiteDbModel\Runtime\withTransactionDecided;

/**
 * Phase B (#85, PHP) — UNIT tests for the public {@see transaction()} boundary (in-proc SQLite) + the
 * tx-completeness primitives (isolation SQL, retryable classifier), the PHP mirror of python's
 * test_transaction_boundary.py + go's TestBoundary* / rust's tx_boundary unit tests.
 *
 * No live DB — an in-proc SQLite {@see \PDO} (wrapped in {@see RecordingPdo}, which counts
 * BEGIN/COMMIT/ROLLBACK/SET issued through `exec()`) proves the boundary mechanics that DON'T need
 * PG/MySQL:
 *
 *   (1) MULTI-OP ATOMICITY — transaction(fn: [opA_insert; opB_insert]) → both commit; the recording
 *       PDO asserts EXACTLY ONE BEGIN / ONE COMMIT for the whole boundary (the ambient JOIN — opB
 *       opens no second BEGIN). opB PK-collides → opA's row ALSO rolls back (ONE BEGIN + ONE ROLLBACK,
 *       zero COMMIT), verified by reading real rows.
 *   (2) GUARD — a write OUTSIDE transaction() → WriteOutsideTransactionError; a read-only write inside
 *       → WriteInReadOnlyContextError; inside a boundary → ok.
 *   (4) NESTED — one BEGIN/COMMIT; an inner error rolls back the whole tx.
 *   (5) rollback_only — the body runs + returns its value, but NOTHING commits (dry-run).
 *   (6) SQLite isolation is a HARD ERROR at the boundary (before any connection is acquired).
 *   (7) The typed retryable classifier (errorInfo SQLSTATE/errno through the wrapped chain) +
 *       isolation-prelude SQL emission per dialect.
 *
 * The live-PG/MySQL isolation + real-contention-retry proof lives in TxBoundaryLiveTest.php.
 */
final class TxBoundaryTest extends TestCase
{
    private const TBL = 'scp_tx_boundary_php';

    private static function makeDriver(RecordingSink $sink): RecordingPdo
    {
        $db = new RecordingPdo('sqlite::memory:', $sink);
        $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $db->exec('CREATE TABLE ' . self::TBL . ' (id INTEGER PRIMARY KEY, worker INTEGER NOT NULL, seq INTEGER NOT NULL)');
        $sink->reset(); // ignore the DDL
        return $db;
    }

    /** The single-row INSERT into TBL (sqlite `?` placeholders). */
    private const INSERT_SQL = 'INSERT INTO ' . self::TBL . ' (id, worker, seq) VALUES (?, ?, ?)';

    /** @return list<array{0:int,1:int}> sorted (id, worker) rows (worker != 999 filters pre-seeds). */
    private static function readRows(\PDO $db): array
    {
        $rows = $db->query('SELECT id, worker FROM ' . self::TBL . ' WHERE worker <> 999')->fetchAll(\PDO::FETCH_OBJ);
        $out = array_map(fn ($r) => [(int) $r->id, (int) $r->worker], $rows);
        sort($out);
        return $out;
    }

    /**
     * The op the boundary body issues — a PUBLIC guarded write through the production guarded write
     * seam ({@see runGuarded()}) on the tx ctx pinned for `$ctx`, JOINing the ambient tx (the same seam a
     * user-facing write inside transaction() rides). Outside a boundary the ambient pin is absent, so
     * the guard fires (WriteOutsideTransactionError).
     */
    private static function op(ExecutionContext $ctx, int $id, int $worker, int $seq): RunInfo
    {
        return runGuarded(currentContext($ctx), self::INSERT_SQL, [$id, $worker, $seq], 'WRITE', self::TBL);
    }

    // ── (1) MULTI-OP ATOMICITY — commit path ────────────────────────────────────

    public function testMultiOpBoundaryOneBeginOneCommit(): void
    {
        $sink = new RecordingSink();
        $db = self::makeDriver($sink);
        $ctx = Context::forPdo($db);

        $result = transaction($ctx, fn () => [self::op($ctx, 100, 1, 0), self::op($ctx, 101, 1, 1)], new TransactionOptions(), 'sqlite');

        $this->assertSame([1, 1], array_map(fn ($r) => $r->changes, $result));
        // N ops in one boundary ⇒ ONE BEGIN + ONE COMMIT (the ambient JOIN — opB opens no 2nd BEGIN).
        $this->assertSame(1, $sink->begins, 'expected 1 BEGIN');
        $this->assertSame(1, $sink->commits, 'expected 1 COMMIT');
        $this->assertSame(0, $sink->rolls);
        $this->assertSame([[100, 1], [101, 1]], self::readRows($db));
    }

    // ── (1) MULTI-OP ATOMICITY — rollback path (B fails ⇒ A also rolls back) ─────

    public function testMultiOpBoundaryOpBFailRollsBackOpA(): void
    {
        $sink = new RecordingSink();
        $db = self::makeDriver($sink);
        $db->exec('INSERT INTO ' . self::TBL . ' (id, worker, seq) VALUES (201, 999, 9)'); // pre-seed collision
        $sink->reset();
        $ctx = Context::forPdo($db);

        $raised = false;
        try {
            transaction($ctx, fn () => [self::op($ctx, 200, 2, 0), self::op($ctx, 201, 2, 1)], new TransactionOptions(retryOnError: false), 'sqlite');
        } catch (\Throwable) {
            $raised = true;
        }
        $this->assertTrue($raised, 'opB PK collision must fail the whole boundary');
        $this->assertSame(1, $sink->begins);
        $this->assertSame(0, $sink->commits);
        $this->assertSame(1, $sink->rolls, 'opB failure ⇒ ONE ROLLBACK');
        // opA (id=200) must ALSO have rolled back — the whole boundary is atomic.
        $this->assertSame([], self::readRows($db), 'opA must roll back when opB fails (cross-op atomicity)');
    }

    // ── (2) write=tx GUARD ──────────────────────────────────────────────────────

    public function testGuardOutsideBoundaryRejectsWrite(): void
    {
        $sink = new RecordingSink();
        $db = self::makeDriver($sink);
        $ctx = Context::forPdo($db);
        // A bare guarded write OUTSIDE any transaction() (base ctx, no ambient pin; the guard fires
        // before the ctx is reached) → WriteOutsideTransactionError, nothing written.
        $this->expectException(WriteOutsideTransactionError::class);
        try {
            runGuarded($ctx, self::INSERT_SQL, [300, 3, 0], 'WRITE', self::TBL);
        } finally {
            $this->assertSame([], self::readRows($db));
        }
    }

    public function testGuardReadOnlyInsideBoundaryRejectsWrite(): void
    {
        $sink = new RecordingSink();
        $db = self::makeDriver($sink);
        $ctx = Context::forPdo($db);

        // Read-only-scoped write inside a boundary → WriteInReadOnlyContextError (read-only checked FIRST).
        $body = function () use ($db, $ctx): int {
            $ro = currentContext($ctx)->withReadOnly(); // the pinned tx ctx, derived read-only
            $threw = false;
            try {
                runWithPinnedContext($ro, fn () => self::op($ctx, 301, 3, 0));
            } catch (WriteInReadOnlyContextError) {
                $threw = true;
            }
            $this->assertTrue($threw, 'a read-only-scoped write inside a boundary must be rejected');
            return 0;
        };
        transaction($ctx, $body, new TransactionOptions(retryOnError: false), 'sqlite');
    }

    public function testGuardInsideBoundaryAllowsWrite(): void
    {
        $sink = new RecordingSink();
        $db = self::makeDriver($sink);
        $ctx = Context::forPdo($db);
        $r = transaction($ctx, fn () => self::op($ctx, 302, 3, 0), new TransactionOptions(), 'sqlite');
        $this->assertSame(1, $r->changes);
        $this->assertSame([[302, 3]], self::readRows($db));
    }

    // ── (4) NESTED transaction = one begin/commit ───────────────────────────────

    public function testNestedTransactionOneBeginCommit(): void
    {
        $sink = new RecordingSink();
        $db = self::makeDriver($sink);
        $ctx = Context::forPdo($db);

        $outer = function () use ($db, $ctx) {
            self::op($ctx, 500, 5, 0);
            // A NESTED transaction() JOINs the outer — no new BEGIN/COMMIT.
            return transaction($ctx, fn () => self::op($ctx, 501, 5, 1), new TransactionOptions(), 'sqlite');
        };
        transaction($ctx, $outer, new TransactionOptions(), 'sqlite');

        $this->assertSame(1, $sink->begins);
        $this->assertSame(1, $sink->commits);
        $this->assertSame(0, $sink->rolls);
        $this->assertSame([[500, 5], [501, 5]], self::readRows($db));
    }

    public function testNestedInnerErrorRollsBackWholeTx(): void
    {
        $sink = new RecordingSink();
        $db = self::makeDriver($sink);
        $db->exec('INSERT INTO ' . self::TBL . ' (id, worker, seq) VALUES (601, 999, 9)'); // collision for inner
        $sink->reset();
        $ctx = Context::forPdo($db);

        $outer = function () use ($db, $ctx) {
            self::op($ctx, 600, 6, 0);
            return transaction($ctx, fn () => self::op($ctx, 601, 6, 1), new TransactionOptions(), 'sqlite');
        };
        $raised = false;
        try {
            transaction($ctx, $outer, new TransactionOptions(retryOnError: false), 'sqlite');
        } catch (\Throwable) {
            $raised = true;
        }
        $this->assertTrue($raised);
        $this->assertSame(0, $sink->commits);
        $this->assertSame(1, $sink->rolls);
        $this->assertSame([], self::readRows($db), 'an inner error rolls back the WHOLE tx (id=600 absent)');
    }

    /**
     * #352 — the nested JOIN lives in the combinator, so a nested withTransaction() joins the outer
     * transaction like a nested transaction() does: no second BEGIN/COMMIT, and an outer body that fails
     * after it returned rolls back every row. It used to BEGIN again on the same \PDO (SQLite raises, PG
     * warns, MySQL implicitly commits the outer work).
     */
    public function testNestedWithTransactionJoinsTheOuter(): void
    {
        $sink = new RecordingSink();
        $db = self::makeDriver($sink);
        $ctx = Context::forPdo($db);

        $error = null;
        try {
            transaction($ctx, function () use ($ctx): void {
                self::op($ctx, 1, 1, 0);
                withTransaction($ctx, fn () => self::op($ctx, 2, 1, 1));
                self::op($ctx, 3, 1, 2);
                throw new \RuntimeException('outer body fails');
            }, new TransactionOptions(retryOnError: false), 'sqlite');
        } catch (\Throwable $e) {
            $error = $e;
        }
        $this->assertNotNull($error);
        $this->assertSame('outer body fails', $error->getMessage(), "the outer body's own error surfaces");
        $this->assertSame([1, 0, 1], [$sink->begins, $sink->commits, $sink->rolls], 'ONE BEGIN, then ONE ROLLBACK');
        $this->assertSame([], self::readRows($db), 'the failed outer transaction keeps none of its rows');
    }

    /**
     * A joined boundary leaves the envelope to the outer (TS `withTransactionAsync`, go
     * `TransactionDecided`): a nested ROLLBACK decision returns its value without rolling the outer back,
     * and a nested transaction() does not re-run its body on a retryable error — the outer transaction
     * it ran in is the one that failed.
     */
    public function testANestedBoundaryLeavesTheEnvelopeToTheOuter(): void
    {
        $sink = new RecordingSink();
        $db = self::makeDriver($sink);
        $ctx = Context::forPdo($db);

        $gate = transaction($ctx, function () use ($ctx): string {
            self::op($ctx, 1, 1, 0);
            return withTransactionDecided($ctx, function (ExecutionContext $tx) use ($ctx): \LiteDbModel\Runtime\TxDecision {
                self::op($ctx, 2, 1, 1);
                return rollbackWith('gate');
            });
        }, new TransactionOptions(), 'sqlite');
        $this->assertSame('gate', $gate);
        $this->assertSame([1, 1, 0], [$sink->begins, $sink->commits, $sink->rolls], 'the outer decides: ONE BEGIN, ONE COMMIT');
        $this->assertSame([[1, 1], [2, 1]], self::readRows($db));

        $runs = 0;
        try {
            transaction($ctx, function () use ($ctx, &$runs): void {
                transaction($ctx, function () use (&$runs): void {
                    $runs++;
                    throw self::pdoException(['40001', null, 'could not serialize access'], 'could not serialize access');
                }, new TransactionOptions(retryLimit: 3, retryDurationMs: 0), 'sqlite');
            }, new TransactionOptions(retryOnError: false), 'sqlite');
        } catch (\Throwable) {
        }
        $this->assertSame(1, $runs, 'a nested body is not retried inside the outer transaction');
    }

    // ── (4b) a transaction belongs to the context it was opened on (#351) ───────

    /**
     * Two INDEPENDENT contexts in one process (one database per tenant): the leaf of B, a nested
     * transaction() on B, and a routed context over B's own config must all reach B while a transaction
     * on A is open. The pin used to be ONE process-wide slot, so B's read returned A's row and B's write
     * landed in A and committed with A's transaction (the TS runtime keys the pin by ctx since 010a3fb).
     */
    public function testATransactionIsNotJoinedByAnIndependentContext(): void
    {
        $sinkA = new RecordingSink();
        $a = self::makeDriver($sinkA);
        $sinkB = new RecordingSink();
        $b = self::makeDriver($sinkB);
        $a->exec('INSERT INTO ' . self::TBL . ' (id, worker, seq) VALUES (1, 1, 0)');
        $b->exec('INSERT INTO ' . self::TBL . ' (id, worker, seq) VALUES (1, 2, 0)');
        $sinkA->reset();
        $sinkB->reset();
        $ctxA = Context::forPdo($a);
        $ctxB = Context::forPdo($b);
        $leafB = Leaves::makeHandlers($ctxB, 'sqlite')['executeSQL'];
        $at = ['nodeId' => 'n0', 'component' => 'executeSQL'];
        $select = 'SELECT id, worker FROM ' . self::TBL . ' ORDER BY id';
        $rows = static fn (array $out): array => array_map(static fn ($r): array => [(int) $r->id, (int) $r->worker], $out['ok']);

        $seen = null;
        transaction($ctxA, function () use ($ctxB, $leafB, $at, $select, $rows, &$seen): void {
            $seen = $rows($leafB(['sql' => $select, 'params' => []], $at));
            transaction($ctxB, static fn () => $leafB([
                'sql' => self::INSERT_SQL,
                'params' => [2, 2, 0],
                'opts' => (object) ['db' => null, 'write' => (object) ['returning' => false], 'whereDynamic' => null, 'guard' => null],
            ], $at), new TransactionOptions(retryOnError: false), 'sqlite');
        }, new TransactionOptions(retryOnError: false), 'sqlite');

        $this->assertSame([[1, 2]], $seen, "B's leaf must read B, not the open transaction on A");
        $this->assertSame([[1, 1]], self::readRows($a), "B's write must not land in A");
        $this->assertSame([[1, 2], [2, 2]], self::readRows($b), "B's write lands in B");
        $this->assertSame([1, 1], [$sinkB->begins, $sinkB->commits], 'the transaction on B opens and commits on B');
        $this->assertSame([1, 1], [$sinkA->begins, $sinkA->commits]);

        // The routed half: a context over an independent RoutingConfig is not joined either.
        $routed = static fn (\PDO $pdo) => routingContext(new RoutingConfig(
            ConnectionRegistry::singleDefault(new PlainPdoPool(new PdoDriver($pdo), 'sqlite')),
            new WriterStickyClock(useWriterAfterTransaction: false),
        ));
        $routedA = $routed($a);
        $routedB = $routed($b);
        $seen = null;
        routedTransaction($routedA, function () use ($routedB, $select, &$seen): void {
            $seen = array_map(static fn ($r): array => [(int) $r->id, (int) $r->worker], execute($routedB, $select, []));
        }, new TransactionOptions(retryOnError: false), 'sqlite');
        $this->assertSame([[1, 2], [2, 2]], $seen, "a routed context over B's config must read B");
    }

    // ── (5) rollback_only (dry-run) ─────────────────────────────────────────────

    public function testRollbackOnlyReturnsValueButCommitsNothing(): void
    {
        $sink = new RecordingSink();
        $db = self::makeDriver($sink);
        $ctx = Context::forPdo($db);
        $r = transaction($ctx, fn () => self::op($ctx, 700, 7, 0), new TransactionOptions(rollbackOnly: true), 'sqlite');
        $this->assertSame(1, $r->changes); // the body's own view: its statement ran (before the boundary rolled back)
        // …but the boundary ROLLED BACK, so nothing persisted.
        $this->assertSame(1, $sink->begins);
        $this->assertSame(0, $sink->commits);
        $this->assertSame(1, $sink->rolls);
        $this->assertSame([], self::readRows($db), 'rollback_only must commit nothing');
    }

    // ── (6) SQLite isolation is a hard error at the boundary ────────────────────

    public function testSqliteIsolationRequestIsHardError(): void
    {
        $sink = new RecordingSink();
        $db = self::makeDriver($sink);
        $ctx = Context::forPdo($db);
        $threw = false;
        try {
            transaction($ctx, fn () => null, new TransactionOptions(isolation: IsolationLevel::Serializable), 'sqlite');
        } catch (\RuntimeException $e) {
            $threw = true;
            $this->assertStringContainsString('SQLite does not support a per-transaction isolation level', $e->getMessage());
        }
        $this->assertTrue($threw, 'a SQLite isolation request must be a hard error');
        // The hard-error fires BEFORE any connection is acquired.
        $this->assertSame(0, $sink->begins);
    }

    // ── (7a) isolation-prelude SQL emission per dialect ─────────────────────────

    public function testIsolationPreludePostgresPostBegin(): void
    {
        $this->assertSame([[], []], isolationPrelude('postgres', null));
        $this->assertSame([[], ['SET TRANSACTION ISOLATION LEVEL SERIALIZABLE']], isolationPrelude('postgres', IsolationLevel::Serializable));
        $this->assertSame([[], ['SET TRANSACTION ISOLATION LEVEL READ COMMITTED']], isolationPrelude('postgres', IsolationLevel::ReadCommitted));
    }

    public function testIsolationPreludeMysqlPreBegin(): void
    {
        $this->assertSame([['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'], []], isolationPrelude('mysql', IsolationLevel::RepeatableRead));
        $this->assertSame([[], []], isolationPrelude('mysql', null));
    }

    // ── (7b) typed retryable classifier — errorInfo SQLSTATE/errno, NOT string ──

    public function testTypedCodeClassifiesPgSerializationFailure(): void
    {
        // A synthetic \PDOException carrying the PG 40001 SQLSTATE in errorInfo[0] (the SAME shape
        // PDO_pgsql sets on a real serialization failure). No 40001 in the MESSAGE — so ONLY the typed
        // errorInfo path can classify it. This is the load-bearing path the live retry relies on.
        $e = self::pdoException(['40001', null, 'oops'], 'a driver failure with no code in text');
        $this->assertTrue(retryableByTypedCode($e), 'PG 40001 SQLSTATE (errorInfo[0]) must classify typed');
        $this->assertTrue(isRetryableTxError($e));
    }

    public function testTypedCodeClassifiesMysqlDeadlockErrno(): void
    {
        // A synthetic \PDOException carrying the MySQL 1213 errno in errorInfo[1]. No 1213 in the text.
        $e = self::pdoException(['40001', 1213, 'a lock problem'], 'a driver failure with no code in text');
        $this->assertTrue(retryableByTypedCode($e), 'MySQL 1213 errno (errorInfo[1]) must classify typed');
        $this->assertTrue(isRetryableTxError($e));
    }

    public function testTypedCodeReachesWrappedPdoThroughSqlFailure(): void
    {
        // The COMMIT-time shape: a raw \PDOException (PG 40001) mapped into a SqlFailure. The typed
        // classifier must TRAVERSE the wrapped chain (SqlFailure->wrapped / getPrevious) to reach the
        // concrete errorInfo — even though the SqlFailure's OWN message is a flattened text (go
        // SqlFailure.Unwrap() parity). This is the exact defect go #83's audit caught.
        $raw = self::pdoException(['40001', null, 'serialization failure'], 'boom');
        $wrapped = SqlFailure::fromPdo($raw);
        $this->assertTrue(retryableByTypedCode($wrapped), 'typed classifier must reach errorInfo through the wrapped chain');
        $this->assertTrue(isRetryableTxError($wrapped));
    }

    public function testNonRetryableDataConflictIsNotRetryable(): void
    {
        // A unique-violation SQLSTATE (23505 on PG) is a DATA conflict — NOT retryable (re-running fails
        // identically). Neither the typed path nor the string fallback should classify it retryable.
        $e = self::pdoException(['23505', 1062, 'duplicate key value violates unique constraint'], 'unique_violation');
        $this->assertFalse(retryableByTypedCode($e));
        $this->assertFalse(isRetryableTxError($e), 'a unique/data conflict must NOT be retryable');
    }

    // ── #330 defect 2: the COMMIT stage ─────────────────────────────────────────

    /** @return array{0:int,1:?\Throwable} body runs, error */
    private static function runWithCommitFailure(\PDOException $commitError, int $failures): array
    {
        $db = new CommitFailingPdo('sqlite::memory:', $commitError, $failures);
        $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $db->exec('CREATE TABLE ' . self::TBL . ' (id INTEGER PRIMARY KEY, worker INTEGER NOT NULL, seq INTEGER NOT NULL)');
        $runs = 0;
        $ctx = Context::forPdo($db);
        $body = function () use (&$runs, $ctx) {
            $runs++;
            return self::op($ctx, 800 + $runs, 8, 0);
        };
        try {
            transaction($ctx, $body, new TransactionOptions(retryLimit: 3, retryDurationMs: 0), 'sqlite');
            return [$runs, null];
        } catch (\Throwable $e) {
            return [$runs, $e];
        }
    }

    public function testCommitConnectionErrorDoesNotRerunTheBody(): void
    {
        // The COMMIT may have reached the server before the connection dropped: re-running the body
        // could write twice. The error surfaces after ONE run of the body.
        [$runs, $error] = self::runWithCommitFailure(
            self::pdoException(['HY000', 7, 'server closed the connection unexpectedly'], 'server closed the connection unexpectedly'),
            3,
        );
        $this->assertSame(1, $runs, 'the body must not re-run after a COMMIT connection error');
        $this->assertNotNull($error);
        $this->assertStringContainsString('server closed the connection', $error->getMessage());
    }

    public function testCommitSerializationFailureIsStillRetried(): void
    {
        [$runs, $error] = self::runWithCommitFailure(
            self::pdoException(['40001', 7, 'could not serialize access'], 'could not serialize access'),
            1,
        );
        $this->assertNull($error);
        $this->assertSame(2, $runs);
    }

    // ── A retry after a connection error runs only on a connection that passed a probe ──────────

    public function testRetryAfterAConnectionErrorProbesBeforeBeginAndNeverBeginsOnAConnectionThatFailsIt(): void
    {
        // The connection dies under the body's first statement; from then on every statement fails with a
        // connection error. A retry must not issue BEGIN on it: attempts 2 and 3 each send `SELECT 1` to at
        // most retryLimit acquired connections (here always the one \PDO), none passes, and the probe's
        // error surfaces once the attempts run out.
        $db = new DyingPdo('sqlite::memory:');
        $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $db->exec('CREATE TABLE ' . self::TBL . ' (id INTEGER PRIMARY KEY, worker INTEGER NOT NULL, seq INTEGER NOT NULL)');
        $ctx = Context::forPdo($db);
        $runs = 0;
        try {
            transaction($ctx, function () use ($ctx, &$runs) {
                $runs++;
                return self::op($ctx, 900, 9, 0);
            }, new TransactionOptions(retryLimit: 3, retryDurationMs: 0), 'sqlite');
            $this->fail('the transaction must fail: the only connection is dead');
        } catch (\Throwable $e) {
            $this->assertStringContainsString('server closed the connection', $e->getMessage());
        }
        $this->assertSame(1, $runs, 'the body runs only on a connection that passed the probe');
        $this->assertSame(array_fill(0, 6, 'SELECT 1'), $db->afterDeath(), 'no BEGIN after the connection died — only the probe, retryLimit times in each of the 2 retries');
    }

    public function testADeadlockRetryIsNotProbed(): void
    {
        [$runs, $error] = self::runWithCommitFailure(
            self::pdoException(['40001', 7, 'could not serialize access'], 'could not serialize access'),
            1,
        );
        $this->assertNull($error);
        $this->assertSame(2, $runs);
        // The CommitFailingPdo records no probe: a serialization failure is not a connection error.
    }

    /** Build a \PDOException with a specific errorInfo triple (the live-driver shape). */
    private static function pdoException(array $errorInfo, string $message): \PDOException
    {
        $e = new \PDOException($message);
        $e->errorInfo = $errorInfo;
        return $e;
    }
}

/** A shared sink counting BEGIN / COMMIT / ROLLBACK issued through {@see RecordingPdo::exec()}. */
final class RecordingSink
{
    public int $begins = 0;
    public int $commits = 0;
    public int $rolls = 0;
    /** @var list<string> the raw tx-control / SET statements, in issue order (for isolation SQL capture). */
    public array $control = [];

    public function reset(): void
    {
        $this->begins = $this->commits = $this->rolls = 0;
        $this->control = [];
    }
}

/**
 * A \PDO that records the tx-control (BEGIN/COMMIT/ROLLBACK) + SET statements the owned-connection tx
 * path emits through `exec()` — so the boundary tests assert EXACTLY the BEGIN/COMMIT/ROLLBACK counts
 * (the ambient JOIN: N ops = ONE BEGIN). Everything else passes through verbatim.
 */
final class RecordingPdo extends \PDO
{
    public function __construct(string $dsn, private readonly RecordingSink $sink)
    {
        parent::__construct($dsn);
    }

    #[\ReturnTypeWillChange]
    public function exec(string $statement): int|false
    {
        $head = strtoupper(strtok(trim($statement), " \t\n"));
        if ($head === 'BEGIN') {
            $this->sink->begins++;
        } elseif ($head === 'COMMIT') {
            $this->sink->commits++;
        } elseif ($head === 'ROLLBACK') {
            $this->sink->rolls++;
        }
        if ($head === 'BEGIN' || $head === 'COMMIT' || $head === 'ROLLBACK' || $head === 'SET') {
            $this->sink->control[] = trim($statement);
        }
        return parent::exec($statement);
    }
}

/** A \PDO whose COMMIT rolls back the in-proc tx (a dropped connection leaves none open) and throws `$error`, `$failures` times. */
final class CommitFailingPdo extends \PDO
{
    public function __construct(string $dsn, private readonly \PDOException $error, private int $failures)
    {
        parent::__construct($dsn);
    }

    #[\ReturnTypeWillChange]
    public function exec(string $statement): int|false
    {
        if (strtoupper(strtok(trim($statement), " \t\n")) === 'COMMIT' && $this->failures > 0) {
            $this->failures--;
            parent::exec('ROLLBACK');
            throw $this->error;
        }
        return parent::exec($statement);
    }
}

/**
 * A \PDO whose connection dies under the first INSERT: that statement and every one after it fail with a
 * connection error (`server closed the connection unexpectedly`). {@see afterDeath()} lists what was sent
 * to it after it died.
 */
final class DyingPdo extends \PDO
{
    private bool $dead = false;
    /** @var list<string> */
    private array $afterDeath = [];

    /** @return list<string> */
    public function afterDeath(): array
    {
        return $this->afterDeath;
    }

    private function check(string $sql): void
    {
        if (!$this->dead && str_starts_with(strtoupper(trim($sql)), 'INSERT')) {
            $this->dead = true;
            throw self::lost();
        }
        if ($this->dead) {
            if (strtoupper(trim($sql)) !== 'ROLLBACK') {
                $this->afterDeath[] = trim($sql);
            }
            throw self::lost();
        }
    }

    private static function lost(): \PDOException
    {
        $e = new \PDOException('SQLSTATE[HY000]: General error: 7 server closed the connection unexpectedly');
        $e->errorInfo = ['HY000', 7, 'server closed the connection unexpectedly'];
        return $e;
    }

    #[\ReturnTypeWillChange]
    public function exec(string $statement): int|false
    {
        $this->check($statement);
        return parent::exec($statement);
    }

    #[\ReturnTypeWillChange]
    public function prepare(string $query, array $options = []): \PDOStatement|false
    {
        $this->check($query);
        return parent::prepare($query, $options);
    }
}
