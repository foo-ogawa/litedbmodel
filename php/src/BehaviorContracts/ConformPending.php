<?php

/**
 * !!! VENDORED — DO NOT EDIT !!!
 *
 * Mechanically vendored from behavior-contracts/php/src/ConformPending.php by
 * scripts/vendor-behavior-contracts-php.mjs (litedbmodel#33). The SSoT is the
 * behavior-contracts repo; edit there and re-run the vendoring script. A CI drift
 * gate (npm run vendor:bc-php:check) fails if this copy diverges.
 */

/**
 * ConformPending.php — outType 適合検査の失敗を、field path が確定するまで運ぶ搬送体（PHP port）。
 *
 * @internal `Behavior` の適合検査の内部だけで生成・捕捉される。`Behavior::runBehavior` の外へは
 * 決して漏れない（必ず {@see ExprFailure} に組み直されて送出される）。
 *
 * 走査は結果セットの全要素・全フィールドを通るので、成功パスで path 文字列を組み立てると
 * 行数×フィールド数の連結になる（#280）。path は失敗が外側の arr/map/obj を抜けるときに
 * 1 segment ずつ積み、文字列化と Error Value の組み立ては 1 箇所（`Behavior::raiseConform`）だけ。
 */

declare(strict_types=1);

namespace LiteDbModel\Runtime\BehaviorContracts;

final class ConformPending extends \RuntimeException
{
    /** 外側から積まれる path segment（内側→外側の順で入る）。 @var array<int,string> */
    public array $segs = [];

    /**
     * @param string|null $what     message が綴る期待型（'string' / 'arr' / 'obj' …）。$prop 有りでは未使用。
     * @param mixed       $expected detail.expectedType の元 PortableType。
     * @param mixed       $actual   detail.actualWireType / rawValue の元値。
     * @param string|null $prop     MISSING_PROP の欠落プロパティ名（TYPE_MISMATCH では null）。
     */
    public function __construct(
        public readonly ?string $what,
        public readonly mixed $expected,
        public readonly mixed $actual,
        public readonly ?string $prop,
    ) {
        parent::__construct($prop ?? ($what ?? ''));
    }
}
