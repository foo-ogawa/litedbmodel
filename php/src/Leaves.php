<?php

declare(strict_types=1);

namespace LiteDbModel\Runtime;

/**
 * litedbmodel v2 SCP — the op-INDEPENDENT leaf transport (#141), PHP port of `src/scp/leaves.ts`
 * and the twin of the python `litedbmodel_runtime.leaves.make_handlers`.
 *
 * The three op-agnostic (NOT per-op) leaves the bc PHP emitter's ir-exec runner
 * (`Behavior::runBehavior`) calls by catalog name via boundary injection (`bind($handlers)`). Each is
 * a bc handler (`fn(array $ports, array $ctx): array` returning `['ok' => Value] | ['error' => str]`)
 * — the SAME contract the rust/go typed-native runners call positionally, reproduced for the PHP
 * literal (ir-exec) path (epic #123: ts/go/rust = native de-box; py/php = literal). PHP's native value
 * model is the plain `\stdClass` record (the runtime `execute` seam returns `PDO::FETCH_OBJ` rows), so
 * there is NO WireValue conversion — the wire IS the `\stdClass`.
 *
 *   - `executeSQL` — the SOLE SQL transport: render `?` → dialect placeholders, bind params (an array
 *     param — a relation key set from `pluck` or a batch record set — rides per dialect: sqlite/mysql
 *     JSON-encode it for `json_each`/`JSON_TABLE`, postgres binds the array as-is), and run it through
 *     the runtime's central {@see execute()} / {@see run()} seam on the bound context — the ONLY driver
 *     contact. Everything besides the statement rides in the OPTIONAL `opts` control record (absent ⇒ a
 *     plain read): `opts->guard` is the RELATION runaway cap of a guarded relation child fetch
 *     (absent/null ⇒ uncapped), asserted against the raw rows HERE
 *     ({@see LimitExceededError::check}) because past `group` the graph is already nested. A
 *     non-returning write returns a one-row
 *     `[{changes, lastInsertRowid}]` summary so the leaf output shape is uniform (a list of rows).
 *   - `pluck` — rows + the ordered key-column TUPLE → the deduped, non-null batch key set (single-key →
 *     a flat scalar array; composite → an array-of-tuples). Delegates the dedupe to the shared grouping
 *     core ({@see Grouping::dedupeKeyTuples}) — the SAME SSoT the runtime relation path uses.
 *   - `group` — parents + flat children → each parent with its children nested under `into` per
 *     cardinality. Delegates to the shared grouping core ({@see Grouping::groupByKey} /
 *     {@see Grouping::attachToParent}) — the SAME SSoT, no duplicated grouping.
 *
 * The leaf is injected context-bound (a closure over the {@see ExecutionContext} + dialect) rather than
 * resolving an ambient driver: the bc PHP boundary is `bind($handlers)`, so the transport is handed in
 * directly. `executeSQL` resolves the AMBIENT tx-scoped ctx ({@see currentContext()}) first so every
 * statement inside a `withTransaction` scope runs on the tx-OWNED connection (the tx boundary is the
 * runtime's BEGIN/COMMIT/ROLLBACK, never baked into the generated runner); outside a tx it falls back
 * to the bound ctx.
 */
final class Leaves
{
    /**
     * The SQL keywords that may follow a WHERE clause — a dynamic WHERE splices in BEFORE the first
     * of them, at exactly the position a bounded WHERE occupies.
     */
    private const WHERE_TAIL_RE = '/\s+(GROUP BY|ORDER BY|LIMIT|OFFSET|FOR UPDATE|RETURNING)\b/i';

    /**
     * The WHERE keyword itself, matched the SAME way a tail keyword is, so the five language ports
     * share one lexical rule. A statement that carries it already has a (bounded) WHERE, which a
     * dynamic clause CONTINUES instead of opening a second one.
     */
    private const WHERE_RE = '/\s+WHERE\b/i';

    /**
     * Where a dynamic WHERE clause joins `$baseSql` (port of leaves.ts `whereSplice`) — the ONE scan
     * {@see effectiveStatement()} makes, and everything it needs to place both the text and the values:
     *
     *  - `at`      — the end of the statement's WHERE region: before the first tail keyword, or the end
     *                of the statement. The exact position a bounded WHERE occupies.
     *  - `keyword` — how the clause joins: ` AND ` when the statement already carries a WHERE (its
     *                BOUNDED predicates, lowered at emit — CLAUDE.md §2), ` WHERE ` when it carries none.
     *  - `tail`    — how many base params bind AFTER the clause. Every `?` past `at` is a page-tail
     *                bound count (`LIMIT ?` / `OFFSET ?`) — the only placeholders the emitted SELECT
     *                carries after the WHERE — so the surviving fragments' params bind before exactly
     *                that many of the base params, which is the position their own `?`s occupy in the
     *                final statement. It counts a SUBSTRING's placeholders and every placeholder binds
     *                one param, so it never exceeds `count($params)` for a statement that can be bound
     *                at all.
     *
     * @return array{0: int, 1: string, 2: int}
     */
    private static function whereSplice(string $baseSql): array
    {
        $at = preg_match(self::WHERE_TAIL_RE, $baseSql, $m, PREG_OFFSET_CAPTURE) === 1
            ? (int) $m[0][1]
            : strlen($baseSql);
        $keyword = preg_match(self::WHERE_RE, substr($baseSql, 0, $at)) === 1 ? ' AND ' : ' WHERE ';
        return [$at, $keyword, substr_count(substr($baseSql, $at), '?')];
    }

    /**
     * The `[sql, params]` a statement actually executes: the DYNAMIC (SKIP) WHERE plan assembled when it
     * has surviving fragments, the ports verbatim otherwise. Port of `src/scp/leaves.ts`
     * `assembleDynamicWhere`.
     *
     * `$plan` is the control record's `whereDynamic` field (null ⇒ no dynamic WHERE — only a read that
     * declares an OPTIONAL predicate carries one; CLAUDE.md §2). A SKIP predicate's presence is
     * per-CALL, so the FINAL statement can only be determined here, at execution time — which is why the
     * placeholder render runs AFTER this. bc carries each fragment's SKIP decision as DATA: a skipped
     * fragment is PRESENT with `skipped` true (never omitted), so assembly DROPS the `skipped`
     * fragments; the survivors join with ` AND `, the clause CONTINUES the bounded WHERE the emitter
     * already lowered (or opens one when there is none), and their params bind at the slot their `?`s
     * occupy: after the base params the clause follows, before the page tail's.
     *
     * @param array<string, mixed> $ports
     * @return array{0: string, 1: list<mixed>}
     */
    private static function effectiveStatement(array $ports, mixed $plan): array
    {
        /** @var list<mixed> $params */
        $params = array_values($ports['params']);
        $sql = (string) $ports['sql'];
        if ($plan === null) {
            return [$sql, $params];
        }
        $clause = '';
        $whereParams = [];
        foreach (((array) $plan)['frags'] as $frag) {
            $f = (array) $frag;
            if ($f['skipped']) {
                continue;
            }
            $clause .= ($clause === '' ? '' : ' AND ') . (string) $f['sql'];
            foreach ($f['params'] as $p) {
                $whereParams[] = $p;
            }
        }
        if ($clause === '') {
            return [$sql, $params];
        }
        [$at, $keyword, $tail] = self::whereSplice($sql);
        $bind = count($params) - $tail;
        return [
            substr($sql, 0, $at) . $keyword . $clause . substr($sql, $at),
            array_merge(array_slice($params, 0, $bind), $whereParams, array_slice($params, $bind)),
        ];
    }

    /**
     * Bind a leaf's resolved param list for the driver per dialect — the SAME rule as TS
     * `leaves.encodeParams`, mirrored by the python / rust / go leaf transports.
     *
     * A COMPOSITE key set (an array whose elements are the key TUPLES) binds as ONE JSON
     * array-of-tuples string on EVERY dialect (#159): PostgreSQL expands it server-side with
     * `json_array_elements`, and a `{…}` array literal would hand the server a nested array no cast
     * can turn into json. Any other array is a list of scalar cells: postgres binds it as the `{…}`
     * array-literal TEXT (PDO binds scalars only) for `= ANY($1)`, sqlite/mysql JSON-encode it for
     * `json_each` / `JSON_TABLE`. A scalar param binds unchanged.
     *
     * @param list<mixed> $params
     * @return list<mixed>
     */
    private static function bindParams(array $params, string $dialect): array
    {
        $json = static fn (array $p): string => (string) json_encode($p, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        // A composite key set — its first element is itself an array. No column class de-boxes to a
        // nested list, so every other array param is a list of scalar cells.
        $isTupleSet = static fn (array $p): bool => count($p) > 0 && is_array(array_values($p)[0]);
        return array_map(
            static function ($p) use ($dialect, $json, $isTupleSet) {
                if (!is_array($p)) {
                    return $p;
                }
                if ($dialect === 'postgres' && !$isTupleSet($p)) {
                    // PDO binds SCALARS only, so a PG array param rides as the `{…}` array-literal TEXT —
                    // the SAME conversion the imperative paths use ({@see StaticBundle::pgArrayLiteral}).
                    return StaticBundle::pgArrayLiteral($p);
                }
                return $json($p);
            },
            array_values($params),
        );
    }

    /**
     * The op-agnostic leaf transport handlers (`executeSQL`/`pluck`/`group`), bound to a driver (a raw
     * `\PDO`) or an {@see ExecutionContext} + its `$dialect`, ready to inject into a bc-generated PHP
     * module's `bind($handlers)`. Every SQL access funnels through the central {@see execute()} /
     * {@see run()} seam over the bound ctx — the SAME seam the runtime read/relation path uses
     * (middleware-visible, N+1-free).
     *
     * @return array{executeSQL: callable, pluck: callable, group: callable}
     */
    public static function makeHandlers(\PDO|ExecutionContext $driverOrCtx, string $dialect): array
    {
        $ctx = Context::of($driverOrCtx);

        $executeSQL = static function (array $ports, array $_ctx) use ($ctx, $dialect): array {
            // Resolve the AMBIENT tx-scoped ctx when this leaf runs inside a `withTransaction` scope
            // (the combinator pins it), so every statement resolves the tx-OWNED connection — the tx
            // boundary is the runtime's, not baked into the generated runner. Outside a tx,
            // `currentContext()` is null ⇒ the bound ctx.
            $active = currentContext() ?? $ctx;
            // The OPTIONAL `opts` control record — how to run the statement plus the two optional control
            // structs. ABSENT ⇒ a plain READ with no dynamic WHERE and no cap (the ONE statement shape
            // that omits the port, so its payload is `sql` + `params` and nothing else).
            $opts = $ports['opts'] ?? null;
            // The DYNAMIC (SKIP) WHERE is assembled FIRST: the final statement shape is only known
            // here, so the placeholder render must follow it (CLAUDE.md §2).
            [$effectiveSql, $effectiveParams] = self::effectiveStatement($ports, $opts?->whereDynamic ?? null);
            if ($dialect === 'postgres') {
                // The DEFERRED `?::<T>[]` element type (#46) resolves from the REAL bound key set —
                // the same render-layer step, and the same SSoT, the imperative relation path uses.
                foreach ($effectiveParams as $p) {
                    if (is_array($p)) {
                        $effectiveSql = StaticBundle::resolvePgArrayCast($effectiveSql, $p);
                    }
                }
            }
            $sql = StaticBundle::renderPlaceholders($effectiveSql, $dialect);
            $params = self::bindParams($effectiveParams, $dialect);
            try {
                // `write` is the statement's RUN MODE: null ⇒ a read; an object ⇒ a write carrying
                // its OWN `returning` (ONE field, three values — "returns rows but is not a write" is
                // not a state the ABI can hold, #206).
                $write = $opts?->write ?? null;
                if ($write !== null && !($write->returning ?? false)) {
                    $info = run($active, $sql, $params, StatementIntent::write());
                    // The affected-write summary row (uniform list output shape — TS `writeSummary`).
                    return ['ok' => [(object) ['changes' => $info->changes, 'lastInsertRowid' => $info->lastInsertRowid]]];
                }
                $rows = execute($active, $sql, $params, StatementIntent::read());
            } catch (SqlFailure $e) {
                return ['error' => $e->getMessage()];
            }
            // The RELATION runaway guard, on the RAW child rows — the only point they are visible (past
            // `group` the graph is already nested) and the reason the cap rides on this transport at
            // all. The comparison + error assembly are the shared {@see LimitExceededError::check} SSoT,
            // so this path cannot drift from the runtime relation path ({@see Relation}) or from the TS
            // reference. It THROWS rather than returning `['error' => …]`: a runaway is a litedbmodel
            // policy error with typed fields, not a mapped transport failure (the TS leaf throws too).
            $guard = $opts?->guard ?? null;
            if ($guard !== null) {
                LimitExceededError::check(
                    (int) $guard->limit,
                    count($rows),
                    'relation',
                    isset($guard->model) ? (string) $guard->model : null,
                    (string) $guard->relation,
                );
            }
            return ['ok' => $rows];
        };

        $pluck = static function (array $ports, array $_ctx): array {
            /** @var list<string> $col */
            $col = $ports['col'];
            $tuples = Grouping::dedupeKeyTuples($ports['rows'], $col);
            // single-key → a flat scalar key array (json_each scalar `value`); composite → an
            // array-of-tuples (json_each per-ordinal `$[i]`) — the SAME shape `Relation` binds.
            $keys = count($col) === 1
                ? array_map(static fn (array $t) => $t[0], $tuples)
                : array_map(static fn (array $t) => array_values($t), $tuples);
            return ['ok' => $keys];
        };

        $group = static function (array $ports, array $_ctx): array {
            $into = (string) $ports['into'];
            $single = (bool) $ports['single'];
            /** @var list<string> $pk */
            $pk = $ports['pk'];
            $byKey = Grouping::groupByKey($ports['children'], $ports['fk']);
            // {...par, [into]: nested}: shallow-clone each parent (the input is not mutated — TS spread).
            $out = array_map(static function (\stdClass $par) use ($pk, $into, $byKey, $single): \stdClass {
                $o = clone $par;
                $o->{$into} = Grouping::attachToParent($par, $pk, $byKey, $single);
                return $o;
            }, $ports['parents']);
            return ['ok' => $out];
        };

        return ['executeSQL' => $executeSQL, 'pluck' => $pluck, 'group' => $group];
    }
}
