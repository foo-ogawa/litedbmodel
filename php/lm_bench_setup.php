<?php

declare(strict_types=1);

/**
 * Load the ONE cross-lang ORM-bench seed SSoT — benchmark/crosslang/.setup/<dialect>.json, emitted from
 * orm-domain.ts by emit-setup.ts — for BOTH php bench cells (orm_bench + orm_bench_sdk). No php cell
 * hand-writes a schema or seed: each applies `schema` once at open and `delete`+`insert` (the canonical
 * 110-user fixture, literal SQL) per op. This is the single php-side reader of the JSON artifact.
 *
 * @return array{dialect:string,users:int,schema:list<string>,delete:list<string>,insert:list<string>}
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
