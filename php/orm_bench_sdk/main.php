<?php

declare(strict_types=1);

/**
 * Raw-driver SDK-baseline ORM-bench cell (php leg) — the apples-to-apples twin of the native-codegen
 * cell {@see \LiteDbModel\Bench\OrmBench}.
 *
 * Runs the SAME 19 ORM ops over the SAME canonical fixture and the SAME in-memory sqlite storage the
 * native cell uses (`new PDO('sqlite::memory:')`), but every op is HAND-WRITTEN SQL issued straight at
 * PDO. The vendored `litedbmodel_runtime` and the bc-generated `behaviors_generated.php` are NOT loaded
 * and NOT in the path — this file is a self-contained raw-PDO cell (no composer autoload).
 *
 * Fairness (a strawman SDK invalidates the comparison):
 *   - SAME storage: in-memory sqlite (no file → no fsync/WAL the native in-memory cell never pays).
 *   - Prepared-statement REUSE: each op's SQL is prepared once and the PDOStatement cached by SQL text
 *     ($stmts), re-executed with fresh params across iterations — matching the native runtime's
 *     prepared-statement cache, not a re-parse-per-call strawman.
 *   - N+1-FREE relations: parent read → pluck keys → ONE batched child read (WHERE fk IN (…)) → group
 *     in memory, the SAME query counts the native cell proves (nestedFindAll=2, nestedRelations=3,
 *     compositeRelations=3, batch write=1, RETURNING-chained tx = BEGIN + body + COMMIT).
 *   - SAME seed + inputs as the native twin: the small canonical nested fixture (mirrored from OrmBench
 *     — the fixture each isolated cell carries), re-seeded before each op, and the SAME per-op inputs
 *     (findUnique=user1, update id=1, …).
 *
 * Usage:
 *   php orm_bench_sdk/main.php <dialect> [reps] [warmup]   # print the CSV (cell,dialect,op,iter,us,rows)
 *   php orm_bench_sdk/main.php safety <dialect>            # assert + print the safety counts
 */

// ── the canonical fixture from the ONE seed SSoT (benchmark/crosslang/.setup/sqlite.json, emitted from
//    orm-domain.ts) — the SAME fixture the native twin loads. Shared TEST DATA, not covered code. ─────
require_once __DIR__ . '/../lm_bench_setup.php';
/**
 * The cached setup doc: `schema` (drop+create, applied once) + `delete`+`insert` (the canonical
 * 110-user fixture, per op). Cached so the JSON is read once.
 *
 * @return array{schema:list<string>,delete:list<string>,insert:list<string>}
 */
function benchSetup(string $dialect = 'sqlite'): array
{
    static $docs = [];
    return $docs[$dialect] ??= lm_bench_load_setup($dialect);
}

const OPS = [
    'findAll', 'filterPaginateSort', 'findFirst', 'findUnique',
    'nestedFindAll', 'nestedFindFirst', 'nestedFindUnique', 'nestedRelations', 'compositeRelations',
    'create', 'update', 'upsert', 'createMany', 'upsertMany', 'updateMany',
    'nestedCreate', 'nestedUpsert', 'nestedUpdate', 'delete',
];

const RELATION_QUERY_COUNTS = [
    'nestedFindAll' => 2, 'nestedFindFirst' => 2, 'nestedFindUnique' => 2,
    'nestedRelations' => 3, 'compositeRelations' => 3,
];
const BATCH_QUERY_COUNTS = ['createMany' => 1, 'upsertMany' => 1, 'updateMany' => 1];
// tx: BEGIN + body + COMMIT — the same count the native cell proves, since the baseline issues the same
// statements (a MySQL RETURNING write plus its recovery is ONE logical statement in both surfaces).
const TX_STMT_COUNTS = ['nestedCreate' => 4, 'nestedUpsert' => 4, 'nestedUpdate' => 4, 'delete' => 4];

/**
 * The ONE exec seam. All DB access rides these methods, so the prepared-statement cache and the
 * statement counter (safety proof) each live in one place.
 */
final class Db
{
    /** @var array<string,\PDOStatement> per-SQL prepared-statement cache (reused across iterations) */
    private array $stmts = [];
    public int $count = 0;
    /**
     * Rows this hand-written baseline scanned (#170) — the report's per-row denominator, and the proof the
     * baseline moved the SAME rows the native cell did (a baseline that fetched fewer would post a
     * flattering ratio).
     */
    public int $rows = 0;

    public function __construct(public \PDO $pdo, public string $dialect = 'sqlite')
    {
    }

    private function prep(string $sql): \PDOStatement
    {
        return $this->stmts[$sql] ??= $this->pdo->prepare($sql);
    }

    /**
     * Bind by VALUE TYPE, not as text. PDO's default is a string bind, which PostgreSQL refuses to
     * compare against an integer column (`operator does not exist: integer = text`); sqlite and MySQL
     * coerce, so the sqlite pilot never saw it. One place, so every op binds the same way.
     *
     * @param list<mixed> $params
     */
    private function bindAll(\PDOStatement $stmt, array $params): void
    {
        foreach ($params as $i => $v) {
            $type = is_int($v) ? \PDO::PARAM_INT : (is_bool($v) ? \PDO::PARAM_BOOL : (is_null($v) ? \PDO::PARAM_NULL : \PDO::PARAM_STR));
            $stmt->bindValue($i + 1, $v, $type);
        }
    }

    /** @param list<mixed> $params @return list<array<int,mixed>> */
    public function query(string $sql, array $params = []): array
    {
        $this->count++;
        $stmt = $this->prep($sql);
        $this->bindAll($stmt, $params);
        $stmt->execute();
        $out = $stmt->fetchAll(\PDO::FETCH_NUM);
        $this->rows += count($out);
        return $out;
    }

    /** @param list<mixed> $params */
    public function exec(string $sql, array $params = []): void
    {
        $this->count++;
        $stmt = $this->prep($sql);
        $this->bindAll($stmt, $params);
        $stmt->execute();
    }

    /** param-free control statement (BEGIN / COMMIT). */
    public function execRaw(string $sql): void
    {
        $this->count++;
        $this->pdo->exec($sql);
    }

    /**
     * A write that hands back the id of the row it wrote — the ` RETURNING id` the authored native module
     * declares for every id-chaining write (benchmark/crosslang/native-model.ts). The baseline issues the
     * SAME statement and reads the SAME row back, so the two surfaces do equal work.
     *
     * MySQL has no RETURNING: the runtime's mysql adapter strips the clause and recovers the written rows
     * with a keyed SELECT on the same connection (src/scp/makesql/mysql-returning.ts). $recoverSql is that
     * same recovery, and it belongs to the SAME logical statement — the runtime's seam counts a MySQL
     * RETURNING write as one (its recovery runs below the seam) while counting the row it recovers — so the
     * rows are tallied and the statement count is not bumped a second time.
     *
     * @param list<mixed> $params
     * @param list<mixed> $recoverParams
     */
    public function writeReturningId(string $sql, array $params, string $recoverSql, array $recoverParams = []): int
    {
        if ($this->dialect !== 'mysql') {
            return (int) $this->query($sql, $params)[0][0];
        }
        // MySQL cannot parse RETURNING: strip the clause (and the /*scp:pk=…*/ hint naming the key) exactly
        // as the runtime's mysql adapter does, then recover the written row with the keyed SELECT.
        $this->exec((string) preg_replace('/\s+RETURNING\s+.*$/is', '', $sql), $params);
        return (int) $this->recoverRows($recoverSql, $recoverParams)[0][0];
    }

    /**
     * Fetch belonging to the logical statement just issued: rows tallied, statement count not bumped.
     *
     * @param list<mixed> $params
     * @return list<array<int,mixed>>
     */
    private function recoverRows(string $sql, array $params): array
    {
        $stmt = $this->prep($sql);
        $this->bindAll($stmt, $params);
        $stmt->execute();
        $out = $stmt->fetchAll(\PDO::FETCH_NUM);
        $this->rows += count($out);
        return $out;
    }
}

function openDb(string $dialect = 'sqlite'): Db
{
    // The raw PDO for ONE target — the SAME database the native cell of that dialect uses (#145
    // invariant 1), seeded from the SAME `.setup/<dialect>.json` (invariant 2). Raw driver only: no
    // litedbmodel runtime, no generated module (invariant 6). Unknown/unreachable = LOUD failure.
    if ($dialect === 'sqlite') {
        $pdo = new \PDO('sqlite::memory:');
    } elseif ($dialect === 'postgres') {
        $host = getenv('TEST_DB_HOST') ?: 'localhost';
        $port = (int) (getenv('TEST_DB_PORT') ?: 5433);
        $name = getenv('TEST_DB_NAME') ?: 'testdb';
        $pdo = new \PDO("pgsql:host={$host};port={$port};dbname={$name}", getenv('TEST_DB_USER') ?: 'testuser', getenv('TEST_DB_PASSWORD') ?: 'testpass');
    } elseif ($dialect === 'mysql') {
        $host = getenv('TEST_MYSQL_HOST') ?: '127.0.0.1';
        $port = (int) (getenv('TEST_MYSQL_PORT') ?: 3307);
        $name = getenv('TEST_MYSQL_DB') ?: 'testdb';
        $pdo = new \PDO("mysql:host={$host};port={$port};dbname={$name}", getenv('TEST_MYSQL_USER') ?: 'testuser', getenv('TEST_MYSQL_PASSWORD') ?: 'testpass', [\PDO::ATTR_EMULATE_PREPARES => false]);
    } else {
        throw new \RuntimeException("orm_bench_sdk: unknown target '{$dialect}' (sqlite|postgres|mysql)");
    }
    $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(\PDO::ATTR_STRINGIFY_FETCHES, false);
    foreach (benchSetup($dialect)['schema'] as $stmt) {
        $pdo->exec($stmt);
    }
    return new Db($pdo, $dialect);
}

function seed(Db $db): void
{
    foreach (array_merge(benchSetup($db->dialect)['delete'], benchSetup($db->dialect)['insert']) as $stmt) {
        $db->pdo->exec($stmt); // runs on the PDO directly (off-seam) → never counted
    }
}

/** @return array{0:list<string>,1:list<string>} */
function batchRows(int $it, bool $stable): array
{
    $emails = [];
    $names = [];
    for ($i = 0; $i < 10; $i++) {
        $emails[] = $stable ? "many{$i}@bench.com" : "many{$it}_{$i}@bench.com";
        $names[] = "Many {$i}";
    }
    return [$emails, $names];
}

/**
 * One relation level's key set as the ONE param the captured SQL expects. The generated module binds a
 * batched child read's key set as a single JSON array (json_each(?) / JSON_TABLE(?) / UNNEST(?::t[])),
 * never as N placeholders — so the baseline binds it the same way, or it is running different SQL. A
 * composite key is an array of tuples, a single key an array of scalars.
 *
 * @param list<list<int>> $tuples
 */
function keyParam(array $tuples, string $sql): string
{
    $keys = array_map(static fn (array $t) => count($t) === 1 ? $t[0] : $t, $tuples);
    // The statement says which encoding it wants: an ARRAY cast (`$1::int[]`, PostgreSQL's single-key
    // predicate) takes a PostgreSQL array literal; a `::json` cast and MySQL/SQLite's json_each /
    // JSON_TABLE take JSON. Reading it off the SQL keeps the encoding tied to the statement.
    return pgArrayCast($sql) ? pgArrayLiteral($keys) : json_encode($keys, JSON_THROW_ON_ERROR);
}

/** True when the statement casts its param to a PostgreSQL array (`::int[]` / `::text[]`). */
function pgArrayCast(string $sql): bool
{
    return preg_match('/::\w+\[\]/', $sql) === 1;
}

/**
 * A PostgreSQL array literal (`{1,2,3}`), bound as TEXT and cast by the statement's own `::int[]` /
 * `::text[]` — so it needs no driver-specific array support.
 *
 * @param list<mixed> $values
 */
function pgArrayLiteral(array $values): string
{
    $one = static fn ($v) => is_int($v) || is_float($v)
        ? (string) $v
        : '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], (string) $v) . '"';
    return '{' . implode(',', array_map($one, $values)) . '}';
}

/**
 * A batch write's record set as the param(s) the captured statement expects: ONE JSON array on
 * MySQL/SQLite, one array PER COLUMN on PostgreSQL (its UNNEST form takes column arrays). The payload
 * repeats once per `?` — updateMany's SET subquery and its WHERE each read it.
 *
 * @param list<array<string,mixed>> $records
 * @return list<string>
 */
function batchParams(Db $db, array $records, string $sql): array
{
    if ($db->dialect === 'postgres') {
        $cols = array_keys($records[0]);
        sort($cols);
        $one = array_map(static fn (string $c) => pgArrayLiteral(array_column($records, $c)), $cols);
    } else {
        $one = [json_encode($records, JSON_THROW_ON_ERROR)];
    }
    $reps = max(1, (int) round(substr_count($sql, '?') / count($one)));
    $out = [];
    for ($i = 0; $i < $reps; $i++) {
        $out = array_merge($out, $one);
    }
    return $out;
}

/**
 * The keyed SELECTs the runtime's MySQL adapter recovers a RETURNING write's rows with
 * (src/scp/makesql/mysql-returning.ts): the conflict key for an upsert, the AUTO_INCREMENT range for an
 * insert, the write's own WHERE for an update. Only MySQL runs them — the others have RETURNING.
 */
const RECOVER_BY_EMAIL = 'SELECT id FROM benchmark_users WHERE email = ?';
const RECOVER_BY_LAST_INSERT_ID = 'SELECT id FROM benchmark_users WHERE id = LAST_INSERT_ID()';
const RECOVER_BY_ID = 'SELECT id FROM benchmark_users WHERE id = ?';

/** @return list<array<string,mixed>> */
function userRecords(int $it, bool $stable): array
{
    [$emails, $names] = batchRows($it, $stable);
    $out = [];
    for ($k = 0; $k < 10; $k++) {
        $out[] = ['email' => $emails[$k], 'name' => $names[$k]];
    }
    return $out;
}

/** @return list<array<string,mixed>> */
function patchRecords(): array
{
    [, $names] = batchRows(0, false);
    $out = [];
    for ($k = 0; $k < 10; $k++) {
        $out[] = ['id' => $k + 1, 'name' => $names[$k]];
    }
    return $out;
}

// ── nested materialization (fair vs the native cell) ─────────────────────────────────────────────────
// The native ORM assembles a nested TYPED object graph: each parent record with its child list nested
// under the relation key (the runtime group_children builds it; the generated de-box holds it). The SDK
// mirrors that — decode every selected column into a plain typed object and ATTACH the grouped children
// into their parent BY MOVE (assign the grouped array into $parent->children; PHP objects are by-handle,
// so no child is cloned). The fully-assembled list-of-parents is held in $GLOBALS['benchSink'] so the
// interpreter keeps it. Payload fields (email/name/title/body) are decoded-then-held (the same decode the
// native pays) but never read downstream — only the key columns drive the grouping.
final class SdkUser
{
    /** @var list<SdkPost> */
    public array $posts = [];

    public function __construct(public int $id, public mixed $email, public mixed $name)
    {
    }
}
final class SdkPost
{
    /** @var list<SdkComment> */
    public array $comments = [];

    public function __construct(public int $id, public mixed $title, public int $authorId)
    {
    }
}
final class SdkComment
{
    public function __construct(public int $id, public mixed $body, public int $postId)
    {
    }
}
final class SdkTenantUser
{
    /** @var list<SdkTenantPost> */
    public array $posts = [];

    public function __construct(public int $tenantId, public int $userId, public mixed $name)
    {
    }
}
final class SdkTenantPost
{
    /** @var list<SdkTenantComment> */
    public array $comments = [];

    public function __construct(public int $tenantId, public int $postId, public int $userId, public mixed $title)
    {
    }
}
final class SdkTenantComment
{
    public function __construct(public int $tenantId, public int $commentId, public int $postId, public mixed $body)
    {
    }
}

/** @param list<array<int,mixed>> $userRows @return list<SdkUser> */
function materializeUsersPosts(Db $db, array $userRows, string $childSql): array
{
    $users = [];
    foreach ($userRows as $r) {
        $users[] = new SdkUser((int) $r[0], $r[1], $r[2]);
    }
    if ($users === []) {
        return $users;
    }
    $keys = keyParam(array_map(static fn (SdkUser $u): array => [$u->id], $users), $childSql);
    $byAuthor = [];
    foreach ($db->query($childSql, [$keys]) as $r) {
        $p = new SdkPost((int) $r[0], $r[1], (int) $r[2]);
        $byAuthor[$p->authorId][] = $p;
    }
    foreach ($users as $u) {
        $u->posts = $byAuthor[$u->id] ?? []; // MOVE the grouped array into the parent
    }
    return $users;
}

/** @param list<array<int,mixed>> $userRows @return list<SdkUser> */
function materializeUsersPostsComments(Db $db, array $userRows, string $postSql, string $commentSql): array
{
    $users = [];
    foreach ($userRows as $r) {
        $users[] = new SdkUser((int) $r[0], $r[1], $r[2]);
    }
    if ($users === []) {
        return $users;
    }
    $ukeys = keyParam(array_map(static fn (SdkUser $u): array => [$u->id], $users), $postSql);
    /** @var list<SdkPost> $posts */
    $posts = [];
    foreach ($db->query($postSql, [$ukeys]) as $r) {
        $posts[] = new SdkPost((int) $r[0], $r[1], (int) $r[2]);
    }
    if ($posts !== []) {
        $pkeys = keyParam(array_map(static fn (SdkPost $p): array => [$p->id], $posts), $commentSql);
        $byPost = [];
        foreach ($db->query($commentSql, [$pkeys]) as $r) {
            $c = new SdkComment((int) $r[0], $r[1], (int) $r[2]);
            $byPost[$c->postId][] = $c;
        }
        foreach ($posts as $p) {
            $p->comments = $byPost[$p->id] ?? [];
        }
    }
    $byAuthor = [];
    foreach ($posts as $p) {
        $byAuthor[$p->authorId][] = $p;
    }
    foreach ($users as $u) {
        $u->posts = $byAuthor[$u->id] ?? [];
    }
    return $users;
}

/** @return list<SdkTenantUser> */
function materializeComposite(Db $db, array $sqlList): array
{
    $tusers = [];
    foreach ($db->query($sqlList[0]) as $r) {
        $tusers[] = new SdkTenantUser((int) $r[0], (int) $r[1], $r[2]);
    }
    if ($tusers === []) {
        return $tusers;
    }
    $ukeys = keyParam(array_map(static fn (SdkTenantUser $u): array => [$u->tenantId, $u->userId], $tusers), $sqlList[1]);
    /** @var list<SdkTenantPost> $tposts */
    $tposts = [];
    foreach ($db->query($sqlList[1], [$ukeys]) as $r) {
        $tposts[] = new SdkTenantPost((int) $r[0], (int) $r[1], (int) $r[2], $r[3]);
    }
    if ($tposts !== []) {
        $pkeys = keyParam(array_map(static fn (SdkTenantPost $p): array => [$p->tenantId, $p->postId], $tposts), $sqlList[2]);
        $byPost = [];
        foreach ($db->query($sqlList[2], [$pkeys]) as $r) {
            $c = new SdkTenantComment((int) $r[0], (int) $r[1], (int) $r[2], $r[3]);
            $byPost[$c->tenantId . ':' . $c->postId][] = $c; // composite (tenant_id,post_id) key
        }
        foreach ($tposts as $p) {
            $p->comments = $byPost[$p->tenantId . ':' . $p->postId] ?? [];
        }
    }
    $byUser = [];
    foreach ($tposts as $p) {
        $byUser[$p->tenantId . ':' . $p->userId][] = $p; // composite (tenant_id,user_id) key
    }
    foreach ($tusers as $u) {
        $u->posts = $byUser[$u->tenantId . ':' . $u->userId] ?? [];
    }
    return $tusers;
}

/**
 * The 19 ops (native-cell order). Fixed inputs mirror the php native cell; mutating ops vary their
 * UNIQUE column by $it. Read LIMIT/ORDER shapes match the ops SSoT (== the native generated SQL).
 */
/**
 * Run ONE op, issuing the statements the GENERATED module issues for this dialect ($sqlList =
 * $setup['ops'][$op], captured at the runtime seam). The baseline hand-writes no SQL: the report divides
 * native by sdk, which only isolates the runtime's cost if both send the DB the same statements. What
 * stays hand-written is what a raw-driver user writes: param binding, decode, grouping children into
 * parents, and the transaction bracket.
 *
 * @param list<string> $sqlList
 */
function runOp(Db $db, string $op, int $it, array $sqlList): void
{
    switch ($op) {
        case 'findAll':
            $db->query($sqlList[0]);
            break;
        case 'filterPaginateSort':
            $db->query($sqlList[0], [1]);
            break;
        case 'findFirst':
            $db->query($sqlList[0], ['User%']);
            break;
        case 'findUnique':
            $db->query($sqlList[0], ['user1@example.com']);
            break;
        case 'nestedFindAll':
            $GLOBALS['benchSink'] = materializeUsersPosts($db, $db->query($sqlList[0]), $sqlList[1]);
            break;
        case 'nestedFindFirst':
            $GLOBALS['benchSink'] = materializeUsersPosts($db, $db->query($sqlList[0], ['User%']), $sqlList[1]);
            break;
        case 'nestedFindUnique':
            $GLOBALS['benchSink'] = materializeUsersPosts($db, $db->query($sqlList[0], ['user1@example.com']), $sqlList[1]);
            break;
        case 'nestedRelations':
            $GLOBALS['benchSink'] = materializeUsersPostsComments($db, $db->query($sqlList[0]), $sqlList[1], $sqlList[2]);
            break;
        case 'compositeRelations':
            $GLOBALS['benchSink'] = materializeComposite($db, $sqlList);
            break;
        case 'create':
            $db->exec($sqlList[0], ["new{$it}@bench.com", 'New']);
            break;
        case 'update':
            $db->exec($sqlList[0], ['Updated 1', 1]);
            break;
        case 'upsert':
            // The captured statement declares ` RETURNING id`, so the baseline reads the id back too.
            $sink = $db->writeReturningId($sqlList[0], ['user1@example.com', 'Upserted One'], RECOVER_BY_EMAIL, ['user1@example.com']);
            unset($sink);
            break;
        case 'createMany':
            $db->exec($sqlList[0], batchParams($db, userRecords($it, false), $sqlList[0]));
            break;
        case 'upsertMany':
            // The SAME 10 records the native module upserts.
            $db->exec($sqlList[0], batchParams($db, userRecords($it, true), $sqlList[0]));
            break;
        case 'updateMany':
            $db->exec($sqlList[0], batchParams($db, patchRecords(), $sqlList[0]));
            break;
        case 'nestedCreate':
            $db->execRaw('BEGIN');
            $uid = $db->writeReturningId($sqlList[0], ["nc{$it}@bench.com", 'NC'], RECOVER_BY_LAST_INSERT_ID);
            $db->exec($sqlList[1], [$uid, 'NC Post']);
            $db->execRaw('COMMIT');
            break;
        case 'nestedUpsert':
            $db->execRaw('BEGIN');
            $uid = $db->writeReturningId($sqlList[0], ['user1@example.com', 'NUp'], RECOVER_BY_EMAIL, ['user1@example.com']);
            $db->exec($sqlList[1], [$uid, 'NUp Post']);
            $db->execRaw('COMMIT');
            break;
        case 'nestedUpdate':
            $db->execRaw('BEGIN');
            // The generated runner chains the dependent UPDATE off the id the first UPDATE returned; taking
            // the id from the input instead would skip a statement's worth of work.
            $uid = $db->writeReturningId($sqlList[0], ['NU', 1], RECOVER_BY_ID, [1]);
            $db->exec($sqlList[1], ['NU Post', $uid]);
            $db->execRaw('COMMIT');
            break;
        case 'delete':
            $db->execRaw('BEGIN');
            $uid = $db->writeReturningId($sqlList[0], ["del{$it}@bench.com", 'Del'], RECOVER_BY_LAST_INSERT_ID);
            $db->exec($sqlList[1], [$uid]);
            $db->execRaw('COMMIT');
            break;
        default:
            throw new \RuntimeException("unknown op {$op}");
    }
}

function measure(string $dialect, int $reps, int $warmup): void
{
    $db = openDb($dialect);
    $ops = benchSetup($dialect)['ops'];
    echo "cell,dialect,op,iter,us,rows\n";
    foreach (OPS as $op) {
        seed($db); // re-seed before each op (matches the native cell)
        // One UN-TIMED probe measures the rows this op moves — the per-row denominator (#170).
        $db->rows = 0;
        runOp($db, $op, 0, $ops[$op]);
        $rows = $db->rows;
        for ($it = 0; $it < $warmup; $it++) {
            runOp($db, $op, $it + 1, $ops[$op]);
        }
        for ($it = 0; $it < $reps; $it++) {
            // Unique iteration id: the probe took 0, so warmup/timed start at 1.
            $g = $it + $warmup + 1;
            $t = hrtime(true);
            runOp($db, $op, $g, $ops[$op]);
            $us = intdiv(hrtime(true) - $t, 1000);
            echo "sdk,{$dialect},{$op},{$it},{$us},{$rows}\n";
        }
    }
}

function safety(string $dialect): void
{
    $db = openDb($dialect);
    $ops = benchSetup($dialect)['ops'];
    $expected = RELATION_QUERY_COUNTS + BATCH_QUERY_COUNTS + TX_STMT_COUNTS;
    // EVERY op, with the rows it moves — the surface that lets this baseline's row yield be compared
    // against the native cell's (#170), not just the guarded statement counts.
    echo str_pad('op', 22) . str_pad('statements', 12) . "rows\n";
    foreach (OPS as $op) {
        seed($db);
        $db->count = 0;
        $db->rows = 0;
        runOp($db, $op, 0, $ops[$op]);
        $got = $db->count;
        $want = $expected[$op] ?? null;
        if ($want !== null && $got !== $want) {
            throw new \RuntimeException("{$op} statement-count regression: got {$got}, expect {$want}");
        }
        echo str_pad($op, 22) . str_pad((string) $got, 12) . $db->rows . "\n";
    }
}

// ── argv dispatch ────────────────────────────────────────────────────────────────────────────────
$args = $_SERVER['argv'];
array_shift($args); // drop the script name
if (($args[0] ?? null) === 'safety') {
    safety($args[1] ?? 'sqlite');
    return;
}
$dialect = $args[0] ?? 'sqlite';
$reps = isset($args[1]) ? (int) $args[1] : 300;
$warmup = isset($args[2]) ? (int) $args[2] : 30;
measure($dialect, $reps, $warmup);
