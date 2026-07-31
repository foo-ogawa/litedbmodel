<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime\Tests;

/**
 * Running a relation THE ONLY WAY PRODUCTION REACHES ONE. The codegen path calls exactly three leaves
 * (`src/scp/leaf-transport.ts:184,187,190`), so a relation is:
 *
 *   executeSQL (parent read) → pluck (dedupe the parent keys) → executeSQL (BATCHED child fetch, the
 *   statement a cross-DB relation names its own database on) → group (nest children onto parents)
 *
 * There is no fourth entry point for a generated module to call, so driving a relation through anything
 * else tests a path production does not take. Shared as a trait because two test classes need the SAME
 * sequence and PHPUnit gives them no other common home.
 */
trait RelationThroughLeavesTrait
{
    /** @param array<string,mixed> $outcome */
    private static function leafOk(array $outcome, string $what): mixed
    {
        if (!array_key_exists('ok', $outcome)) {
            throw new \RuntimeException("{$what} did not return an ok outcome: " . json_encode($outcome));
        }
        return $outcome['ok'];
    }

    /**
     * Run one relation through the three leaves, returning the grouped parents. `$childDb` is the child
     * fetch's `db` control field — null is the DEFAULT connection, exactly how a same-DB relation lowers.
     *
     * @param array<string,callable> $handlers
     * @return list<\stdClass>
     */
    private static function relationThroughLeaves(
        array $handlers,
        string $parentSql,
        string $childSql,
        string $pk,
        string $fk,
        string $into,
        ?string $childDb = null,
    ): array {
        $at = ['nodeId' => 'n0', 'component' => 'executeSQL'];
        $parents = self::leafOk($handlers['executeSQL'](['sql' => $parentSql, 'params' => []], $at), 'parent read');
        $keys = self::leafOk($handlers['pluck'](['rows' => $parents, 'col' => [$pk]], $at), 'pluck');
        // ONE param: the deduped key set. The leaf owns its dialect encoding (a JSON array on
        // sqlite/MySQL, a native array on PG) — the shaping the batched child SELECT is compiled against.
        $children = self::leafOk($handlers['executeSQL']([
            'sql' => $childSql,
            'params' => [$keys],
            'opts' => (object) ['db' => $childDb, 'write' => null, 'whereDynamic' => null, 'guard' => null],
        ], $at), 'child fetch');
        /** @var list<\stdClass> */
        return self::leafOk($handlers['group']([
            'parents' => $parents,
            'children' => $children,
            'pk' => [$pk],
            'fk' => [$fk],
            'into' => $into,
            'single' => false,
        ], $at), 'group');
    }
}
