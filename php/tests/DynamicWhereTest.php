<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime\Tests;

use LiteDbModel\Runtime\Connection;
use LiteDbModel\Runtime\ConnectionRegistry;
use LiteDbModel\Runtime\Context;
use LiteDbModel\Runtime\Leaves;
use LiteDbModel\Runtime\MiddlewareChain;
use LiteDbModel\Runtime\PdoDriver;
use LiteDbModel\Runtime\PdoPool;
use LiteDbModel\Runtime\ReaderWriterPools;
use LiteDbModel\Runtime\RoutingConfig;
use LiteDbModel\Runtime\RoutingExecutionContext;
use LiteDbModel\Runtime\WriterStickyClock;
use PHPUnit\Framework\TestCase;

use function LiteDbModel\Runtime\createMiddleware;
use function LiteDbModel\Runtime\routedTransaction;
use function LiteDbModel\Runtime\use_;
use function LiteDbModel\Runtime\withMiddlewareScope;

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
    use RelationThroughLeavesTrait;

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
     * @param list<object> $frags every fragment as the OBJECT a generated module wires (`ExprEval`
     *                            renders an `{obj: …}` struct literal as a `\stdClass`), never an assoc
     *                            array — the leaf reads the declared type, so the gate has to feed the
     *                            shape the real seam carries.
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
                'db' => null,
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
        self::assertSame([3], $this->ids([(object) ['skipped' => false, 'sql' => 'v = ?', 'params' => ['c']]]));
    }

    public function testASkippedFragmentIsDroppedFromTextAndBinding(): void
    {
        // The skipped fragment's param is never bound (else the bind count would not match the `?`s).
        self::assertSame([3], $this->ids([
            (object) ['skipped' => true, 'sql' => 'v = ?', 'params' => [null]],
            (object) ['skipped' => false, 'sql' => 'v <> ?', 'params' => ['b']],
        ]));
    }

    public function testEveryFragmentSkippedRunsTheStatementAsCompiled(): void
    {
        // No survivor ⇒ the emitted statement is untouched: its OWN bounded WHERE + page tail still apply.
        self::assertSame([2, 3], $this->ids([(object) ['skipped' => true, 'sql' => 'v = ?', 'params' => [null]]]));
    }

    /**
     * #205 — a field ABSENT from a PRESENT struct, or present with the WRONG TYPE, is an ABI BREAK,
     * never an absent VALUE. bc types a port by the literal wired into it and REJECTS a partial struct,
     * so a generated module always spells every field of every struct it wires, with the type the port
     * declares (`null` is how absence is spelled). Neither shape came from one, and defaulting or
     * coercing it would silently downgrade a write to a read, drop a relation cap, or erase a SKIP
     * predicate. The five languages must agree; this is the php leg.
     */
    public function testAMissingOrMistypedFieldOfAPresentStructIsLoud(): void
    {
        $ctx = ['nodeId' => 'n0', 'component' => 'executeSQL'];
        $sql = 'SELECT id, v FROM t ORDER BY id';
        $nulls = (object) ['db' => null, 'write' => null, 'whereDynamic' => null, 'guard' => null];
        // Ports whose control record carries a `whereDynamic` plan of ONE fragment (the #209 cases).
        $plan = static fn (mixed $frag): array => [
            'sql' => 'SELECT id, v FROM t ORDER BY id',
            'params' => [],
            'opts' => (object) ['db' => null, 'write' => null, 'whereDynamic' => (object) ['frags' => [$frag]], 'guard' => null],
        ];
        // Ports whose control record has ONE field replaced (every other field spelled as its null).
        $opts = static fn (array $kw): array => [
            'sql' => 'SELECT id, v FROM t ORDER BY id',
            'params' => [],
            'opts' => (object) array_merge(['db' => null, 'write' => null, 'whereDynamic' => null, 'guard' => null], $kw),
        ];

        // Each case breaks exactly ONE declared field of a struct that is present — by DROPPING it first…
        $cases = [
            [['params' => []], "'sql' field"],
            [['sql' => $sql], "'params' field"],
            [['sql' => $sql, 'params' => [], 'opts' => (object) ['write' => null, 'whereDynamic' => null, 'guard' => null]], "'db' field"],
            [['sql' => $sql, 'params' => [], 'opts' => (object) ['db' => null, 'whereDynamic' => null, 'guard' => null]], "'write' field"],
            [['sql' => $sql, 'params' => [], 'opts' => (object) ['db' => null, 'write' => null, 'guard' => null]], "'whereDynamic' field"],
            [['sql' => $sql, 'params' => [], 'opts' => (object) ['db' => null, 'write' => null, 'whereDynamic' => null]], "'guard' field"],
            [['sql' => $sql, 'params' => [], 'opts' => (object) ['db' => null, 'write' => (object) [], 'whereDynamic' => null, 'guard' => null]], "'returning' field"],
            [
                ['sql' => $sql, 'params' => [], 'opts' => (object) [
                    'write' => null, 'whereDynamic' => null,
                    'db' => null,
                    'guard' => (object) ['limit' => 2, 'relation' => 'things'],
                ]],
                "'model' field",
            ],
            // …and the PLAN and its FRAGMENTS, one level further down (#209).
            [
                ['sql' => $sql, 'params' => [], 'opts' => (object) ['db' => null, 'write' => null, 'whereDynamic' => (object) [], 'guard' => null]],
                "'frags' field",
            ],
            [$plan((object) ['sql' => 'v = ?', 'params' => ['zzz']]), "'skipped' field"],
            [$plan((object) ['skipped' => false, 'params' => ['zzz']]), "'sql' field"],
            [$plan((object) ['skipped' => false, 'sql' => 'v = ?']), "'params' field"],
            // A SKIPPED fragment is unboxed too — it is spelled in full like any other.
            [$plan((object) ['skipped' => true, 'params' => ['zzz']]), "'sql' field"],
            // …and then by giving it the WRONG TYPE, which is the same ABI break in every one of those
            // positions: bc emits the literal the port's type says, so nothing else can arrive from a
            // generated module, and coercing it is how a `returning` that is not a bool ran an INSERT on
            // the READ seam and a `skipped` that is not a bool applied a predicate the call SKIPPED —
            // the #209 failure modes, reached by another route.
            [['sql' => 42, 'params' => []], "payload's 'sql' must be string"],
            [['sql' => $sql, 'params' => 'x'], "payload's 'params' must be list"],
            [['sql' => $sql, 'params' => [], 'opts' => 'nope'], "payload's 'opts' must be record|null"],
            [$opts(['write' => 'nope']), "control record's 'write' must be record|null"],
            [$opts(['write' => (object) ['returning' => 'nope']]), "'write' mode's 'returning' must be bool"],
            [$opts(['write' => (object) ['returning' => 0]]), "'write' mode's 'returning' must be bool"],
            [$opts(['whereDynamic' => 'nope']), "control record's 'whereDynamic' must be record|null"],
            [$opts(['whereDynamic' => (object) ['frags' => 'nope']]), "'whereDynamic' plan's 'frags' must be list"],
            [$opts(['guard' => 'nope']), "control record's 'guard' must be record|null"],
            [$opts(['guard' => (object) ['limit' => 'nope', 'model' => 't', 'relation' => 'things']]), "'guard' cap's 'limit' must be int"],
            [$opts(['guard' => (object) ['limit' => 2.5, 'model' => 't', 'relation' => 'things']]), "'guard' cap's 'limit' must be int"],
            [$opts(['guard' => (object) ['limit' => 2, 'model' => 42, 'relation' => 'things']]), "'guard' cap's 'model' must be string|null"],
            [$opts(['guard' => (object) ['limit' => 2, 'model' => 't', 'relation' => 42]]), "'guard' cap's 'relation' must be string"],
            [$plan('nope'), 'fragment must be record'],
            [$plan((object) ['skipped' => 'no', 'sql' => 'v = ?', 'params' => ['zzz']]), "fragment's 'skipped' must be bool"],
            [$plan((object) ['skipped' => false, 'sql' => 42, 'params' => []]), "fragment's 'sql' must be string"],
            [$plan((object) ['skipped' => false, 'sql' => 'v = ?', 'params' => 'z']), "fragment's 'params' must be list"],
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
            'db' => null, 'write' => null, 'whereDynamic' => null,
            'guard' => (object) ['limit' => 2, 'model' => 't', 'relation' => 'things'],
        ]];
        $this->expectException(\LiteDbModel\Runtime\LimitExceededError::class);
        ($this->executeSQL)($capped, $ctx);
    }

    /**
     * #207 — the leaf hands the central seam ONE {@see \LiteDbModel\Runtime\StatementIntent}, derived
     * from the statement's RUN MODE, and `connectionFor` resolves the CONNECTION from it
     * ({@see \LiteDbModel\Runtime\resolvePool()}: write ⇒ the writer pool). The branch that selects the
     * SEAM is a DIFFERENT question: a RETURNING write runs on the ROW seam ({@see
     * \LiteDbModel\Runtime\execute()}) and is still a write. Deriving the intent from the branch — which
     * is what this transport did — sent `INSERT … RETURNING` to the READ REPLICA.
     *
     * The conformance/livedb setups run reader === writer (every intent returns the same pool), which is
     * why no cross-language leg saw this; the gate therefore SPLITS the pair and records which pool
     * served each statement. The PHP leg of the five.
     */
    public function testTheRunModeNotTheSeamBranchPicksThePool(): void
    {
        $pdo = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
        $driver = new PdoDriver($pdo);
        $log = new \ArrayObject();
        $routing = new RoutingConfig(
            ConnectionRegistry::fromDefault(new ReaderWriterPools(
                new RecordingPdoPool('reader', $driver, $log),
                new RecordingPdoPool('writer', $driver, $log),
            ))->build(),
            new WriterStickyClock(useWriterAfterTransaction: false),
        );
        $executeSQL = Leaves::makeHandlers(
            new RoutingExecutionContext($driver, new MiddlewareChain(), $routing),
            'sqlite',
        )['executeSQL'];
        $ctx = ['nodeId' => 'n0', 'component' => 'executeSQL'];

        // A plain READ — the bounded payload that omits the control record entirely → the READER.
        $executeSQL(['sql' => 'SELECT id FROM users', 'params' => []], $ctx);
        self::assertSame(['reader'], $log->getArrayCopy());

        // A RETURNING write → the WRITER, even though it runs on the ROW seam. This is the #207 case:
        // with the intent taken from the branch it landed on the reader above.
        $returning = $executeSQL([
            'sql' => 'INSERT INTO users (name) VALUES (?) RETURNING id',
            'params' => ['A'],
            'opts' => (object) ['db' => null, 'write' => (object) ['returning' => true], 'whereDynamic' => null, 'guard' => null],
        ], $ctx);
        self::assertSame(['reader', 'writer'], $log->getArrayCopy());
        // …and the two decisions are INDEPENDENT, not accidentally aligned: it took the ROW seam.
        self::assertSame([['id' => 1]], array_map(static fn ($r): array => (array) $r, $returning['ok']));

        // A NON-returning write → the WRITER too (the half that was already right stays right).
        $summary = $executeSQL([
            'sql' => 'INSERT INTO users (name) VALUES (?)',
            'params' => ['B'],
            'opts' => (object) ['db' => null, 'write' => (object) ['returning' => false], 'whereDynamic' => null, 'guard' => null],
        ], $ctx);
        self::assertSame(['reader', 'writer', 'writer'], $log->getArrayCopy());
        // The affected-rows summary, not rows (`lastInsertRowid` is deliberately 0 on this plane — see
        // {@see \LiteDbModel\Runtime\PdoConnection::run()}), so the seam it took is unambiguous.
        $row = (array) $summary['ok'][0];
        self::assertSame(['changes', 'lastInsertRowid'], array_keys($row));
        self::assertSame(1, $row['changes']);
    }


    /**
     * #215 — a covered-plane transaction is the runtime's ONE transaction: it takes its owned
     * connection from the WRITER pool, PINS it for the whole body, issues its tx-control THROUGH the
     * seam (so a registered middleware sees BEGIN/COMMIT) and arms writer-sticky on COMMIT. PHP gets all
     * four from {@see \LiteDbModel\Runtime\routedTransaction()}, which is why it is one of the three
     * legs that were already right; go and rust each ran a private BEGIN/COMMIT beside the central one
     * and lost some of them. The single-pool conformance/livedb setups cannot tell (reader IS writer
     * there), so the gate SPLITS the pair. The PHP leg of the five.
     */
    public function testACoveredTransactionOpensOnTheWriterAndIsSeamVisible(): void
    {
        $pdo = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
        $driver = new PdoDriver($pdo);
        $log = new \ArrayObject();
        $clock = 1000000.0;
        $routing = new RoutingConfig(
            ConnectionRegistry::fromDefault(new ReaderWriterPools(
                new RecordingPdoPool('reader', $driver, $log),
                new RecordingPdoPool('writer', $driver, $log),
            ))->build(),
            new WriterStickyClock(
                useWriterAfterTransaction: true,
                writerStickyDuration: 5000,
                now: static function () use (&$clock): float { return $clock; },
            ),
        );
        // The AMBIENT middleware chain (what a routed deployment gets), so the registered observer below
        // sees every statement the seam issues — including the runtime's own tx-control.
        $execCtx = new RoutingExecutionContext($driver, Context::ambientChain(), $routing);
        $executeSQL = Leaves::makeHandlers($execCtx, 'sqlite')['executeSQL'];
        $ctx = ['nodeId' => 'n0', 'component' => 'executeSQL'];
        $seen = [];
        $read = static function () use ($executeSQL, $ctx): void {
            $executeSQL(['sql' => 'SELECT id FROM users', 'params' => []], $ctx);
        };

        withMiddlewareScope(function () use ($execCtx, $executeSQL, $ctx, $read, &$seen, &$clock): void {
            use_(createMiddleware(['execute' => function (callable $next, string $sql, array $params) use (&$seen) {
                $seen[] = $sql;
                return $next($sql, $params);
            }]));
            // Before any transaction: a plain read => the READER (the sticky clock is unarmed).
            $read();
            routedTransaction($execCtx, static function () use ($executeSQL, $ctx, $read): void {
                // A READ inside the tx: its intent says READER, but the tx PIN wins — and it acquires NO
                // further pooled connection.
                $read();
                $executeSQL([
                    'sql' => 'INSERT INTO users (name) VALUES (?)',
                    'params' => ['A'],
                    'opts' => (object) ['db' => null, 'write' => (object) ['returning' => false], 'whereDynamic' => null, 'guard' => null],
                ], $ctx);
            }, null, 'sqlite');
            // The COMMIT armed writer-sticky: the SAME plain read now routes to the WRITER.
            $clock += 100.0;
            $read();
        });

        self::assertSame(['reader', 'writer:tx', 'writer'], $log->getArrayCopy());
        self::assertSame([
            'SELECT id FROM users',
            'BEGIN',
            'SELECT id FROM users',
            'INSERT INTO users (name) VALUES (?)',
            'COMMIT',
            'SELECT id FROM users',
        ], $seen);
    }

    /**
     * #213 — `pluck` / `group` read their ports through the SAME fail-closed reader as the SQL transport.
     * Their ports are FLAT, which is not a reason to trust them: the generator spells every one with the
     * type the catalog declares, so anything else is an ABI break — and on `group` the break is SILENT
     * and changes the SHAPE of the returned graph. A `single` cast with `(bool)` flipped the relation's
     * CARDINALITY, an `into` cast with `(string)` nested the children under `"42"`, and an absent
     * `pk`/`col` surfaced as an E_WARNING-shaped failure that named no port at all. The PHP leg.
     */
    public function testAMissingOrMistypedPluckOrGroupPortIsLoud(): void
    {
        $handlers = Leaves::makeHandlers(new \PDO('sqlite::memory:'), 'sqlite');
        $ctx = ['nodeId' => 'n0', 'component' => 'group'];
        $rows = [(object) ['id' => 1], (object) ['id' => 2]];
        $kids = [(object) ['post_id' => 1, 't' => 'a'], (object) ['post_id' => 1, 't' => 'b']];
        $pluckPorts = static fn (array $kw = []): array => array_merge(['rows' => $rows, 'col' => ['id']], $kw);
        $groupPorts = static fn (array $kw = []): array => array_merge([
            'parents' => $rows, 'children' => $kids, 'pk' => ['id'], 'fk' => ['post_id'],
            'into' => 'kids', 'single' => false,
        ], $kw);
        $loud = function (string $leaf, array $ports, string $want) use ($handlers, $ctx): void {
            $caught = null;
            try {
                $handlers[$leaf]($ports, $ctx);
            } catch (\RuntimeException $e) {
                $caught = $e;
            }
            self::assertNotNull($caught, "{$want} must be loud, but the leaf ran");
            self::assertStringContainsString($want, $caught->getMessage());
        };
        $drop = static function (array $ports, string $name): array {
            unset($ports[$name]);
            return $ports;
        };

        foreach (['rows', 'col'] as $name) {
            $loud('pluck', $drop($pluckPorts(), $name), "the pluck payload is missing its '{$name}' field");
        }
        foreach (['parents', 'children', 'pk', 'fk', 'into', 'single'] as $name) {
            $loud('group', $drop($groupPorts(), $name), "the group payload is missing its '{$name}' field");
        }

        // The MISTYPED ports — the silent failures the issue measured.
        $loud('pluck', $pluckPorts(['rows' => 'x']), "the pluck payload's 'rows' must be list");
        $loud('pluck', $pluckPorts(['col' => [1]]), "the pluck payload's 'col' must be string[]");
        $loud('group', $groupPorts(['single' => 'yes']), "the group payload's 'single' must be bool");
        $loud('group', $groupPorts(['into' => 42]), "the group payload's 'into' must be string");
        $loud('group', $groupPorts(['pk' => [1]]), "the group payload's 'pk' must be string[]");
        $loud('group', $groupPorts(['fk' => 'post_id']), "the group payload's 'fk' must be string[]");
        $loud('group', $groupPorts(['parents' => 'x']), "the group payload's 'parents' must be list");
        $loud('group', $groupPorts(['children' => 'x']), "the group payload's 'children' must be list");

        // A string-KEYED array is a `record` on this plane, never a list — the same answer TS's
        // `Array.isArray` and python's `isinstance(v, list)` give. php's `is_array` alone says yes to
        // one, so both list-shaped declarations passed a map straight through to the grouping core.
        $loud('pluck', $pluckPorts(['rows' => ['a' => 1]]), "the pluck payload's 'rows' must be list");
        $loud('pluck', $pluckPorts(['col' => ['a' => 'id']]), "the pluck payload's 'col' must be string[]");

        // The LEGAL shapes stay silent, and the CARDINALITY the ports declare is the one that comes out:
        // a hasMany nests the LIST, `single` nests the ONE child. (The mistyped `single` above used to
        // land on the other branch without a word.)
        self::assertSame(['ok' => [1, 2]], $handlers['pluck']($pluckPorts(), $ctx));
        $many = $handlers['group']($groupPorts(), $ctx)['ok'];
        self::assertSame($kids, $many[0]->kids);
        self::assertSame([], $many[1]->kids);
        $one = $handlers['group']($groupPorts(['single' => true]), $ctx)['ok'];
        self::assertSame($kids[0], $one[0]->kids);
        self::assertNull($one[1]->kids);
    }

    /**
     * #217 — the statement's own NAMED DATABASE reaches the router. The `db` field of the control record
     * is the ONLY thing that decides WHICH registered connection serves the statement.
     *
     * A single-DB fixture cannot tell a honored connection name from a dropped one — which is exactly why
     * the defect survived the single-DB conformance and livedb suites — so this gate registers TWO
     * connections over TWO SEPARATE in-memory sqlite databases whose tables are DISJOINT: `named_users`
     * exists ONLY in "B". A statement that lands on the wrong connection therefore does not return the
     * wrong rows, it cannot see a table at all.
     *
     * The PHP leg of "the same behaviour in all five languages": the twin of the TS `leaves.test.ts` #217
     * tests, the go `TestExecuteSQL_NamedDBRoutesTheStatement`, the rust `named_db_routes_the_statement`
     * and the python `test_named_db_routes_the_statement`.
     */
    /**
     * The TWO-database routed context both named-DB consumers resolve against: DB "A" (the default
     * connection) holds an UNRELATED table, DB "B" holds `named_users`. Returns the ctx plus the log of
     * WHICH connection each acquire drew from.
     *
     * @return array{0: RoutingExecutionContext, 1: \ArrayObject<int,string>}
     */
    private static function namedDbContext(): array
    {
        $open = static function (array $seed): PdoDriver {
            $pdo = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
            foreach ($seed as $sql) {
                $pdo->exec($sql);
            }
            return new PdoDriver($pdo);
        };
        // `only_in_a` is also the PARENT page of the cross-DB relation gate below: its rows live on A,
        // their children only on B, so one relation's two halves genuinely straddle two databases.
        $a = $open(['CREATE TABLE only_in_a (id INTEGER PRIMARY KEY)', 'INSERT INTO only_in_a VALUES (1),(2)']);
        $b = $open([
            'CREATE TABLE named_users (id INTEGER PRIMARY KEY, name TEXT)',
            "INSERT INTO named_users VALUES (1,'Ada'),(2,'Bob')",
        ]);
        $log = new \ArrayObject();
        $routing = new RoutingConfig(
            ConnectionRegistry::fromDefault(ReaderWriterPools::single(new RecordingPdoPool('A', $a, $log)))
                ->add('B', ReaderWriterPools::single(new RecordingPdoPool('B', $b, $log)))
                ->build(),
            new WriterStickyClock(useWriterAfterTransaction: false),
        );
        return [new RoutingExecutionContext($a, new MiddlewareChain(), $routing), $log];
    }

    /** Catch a failure's message so several negatives can be asserted in ONE run. */
    private static function failureMessage(callable $fn): string
    {
        try {
            $fn();
        } catch (\Throwable $e) {
            return $e->getMessage();
        }
        return '';
    }

    public function testNamedDbRoutesTheStatement(): void
    {
        [$ctx, $log] = self::namedDbContext();
        $executeSQL = Leaves::makeHandlers($ctx, 'sqlite')['executeSQL'];
        $at = ['nodeId' => 'n0', 'component' => 'executeSQL'];
        $read = static fn (?string $db): array => $executeSQL([
            'sql' => 'SELECT id, name FROM named_users ORDER BY id',
            'params' => [],
            'opts' => (object) ['db' => $db, 'write' => null, 'whereDynamic' => null, 'guard' => null],
        ], $at);

        // NAMED ⇒ B served it. The rows are unforgeable: `named_users` exists in NO other registered db.
        self::assertSame(
            [['id' => 1, 'name' => 'Ada'], ['id' => 2, 'name' => 'Bob']],
            array_map(static fn ($r): array => (array) $r, $read('B')['ok']),
        );
        self::assertSame(['B'], $log->getArrayCopy());

        // NEGATIVE CONTROL — the name DROPPED (`null`, which is exactly the pre-#217 lowering) sends the
        // SAME statement to the DEFAULT connection, where the table does not exist. Measured, not
        // reasoned: this is the failure a cross-DB relation produced before the emitter lowered the name.
        // Both negatives are caught rather than declared, so all three outcomes are asserted in ONE run
        // (an `expectException` would end the test at the first of them).
        self::assertStringContainsString(
            'named_users',
            self::failureMessage(static fn () => $read(null)),
            'a dropped name must land on the DEFAULT connection, where the table does not exist',
        );
        self::assertSame(['B', 'A'], $log->getArrayCopy());

        // An UNREGISTERED name is LOUD, never a silent fall back to the default.
        self::assertStringContainsString(
            "no connection registered under name 'ghost'",
            self::failureMessage(static fn () => $read('ghost')),
        );
    }

    /**
     * A CROSS-DB RELATION through the production path: the parent page reads from the DEFAULT connection
     * and the batched child fetch names the TARGET model's database, so one relation's two statements land
     * on DIFFERENT servers. The emitter bakes that name into the child fetch's `db` control field; here the
     * leaf carries it to `connectionFor` and the ONE ConnectionRegistry resolves it. The tables are
     * DISJOINT, so a mis-routed half sees no table at all.
     */
    public function testNamedDbRoutesTheRelationChildFetch(): void
    {
        [$ctx, $log] = self::namedDbContext();
        $handlers = Leaves::makeHandlers($ctx, 'sqlite');
        $parentSql = 'SELECT id FROM only_in_a ORDER BY id';
        $childSql = 'SELECT id, name FROM named_users WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id';
        $run = fn (?string $db): array => self::relationThroughLeaves($handlers, $parentSql, $childSql, 'id', 'id', 'kids', $db);

        // NAMED ⇒ B served the child fetch; the nested row proves it (`named_users` is on NO other connection).
        $grouped = $run('B');
        self::assertSame(['Ada'], array_map(static fn (\stdClass $r) => $r->name, $grouped[0]->kids));
        // Parent read on the default connection, child fetch on the named one.
        self::assertSame(['A', 'B'], $log->getArrayCopy());

        // NEGATIVE CONTROL — the SAME relation with the child fetch's name DROPPED (`null`, exactly the
        // pre-#217 lowering) sends it to the DEFAULT connection, where `named_users` does not exist.
        self::assertStringContainsString('named_users', self::failureMessage(static fn () => $run(null)));

        // An UNREGISTERED name is LOUD, never a silent fall back to the parent's database.
        self::assertStringContainsString(
            "no connection registered under name 'ghost'",
            self::failureMessage(static fn () => $run('ghost')),
        );
    }

    /**
     * A named statement on a NON-ROUTED (single-connection) ctx has no registry to resolve the name
     * against, so it must be LOUD. Running it on that one connection anyway is the silent wrong-database
     * execution named-DB lowering exists to prevent — and a single-DB deployment is exactly where it
     * would go unnoticed.
     */
    public function testNamedDbOnANonRoutedContextIsLoud(): void
    {
        $pdo = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
        $executeSQL = Leaves::makeHandlers($pdo, 'sqlite')['executeSQL'];
        $at = ['nodeId' => 'n0', 'component' => 'executeSQL'];
        $ports = static fn (?string $db): array => [
            'sql' => 'SELECT id FROM t',
            'params' => [],
            'opts' => (object) ['db' => $db, 'write' => null, 'whereDynamic' => null, 'guard' => null],
        ];
        // The DEFAULT connection is the single-connection case itself and still runs.
        self::assertSame([], $executeSQL($ports(null), $at)['ok']);
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches("/a statement names connection 'analytics'/");
        $executeSQL($ports('analytics'), $at);
    }
}

/**
 * A {@see PdoPool} that records its label on every acquire and delegates to ONE real {@see PdoDriver},
 * so a test can assert WHICH pool (reader vs writer) `resolvePool` selected for a leaf's statement while
 * the SQL really runs. The go/rust/TS/python legs use the same recording-pool instrument.
 */
final class RecordingPdoPool implements PdoPool
{
    public function __construct(
        private readonly string $label,
        private readonly PdoDriver $backing,
        private readonly \ArrayObject $log,
    ) {
    }

    public function acquire(): Connection
    {
        $this->log[] = $this->label;
        return $this->backing->connection();
    }

    public function release(Connection $conn, bool $destroy = false): void
    {
    }

    public function close(): void
    {
    }

    public function driver(): string
    {
        return 'sqlite';
    }

    public function backingDriver(): PdoDriver
    {
        // A TRANSACTION takes its owned connection from the pool's backing driver (the production call
        // `routedTransaction` makes to pin the writer), so recording it is how a test observes WHICH
        // pool a covered transaction opened on.
        $this->log[] = $this->label . ':tx';
        return $this->backing;
    }
}
