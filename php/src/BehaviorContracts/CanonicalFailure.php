<?php

/**
 * !!! VENDORED — DO NOT EDIT !!!
 *
 * Mechanically vendored from behavior-contracts/php/src/CanonicalFailure.php by
 * scripts/vendor-behavior-contracts-php.mjs (litedbmodel#33). The SSoT is the
 * behavior-contracts repo; edit there and re-run the vendoring script. A CI drift
 * gate (npm run vendor:bc-php:check) fails if this copy diverges.
 */

/**
 * CanonicalFailure.php — canonical 直列化の Failure（PHP port）。
 *
 * TS `CanonicalFailure` / Python `CanonicalFailure` と同一の `code` セットを持つ
 * （canonical-serialization.md §4）:
 *   NAN_OR_INF / INVALID_VALUE / FORBIDDEN_KEY
 */

declare(strict_types=1);

namespace LiteDbModel\Runtime\BehaviorContracts;

final class CanonicalFailure extends \RuntimeException
{
    /**
     * CanonicalFailure コード。`\Exception::$code`（親の int プロパティ）と衝突するため
     * 専用プロパティに保持する（TS/Python の `.code` に相当）。
     *
     * @var string
     */
    public string $failureCode;

    public function __construct(string $code, string $message)
    {
        parent::__construct($message);
        $this->failureCode = $code;
    }

    /** @return never */
    public static function raise(string $code, string $message): never
    {
        throw new self($code, $message);
    }
}
