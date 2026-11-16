<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime\Tests;

use LiteDbModel\Runtime\ExecutionContext;
use LiteDbModel\Runtime\Leaves;

/**
 * Running a relation THE ONLY WAY PRODUCTION REACHES ONE. The codegen path calls exactly three leaves
 * (`src/scp/leaf-transport.ts:184,187,190`), so a relation is:
 *
 *   executeSQL (parent read) → pluck (dedupe the parent keys) → executeSQL (BATCHED child fetch, the
 *   statement a cross-DB relation names its own database on) → group (nest children onto parents)
 *
 * There is no fourth entry point for a generated module to call, so driving a relation through anything
 * else tests a path production does not take. Shared as a trait because several test classes need the SAME
 * calls and PHPUnit gives them no other common home.
 */
trait RelationThroughLeavesTrait
{
    /**
     * The three leaf transports as a generated `php-native` module calls them: `executeSQL` inside
     * {@see Leaves::withTransport()} bound to `$driverOrCtx`, `pluck` / `group` as they are (they read no
     * binding).
     *
     * @return array{executeSQL: \Closure(array<string,mixed>): list<mixed>, pluck: \Closure(array<string,mixed>): list<mixed>, group: \Closure(array<string,mixed>): list<\stdClass>}
     */
    private static function boundLeaves(\PDO|ExecutionContext $driverOrCtx, string $dialect): array
    {
        return [
            'executeSQL' => static fn (array $ports): array => Leaves::withTransport(
                $driverOrCtx,
                $dialect,
                static fn (): array => Leaves::executeSQL($ports),
            ),
            'pluck' => static fn (array $ports): array => Leaves::pluckKeys($ports),
            'group' => static fn (array $ports): array => Leaves::groupChildren($ports),
        ];
    }

    /**
     * Run one relation through the three leaves, returning the grouped parents. `$childDb` is the child
     * fetch's `db` control field — null is the DEFAULT connection, exactly how a same-DB relation lowers.
     *
     * @param array<string,callable> $leaves {@see boundLeaves()}
     * @return list<\stdClass>
     */
    private static function relationThroughLeaves(
        array $leaves,
        string $parentSql,
        string $childSql,
        string $pk,
        string $fk,
        string $into,
        ?string $childDb = null,
    ): array {
        $parents = $leaves['executeSQL'](['sql' => $parentSql, 'params' => []]);
        $keys = $leaves['pluck'](['rows' => $parents, 'col' => [$pk]]);
        // ONE param: the deduped key set. The leaf owns its dialect encoding (a JSON array on
        // sqlite/MySQL, a native array on PG) — the shaping the batched child SELECT is compiled against.
        $children = $leaves['executeSQL']([
            'sql' => $childSql,
            'params' => [$keys],
            'opts' => (object) ['db' => $childDb, 'write' => null, 'whereDynamic' => null, 'guard' => null],
        ]);
        /** @var list<\stdClass> */
        return $leaves['group']([
            'parents' => $parents,
            'children' => $children,
            'pk' => [$pk],
            'fk' => [$fk],
            'into' => $into,
            'single' => false,
        ]);
    }
}
