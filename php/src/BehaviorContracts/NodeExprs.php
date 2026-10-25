<?php

/**
 * !!! VENDORED — DO NOT EDIT !!!
 *
 * Mechanically vendored from behavior-contracts/php/src/NodeExprs.php by
 * scripts/vendor-behavior-contracts-php.mjs (litedbmodel#33). The SSoT is the
 * behavior-contracts repo; edit there and re-run the vendoring script. A CI drift
 * gate (npm run vendor:bc-php:check) fails if this copy diverges.
 */

/**
 * NodeExprs.php — 1 body ノードが持つ Expression IR を compile 済み Closure へ解決した結果（PHP port）。
 *
 * @internal `Behavior::compileNodeExprs` だけが生成し、`Behavior::runBehavior` だけが読む。
 * {@see PreparedComponent} の 1 ノード分の切片であり、`Behavior` の外へは出ない。
 *
 * 式は compile 済み IR に固定なので、演算子 dispatch も引数形の検査も IR ごとに 1 回でよい
 * （#280 の outType、#287 の setup と同じ「静的に決まるものを実行ごとに再計算している」型 —
 * #291 で findUnique の php 14% / python 20〜25% を占めていた）。cond / map.when が要求する
 * `{cond:[…]}` への lower もここで 1 回だけ組む（call ごとに stdClass を組み直さない）。
 */

declare(strict_types=1);

namespace LiteDbModel\Runtime\BehaviorContracts;

final class NodeExprs
{
    /**
     * @param \Closure|null $cond      cond ノードの `{cond:[if,then,else]}`（他の種では null）。
     * @param \Closure|null $over      map / fanout の反復対象式（他の種では null）。
     * @param \Closure|null $when      map の per-element guard `{cond:[when,true,false]}`（未宣言なら null）。
     * @param \Closure|null $transform 純式 map の要素式（Component 呼びの map / 他の種では null）。
     * @param array<int,array{0:string,1:\Closure}> $ports ports 配線（宣言順の [名前, 式] 対）。
     */
    public function __construct(
        public readonly ?\Closure $cond = null,
        public readonly ?\Closure $over = null,
        public readonly ?\Closure $when = null,
        public readonly ?\Closure $transform = null,
        public readonly array $ports = [],
    ) {
    }
}
