<?php

/**
 * !!! VENDORED — DO NOT EDIT !!!
 *
 * Mechanically vendored from behavior-contracts/php/src/ProvenanceError.php by
 * scripts/vendor-behavior-contracts-php.mjs (litedbmodel#33). The SSoT is the
 * behavior-contracts repo; edit there and re-run the vendoring script. A CI drift
 * gate (npm run vendor:bc-php:check) fails if this copy diverges.
 */

/**
 * ProvenanceError.php — 出自ゲートの Failure（PHP port of TS `ProvenanceError`）。
 *
 * un-tokened / hand-built / tampered な IR の loud reject。コードは 5 言語共通の `NON_COMPILED_IR`。
 */

declare(strict_types=1);

namespace LiteDbModel\Runtime\BehaviorContracts;

final class ProvenanceError extends \RuntimeException
{
    /** 5 言語共通の失敗コード。 */
    public const CODE = 'NON_COMPILED_IR';

    /** @return never */
    public static function raise(string $message): never
    {
        throw new self($message);
    }
}
