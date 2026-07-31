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
 *     core ({@see Grouping::dedupeKeyTuples}) — the SAME SSoT every relation consumer uses.
 *   - `group` — parents + flat children → each parent with its children nested under `into` per
 *     cardinality. Delegates to the shared grouping core ({@see Grouping::groupByKey} /
 *     {@see Grouping::attachToParent}) — the SAME SSoT, no duplicated grouping.
 *
 * The leaf is injected context-bound (a closure over the {@see ExecutionContext} + dialect) rather than
 * resolving an ambient driver: the bc PHP boundary is `bind($handlers)`, so the transport is handed in
 * directly. `executeSQL` resolves the AMBIENT tx-scoped ctx ({@see currentContext()}) first so every
 * statement inside a `withTransaction` scope of the tx's own database runs on the tx-OWNED connection (a statement
 * naming a DIFFERENT database is rejected) (the tx boundary is the
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
     * The six `at` labels the fail-closed field read names — one per leaf payload (`executeSQL` /
     * `pluck` / `group`), plus the control record, the dynamic-WHERE plan and one of its fragments.
     */
    private const PAYLOAD = 'the executeSQL payload';
    private const PLUCK = 'the pluck payload';
    private const GROUP = 'the group payload';
    private const RECORD = "the 'opts' control record";
    private const PLAN = "the 'whereDynamic' plan";
    private const FRAG = "a 'whereDynamic' fragment";

    /**
     * Confirm ONE unboxed value against its DECLARED type, exactly as the catalog spells it
     * (`src/scp/leaf-transport.ts`) — the php leg's ONE wrong-type failure, and the twin of the go
     * `portErr` wrong-variant half / rust `port_mismatch`. A `|null` suffix marks a NULLABLE field,
     * whose `null` is the declared absence.
     *
     * A field of the wrong type is the same ABI break as a missing one, for the same reason: the
     * generator emits the literal the port's type says, so nothing else can arrive from a generated
     * module. Coercing it instead ran an INSERT on the read seam (`returning` not a bool), applied a
     * predicate the call SKIPPED (`skipped` not a bool) or spliced a cast number in place of a
     * predicate (`sql` not a string). A leaf STRUCT is a `\stdClass` on this plane and a leaf LIST is a
     * PHP array — the bc php value model (`ExprEval` renders `{obj:…}` / `{arr:…}` as exactly those).
     */
    private static function typed(mixed $value, string $what, string $declared): mixed
    {
        $kind = str_ends_with($declared, '|null') ? substr($declared, 0, -5) : $declared;
        if ($kind !== $declared && $value === null) {
            return null;
        }
        $ok = match ($kind) {
            'bool' => is_bool($value),
            'int' => is_int($value),
            'string' => is_string($value),
            // A leaf LIST is a php array with the keys 0..n-1. `array_is_list` is what makes that the
            // SAME predicate the other four legs apply (TS `Array.isArray`, python `isinstance(v, list)`,
            // the go / rust `list` wire variant): php's `is_array` alone also accepts a string-keyed MAP,
            // which is a `record` on this plane and never a list.
            'list' => is_array($value) && array_is_list($value),
            // The ordered key-column TUPLE (`col` / `pk` / `fk`): a list whose every element is a column
            // NAME — the same element check the go `portStrings` / rust `port_strings` probes make.
            'string[]' => is_array($value) && array_is_list($value)
                && $value === array_filter($value, 'is_string'),
            'record' => is_object($value),
        };
        if (!$ok) {
            throw new \RuntimeException(
                "scp leaf: {$what} must be {$declared}, got " . json_encode($value),
            );
        }
        return $value;
    }

    /**
     * Read ONE DECLARED field out of a payload / struct that IS present — the php leg's ONE fail-closed
     * field read (the twin of the go `optRowField` / rust `take_opt_row` discipline). Presence and the
     * DECLARED type ({@see typed()}) are confirmed at the SAME read, exactly as go's and rust's typed
     * probes confirm both.
     *
     * `null` is a VALUE (the declared absence of a write mode / a plan / a cap / a model); a MISSING KEY
     * is an ABI BREAK, and the two must not collapse: bc types a port by the literal wired into it and
     * REJECTS a partial struct, so a generated module ALWAYS spells every field of every struct it
     * wires. A key that is not there did not come from one, and defaulting it would silently downgrade a
     * write to a read, drop a relation cap, or erase a SKIP predicate (#205).
     *
     * @param array<string, mixed>|object $record
     */
    private static function required(array|object $record, string $name, string $at, string $declared): mixed
    {
        $present = is_array($record) ? array_key_exists($name, $record) : property_exists($record, $name);
        if (!$present) {
            throw new \RuntimeException(
                "scp leaf: {$at} is missing its '{$name}' field — a generated module spells "
                . 'every field of every struct it wires, so an ABSENT key is an ABI break (a null VALUE '
                . 'is how an absent write mode / plan / cap is spelled)',
            );
        }
        return self::typed(is_array($record) ? $record[$name] : $record->{$name}, "{$at}'s '{$name}'", $declared);
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
        $params = array_values(self::required($ports, 'params', self::PAYLOAD, 'list'));
        $sql = self::required($ports, 'sql', self::PAYLOAD, 'string');
        if ($plan === null) {
            return [$sql, $params];
        }
        $clause = '';
        $whereParams = [];
        // EVERY field of EVERY fragment is unboxed fail-closed BEFORE any of them is used, skipped ones
        // included — a fragment is a PRESENT struct like every other and the generator spells it in
        // full, so a missing or mistyped field is an ABI break and NOT a default: without `skipped` the
        // statement applies a predicate the call SKIPPED, without `sql` the predicate is erased
        // entirely, and without `params` a value binds where none belongs — each silently returning
        // DIFFERENT ROWS (#209). The go / rust transports unbox the same three fields the same way.
        foreach (self::required($plan, 'frags', self::PLAN, 'list') as $frag) {
            $frag = self::typed($frag, self::FRAG, 'record');
            $skipped = self::required($frag, 'skipped', self::FRAG, 'bool');
            $fragSql = self::required($frag, 'sql', self::FRAG, 'string');
            $fragParams = self::required($frag, 'params', self::FRAG, 'list');
            if ($skipped) {
                continue;
            }
            $clause .= ($clause === '' ? '' : ' AND ') . $fragSql;
            foreach ($fragParams as $p) {
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
            // (the combinator pins it), so every statement of the tx's own database (an unnamed one, or one naming that database) resolves
            // the tx-OWNED connection — the tx
            // boundary is the runtime's, not baked into the generated runner. Outside a tx,
            // `currentContext()` is null ⇒ the bound ctx.
            $active = currentContext() ?? $ctx;
            // The OPTIONAL `opts` control record — how to run the statement plus the two optional control
            // structs. An OMITTED port is the ONE legitimate absence: a plain READ with no dynamic WHERE
            // and no cap (the ONE statement shape that omits it, so its payload is `sql` + `params` and
            // nothing else). Once the port IS there it is read exactly like every field below — its own
            // `null` is the same plain read, anything that is not the control record is an ABI break.
            $opts = array_key_exists('opts', $ports)
                ? self::required($ports, 'opts', self::PAYLOAD, 'record|null')
                : null;
            // Every FIELD of a record that IS present is required — a missing or mistyped key is an ABI
            // break, not an absent value.
            $plan = $opts === null ? null : self::required($opts, 'whereDynamic', self::RECORD, 'record|null');
            // The NAMED connection (database) this statement runs on — the only control field that is a
            // bare nullable STRING rather than a struct. `null` ⇒ the DEFAULT connection; an ABSENT KEY is
            // LOUD like every other field of a record that IS present, because a name read as "no name"
            // runs the statement against a DIFFERENT database than its model declares (#217).
            $db = $opts === null ? null : self::required($opts, 'db', self::RECORD, 'string|null');
            // The DYNAMIC (SKIP) WHERE is assembled FIRST: the final statement shape is only known
            // here, so the placeholder render must follow it (CLAUDE.md §2).
            [$effectiveSql, $effectiveParams] = self::effectiveStatement($ports, $plan);
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
                $write = $opts === null ? null : self::required($opts, 'write', self::RECORD, 'record|null');
                // The seam INTENT the RUN MODE reduces to: a write mode PRESENT ⇒ a WRITE (the writer /
                // tx connection), absent ⇒ a READ. Derived BEFORE the branch, because the branch selects
                // the SEAM (`returning` ⇒ the row seam) while the intent selects the CONNECTION
                // ({@see resolvePool()}): a RETURNING write runs on {@see execute()} and still belongs on
                // the WRITER. Reading `returning` as the intent sent `INSERT … RETURNING` to the READ
                // REPLICA (#207).
                //
                // The NAMED database rides on the SAME intent, because {@see resolvePool()} resolves both
                // together: it picks the named connection's reader/writer PAIR first, then the
                // write/sticky split within it. `null` ⇒ the default connection, i.e. the intent every
                // single-DB statement has always carried.
                $intent = new StatementIntent($write !== null, $db);
                if ($write !== null && !self::required($write, 'returning', "the 'write' mode", 'bool')) {
                    $info = run($active, $sql, $params, $intent);
                    // The affected-write summary row (uniform list output shape — TS `writeSummary`).
                    return ['ok' => [(object) ['changes' => $info->changes, 'lastInsertRowid' => $info->lastInsertRowid]]];
                }
                $rows = execute($active, $sql, $params, $intent);
            } catch (SqlFailure $e) {
                return ['error' => $e->getMessage()];
            }
            // The RELATION runaway guard, on the RAW child rows — the only point they are visible (past
            // `group` the graph is already nested) and the reason the cap rides on this transport at
            // all. The comparison + error assembly are the shared {@see LimitExceededError::check} SSoT,
            // so this path cannot drift from the TS
            // reference. It THROWS rather than returning `['error' => …]`: a runaway is a litedbmodel
            // policy error with typed fields, not a mapped transport failure (the TS leaf throws too).
            $guard = $opts === null ? null : self::required($opts, 'guard', self::RECORD, 'record|null');
            if ($guard !== null) {
                $at = "the 'guard' cap";
                LimitExceededError::check(
                    self::required($guard, 'limit', $at, 'int'),
                    count($rows),
                    'relation',
                    self::required($guard, 'model', $at, 'string|null'),
                    self::required($guard, 'relation', $at, 'string'),
                );
            }
            return ['ok' => $rows];
        };

        // `pluck` / `group` read their ports through the SAME fail-closed reader the SQL transport uses
        // ({@see required()}) — a FLAT port shape is not a reason to trust it. The `(string)` / `(bool)`
        // casts below WERE the silent path: a mistyped `single` flipped the relation's CARDINALITY (a
        // `hasMany` nesting ONE child), `into` = 42 nested the relation under `"42"`, and an absent
        // `pk` / `col` raised an E_WARNING-shaped failure that named no port at all (#213).
        $pluck = static function (array $ports, array $_ctx): array {
            /** @var list<string> $col */
            $col = self::required($ports, 'col', self::PLUCK, 'string[]');
            $tuples = Grouping::dedupeKeyTuples(self::required($ports, 'rows', self::PLUCK, 'list'), $col);
            // single-key → a flat scalar key array (json_each scalar `value`); composite → an
            // array-of-tuples (json_each per-ordinal `$[i]`) — the SAME shape `Relation` binds.
            $keys = count($col) === 1
                ? array_map(static fn (array $t) => $t[0], $tuples)
                : array_map(static fn (array $t) => array_values($t), $tuples);
            return ['ok' => $keys];
        };

        $group = static function (array $ports, array $_ctx): array {
            $into = self::required($ports, 'into', self::GROUP, 'string');
            $single = self::required($ports, 'single', self::GROUP, 'bool');
            /** @var list<string> $pk */
            $pk = self::required($ports, 'pk', self::GROUP, 'string[]');
            $byKey = Grouping::groupByKey(
                self::required($ports, 'children', self::GROUP, 'list'),
                self::required($ports, 'fk', self::GROUP, 'string[]'),
            );
            // {...par, [into]: nested}: shallow-clone each parent (the input is not mutated — TS spread).
            $out = array_map(static function (\stdClass $par) use ($pk, $into, $byKey, $single): \stdClass {
                $o = clone $par;
                $o->{$into} = Grouping::attachToParent($par, $pk, $byKey, $single);
                return $o;
            }, self::required($ports, 'parents', self::GROUP, 'list'));
            return ['ok' => $out];
        };

        return ['executeSQL' => $executeSQL, 'pluck' => $pluck, 'group' => $group];
    }
}
