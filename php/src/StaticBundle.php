<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime;

/**
 * litedbmodel v2 SCP — the render-layer placeholder resolution (PHP, spec §8).
 *
 * The self-built `SqlBundle`/`ReadGraph` execution was deleted (#227): the only execution path is the
 * bc-generated native module bound to the leaf transport ({@see Leaves::makeHandlers}). What remains
 * here are the final render-layer helpers the leaf transport (`{@see Leaves}::executeSQL`) — and the
 * conformance runner's expected-value encoder — apply once a statement's SQL text AND its bound params
 * are final: resolve each deferred PG array-cast token from the array that fills it, encode a PG array
 * literal PDO can bind, and rewrite `?` → the dialect placeholder form (`$N` for Postgres, quote-aware).
 */
final class StaticBundle
{
    // ── Dialect placeholder render (port of handler.ts renderPlaceholders) ──────

    /**
     * Render `?` → the dialect placeholder form: PG `$N` (quote-aware), MySQL/SQLite keep `?`.
     * Byte-for-byte port of the TS renderPlaceholders: a `?` inside a single-quoted string literal
     * is NOT a placeholder.
     */
    public static function renderPlaceholders(string $sql, string $dialectName): string
    {
        if ($dialectName !== 'postgres') {
            return $sql;
        }
        $out = '';
        $index = 0;
        $inString = false;
        $len = strlen($sql);
        for ($i = 0; $i < $len; $i++) {
            $ch = $sql[$i];
            if ($inString) {
                $out .= $ch;
                if ($ch === "'") {
                    $inString = false;
                }
            } elseif ($ch === "'") {
                $out .= $ch;
                $inString = true;
            } elseif ($ch === '?') {
                $index += 1;
                $out .= '$' . $index;
            } else {
                $out .= $ch;
            }
        }
        return $out;
    }

    /**
     * Encode a flat scalar array to the Postgres array-literal text form (`{1,3}` /
     * `{"a","b"}`) PDO can bind to a single `= ANY($1)` placeholder. Elements are quoted +
     * escaped so text/uuid values (and empty `{}`) round-trip; PG coerces each element to the
     * column's element type. Mirrors the JS pg driver's array serialization.
     *
     * @param list<mixed> $arr
     */
    public static function pgArrayLiteral(array $arr): string
    {
        $parts = [];
        foreach ($arr as $e) {
            if ($e === null) {
                $parts[] = 'NULL';
            } elseif (is_bool($e)) {
                $parts[] = $e ? 't' : 'f';
            } elseif (is_int($e) || is_float($e)) {
                $parts[] = (string) $e;
            } else {
                // Quote + escape backslashes and double-quotes (PG array-literal escaping).
                $parts[] = '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], (string) $e) . '"';
            }
        }
        return '{' . implode(',', $parts) . '}';
    }

    // ── Deferred PG array-cast resolution (#46 — mirrors compile-relation.ts) ────

    /** The DEFERRED PG array-cast placeholder, resolved at render from the bound array. */
    private const PG_ARRAY_CAST_TOKEN = '@@PG_ARRAY_CAST@@';

    /**
     * Port of the ORIGINAL inferPgArrayType (v1 LazyRelation): the element type inferred from the
     * sample values (no sqlCast at this schema-less surface). PHP has no bool/int subclass trap.
     *
     * @param list<mixed> $values
     */
    private static function inferPgArrayType(array $values): string
    {
        if (count($values) === 0) {
            return 'text[]';
        }
        $sample = $values[0];
        if (is_bool($sample)) {
            return 'boolean[]';
        }
        if (is_int($sample)) {
            return 'int[]';
        }
        if (is_float($sample)) {
            return 'numeric[]';
        }
        return 'text[]';
    }

    /**
     * Resolve the FIRST unresolved cast token to the element type inferred from $values (mirrors TS
     * resolvePgArrayCast). SQL with no token is unchanged.
     *
     * @param list<mixed> $values
     */
    public static function resolvePgArrayCast(string $sql, array $values): string
    {
        $at = strpos($sql, self::PG_ARRAY_CAST_TOKEN);
        if ($at === false) {
            return $sql;
        }
        return substr($sql, 0, $at) . self::inferPgArrayType($values)
            . substr($sql, $at + strlen(self::PG_ARRAY_CAST_TOKEN));
    }
}
