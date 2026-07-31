<?php

declare(strict_types=1);

/**
 * Load the ONE cross-lang ORM-bench seed SSoT — benchmark/crosslang/.setup/<dialect>.json, emitted from
 * orm-domain.ts by emit-setup.ts — for BOTH php bench cells (orm_bench + orm_bench_sdk). No php cell
 * hand-writes a schema or seed: each applies `schema` once at open and `delete`+`insert` (the canonical
 * 110-user fixture, literal SQL) per op. This is the single php-side reader of the JSON artifact.
 *
 * Besides the fixture the doc carries what every cell must agree on: `ops` (the statements the GENERATED
 * module issues, captured at the runtime seam), `inputs` (the values each op binds, from the axis SSoT
 * benchmark/crosslang/contract.ts), `recover` (the MySQL RETURNING recovery, derived from the captured
 * write by the library's own buildMysqlReselect) and `batchColumns` (each batch statement's own column
 * list).
 *
 * @return array<string,mixed>
 */
function lm_bench_load_setup(string $dialect): array
{
    $path = __DIR__ . '/../benchmark/crosslang/.setup/' . $dialect . '.json';
    $raw = @file_get_contents($path);
    if ($raw === false) {
        throw new \RuntimeException("read seed SSoT $path");
    }
    $doc = json_decode($raw, true);
    if (!is_array($doc)) {
        throw new \RuntimeException("parse seed SSoT $path");
    }
    return $doc;
}

/**
 * Substitute `{it}` — the ONE token the artifact carries — in every string of an input value.
 *
 * @param mixed $value
 * @return mixed
 */
function lm_bench_resolve_it($value, int $it)
{
    if (is_string($value)) {
        return str_replace('{it}', (string) $it, $value);
    }
    if (is_array($value)) {
        return array_map(static fn ($v) => lm_bench_resolve_it($v, $it), $value);
    }
    return $value;
}

/**
 * The values `$op` binds at iteration `$it`, keyed by the parameter names the authored `@behavior`
 * declares. Read here so neither php cell spells one out — two cells binding different values do
 * different work even on identical SQL, which is exactly what a rows/op check cannot see.
 *
 * @param array<string,mixed> $doc
 * @return array<string,mixed>
 */
function lm_bench_op_input(array $doc, string $op, int $it): array
{
    $declared = $doc['inputs'][$op] ?? null;
    if (!is_array($declared)) {
        throw new \RuntimeException(".setup/{$doc['dialect']}.json declares no inputs for op $op");
    }
    return lm_bench_resolve_it($declared, $it);
}

/**
 * Statement `$index`'s MySQL RETURNING recovery, or null where the database executes the declared
 * RETURNING itself (every PostgreSQL and SQLite statement, and most MySQL ones).
 *
 * @param array<string,mixed> $doc
 * @return array{writeSql:string,selectSql:string,binds:list<array{kind:string,index?:int}>}|null
 */
function lm_bench_recovery(array $doc, string $op, int $index): ?array
{
    $entries = $doc['recover'][$op] ?? [];
    return $entries[$index] ?? null;
}

/**
 * The columns `$op`'s batch statement reads, in its own order — a HARD failure when absent, since
 * binding a batch write without the statement's column order is exactly the guess this removes.
 *
 * @param array<string,mixed> $doc
 * @return list<string>
 */
function lm_bench_batch_columns(array $doc, string $op): array
{
    $cols = $doc['batchColumns'][$op] ?? null;
    if (!is_array($cols)) {
        throw new \RuntimeException(".setup/{$doc['dialect']}.json declares no batchColumns for op $op");
    }
    return $cols;
}

/**
 * Apply ONE seed statement (schema / delete / insert) directly on the PDO — the single seed-exec point
 * for BOTH php cells. Unlike `PDO::exec()`, this DRAINS any result set the statement produces: the
 * terminal `insert` entry is MySQL `ANALYZE TABLE …` (a post-load stats refresh so the optimizer picks
 * the seeded plans, not empty-table ones), which returns a status result set. With native prepares
 * `exec()` leaves that set undrained, so the connection stays busy and the NEXT `prepare()` throws
 * "2014 Cannot execute queries while other unbuffered queries are active" — which slipped past because
 * `exec()` returns cleanly and only the FOLLOWING statement fails. `query()` + `closeCursor()` frees the
 * result set (a no-op for the DDL/DML statements that return none), leaving the connection ready.
 */
function lm_bench_seed_apply(\PDO $pdo, string $sql): void
{
    $stmt = $pdo->query($sql);
    if ($stmt instanceof \PDOStatement) {
        $stmt->closeCursor();
    }
}
