<?php

/**
 * !!! VENDORED — DO NOT EDIT !!!
 *
 * Mechanically vendored from behavior-contracts/php/src/Behavior.php by
 * scripts/vendor-behavior-contracts-php.mjs (litedbmodel#33). The SSoT is the
 * behavior-contracts repo; edit there and re-run the vendoring script. A CI drift
 * gate (npm run vendor:bc-php:check) fails if this copy diverges.
 */

/**
 * Behavior.php — component-graph IR + runBehavior 統合実行 IF（PHP port）。
 *
 * TS 参照実装 `ts/src/behavior.ts` / Python port `behavior.py` の意味論を **完全一致** で
 * 移植（scp-ir-architecture.md §5–§7）。
 *
 * component-graph IR（`components[]{name, inputPorts, body[], output, plan}`）を、既存 COMMON の
 * `Plan::runPlan`（stage 実行・Skip 伝播・Policy Kind）+ `ExprEval::compile`（Expression IR）の
 * 上に実行する。専用コンポーネントの実装は handler registry（catalog名 → 実装。境界注入）で
 * 名前解決して委譲する。
 *
 * body ノード種:
 *   - componentRef: `{id, component, ports, parent?, bindField?, relationKind?, policy?}`
 *   - map:          `{id, map:{over, as, component, ports, when?, into?, batched?, parent?,
 *                    relationKind?, policy?}}`（when/into/batched は behaviorVersion 2）
 *   - cond:         `{id, cond:{if, then, else, parent?}}`（純 Expression、handler を呼ばない）
 *
 * behaviorVersion 2（bc#22）:
 *   - `map.when`   — per-element guard。`{cond:[when,true,false]}` へ lower して評価
 *     （strict-bool・非 bool は TYPE_MISMATCH で fail-closed）。false の要素は skip。
 *   - `map.into`   — zip-attach。結果は「over の各 guard 通過要素へ into キーで handler 結果を
 *     書き戻した augment 済みリスト」（over と同じ長さ・順序。skip 要素は無変更で pass through）。
 *     guard 通過要素が stdClass でなければ MAP_INTO_ELEMENT_NOT_OBJECT。
 *   - `map.batched`— guard 通過全要素の ports を先に評価し handler を 1 回だけ
 *     `handler(['items' => [<stdClass ports>…]], $ctx)` で呼ぶ。結果は items と同じ長さ・順序の
 *     リスト契約（違反は MAP_BATCH_RESULT_MISMATCH）。通過 0 件なら handler は呼ばれず空リスト。
 *   - handler ctx  — 全 handler 呼び出しに `['nodeId'=>…, 'component'=>…]`（map 非 batched は
 *     さらに `'bound'`）を渡す。追加のみ・既存 handler 互換。
 *
 * 値モデル: IR ノードは stdClass、list は PHP array（json_decode(.., false) 由来）。
 * scope は assoc array（束縛名 → runtime 値）。
 *
 * handler 型（境界注入・§7.1）:
 *   callable(array<string,mixed> $ports, array<string,mixed> $ctx): array
 *     戻り値 = ['ok' => Value] | ['error' => string]。$ctx は node identity
 *     ['nodeId'=>…, 'component'=>…] ＋ map 要素の束縛値 ['bound'=>...]（非 batched map）。
 */

declare(strict_types=1);

namespace LiteDbModel\Runtime\BehaviorContracts;

final class Behavior
{
    /** ノード結果 path の root（`ErrorDetail.field` は `result` から綴る — scp-error.md）。 */
    private const RESULT_ROOT = 'result';

    /**
     * 実行に要る構造は compile 済み IR に固定なので、解決は **IR handle ごとに 1 回**だけ（call ごとに
     * 組み直すと、行数の少ない op ではその組み立て代が interpreter の支配項になる — #287。#280 で潰した
     * outType 走査と同じ「静的に決まるものを実行ごとに再計算している」型で、conformer もこの解決の
     * 1 フィールドとしてここに畳んである）。key は handle 自身の弱参照なので、handle が落ちればこの
     * cache も落ちる。内側の key は {@see self::prepare} が綴る**タグ付き** key。
     *
     * @var \WeakMap<CompiledIr, array<string, PreparedComponent>>|null
     */
    private static ?\WeakMap $prepared = null;

    /** {@see self::passConformer} の唯一のインスタンス（`===` で「検査なし」を畳むための同一性）。 */
    private static ?\Closure $passConformer = null;

    /**
     * runBehavior — component-graph IR の統合実行 IF（scp-ir-architecture.md §7）。
     *
     * @param CompiledIr $ir compile 済み IR handle（{@see CompiledIr::load} が発行する。生の stdClass は
     *                        出自ゲートで NON_COMPILED_IR — #208）。
     * @param array<string,callable> $handlers 専用コンポーネント handler registry（catalog名 → 実装。境界注入）。
     * @param array<string,mixed> $input エントリ component の inputPorts 束縛（param 値）。
     * @param string|null $entry 実行する component 名（省略時は先頭 component）。
     * @return mixed `output` を評価した最終 Value（Φ 合流）。
     * @throws ProvenanceError handle でない IR（手組み / 無 token / 改竄）を渡したとき。
     * @throws BehaviorFailure UNKNOWN_COMPONENT / MAP_OVER_NOT_ARRAY / UNKNOWN_NODE_KIND / UNKNOWN_ENTRY。
     * @throws PlanFailure OP_FAILED 等（plan 実行由来）。
     * @throws ExprFailure port 式・output 評価由来。
     */
    public static function runBehavior(CompiledIr $ir, array $handlers, array $input = [], ?string $entry = null): mixed
    {
        // 出自ゲート（#208・TS runBehavior の assertCompiled と同位置）。型で要求し、entry component の
        // 構造は IR ごとに 1 回だけ解決する（#287）。
        $prep = self::prepare(CompiledIr::assertCompiled($ir), $entry);
        $body = $prep->body;
        $idToIndex = $prep->idToIndex;
        $conformers = $prep->conformers;
        $ops = $prep->ops;
        $nodeExprs = $prep->nodeExprs;
        $declaredPorts = $prep->inputPorts;

        // 省略された opt input port（`required:false`）を null に束縛する。どの port が省略可かは宣言
        // （=IR）で決まっているので {@see PreparedComponent} が解決済み。ここは値の束縛だけ。
        foreach ($prep->optionalPorts as $portName) {
            if (!array_key_exists($portName, $input)) {
                $input[$portName] = null;
            }
        }

        // 各 op 実行時に参照するスコープ: input params + それまでに ok になった node 結果（id → Value）。
        $results = [];
        $baseScope = static function () use ($input, &$results): array {
            return array_merge($input, $results);
        };

        $exec = static function (array $op, mixed $_bound) use (&$body, $idToIndex, $nodeExprs, $handlers, $baseScope, $declaredPorts): array {
            $idx = $idToIndex[$op['id']];
            $node = $body[$idx];
            $exprs = $nodeExprs[$idx];
            $props = get_object_vars($node);
            $kind = self::nodeKind($node);

            if ($kind === 'cond') {
                return ['ok' => ($exprs->cond)($baseScope())];
            }

            if ($kind === 'map') {
                $m = get_object_vars($props['map']);
                $over = self::resolveOverArray(
                    ($exprs->over)($baseScope()),
                    $m['over'] ?? null,
                    $body,
                    $declaredPorts,
                    (string) $op['id'],
                    'MAP_OVER_NOT_ARRAY',
                    'map'
                );
                $component = $m['component'] ?? null;
                $whenC = $exprs->when; // guard が宣言されていなければ null
                // 純式 map（Component 呼びなし・#222）: 各要素を `as` 束縛入りスコープで評価するだけ。
                // handler も要素ごとの Failure も無い（elementPolicy / batched / into / policy は guard が拒否）。
                if ($exprs->transform !== null) {
                    $asT = (string) ($m['as'] ?? '');
                    $outT = [];
                    foreach ($over as $el) {
                        $scope = $baseScope();
                        $scope[$asT] = $el;
                        if ($whenC !== null && $whenC($scope) !== true) {
                            continue;
                        }
                        $outT[] = ($exprs->transform)($scope);
                    }
                    return ['ok' => $outT];
                }
                if (!isset($handlers[$component])) {
                    BehaviorFailure::raise('UNKNOWN_COMPONENT', "component '{$component}' has no handler (fail-closed)");
                }
                $handler = $handlers[$component];
                $as = (string) ($m['as'] ?? '');
                $ctx = ['nodeId' => $op['id'], 'component' => $component];
                $batched = ($m['batched'] ?? null) === true;
                $hasInto = array_key_exists('into', $m);

                // per-element guard（v2）: `{cond:[when,true,false]}` へ lower 済み（strict-bool）。
                $keep = static function (array $scope) use ($whenC): bool {
                    return $whenC === null ? true : $whenC($scope) === true;
                };

                // Element Error Policy Kind（scp-error.md）。既定 error; 未知 kind は fail-closed。
                // skip は要素ごとの Failure がある文脈でのみ合法 — batched map は handler を 1 回だけ
                // 呼び結果リストを 1 つ受け取るため fail-closed。
                $elementPolicy = $m['elementPolicy'] ?? 'error';
                if ($elementPolicy !== 'error' && $elementPolicy !== 'skip') {
                    BehaviorFailure::raise('UNKNOWN_ELEMENT_POLICY', "map '{$op['id']}': unknown element policy '{$elementPolicy}' (fail-closed)");
                }
                if ($elementPolicy === 'skip' && $batched) {
                    BehaviorFailure::raise('ELEMENT_POLICY_NOT_APPLICABLE', "map '{$op['id']}': elementPolicy 'skip' needs a per-element Failure, but a batched map takes ONE outcome for the whole batch (fail-closed)");
                }

                $keptIdx = []; // guard を通過した over 内 index（into の整列用）
                $collected = [];
                if ($batched) {
                    // batched（v2）: guard 通過全要素の ports を先に評価し、handler を 1 回だけ呼ぶ。
                    $items = [];
                    foreach ($over as $i => $el) {
                        $scope = $baseScope();
                        $scope[$as] = $el;
                        if (!$keep($scope)) {
                            continue;
                        }
                        $items[] = (object) self::evalPorts($exprs->ports, $scope);
                        $keptIdx[] = $i;
                    }
                    if (count($items) > 0) {
                        $outcome = $handler(['items' => $items], $ctx);
                        if (array_key_exists('error', $outcome)) {
                            return $outcome; // policy Kind は runPlan が解釈
                        }
                        $r = $outcome['ok'];
                        if (!is_array($r) || !array_is_list($r) || count($r) !== count($items)) {
                            BehaviorFailure::raise(
                                'MAP_BATCH_RESULT_MISMATCH',
                                "map '{$op['id']}': batched handler must return a list aligned to items (want " . count($items) . ')'
                            );
                        }
                        $collected = $r;
                    }
                    // guard 全落ち: handler は呼ばれず $collected = []。
                } else {
                    foreach ($over as $i => $el) {
                        $scope = $baseScope();
                        $scope[$as] = $el;
                        if (!$keep($scope)) {
                            continue;
                        }
                        $ports = self::evalPorts($exprs->ports, $scope);
                        $outcome = $handler($ports, $ctx + ['bound' => $el]);
                        if (array_key_exists('error', $outcome)) {
                            // Element Error Policy（scp-error.md）: skip は失敗要素を落として続行
                            // （順序保持・leaf は Error Value を保持）; error は map の Component Failure へ昇格。
                            if ($elementPolicy === 'skip') {
                                continue;
                            }
                            return $outcome; // policy Kind は runPlan が解釈
                        }
                        $collected[] = $outcome['ok'];
                        $keptIdx[] = $i;
                    }
                }

                if (!$hasInto) {
                    return ['ok' => $collected];
                }

                // into（v2）: over と同じ長さ・順序の augment 済みリスト。guard-skip 要素は無変更で
                // pass through するが、connection 型 into（#182）は空 connection（Plan::unproducedValue）
                // で埋める＝writeUnproduced の whole-node skip と同一 SSoT。
                $into = (string) $m['into'];
                $nodeRK = self::nodeRelationKind($node);
                $augmented = [];
                $k = 0;
                foreach ($over as $i => $el) {
                    if ($k < count($keptIdx) && $keptIdx[$k] === $i) {
                        $intoVal = $collected[$k];
                        $k++;
                    } elseif ($nodeRK === 'connection') {
                        $intoVal = Plan::unproducedValue($nodeRK);
                    } else {
                        $augmented[] = $el;
                        continue;
                    }
                    if (!($el instanceof \stdClass)) {
                        BehaviorFailure::raise(
                            'MAP_INTO_ELEMENT_NOT_OBJECT',
                            "map '{$op['id']}': 'into' requires object elements (element {$i} is not an object)"
                        );
                    }
                    $aug = clone $el;
                    $aug->{$into} = $intoVal;
                    $augmented[] = $aug;
                }
                return ['ok' => $augmented];
            }

            if ($kind === 'fanout') {
                // fanout（v3）: over（id-list）→ dedup 済み 1 回の batched handler → dedupe/drop/strip →
                // connection {items, cursor:null}。整列制約（MAP_BATCH_RESULT_MISMATCH）は適用されない。
                $f = get_object_vars($props['fanout']);
                $over = self::resolveOverArray(
                    ($exprs->over)($baseScope()),
                    $f['over'] ?? null,
                    $body,
                    $declaredPorts,
                    (string) $op['id'],
                    'FANOUT_OVER_NOT_ARRAY',
                    'fanout'
                );
                $component = $f['component'] ?? null;
                if (!isset($handlers[$component])) {
                    BehaviorFailure::raise('UNKNOWN_COMPONENT', "component '{$component}' has no handler (fail-closed)");
                }
                $handler = $handlers[$component];
                $as = (string) ($f['as'] ?? '');
                $itemsPorts = [];
                foreach ($over as $el) {
                    $scope = $baseScope();
                    $scope[$as] = $el;
                    $itemsPorts[] = (object) self::evalPorts($exprs->ports, $scope);
                }
                $conn = new \stdClass();
                $conn->items = [];
                $conn->cursor = null;
                if (count($itemsPorts) > 0) {
                    $outcome = $handler(['items' => $itemsPorts], ['nodeId' => $op['id'], 'component' => $component]);
                    if (array_key_exists('error', $outcome)) {
                        return $outcome; // policy Kind は runPlan が解釈
                    }
                    $r = $outcome['ok'];
                    if (!is_array($r) || !array_is_list($r) || count($r) !== count($itemsPorts)) {
                        BehaviorFailure::raise(
                            'FANOUT_BATCH_RESULT_MISMATCH',
                            "fanout '{$op['id']}': batched handler must return a list aligned to the deduped id list (want " . count($itemsPorts) . ')'
                        );
                    }
                    $conn->items = self::fanoutDedupDrop($r, (string) $f['dedupeKey'], (string) $f['drop'], self::optStr($f['implicitSource'] ?? null));
                }
                return ['ok' => $conn];
            }

            // componentRef
            $component = $props['component'] ?? null;
            if (!isset($handlers[$component])) {
                BehaviorFailure::raise('UNKNOWN_COMPONENT', "component '{$component}' has no handler (fail-closed)");
            }
            $handler = $handlers[$component];
            $ports = self::evalPorts($exprs->ports, $baseScope());
            return $handler($ports, ['nodeId' => $op['id'], 'component' => $component]);
        };

        // runPlan は stage 実行・Skip 伝播・Policy Kind を担う。成功結果を results へ写す薄いラッパ。
        $wrappedExec = static function (array $op, mixed $bound) use ($exec, &$results, $conformers): array {
            $outcome = $exec($op, $bound);
            if (array_key_exists('ok', $outcome)) {
                // outType conformance（scp-error.md）: 宣言は主張であり、ここで（runtime が宣言型と
                // 返り値の両方を持つ地点で）検査する。不一致は構造化 Error Value を載せて loud に落とし、
                // 値は宣言型へ正規化する（int→float widen / 欠落 opt→null）ので results が de-box と一致する。
                // 宣言型の解決は compile 済み IR ごとに 1 回だけ（{@see self::prepare}）。
                $value = $outcome['ok'];
                $conform = $conformers[$op['id']];
                if ($conform !== null) {
                    $value = $conform($value);
                }
                $results[$op['id']] = $value;
            }
            return $outcome;
        };

        $run = Plan::runPlan($prep->planSpec, $ops, $wrappedExec);

        // Skip されたノードは未生成表現を results に載せる（output の ref が読めるように）。
        foreach ($run['states'] as $i => $s) {
            if ($s !== null && ($s['status'] ?? null) === 'skipped') {
                $results[$ops[$i]['id']] = Plan::unproducedValue(self::nodeRelationKind($body[$i]));
            }
        }

        // output（Φ 合流）を Expression IR として評価。
        return ($prep->output)($baseScope());
    }

    // ── ノード種判定 ─────────────────────────────────────────────────────────
    private static function nodeKind(\stdClass $n): string
    {
        $props = get_object_vars($n);
        if (array_key_exists('fanout', $props)) {
            return 'fanout';
        }
        if (array_key_exists('map', $props)) {
            return 'map';
        }
        if (array_key_exists('cond', $props)) {
            return 'cond';
        }
        if (array_key_exists('component', $props)) {
            return 'componentRef';
        }
        $id = $props['id'] ?? '?';
        BehaviorFailure::raise('UNKNOWN_NODE_KIND', "body node '{$id}' is not componentRef/map/cond/fanout");
    }

    private static function nodeParent(\stdClass $n): ?string
    {
        $props = get_object_vars($n);
        if (array_key_exists('fanout', $props)) {
            return self::optStr(get_object_vars($props['fanout'])['parent'] ?? null);
        }
        if (array_key_exists('map', $props)) {
            return self::optStr(get_object_vars($props['map'])['parent'] ?? null);
        }
        if (array_key_exists('cond', $props)) {
            return self::optStr(get_object_vars($props['cond'])['parent'] ?? null);
        }
        return self::optStr($props['parent'] ?? null);
    }

    private static function nodeBindField(\stdClass $n): ?string
    {
        $props = get_object_vars($n);
        if (array_key_exists('map', $props) || array_key_exists('cond', $props) || array_key_exists('fanout', $props)) {
            return null;
        }
        return self::optStr($props['bindField'] ?? null);
    }

    private static function nodePolicy(\stdClass $n): ?string
    {
        $props = get_object_vars($n);
        if (array_key_exists('fanout', $props)) {
            return self::optStr(get_object_vars($props['fanout'])['policy'] ?? null);
        }
        if (array_key_exists('map', $props)) {
            return self::optStr(get_object_vars($props['map'])['policy'] ?? null);
        }
        if (array_key_exists('cond', $props)) {
            return null;
        }
        return self::optStr($props['policy'] ?? null);
    }

    private static function nodeRelationKind(\stdClass $n): ?string
    {
        $props = get_object_vars($n);
        if (array_key_exists('fanout', $props)) {
            return self::optStr(get_object_vars($props['fanout'])['relationKind'] ?? null);
        }
        if (array_key_exists('map', $props)) {
            return self::optStr(get_object_vars($props['map'])['relationKind'] ?? null);
        }
        if (array_key_exists('cond', $props)) {
            return null;
        }
        return self::optStr($props['relationKind'] ?? null);
    }

    /**
     * fanoutDedupDrop — THE ONE dedup/drop definition (behaviorVersion 3) — PHP twin of behavior.ts
     * fanoutDedupDrop. First-seen dedupe by the body's `dedupeKey` field + dangling drop + implicitSource
     * strip on the aligned raw list; returns the connection `items` (the caller wraps). Byte-equal to the
     * TS/Python/native definitions. Bodies are \stdClass; a null / non-object / absent-key body is dangling.
     *
     * @param list<mixed> $alignedBodies
     * @return list<mixed>
     */
    public static function fanoutDedupDrop(array $alignedBodies, string $dedupeKey, string $drop, ?string $implicitSource): array
    {
        $items = [];
        $seen = [];
        foreach ($alignedBodies as $body) {
            $isObj = $body instanceof \stdClass;
            $rec = $isObj ? get_object_vars($body) : null;
            $keyVal = ($rec !== null && array_key_exists($dedupeKey, $rec)) ? $rec[$dedupeKey] : null;
            $hasKey = $keyVal !== null;
            if (!$hasKey) {
                if ($drop === 'dangling') {
                    continue;
                }
                $items[] = $body; // drop:none で dangling を保持
                continue;
            }
            $seenKey = is_string($keyVal) ? ('s:' . $keyVal) : ('j:' . json_encode($keyVal));
            if (array_key_exists($seenKey, $seen)) {
                continue;
            }
            $seen[$seenKey] = true;
            if ($implicitSource !== null && $rec !== null && array_key_exists($implicitSource, $rec)) {
                $copy = clone $body;
                unset($copy->{$implicitSource});
                $items[] = $copy;
            } else {
                $items[] = $body;
            }
        }
        return $items;
    }

    private static function optStr(mixed $v): ?string
    {
        return is_string($v) ? $v : null;
    }

    /**
     * ports オブジェクトの各式を compile 済み Closure へ解決する（key はソートせず宣言順のまま）。
     *
     * @param mixed $ports stdClass（ポート配線）。
     * @return array<int,array{0:string,1:\Closure}>
     */
    private static function compilePorts(mixed $ports): array
    {
        $out = [];
        if ($ports instanceof \stdClass) {
            foreach (get_object_vars($ports) as $k => $v) {
                $out[] = [$k, ExprEval::compile($v)];
            }
        }
        return $out;
    }

    /**
     * ノードの式を解決する。種の判定順は {@see self::nodeKind} と同じ。
     *
     * 種を持たないノードは式も持たない（UNKNOWN_NODE_KIND は {@see self::nodeKind} が実行時に
     * 出す — 解決は total で、実行されないノードのために失敗しない）。
     */
    private static function compileNodeExprs(\stdClass $node): NodeExprs
    {
        $props = get_object_vars($node);
        if (array_key_exists('fanout', $props)) {
            $f = get_object_vars($props['fanout']);
            return new NodeExprs(
                over: ExprEval::compile($f['over'] ?? null),
                ports: self::compilePorts($f['ports'] ?? new \stdClass()),
            );
        }
        if (array_key_exists('map', $props)) {
            $m = get_object_vars($props['map']);
            // 要素本体の 2 形は排他: 純式（transform）か Component 呼び（component + ports）。
            $isTransform = ($m['component'] ?? null) === null && array_key_exists('transform', $m);
            $when = null;
            if (array_key_exists('when', $m)) {
                // per-element guard（v2）: `{cond:[when,true,false]}` へ lower（strict-bool）。
                $whenNode = new \stdClass();
                $whenNode->cond = [$m['when'], true, false];
                $when = ExprEval::compile($whenNode);
            }
            return new NodeExprs(
                over: ExprEval::compile($m['over'] ?? null),
                when: $when,
                transform: $isTransform ? ExprEval::compile($m['transform']) : null,
                ports: $isTransform ? [] : self::compilePorts($m['ports'] ?? new \stdClass()),
            );
        }
        if (array_key_exists('cond', $props)) {
            // Conditional は純 Expression。cond 演算子（[if,then,else]）へ lower して評価する。
            $c = get_object_vars($props['cond']);
            $condNode = new \stdClass();
            $condNode->cond = [$c['if'] ?? null, $c['then'] ?? null, $c['else'] ?? null];
            return new NodeExprs(cond: ExprEval::compile($condNode));
        }
        if (array_key_exists('component', $props)) {
            return new NodeExprs(ports: self::compilePorts($props['ports'] ?? new \stdClass()));
        }
        return new NodeExprs();
    }

    /**
     * compile 済み ports 配線を評価する（宣言順は {@see self::compilePorts} が保持済み）。
     * FORBIDDEN_KEY 等は compile 済み式が投げる（fail-closed — 組み立ては total で、送出は
     * その位置が評価されたとき）。
     *
     * @param array<int,array{0:string,1:\Closure}> $ports
     * @param array<string,mixed> $scope
     * @return array<string,mixed>
     */
    private static function evalPorts(array $ports, array $scope): array
    {
        $out = [];
        foreach ($ports as [$k, $f]) {
            $out[$k] = $f($scope);
        }
        return $out;
    }

    // ── outType conformance（scp-error.md「The outType conformance check」）──────────────

    /** 観測された値の wire 型名（ErrorDetail.actualWireType の語彙）。 */
    private static function wireTypeName(mixed $v): string
    {
        if ($v === null) {
            return 'null';
        }
        if (is_bool($v)) {
            return 'bool';
        }
        if (is_int($v)) {
            return 'int';
        }
        if (is_float($v)) {
            return 'float';
        }
        if (is_string($v)) {
            return 'string';
        }
        if (is_array($v)) {
            return 'arr';
        }
        return 'obj';
    }

    /** 問題の値（stringify 済み・型復元のために再パースされることは無い）。 */
    private static function rawValueOf(mixed $v): string
    {
        if (is_string($v)) {
            return $v;
        }
        if (is_bool($v)) {
            return $v ? 'true' : 'false';
        }
        if ($v === null) {
            return 'null';
        }
        if (is_int($v)) {
            return (string) $v;
        }
        if (is_float($v)) {
            return Canonical::pyFloatRepr($v);
        }
        return Canonical::canonicalJson($v);
    }

    /**
     * PortableType（型記法）の正準表記。宣言型は IR の stdClass/文字列で来る。
     *
     * @param mixed $t
     */
    private static function portableTypeNotation(mixed $t): string
    {
        if (is_string($t)) {
            return $t;
        }
        if ($t instanceof \stdClass) {
            $props = get_object_vars($t);
            foreach (['opt', 'arr', 'map'] as $key) {
                if (array_key_exists($key, $props)) {
                    return $key . '(' . self::portableTypeNotation($props[$key]) . ')';
                }
            }
            if (array_key_exists('obj', $props) && $props['obj'] instanceof \stdClass) {
                $parts = [];
                foreach (get_object_vars($props['obj']) as $k => $ft) {
                    $parts[] = $k . ':' . self::portableTypeNotation($ft);
                }
                return 'obj{' . implode(',', $parts) . '}';
            }
        }
        return '?';
    }

    /**
     * ノードの宣言 outType を結果値の型へ正規化する。map ノードの outType は要素型なので
     * 結果は `{arr: 要素型}`（compiler と同じ読み方）。map 以外は結果型そのもの。
     *
     * @param array<string, mixed> $nodeProps
     * @param mixed $outType
     */
    private static function resultTypeOf(array $nodeProps, mixed $outType): mixed
    {
        if (array_key_exists('map', $nodeProps)) {
            $wrap = new \stdClass();
            $wrap->arr = $outType;
            return $wrap;
        }
        return $outType;
    }

    // ── 確定型の構造解決（fanout/map の opt-over 空反復・#177 (A)）────────────────────────
    // TS 参照実装 behavior.ts portableTypeOfInputPort / descend / overIsDeclaredOptArr の php 版。

    /** input port schema から確定 PortableType（stdClass|string。確定時のみ、他は null）。 */
    private static function portableTypeOfInputPort(\stdClass $schema): mixed
    {
        $p = get_object_vars($schema);
        $type = $p['type'] ?? null;
        $base = null;
        switch ($type) {
            case 'string':
            case 'int':
            case 'float':
            case 'bool':
            case 'null':
                $base = $type;
                break;
            case 'array':
                if (array_key_exists('elemType', $p)) {
                    $base = new \stdClass();
                    $base->arr = $p['elemType'];
                }
                break;
            case 'map':
                if (array_key_exists('elemType', $p)) {
                    $base = new \stdClass();
                    $base->map = $p['elemType'];
                }
                break;
        }
        if ($base === null) {
            return null;
        }
        if (($p['required'] ?? null) === false) {
            $opt = new \stdClass();
            $opt->opt = $base;
            return $opt;
        }
        return $base;
    }

    /** 確定型 t に field を 1 段降りた型（{obj} は field 型・{opt} は内側降下再ラップ、他は null）。 */
    private static function descendType(mixed $t, string $field): mixed
    {
        if (!($t instanceof \stdClass)) {
            return null;
        }
        $p = get_object_vars($t);
        if (array_key_exists('obj', $p)) {
            $obj = $p['obj'];
            if ($obj instanceof \stdClass) {
                $ov = get_object_vars($obj);
                return array_key_exists($field, $ov) ? $ov[$field] : null;
            }
            return null;
        }
        if (array_key_exists('opt', $p)) {
            $inner = self::descendType($p['opt'], $field);
            if ($inner === null) {
                return null;
            }
            $o = new \stdClass();
            $o->opt = $inner;
            return $o;
        }
        return null;
    }

    /**
     * bare `{ref:[…]}`/`{refOpt:[…]}`（静的 string path）なら path 配列、他は null。
     * @return array<int,string>|null
     */
    private static function bareRefPath(mixed $over): ?array
    {
        if (!($over instanceof \stdClass)) {
            return null;
        }
        $p = get_object_vars($over);
        if (count($p) !== 1) {
            return null;
        }
        $k = array_key_first($p);
        if ($k !== 'ref' && $k !== 'refOpt') {
            return null;
        }
        $path = $p[$k];
        if (!is_array($path) || count($path) === 0) {
            return null;
        }
        foreach ($path as $s) {
            if (!is_string($s)) {
                return null;
            }
        }
        return array_values($path);
    }

    /** t が {opt:{arr:…}} 形か。 */
    private static function isOptArrType(mixed $t): bool
    {
        if (!($t instanceof \stdClass)) {
            return false;
        }
        $p = get_object_vars($t);
        if (!array_key_exists('opt', $p)) {
            return false;
        }
        $inner = $p['opt'];
        return $inner instanceof \stdClass && array_key_exists('arr', get_object_vars($inner));
    }

    /**
     * overIsDeclaredOptArr（#177 (A)）— fanout/map の over（bare ref のみ）の宣言型が {opt:{arr}} か。
     * prior-node ref は結果型を path descend、input-port の optional array は要素型注記に関わらず宣言 opt-arr。
     * @param array<int,\stdClass> $body
     */
    private static function overIsDeclaredOptArr(mixed $over, array $body, ?\stdClass $inputPorts): bool
    {
        $path = self::bareRefPath($over);
        if ($path === null) {
            return false;
        }
        $head = $path[0];
        $rest = array_slice($path, 1);
        $node = null;
        foreach ($body as $n) {
            if ($n instanceof \stdClass && ((get_object_vars($n)['id'] ?? null) === $head)) {
                $node = $n;
                break;
            }
        }
        if ($node !== null) {
            $np = get_object_vars($node);
            if (!array_key_exists('outType', $np)) {
                return false;
            }
            $cur = self::resultTypeOf($np, $np['outType']);
        } else {
            if ($inputPorts === null) {
                return false;
            }
            $ip = get_object_vars($inputPorts);
            if (!array_key_exists($head, $ip) || !($ip[$head] instanceof \stdClass)) {
                return false;
            }
            $schema = $ip[$head];
            if (count($rest) === 0) {
                $sp = get_object_vars($schema);
                return (($sp['required'] ?? null) === false) && (($sp['type'] ?? null) === 'array');
            }
            $cur = self::portableTypeOfInputPort($schema);
        }
        if ($cur === null) {
            return false;
        }
        foreach ($rest as $f) {
            $cur = self::descendType($cur, (string) $f);
            if ($cur === null) {
                return false;
            }
        }
        return self::isOptArrType($cur);
    }

    /**
     * resolveOverArray — fanout/map の over 値を反復対象の配列へ解決する唯一の関門。配列はそのまま・
     * null かつ宣言 opt-arr は空配列（#177 (A) faithful 0 反復）・それ以外の非配列は fail-closed。
     * @param array<int,\stdClass> $body
     * @return array<int,mixed>
     */
    private static function resolveOverArray(mixed $over, mixed $overExpr, array $body, ?\stdClass $inputPorts, string $opId, string $code, string $label): array
    {
        if (is_array($over)) {
            return $over;
        }
        if ($over === null && self::overIsDeclaredOptArr($overExpr, $body, $inputPorts)) {
            return [];
        }
        BehaviorFailure::raise($code, "{$label} '{$opId}': 'over' did not evaluate to an array");
    }

    /**
     * @param mixed $expected
     * @return never
     */
    private static function conformFail(string $code, string $message, string $kind, string $nodeId, string $field, mixed $expected, mixed $actual, bool $hasActual): never
    {
        $detail = [
            'kind' => $kind,
            'model' => $nodeId,
            'field' => $field,
            'expectedType' => self::portableTypeNotation($expected),
        ];
        if ($hasActual) {
            $detail['actualWireType'] = self::wireTypeName($actual);
            $detail['rawValue'] = self::rawValueOf($actual);
        }
        ExprFailure::raise($code, $message, $detail);
    }

    /**
     * 積まれた segment から field path を確定し、Error Value（scp-error.md）を送出する。
     *
     * @return never
     */
    private static function raiseConform(string $nodeId, ConformPending $e): never
    {
        $field = self::RESULT_ROOT . implode('', array_reverse($e->segs));
        if ($e->prop === null) {
            self::conformFail('TYPE_MISMATCH', "node '{$nodeId}': {$field}: expected {$e->what}, got " . self::wireTypeName($e->actual), 'typeMismatch', $nodeId, $field, $e->expected, $e->actual, true);
        }
        self::conformFail('MISSING_PROP', "node '{$nodeId}': {$field}: missing property .{$e->prop}", 'missingField', $nodeId, "{$field}.{$e->prop}", $e->expected, null, false);
    }

    /** 検査を持たない宣言型（不透明ワイヤ値 `value`）の恒等。同一インスタンスなので `===` で畳める。 */
    private static function passConformer(): \Closure
    {
        return self::$passConformer ??= static fn (mixed $v): mixed => $v;
    }

    /**
     * 宣言 PortableType を **1 回だけ**解決して、値を検査＋正規化する Closure にする。
     *
     * 宣言型は IR に固定なので、型を歩くのは compile 時の 1 回で足りる。値ごとに歩き直すと、走査が
     * 行数×フィールド数に比例して interpreter の支配項になる（#280 — php で 72% を占めていた）。
     * 返る Closure は型 dispatch も path 組み立ても持たない。
     *
     * 意味論は emitter の de-box と厳密一致させる（検査だけでなく値も同じ形へ正規化する）:
     *   - float は int を受けて **値を float へ widen**（de-box の ParseFloat と同一・int のまま返すと発散）。
     *   - opt は null 許容。宣言 obj フィールドのキー欠落は opt なら null へ materialize
     *     （de-box の absent→None と同一・MISSING_PROP にしない）。required 欠落は MISSING_PROP のまま。
     *   - obj は**宣言フィールドだけ**を組み直す。宣言に無いキーは落とす（#233 — de-box は宣言型に対して
     *     total で、宣言に無いキーは「位置」ではない）。
     * 宣言と実物がずれた偽注記は loud に落とす。
     *
     * @param mixed $t
     */
    private static function compileConformer(mixed $t): \Closure
    {
        if (is_string($t)) {
            switch ($t) {
                case 'string':
                    return static function (mixed $v): mixed {
                        if (!is_string($v)) {
                            throw new ConformPending('string', 'string', $v, null);
                        }
                        return $v;
                    };
                case 'int':
                    return static function (mixed $v): mixed {
                        // #261: 整数値の float variant は同じ値の別綴りなので厳密に narrow する（float 側の
                        // widening の鏡）。非整数 / i64 の外は LOUD のまま（fail-closed 境界つきの厳密変換
                        // であって fallback ではない）。
                        if (is_float($v) && $v === floor($v) && $v >= -9223372036854775808.0 && $v < 9223372036854775808.0) {
                            return (int) $v;
                        }
                        if (!is_int($v) || is_bool($v)) {
                            throw new ConformPending('int', 'int', $v, null);
                        }
                        return $v;
                    };
                case 'float':
                    return static function (mixed $v): mixed {
                        if (is_int($v) && !is_bool($v)) {
                            return (float) $v; // int → float へ widen（de-box: ParseFloat と同一）
                        }
                        if (!is_float($v)) {
                            throw new ConformPending('float', 'float', $v, null);
                        }
                        return $v;
                    };
                case 'bool':
                    return static function (mixed $v): mixed {
                        if (!is_bool($v)) {
                            throw new ConformPending('bool', 'bool', $v, null);
                        }
                        return $v;
                    };
                case 'null':
                    return static function (mixed $v): mixed {
                        if ($v !== null) {
                            throw new ConformPending('null', 'null', $v, null);
                        }
                        return $v;
                    };
                default:
                    // 不透明ワイヤ値 `value`（wirePassthrough — guard がこの位置を fail-closed で許す）。
                    return self::passConformer();
            }
        }
        if (!($t instanceof \stdClass)) {
            return self::passConformer();
        }
        $props = get_object_vars($t);
        if (array_key_exists('opt', $props)) {
            $inner = self::compileConformer($props['opt']);
            if ($inner === self::passConformer()) {
                return self::passConformer(); // opt(不透明) は恒等（null も非 null も素通し）
            }
            return static function (mixed $v) use ($inner): mixed {
                return $v === null ? null : $inner($v);
            };
        }
        if (array_key_exists('arr', $props)) {
            $elem = self::compileConformer($props['arr']);
            if ($elem === self::passConformer()) {
                // `{arr:"value"}` — 出力ワイヤ透過ノードが取り得る 2 形のうちの片方（もう片方は素の
                // `value`）。要素は AS-IS なので、走らせるのは配列であることの検査だけ。
                return static function (mixed $v) use ($t): mixed {
                    if (!is_array($v) || !array_is_list($v)) {
                        throw new ConformPending('arr', $t, $v, null);
                    }
                    return $v;
                };
            }
            return static function (mixed $v) use ($t, $elem): mixed {
                if (!is_array($v) || !array_is_list($v)) {
                    throw new ConformPending('arr', $t, $v, null);
                }
                $out = [];
                $i = 0;
                try {
                    foreach ($v as $i => $el) {
                        $out[] = $elem($el);
                    }
                } catch (ConformPending $e) {
                    $e->segs[] = "[{$i}]";
                    throw $e;
                }
                return $out;
            };
        }
        if (array_key_exists('map', $props)) {
            $val = self::compileConformer($props['map']);
            return static function (mixed $v) use ($t, $val): mixed {
                if (!($v instanceof \stdClass)) {
                    throw new ConformPending('map', $t, $v, null);
                }
                $out = new \stdClass();
                $k = '';
                try {
                    foreach (get_object_vars($v) as $k => $mv) {
                        $out->{$k} = $val($mv);
                    }
                } catch (ConformPending $e) {
                    $e->segs[] = ".{$k}";
                    throw $e;
                }
                return $out;
            };
        }
        if (array_key_exists('obj', $props) && $props['obj'] instanceof \stdClass) {
            // フィールドの `opt` はこの loop 自身が読む（欠落キーの分岐が既に読んでいる同じ宣言）ので、
            // compile するのは **opt を剥がした内側**の型。`opt` を別の Closure で包むと、null 許容
            // フィールド 1 つにつき呼び出しが 1 段増える（実測ワークロードでは全 conformer 呼び出しの
            // 約半分がそれだった）。
            $plan = [];
            foreach (get_object_vars($props['obj']) as $k => $ft) {
                $isOpt = $ft instanceof \stdClass && array_key_exists('opt', get_object_vars($ft));
                $inner = $isOpt ? get_object_vars($ft)['opt'] : $ft;
                $plan[] = [$k, $isOpt, $ft, self::compileConformer($inner)];
            }
            return static function (mixed $v) use ($t, $plan): mixed {
                if (!($v instanceof \stdClass)) {
                    throw new ConformPending('obj', $t, $v, null);
                }
                $out = new \stdClass();
                $vProps = get_object_vars($v);
                $k = '';
                $ftMissing = null;
                $missing = false;
                try {
                    foreach ($plan as [$k, $isOpt, $ft, $check]) {
                        if (array_key_exists($k, $vProps)) {
                            $fv = $vProps[$k];
                            $out->{$k} = ($isOpt && $fv === null) ? null : $check($fv);
                        } elseif ($isOpt) {
                            $out->{$k} = null; // absent opt → null（de-box: absent→None）
                        } else {
                            $ftMissing = $ft;
                            $missing = true;
                            break;
                        }
                    }
                } catch (ConformPending $e) {
                    $e->segs[] = ".{$k}";
                    throw $e;
                }
                if ($missing) {
                    // MISSING_PROP の field は「親 path + .k」を detail 側だけが綴る（message は親 path）。
                    // この階層の segment は搬送体が prop として持つので、ここでは積まない。
                    throw new ConformPending(null, $ftMissing, null, (string) $k);
                }
                return $out;
            };
        }
        return self::passConformer();
    }

    /**
     * ノードの宣言 outType を解決して「結果値を検査＋正規化する Closure」にする（無ければ null）。
     *
     * 注記の無いノードは検査しない（宣言が無ければ主張も無い）。不透明ワイヤ値そのものを宣言した
     * ノードも検査を持たないので、呼び出し自体を省いて null にする。
     */
    private static function compileNodeConformer(\stdClass $node, string $nodeId): ?\Closure
    {
        $props = get_object_vars($node);
        if (!array_key_exists('outType', $props)) {
            return null;
        }
        $check = self::compileConformer(self::resultTypeOf($props, $props['outType']));
        if ($check === self::passConformer()) {
            return null;
        }
        return static function (mixed $v) use ($check, $nodeId): mixed {
            try {
                return $check($v);
            } catch (ConformPending $e) {
                self::raiseConform($nodeId, $e);
            }
        };
    }

    /**
     * この handle の entry component を実行できる形へ解決する（IR handle × entry ごとに 1 回だけ）。
     *
     * 解決するもの（全て compile 済み IR と entry 名だけで決まる）は {@see PreparedComponent} を参照。
     *
     * @throws BehaviorFailure UNKNOWN_ENTRY（解決できない entry は cache しない — 次の call も同じく落ちる）。
     */
    private static function prepare(CompiledIr $ir, ?string $entry): PreparedComponent
    {
        self::$prepared ??= new \WeakMap();
        // cache key は **タグ付き**にする。`$entry` をそのまま key にして「省略」を番兵**文字列**で綴ると、
        // 番兵が component 名と同じ key 空間に入る — `component.name` は guard が string であることしか
        // 要求しない（`ts/src/guard.ts:234`）ので、その文字列を名前に持つ entry が「省略」の解決を掴み、
        // 存在しない entry が warm cache で UNKNOWN_ENTRY を出さずに先頭 component を返す（fail-open）。
        // 'f' は 1 文字・名前側は必ず 'n' 始まりなので両者は決して一致せず、'n' 接頭辞は数値文字列 key の
        // int 化も塞ぐ。（python は key が `None` で、文字列とは別の key なので構造的に起きない。）
        $key = $entry === null ? 'f' : 'n' . $entry;
        /** @var array<string, PreparedComponent> $perIr */
        $perIr = self::$prepared[$ir] ?? [];
        if (isset($perIr[$key])) {
            return $perIr[$key];
        }

        $components = get_object_vars($ir->doc)['components'] ?? [];
        if (!is_array($components)) {
            $components = [];
        }
        $comp = null;
        if ($entry !== null) {
            foreach ($components as $c) {
                if ($c instanceof \stdClass && (get_object_vars($c)['name'] ?? null) === $entry) {
                    $comp = $c;
                    break;
                }
            }
        } elseif (count($components) > 0) {
            $comp = $components[0];
        }
        if (!($comp instanceof \stdClass)) {
            BehaviorFailure::raise('UNKNOWN_ENTRY', "component '" . ($entry ?? '<first>') . "' not found in IR");
        }
        $compProps = get_object_vars($comp);

        // `{opt:T}` と宣言された input port（PortSchema `required:false`）は **省略可**で、値域は
        // `T | null`。「キーごと省略」と「null を渡す」は同じ「値が無い」の 2 通りの綴りなので、省略
        // されたキーは null に束縛する（可搬 IR が既に持つ宣言を読むだけ）。required な port と未宣言
        // の名前は束縛しない: 未束縛のまま参照されれば UNKNOWN_BINDING（fail-closed はそのまま）。
        $inputPorts = $compProps['inputPorts'] ?? null;
        $inputPorts = $inputPorts instanceof \stdClass ? $inputPorts : null;
        $optionalPorts = [];
        if ($inputPorts !== null) {
            foreach (get_object_vars($inputPorts) as $portName => $portSchema) {
                if ($portSchema instanceof \stdClass && (get_object_vars($portSchema)['required'] ?? null) === false) {
                    $optionalPorts[] = (string) $portName;
                }
            }
        }

        /** @var array<int,\stdClass> $body */
        $body = $compProps['body'] ?? [];

        // id → index、nodeId → 結果 conformer、および index → compile 済みの式。
        $idToIndex = [];
        $conformers = [];
        $nodeExprs = [];
        foreach ($body as $i => $node) {
            $id = (string) (get_object_vars($node)['id'] ?? '');
            $idToIndex[$id] = $i;
            $conformers[$id] = self::compileNodeConformer($node, $id);
            $nodeExprs[$i] = self::compileNodeExprs($node);
        }

        // body ノード → OpSpec（runPlan の staging に載せる）。parent は id → index に解決。
        $ops = [];
        foreach ($body as $node) {
            $id = (string) (get_object_vars($node)['id'] ?? '');
            $pid = self::nodeParent($node);
            $op = ['id' => $id, 'parent' => ($pid !== null) ? ($idToIndex[$pid] ?? null) : null];
            $bf = self::nodeBindField($node);
            if ($bf !== null) {
                $op['bindField'] = $bf;
            }
            $rk = self::nodeRelationKind($node);
            if ($rk !== null) {
                $op['relationKind'] = $rk;
            }
            $pol = self::nodePolicy($node);
            if ($pol !== null) {
                $op['policy'] = $pol;
            }
            $ops[] = $op;
        }

        $plan = $compProps['plan'] ?? null;
        $planSpec = null;
        if ($plan instanceof \stdClass) {
            $pp = get_object_vars($plan);
            $planSpec = [
                'groups' => $pp['groups'] ?? [],
                'concurrency' => $pp['concurrency'] ?? 1,
            ];
        }

        $perIr[$key] = new PreparedComponent(
            $inputPorts,
            $optionalPorts,
            $body,
            $idToIndex,
            $conformers,
            $ops,
            $nodeExprs,
            $planSpec,
            ExprEval::compile($compProps['output'] ?? null),
        );
        self::$prepared[$ir] = $perIr;
        return $perIr[$key];
    }}
