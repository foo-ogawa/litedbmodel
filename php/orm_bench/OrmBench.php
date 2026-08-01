<?php

declare(strict_types=1);

namespace LiteDbModel\Bench;

use LiteDbModel\Runtime\Context;
use LiteDbModel\Runtime\ExecutionContext;
use LiteDbModel\Runtime\Leaves;

use function LiteDbModel\Runtime\clearMiddlewares;
use function LiteDbModel\Runtime\createMiddleware;
use function LiteDbModel\Runtime\registerMiddleware;
use function LiteDbModel\Runtime\withTransaction;

/**
 * NATIVE-codegen ORM-bench cell (php leg, epic #123) — the twin of the python `orm_bench.main`.
 *
 * Self-measures the covered ORM ops through the litedbmodel-GENERATED ir-exec module
 * (`behaviors_generated.php`, verbatim `bc generate --lang php`) + `litedbmodel_runtime`'s op-agnostic
 * leaf transport ({@see Leaves::makeHandlers}), and prints a flat CSV (`cell,dialect,op,iter,us,rows`) the
 * TS collector aggregates.
 *
 * This cell is a litedbmodel-CONSUMER: it binds the leaf transport (`makeHandlers` →
 * executeSQL/pluck/group) into the generated module's `bind($handlers)` (boundary injection — the php
 * literal/ir-exec path, epic #123: ts/go/rust = native de-box; py/php = literal) and calls the
 * resulting per-op callables. It holds NO hand-written exec seam and NO hand-written BEGIN/COMMIT:
 *
 *   - reads/single-writes/batches run the bound op callable directly; the leaf funnels every DB access
 *     through the runtime central execute/run seam. Relations are N+1-free: parents → pluck →
 *     executeSQL(WHERE fk IN …) → group = 1 batched child query per level (nestedFindAll=2,
 *     nestedRelations=3, composite=3). Batch writes are ONE json_each statement.
 *   - RETURNING-chained TRANSACTIONS run THROUGH the runtime tx boundary {@see withTransaction()}
 *     (BEGIN → body → COMMIT on ok / ROLLBACK on error) — the consumer's tx-boundary responsibility.
 *     The generated `.map` runner emits its 2 body statements via the leaf; `withTransaction` pins the
 *     tx-owned connection (the leaf resolves it via `currentContext()`) and brackets BEGIN/COMMIT.
 */
final class OrmBench
{
    /**
     * The ONE seed SSoT (benchmark/crosslang/.setup/sqlite.json, emitted from orm-domain.ts) — the SAME
     * fixture every other cell loads: `schema` (drop+create, applied once) + `delete`+`insert` (the
     * canonical 110-user fixture, per op). FIXTURE setup, not covered code. Cached on first use.
     *
     * @return array{schema:list<string>,delete:list<string>,insert:list<string>}
     */
    private static function setup(string $dialect = 'sqlite'): array
    {
        /** @var array<string,array<string,array>> $cache */
        static $cache = [];
        if (!isset($cache[$dialect])) {
            require_once __DIR__ . '/../lm_bench_setup.php';
            $cache[$dialect] = \lm_bench_load_setup($dialect);
        }
        return $cache[$dialect];
    }

    /**
     * All 19 covered ops in generated declaration order (COMPONENT_NAMES).
     *
     * @var list<string>
     */
    public const OPS = [
        'findAll', 'filterPaginateSort', 'findFirst', 'findUnique',
        'nestedFindAll', 'nestedFindFirst', 'nestedFindUnique', 'nestedRelations', 'compositeRelations',
        'create', 'update', 'upsert', 'createMany', 'upsertMany', 'updateMany',
        'nestedCreate', 'nestedUpsert', 'nestedUpdate', 'delete',
    ];

    /**
     * The RETURNING-chained transactions — run THROUGH the runtime tx boundary. The generated runner
     * emits no BEGIN/COMMIT; the boundary is the consumer's (BEGIN + 2 body + COMMIT).
     *
     * @var list<string>
     */
    public const TX_OPS = ['nestedCreate', 'nestedUpsert', 'nestedUpdate', 'delete'];

    // ── safety expectations ──────────────────────────────────────────────────────────
    /** Batched relation: 1 parent + 1 batched child per level, INDEPENDENT of the row count. @var array<string,int> */
    public const RELATION_QUERY_COUNTS = [
        'nestedFindAll' => 2, 'nestedFindFirst' => 2, 'nestedFindUnique' => 2, 'nestedRelations' => 3, 'compositeRelations' => 3,
    ];
    /** Batch write: ONE json_each statement for N records (no per-row fan-out). @var array<string,int> */
    public const BATCH_QUERY_COUNTS = ['createMany' => 1, 'upsertMany' => 1, 'updateMany' => 1];
    /** RETURNING-chained tx: BEGIN + 2 body (the RETURNING write + the dependent write) + COMMIT = 4. @var array<string,int> */
    public const TX_STMT_COUNTS = ['nestedCreate' => 4, 'nestedUpsert' => 4, 'nestedUpdate' => 4, 'delete' => 4];

    /**
     * The PDO for ONE target DB (#156). sqlite = in-memory; postgres / mysql = the LIVE docker DB on the
     * established ports, opened through the runtime's OWN {@see LiveDb} constructors (the cell writes no
     * connection code). Each applies the schema of ITS OWN target from the single seed SSoT. An unknown
     * or unreachable target is a LOUD failure — never a silent fall back to sqlite, which is exactly the
     * defect that let a "postgres" run execute sqlite SQL.
     */
    public static function openDriver(string $dialect = 'sqlite'): \PDO
    {
        if ($dialect === 'sqlite') {
            $db = new \PDO('sqlite::memory:');
            $db->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            $db->setAttribute(\PDO::ATTR_STRINGIFY_FETCHES, false);
        } elseif ($dialect === 'postgres') {
            $db = \LiteDbModel\Runtime\LiveDb::postgres(
                getenv('TEST_DB_HOST') ?: 'localhost',
                (int) (getenv('TEST_DB_PORT') ?: 5433),
                getenv('TEST_DB_USER') ?: 'testuser',
                getenv('TEST_DB_PASSWORD') ?: 'testpass',
                getenv('TEST_DB_NAME') ?: 'testdb',
            );
        } elseif ($dialect === 'mysql') {
            $db = \LiteDbModel\Runtime\LiveDb::mysql(
                getenv('TEST_MYSQL_HOST') ?: '127.0.0.1',
                (int) (getenv('TEST_MYSQL_PORT') ?: 3307),
                getenv('TEST_MYSQL_USER') ?: 'testuser',
                getenv('TEST_MYSQL_PASSWORD') ?: 'testpass',
                getenv('TEST_MYSQL_DB') ?: 'testdb',
            );
        } else {
            throw new \RuntimeException("orm_bench: unknown target '{$dialect}' (sqlite|postgres|mysql)");
        }
        foreach (self::setup($dialect)['schema'] as $stmt) {
            \lm_bench_seed_apply($db, $stmt);
        }
        return $db;
    }

    /**
     * DELETE + INSERT the canonical nested fixture (runs on the PDO DIRECTLY — not through the seam, so
     * it is never counted by the safety middleware).
     */
    public static function seed(\PDO $db, string $dialect = 'sqlite'): void
    {
        foreach (array_merge(self::setup($dialect)['delete'], self::setup($dialect)['insert']) as $stmt) {
            \lm_bench_seed_apply($db, $stmt);
        }
    }

    /**
     * Bind the op-agnostic leaf transport into the generated module — the per-op callables. The
     * generated module `return`s the factory object; `bind` injects the handlers (boundary injection).
     *
     * @return array<string,callable>
     */
    public static function boundOps(\PDO|ExecutionContext $driver, string $dialect): array
    {
        // One generated module PER TARGET DB (#156): the SQL is baked per dialect, so the dialect the
        // handlers run under selects the module. No fallback.
        if (!in_array($dialect, ['sqlite', 'postgres', 'mysql'], true)) {
            throw new \RuntimeException("orm_bench: no generated module for dialect '{$dialect}'");
        }
        $mod = require __DIR__ . "/behaviors_{$dialect}.php";
        return ($mod->bind)(Leaves::makeHandlers(Context::of($driver), $dialect));
    }

    /**
     * The per-op input scope (the emitter-declared `value` input ports). Mutating ops vary their UNIQUE
     * column by iteration (matching the rust/python bench cell); a read with no input ports gets `[]`.
     *
     * @return array<string,mixed>
     */
    public static function opInput(string $dialect, string $op, int $it): array
    {
        require_once __DIR__ . '/../lm_bench_setup.php';
        $inp = \lm_bench_op_input(self::setup($dialect), $op, $it);
        // A batch row must be a RECORD, not a map: the vendored bc runtime types every PHP array as
        // `arr` and only a stdClass as `object` (ExprEval::typeName), so a row decoded from JSON as an
        // associative array cannot answer `.email` — which is what the PostgreSQL UNNEST transpose reads.
        if (isset($inp['rows']) && is_array($inp['rows'])) {
            $inp['rows'] = array_map(static fn (array $r) => (object) $r, $inp['rows']);
        }
        return $inp;
    }

    /**
     * Run ONE covered op through its generated callable. A RETURNING-chained tx op runs THROUGH the
     * runtime tx boundary ({@see withTransaction()} over the driver ctx) so BEGIN/COMMIT bracket the
     * leaf's body statements on the tx-owned connection; every other op runs the bound callable
     * directly.
     *
     * @param array<string,callable> $fns
     */
    public static function runOp(array $fns, \PDO|ExecutionContext $driver, string $op, int $it, string $dialect = 'sqlite'): mixed
    {
        $inp = self::opInput($dialect, $op, $it);
        if (in_array($op, self::TX_OPS, true)) {
            return withTransaction(Context::of($driver), static fn (ExecutionContext $_tx): mixed => $fns[$op]($inp));
        }
        return $fns[$op]($inp);
    }

    /**
     * Run ONE op once OFF the timed seam and report `['stmts' => int, 'rows' => int]`, observed at the
     * runtime middleware seam (every read / batch write / tx-control statement funnels through
     * execute/run/control → MiddlewareChain::wrap; the read seam hands the row list back, so the same
     * hook totals both). The seed runs on the PDO directly (off-seam), so it is never counted.
     *
     * The middleware is registered for the probe ONLY: an op's rows are the report's per-row denominator
     * (#170), and the published latencies must not pay for observing them.
     *
     * @param array<string,callable> $fns
     * @return array{stmts:int,rows:int}
     */
    public static function probe(\PDO $driver, array $fns, string $dialect, string $op): array
    {
        $tally = new \stdClass();
        $tally->stmts = 0;
        $tally->rows = 0;
        $mw = createMiddleware([
            'execute' => function (callable $next, string $sql, array $params) use ($tally): mixed {
                $tally->stmts++;
                $out = $next($sql, $params);
                if (is_array($out)) {
                    $tally->rows += count($out);
                }
                return $out;
            },
        ]);

        self::seed($driver, $dialect); // clean fixture; not counted (runs off-seam)
        clearMiddlewares();
        $unregister = registerMiddleware($mw);
        try {
            self::runOp($fns, $driver, $op, 0, $dialect);
        } finally {
            $unregister();
            clearMiddlewares();
        }
        return ['stmts' => $tally->stmts, 'rows' => $tally->rows];
    }

    /** The measurement loop: for each op, re-seed then time `$reps` runs; print `cell,dialect,op,iter,us,rows`. */
    public static function measure(string $dialect, int $reps, int $warmup): void
    {
        $driver = self::openDriver($dialect);
        $fns = self::boundOps($driver, $dialect);
        echo "cell,dialect,op,iter,us,rows\n";
        foreach (self::OPS as $op) {
            // One UN-TIMED probe measures the rows this op moves (it re-seeds too) — the per-row
            // denominator (#170); the counting middleware is gone before the timed loop starts.
            $rows = self::probe($driver, $fns, $dialect, $op)['rows'];
            for ($it = 0; $it < $warmup; $it++) {
                self::runOp($fns, $driver, $op, $it + 1, $dialect);
            }
            for ($it = 0; $it < $reps; $it++) {
                // Unique iteration id: the probe took 0, so warmup/timed start at 1 (a UNIQUE-email op
                // must never see an id twice).
                $g = $it + $warmup + 1;
                $t = hrtime(true);
                self::runOp($fns, $driver, $op, $g, $dialect);
                $us = intdiv(hrtime(true) - $t, 1000);
                echo "native,{$dialect},{$op},{$it},{$us},{$rows}\n";
            }
        }
    }

    /**
     * The safety mode: for EVERY op print the statements it issues and the rows it moves, asserting the
     * guarded statement counts. Covering all 19 (not just the guarded subset) is what lets the rows column
     * be compared against the other languages' cells — the fairness check #170 had no surface for.
     */
    public static function safety(string $dialect): void
    {
        $driver = self::openDriver($dialect);
        $fns = self::boundOps($driver, $dialect);
        $expected = self::RELATION_QUERY_COUNTS + self::BATCH_QUERY_COUNTS + self::TX_STMT_COUNTS;
        echo str_pad('op', 22) . str_pad('statements', 12) . "rows\n";
        foreach (self::OPS as $op) {
            $got = self::probe($driver, $fns, $dialect, $op);
            $want = $expected[$op] ?? null;
            if ($want !== null && $got['stmts'] !== $want) {
                throw new \RuntimeException("{$op} statement-count regression: got {$got['stmts']}, expect {$want}");
            }
            // The machine-readable half, in the ONE format every cell prints, so `run-cells.sh` can hold
            // the ten cells to the same statements and rows per op instead of eyeballing ten tables.
            echo "proof,native,{$dialect},{$op},{$got['stmts']},{$got['rows']}\n";
            echo str_pad($op, 22) . str_pad((string) $got['stmts'], 12) . $got['rows'] . "\n";
        }
    }
}
