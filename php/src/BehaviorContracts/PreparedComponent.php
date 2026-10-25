<?php

/**
 * !!! VENDORED — DO NOT EDIT !!!
 *
 * Mechanically vendored from behavior-contracts/php/src/PreparedComponent.php by
 * scripts/vendor-behavior-contracts-php.mjs (litedbmodel#33). The SSoT is the
 * behavior-contracts repo; edit there and re-run the vendoring script. A CI drift
 * gate (npm run vendor:bc-php:check) fails if this copy diverges.
 */

/**
 * PreparedComponent.php — compile 済み IR の 1 entry を「実行できる形」へ解決した結果（PHP port）。
 *
 * @internal `Behavior::prepare` だけが生成し、`Behavior::runBehavior` だけが読む。`Behavior` の外へは
 * 出ない。
 *
 * ここに載るものは全て **compile 済み IR と entry 名だけで決まる** — どの component が entry か、その
 * body、id → index、OpSpec、ノード結果の conformer、ノードの式、省略可 input port、plan、output 式。値も
 * handler も入力も一切関与しない。call ごとに組み直すと、行数の少ない op ではその組み立て代が interpreter の
 * 支配項になる（#287 — findUnique で php 23% / python 22% を占めていた）。
 */

declare(strict_types=1);

namespace LiteDbModel\Runtime\BehaviorContracts;

final class PreparedComponent
{
    /**
     * @param \stdClass|null           $inputPorts    entry component の inputPorts 宣言（無ければ null）。
     * @param array<int,string>        $optionalPorts 省略可（`required: false`）な input port 名。
     * @param array<int,\stdClass>     $body          body ノード（宣言順）。
     * @param array<string,int>        $idToIndex     ノード id → body index。
     * @param array<string,\Closure|null> $conformers ノード id → 結果 conformer（検査なしは null）。
     * @param array<int,array<string,mixed>> $ops     body ノード → OpSpec（runPlan の staging 入力）。
     * @param array<int,NodeExprs>     $nodeExprs     body ノード → compile 済みの式（body と同じ index）。
     * @param array<string,mixed>|null $planSpec      実行計画（plan 不在は null = 1 op 1 stage）。
     * @param \Closure                 $output        compile 済み output 式（Φ 合流）。
     */
    public function __construct(
        public readonly ?\stdClass $inputPorts,
        public readonly array $optionalPorts,
        public readonly array $body,
        public readonly array $idToIndex,
        public readonly array $conformers,
        public readonly array $ops,
        public readonly array $nodeExprs,
        public readonly ?array $planSpec,
        public readonly \Closure $output,
    ) {
    }
}
