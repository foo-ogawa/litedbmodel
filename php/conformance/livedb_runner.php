<?php

declare(strict_types=1);

/**
 * litedbmodel SCP LIVE-DB conformance — the PHP leg (#36 WS7g; leaf/emitter cutover #144).
 *
 * What runs here is the module bc GENERATED for this language from the SAME declaration the TS leg
 * runs (`conformance/harness.ts` → `emitBehaviorModule` → `bc generate --lang php`, one module per
 * live dialect, written by `conformance/gen-livedb.ts`). Nothing is replayed from a serialized
 * bundle: a leaf-executed module needs a LIVE in-process handle, which is exactly why the
 * recorder-era bundle-replay model is gone.
 *
 * The only hand-wiring is the two lines that make the generated module callable — bind the
 * op-agnostic leaf transport to a live PDO and call the endpoint by name:
 *
 *     $ops = ($mod->bind)(Leaves::makeHandlers($pdo, $dialect));
 *     $ops[$vector['entry']]((array) $vector['input']);
 *
 * Every vector is compared against what the TS leg observed on the SAME server for the SAME dialect
 * (`conformance/vectors-livedb/livedb.json`): the ORDERED statements the leaf handed the driver, the
 * FULL nested result (relation children and their field values included — a row count is not a
 * check, #150), and the resulting DB state for a write.
 *
 * REAL DBs, no mock, NO silent skip: if PG/MySQL is unreachable it ERRORS OUT (exit 3). Emits the
 * machine JSON summary as its LAST stdout line:
 *   {"lang":"php-livedb","suites":{"livedb-pg":{..},"livedb-mysql":{..}},"total_pass",...}
 * exit 0 all pass / 1 any fail / 2 corpus-version mismatch / 3 DB unreachable.
 */

$root = dirname(__DIR__, 2); // php/conformance -> php -> repo root
require $root . '/php/src/BehaviorContracts/Constants.php';
require $root . '/php/src/BehaviorContracts/ExprFailure.php';
require $root . '/php/src/BehaviorContracts/ExprEval.php';
require $root . '/php/src/BehaviorContracts/PlanFailure.php';
require $root . '/php/src/BehaviorContracts/Plan.php';
require $root . '/php/src/BehaviorContracts/BehaviorFailure.php';
require $root . '/php/src/BehaviorContracts/Behavior.php';
require $root . '/php/src/BehaviorContracts/SpecVersions.php';
require $root . '/php/src/BehaviorContracts/FingerprintFailure.php';
require $root . '/php/src/BehaviorContracts/Fingerprint.php';
require $root . '/php/src/BehaviorContracts/ProvenanceError.php';
require $root . '/php/src/BehaviorContracts/CompiledIr.php';
require $root . '/php/src/Dialect.php';
require $root . '/php/src/SqlFailure.php';
require $root . '/php/src/TxOptions.php';
require $root . '/php/src/ExecutionContext.php';
require $root . '/php/src/ConnectionRouting.php';
require $root . '/php/src/Middleware.php';
require $root . '/php/src/StaticBundle.php';
require $root . '/php/src/Grouping.php';
require $root . '/php/src/Leaves.php';
require $root . '/php/src/LiveDb.php';

use LiteDbModel\Runtime\Leaves;
use LiteDbModel\Runtime\LiveDb;

/** The corpus schema version this leg supports (harness CORPUS_VERSION — fail-closed). */
const SUPPORTED_CORPUS_VERSION = 5;

$corpusPath = getenv('LITEDBMODEL_LIVEDB_VECTORS');
if ($corpusPath === false || $corpusPath === '') {
    $corpusPath = $root . '/conformance/vectors-livedb/livedb.json';
}

// ── canonical comparison ──────────────────────────────────────────────────────
//
// Two NUMERIC REPRESENTATIONS of one declared type are folded, and nothing else — a differing VALUE
// still compares unequal:
//   - {"$bigint": "N"} is how the TS reference encodes an `int` cell for JSON.
//   - an INTEGRAL float is the integer it denotes: an int32 column's declared read type IS bc
//     `float` (src/scp/coltype.ts — "an int32 column materializes to a JS number → bc float"), and
//     each language renders that ONE declared type in its own numeric model. 10.5 still differs
//     from 10.

function canonical(mixed $v): mixed
{
    if ($v instanceof \stdClass) {
        $props = get_object_vars($v);
        if (count($props) === 1 && array_key_exists('$bigint', $props) && is_string($props['$bigint'])) {
            return (int) $props['$bigint'];
        }
        $out = [];
        foreach ($props as $k => $val) {
            $out[$k] = canonical($val);
        }
        ksort($out);
        return ['__obj__' => $out];
    }
    if (is_array($v)) {
        $isList = array_is_list($v);
        $out = [];
        foreach ($v as $k => $val) {
            $out[$k] = canonical($val);
        }
        if ($isList) {
            return $out;
        }
        ksort($out);
        return ['__obj__' => $out];
    }
    if (is_float($v) && is_finite($v) && floor($v) === $v) {
        return (int) $v;
    }
    return $v;
}

function canonJson(mixed $v): string
{
    return (string) json_encode(canonical($v), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function valuesEqual(mixed $a, mixed $b): bool
{
    return canonJson($a) === canonJson($b);
}

// ── the statement TAP: what the leaf transport actually handed the driver ─────
//
// A SQL-level middleware on the runtime's OWN seam — the sanctioned interception point, and the SAME
// layer the TS harness taps (`tapSync`/`tapAsyncPool` wrap the connection). What it records is the
// exact driver-bound form: the dynamic (SKIP) WHERE already assembled, `?`→`$N` already rendered,
// array params already encoded. Tapping the `\PDOStatement` instead would log the PG live PDO's
// POST-rewrite text (it turns `$N` back into `?` for PDO_pgsql), which is a driver detail below the
// contract, and would displace the RETURNING-emulating statement class MySQL needs.

/** @var list<array{sql: string, params: list<mixed>}> */
$GLOBALS['STATEMENT_LOG'] = [];

LiteDbModel\Runtime\registerMiddleware(LiteDbModel\Runtime\createMiddleware([
    'execute' => function (callable $next, string $sql, array $params): mixed {
        $GLOBALS['STATEMENT_LOG'][] = ['sql' => $sql, 'params' => array_values($params)];
        return $next($sql, $params);
    },
]));

/**
 * The expected statements AS THIS DRIVER MUST BIND THEM.
 *
 * The SQL text is byte-compared verbatim. Only one param form is driver-specific: PDO binds SCALARS
 * only, so a PostgreSQL array param rides as the `{…}` array-literal TEXT, where node-postgres (the
 * reference) binds a real array. This is not a looser comparison — the expected array is pushed
 * through the runtime's OWN encoder ({@see StaticBundle::pgArrayLiteral}, the same SSoT the leaf
 * binds with), so the assertion is "the leaf bound EXACTLY pgArrayLiteral(expected)". A different
 * array still fails.
 *
 * @param list<object> $statements
 * @return list<array{sql: string, params: list<mixed>}>
 */
function expectedStatementsFor(string $dialect, array $statements): array
{
    return array_map(static function (object $s) use ($dialect): array {
        $params = array_map(static function ($p) use ($dialect) {
            if (!is_array($p)) {
                return $p;
            }
            return $dialect === 'postgres'
                ? \LiteDbModel\Runtime\StaticBundle::pgArrayLiteral(canonical($p))
                : $p;
        }, $s->params);
        return ['sql' => $s->sql, 'params' => $params];
    }, $statements);
}

// ── the generated modules ─────────────────────────────────────────────────────

/** Load `php/conformance/behaviors_<dialect>.php` — `bc generate --lang php` for this dialect. */
function loadGenerated(string $root, string $dialect): object
{
    $path = $root . "/php/conformance/behaviors_{$dialect}.php";
    if (!is_file($path)) {
        fwrite(STDERR, "FATAL: {$path} is missing — run `npm run conformance:gen:livedb`\n");
        exit(2);
    }
    return require $path;
}

// ── one leg ───────────────────────────────────────────────────────────────────

/**
 * @param array<string, callable> $ops
 * @param array<string, mixed> $vector
 * @return array{0: bool, 1: string}
 */
function runVector(array $ops, \PDO $pdo, array $vector): array
{
    $GLOBALS['STATEMENT_LOG'] = [];
    $result = $ops[$vector['entry']]((array) $vector['input']);
    $problems = [];
    $expectedStatements = expectedStatementsFor((string) $vector['dialect'], $vector['expectedStatements']);
    if (!valuesEqual($GLOBALS['STATEMENT_LOG'], $expectedStatements)) {
        $problems[] = 'statements ' . canonJson($GLOBALS['STATEMENT_LOG']) . ' != ' . canonJson($expectedStatements);
    }
    if (!valuesEqual($result, $vector['expectedResult'])) {
        $problems[] = 'result ' . canonJson($result) . ' != ' . canonJson($vector['expectedResult']);
    }
    foreach ($vector['expectedDbState'] ?? [] as $state) {
        $stmt = $pdo->query($state->query);
        $got = $stmt === false ? [] : $stmt->fetchAll(\PDO::FETCH_OBJ);
        if (!valuesEqual($got, $state->rows)) {
            $problems[] = "db-state '{$state->query}': " . canonJson($got) . ' != ' . canonJson($state->rows);
        }
    }
    return [count($problems) === 0, implode('; ', $problems)];
}

/**
 * @param list<object> $vectors
 * @param list<string> $schema
 * @return array{pass: int, fail: int}
 */
function runLeg(string $root, string $dialect, \PDO $pdo, array $vectors, array $schema): array
{
    $tally = ['pass' => 0, 'fail' => 0];
    fwrite(STDERR, "\nlivedb-{$dialect} — " . count($vectors) . " vectors (real {$dialect})\n");
    $mod = loadGenerated($root, $dialect);
    $ops = ($mod->bind)(Leaves::makeHandlers($pdo, $dialect));
    foreach ($vectors as $v) {
        try {
            // Every vector starts from the SAME seeded state the TS leg captured from.
            foreach ($schema as $stmt) {
                $pdo->exec($stmt);
            }
            [$ok, $detail] = runVector($ops, $pdo, (array) $v);
        } catch (\Throwable $e) { // a live-DB failure is a vector FAILURE, never a fake pass
            $ok = false;
            $detail = 'threw: ' . $e->getMessage();
        }
        if ($ok) {
            $tally['pass']++;
            fwrite(STDERR, "  ok  {$v->name}\n");
        } else {
            $tally['fail']++;
            fwrite(STDERR, "  XX  {$v->name}\n      {$detail}\n");
        }
    }
    return $tally;
}

// ── main ──────────────────────────────────────────────────────────────────────

fwrite(STDERR, "litedbmodel SCP LIVE-DB conformance — PHP runner (bc-generated modules, real PG + MySQL)\n");
$corpus = json_decode((string) file_get_contents($corpusPath));
if (($corpus->corpusVersion ?? null) !== SUPPORTED_CORPUS_VERSION) {
    fwrite(STDERR, 'FAIL-CLOSED: corpusVersion ' . json_encode($corpus->corpusVersion ?? null) . ' != ' . SUPPORTED_CORPUS_VERSION . "\n");
    echo json_encode(['lang' => 'php-livedb', 'suites' => (object) [], 'total_pass' => 0, 'total_fail' => 0, 'version_mismatch' => true]), "\n";
    exit(2);
}
$schema = array_map('strval', $corpus->schema);

$pdos = [];
try {
    $pdos['postgres'] = LiveDb::postgres(
        getenv('TEST_DB_HOST') ?: 'localhost',
        (int) (getenv('TEST_DB_PORT') ?: '5433'),
        getenv('TEST_DB_USER') ?: 'testuser',
        getenv('TEST_DB_PASSWORD') ?: 'testpass',
        getenv('TEST_DB_NAME') ?: 'testdb',
    );
} catch (\Throwable $e) {
    fwrite(STDERR, 'FATAL: Postgres unreachable — ' . $e->getMessage() . "\n");
    exit(3);
}
try {
    $pdos['mysql'] = LiveDb::mysql(
        getenv('TEST_MYSQL_HOST') ?: '127.0.0.1',
        (int) (getenv('TEST_MYSQL_PORT') ?: '3307'),
        getenv('TEST_MYSQL_USER') ?: 'testuser',
        getenv('TEST_MYSQL_PASSWORD') ?: 'testpass',
        getenv('TEST_MYSQL_DB') ?: 'testdb',
    );
} catch (\Throwable $e) {
    fwrite(STDERR, 'FATAL: MySQL unreachable — ' . $e->getMessage() . "\n");
    exit(3);
}

$suites = [];
foreach (['postgres' => 'livedb-pg', 'mysql' => 'livedb-mysql'] as $dialect => $suite) {
    $pdo = $pdos[$dialect];
    $vectors = array_values(array_filter($corpus->vectors, static fn ($v) => $v->dialect === $dialect));
    $suites[$suite] = runLeg($root, $dialect, $pdo, $vectors, $schema);
}

$totalPass = array_sum(array_column($suites, 'pass'));
$totalFail = array_sum(array_column($suites, 'fail'));
fwrite(STDERR, "\n{$totalPass} passed, {$totalFail} failed / " . ($totalPass + $totalFail) . " live-DB vectors\n");
echo json_encode([
    'lang' => 'php-livedb',
    'suites' => $suites,
    'total_pass' => $totalPass,
    'total_fail' => $totalFail,
    'version_mismatch' => false,
]), "\n";
exit($totalFail > 0 ? 1 : 0);
