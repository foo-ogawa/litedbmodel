<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime;

/**
 * litedbmodel v2 SCP — the SHARED relation-grouping CORE (#141), PHP port.
 *
 * The ONE implementation of relation key-identity + dedupe + parent grouping over `\stdClass`
 * record rows, behaviour-identical to the TS SSoT `src/scp/grouping.ts` (and the Rust port
 * `rust/litedbmodel_runtime/src/grouping.rs`). It is consumed by BOTH relation surfaces so there
 * is a single source of truth (no duplicated grouping logic):
 *
 *   - the EAGER graph — the op-independent `pluck` / `group` leaves ({@link Leaves});
 *   - the RUNTIME lazy / declarative path ({@link Relation} `runRelationOp` / `distributeToParent`),
 *     which groups already-fetched rows over the SAME core.
 *
 * Nothing here touches SQL or a driver: it is pure in-memory grouping over already-fetched rows
 * (`\stdClass` records). Ordered TUPLE keys are supported (composite keys), matching TS.
 */
final class Grouping
{
    /**
     * The separator between the rendered cells of a multi-column key. NUL, the same byte the TS `KEY_SEP`
     * uses, and for the same reason: a SPACE (what this was) collides as soon as a text key contains one —
     * `('a', 'b c')` and `('a b', 'c')` rendered to the same key.
     */
    private const KEY_SEP = "\0";

    /**
     * Mirror TS `String(v)` for the key-identity used by dedupe + grouping: bool → 'true'/'false',
     * a whole float prints as an integer (a scanned INT column arrives as a whole float / int),
     * a fractional float its default string form, string/int verbatim. A null key is dropped before
     * it is ever stringified, so it never affects a grouping result.
     */
    private static function stringifyKey(mixed $v): string
    {
        if (is_bool($v)) {
            return $v ? 'true' : 'false';
        }
        if (is_float($v)) {
            // A whole float prints as an integer (JS String(7) === "7"), but ONLY inside the int range:
            // `(int)` of an out-of-range float WRAPS in PHP — `(int) 1e30` is 5076964154930102272 — and
            // that wrapped value then shares a bucket with a genuine integer key. Both bounds below are
            // exactly representable as a float, and the upper one is exclusive because `(float) PHP_INT_MAX`
            // rounds up to 2^63. The range test also excludes INF, for which `floor($v) === $v` holds.
            if ($v === floor($v) && $v >= -9223372036854775808.0 && $v < 9223372036854775808.0) {
                return (string) (int) $v;
            }
            return (string) $v;
        }
        return (string) $v;
    }

    /**
     * The stringified key identity for dedupe/grouping. Single scalar → its `String(v)` rendering;
     * a tuple → the renderings joined by a single space (mirror of TS `keyIdentity`).
     *
     * @param list<mixed> $values
     */
    public static function keyIdentity(array $values): string|int
    {
        // A single-column key — every hasMany/belongsTo FK — rides as the CELL. PHP array keys are int or
        // string and an integer-like string is cast to the int, so `1` and `"1"` land in one bucket exactly
        // as the rendering did; an int key skips the string conversion entirely. Two columns concatenate
        // directly. Only a wider key pays `array_map` + `implode`, and no relation uses one.
        $n = count($values);
        if ($n === 1) {
            $v = $values[0];
            return is_int($v) ? $v : self::stringifyKey($v);
        }
        if ($n === 2) {
            return self::stringifyKey($values[0]) . self::KEY_SEP . self::stringifyKey($values[1]);
        }
        return implode(self::KEY_SEP, array_map([self::class, 'stringifyKey'], $values));
    }

    /**
     * The deduped, non-null key TUPLES of `$rows` over `$keyCols` (insertion order preserved —
     * deterministic). A tuple is dropped if ANY of its key columns is absent/null (no partial
     * keys); deduped on the stringified tuple identity. Port of TS `dedupeKeyTuples`.
     *
     * @param list<\stdClass> $rows
     * @param list<string> $keyCols
     * @return list<list<mixed>>
     */
    public static function dedupeKeyTuples(array $rows, array $keyCols): array
    {
        $seen = [];
        $out = [];
        foreach ($rows as $r) {
            $tuple = self::tupleOrNull($r, $keyCols);
            if ($tuple === null) {
                continue;
            }
            $id = self::keyIdentity($tuple);
            if (isset($seen[$id])) {
                continue;
            }
            $seen[$id] = true;
            $out[] = $tuple;
        }
        return $out;
    }

    /**
     * Group `$children` by their `$fkCols` tuple identity (a null/absent key drops the child).
     * Child order within a bucket is the input order. Port of TS `groupByKey`.
     *
     * @param list<\stdClass> $children
     * @param list<string> $fkCols
     * @return array<string, list<\stdClass>>
     */
    public static function groupByKey(array $children, array $fkCols): array
    {
        $byKey = [];
        foreach ($children as $c) {
            $tuple = self::tupleOrNull($c, $fkCols);
            if ($tuple === null) {
                continue;
            }
            $byKey[self::keyIdentity($tuple)][] = $c;
        }
        return $byKey;
    }

    /**
     * Distribute grouped children onto ONE parent per cardinality (port of TS `attachToParent`):
     * `$single === false` (hasMany) → the child list ([] when none); `$single === true`
     * (belongsTo/hasOne) → the single child (or null). Keyed by the parent's `$pkCols` tuple
     * identity; a null/absent parent key matches nothing ([]/null).
     *
     * @param list<string> $pkCols
     * @param array<string, list<\stdClass>> $byKey
     * @return list<\stdClass>|\stdClass|null
     */
    public static function attachToParent(\stdClass $parent, array $pkCols, array $byKey, bool $single): mixed
    {
        $tuple = self::tupleOrNull($parent, $pkCols);
        $rows = $tuple === null ? null : ($byKey[self::keyIdentity($tuple)] ?? null);
        if (!$single) {
            return $rows ?? [];
        }
        return ($rows !== null && count($rows) > 0) ? $rows[0] : null;
    }

    /**
     * The ordered key TUPLE of `$row` over `$cols`, or null if ANY column is absent/null (the TS
     * `v === undefined || v === null` drop). `$row->{$c} ?? null` coalesces both an ABSENT property
     * and a present-null to null, matching the TS drop.
     *
     * @param list<string> $cols
     * @return list<mixed>|null
     */
    private static function tupleOrNull(\stdClass $row, array $cols): ?array
    {
        $tuple = [];
        foreach ($cols as $c) {
            $v = $row->{$c} ?? null;
            if ($v === null) {
                return null;
            }
            $tuple[] = $v;
        }
        return $tuple;
    }
}
