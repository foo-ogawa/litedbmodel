<?php

/**
 * !!! VENDORED — DO NOT EDIT !!!
 *
 * Mechanically vendored from behavior-contracts/php/src/Canonical.php by
 * scripts/vendor-behavior-contracts-php.mjs (litedbmodel#33). The SSoT is the
 * behavior-contracts repo; edit there and re-run the vendoring script. A CI drift
 * gate (npm run vendor:bc-php:check) fails if this copy diverges.
 */

/**
 * Canonical.php — canonical-serialization.md の参照実装（doc-grade, COMMON, PHP port）。
 *
 * TS 参照実装 `ts/src/canonical.ts` / Python port の意味論を **完全一致** で移植。
 *
 * 提供する 3 プリミティブ:
 *   - pyFloatRepr(n)      : CPython repr(float) 相当の正準10進（parity SSoT = Python）
 *   - canonicalValue(v)   : key identity（トップレベルのみキーソート）  — §2 serializeContractKey
 *   - canonicalJson(v)    : fingerprint（全階層キーソート）             — §3 canonicalJson
 *
 * 値モデルは ExprEval / Codec と同じ: object は stdClass、list は PHP array、int は PHP int、
 * float は PHP float（int と float を型で区別する。§4.3）。
 *
 * 注（Fingerprint.php との分離）: `Fingerprint` は fingerprint 用途に閉じた内部 canonicalJson /
 * pyFloatRepr を持つ（非有限 float を `INVALID_VALUE` で拒否する）。canonical COMMON suite は
 * 非有限 float を **NAN_OR_INF** で拒否する（TS/Python と一致）ため、code セットが異なる。
 * したがって本 `Canonical` は独立実装として置き、`CanonicalFailure` を送出する。
 */

declare(strict_types=1);

namespace LiteDbModel\Runtime\BehaviorContracts;

final class Canonical
{
    private const FORBIDDEN_KEY = FORBIDDEN_OBJECT_KEY;

    // ── §4.1 float の正準10進（CPython repr(float)）────────────────────────────────

    /**
     * pyFloatRepr — CPython の repr(float) / json.dumps(float) と byte 一致する 10 進表現。
     *
     * 規則（canonical-serialization.md §4.1 / CPython format_float_short('r')）:
     *   1. 最短往復 digits。
     *   2. scientific 判定: decpt <= -4 || decpt > 16。
     *   3. 指数は符号つき・最低 2 桁 zero-pad（e+05 / e-07）。
     *   4. 整数値 float は `.0` を保つ（123 → "123.0"）。
     *   5. -0.0 は "-0.0"、+0.0 は "0.0"。
     *   6. NaN / ±Inf は Failure（NAN_OR_INF）。
     */
    public static function pyFloatRepr(float $n): string
    {
        if (is_nan($n) || is_infinite($n)) {
            CanonicalFailure::raise('NAN_OR_INF', "non-finite float cannot be serialized: {$n}");
        }
        if ($n === 0.0) {
            return self::isNegativeZero($n) ? '-0.0' : '0.0';
        }

        [$neg, $digits, $decpt] = self::shortestDigits($n);
        $len = strlen($digits);

        if ($decpt <= -4 || $decpt > 16) {
            $mant = $digits[0];
            if ($len > 1) {
                $mant .= '.' . substr($digits, 1);
            }
            $e = $decpt - 1;
            $esign = $e < 0 ? '-' : '+';
            $eabs = (string) abs($e);
            if (strlen($eabs) < 2) {
                $eabs = '0' . $eabs;
            }
            $out = $mant . 'e' . $esign . $eabs;
        } elseif ($decpt <= 0) {
            $out = '0.' . str_repeat('0', -$decpt) . $digits;
        } elseif ($decpt >= $len) {
            $out = $digits . str_repeat('0', $decpt - $len) . '.0';
        } else {
            $out = substr($digits, 0, $decpt) . '.' . substr($digits, $decpt);
        }

        return $neg ? '-' . $out : $out;
    }

    private static function isNegativeZero(float $f): bool
    {
        return $f === 0.0 && fdiv(1.0, $f) === -INF;
    }

    /**
     * shortestDigits — 正の/負の有限 float から最短 round-trip digits と decpt を返す。
     * 値 = 0.<digits> × 10^decpt。
     *
     * @return array{0: bool, 1: string, 2: int} [neg, digits, decpt]
     */
    private static function shortestDigits(float $f): array
    {
        $chosen = '';
        for ($p = 0; $p <= 17; $p++) {
            $s = sprintf('%.' . $p . 'e', $f);
            if ((float) $s === $f) {
                $chosen = $s;
                break;
            }
        }
        if ($chosen === '') {
            $chosen = sprintf('%.17e', $f);
        }

        $s = $chosen;
        $neg = false;
        if ($s[0] === '-') {
            $neg = true;
            $s = substr($s, 1);
        }
        $mantissa = $s;
        $expPart = '0';
        $ePos = stripos($s, 'e');
        if ($ePos !== false) {
            $mantissa = substr($s, 0, $ePos);
            $expPart = substr($s, $ePos + 1);
        }
        $exp = (int) $expPart;

        $intPart = $mantissa;
        $fracPart = '';
        $dotPos = strpos($mantissa, '.');
        if ($dotPos !== false) {
            $intPart = substr($mantissa, 0, $dotPos);
            $fracPart = substr($mantissa, $dotPos + 1);
        }
        $digits = $intPart . $fracPart;
        $decpt = strlen($intPart) + $exp;

        $trimmedLeft = ltrim($digits, '0');
        if ($trimmedLeft === '') {
            return [$neg, '0', 1];
        }
        $decpt -= strlen($digits) - strlen($trimmedLeft);
        $digits = $trimmedLeft;

        $digits = rtrim($digits, '0');
        if ($digits === '') {
            $digits = '0';
        }
        return [$neg, $digits, $decpt];
    }

    // ── §2 canonicalValue（serializeContractKey）— トップレベルのみキーソート ──────────

    /**
     * canonicalValue — key identity 用の正準直列化。
     * トップレベル object のキーのみ code-point 昇順ソートし compact JSON を返す。
     * ネスト値は挿入順のまま（§2 注: ネスト key identity は canonicalJson を使う）。
     *
     * @param mixed $v
     */
    public static function canonicalValue(mixed $v): string
    {
        if ($v instanceof \stdClass) {
            $props = get_object_vars($v);
            self::guardKeys(array_keys($props));
            $keys = array_map(static fn ($k): string => (string) $k, array_keys($props));
            usort($keys, static fn (string $a, string $b): int => ExprEval::cmpCodePoints($a, $b));
            $parts = [];
            foreach ($keys as $k) {
                $parts[] = self::jsonString($k) . ':' . self::encodeNested($props[$k]);
            }
            return '{' . implode(',', $parts) . '}';
        }
        return self::encodeNested($v);
    }

    // ── §3 canonicalJson — 全階層キーソート ────────────────────────────────────────

    /**
     * canonicalJson — fingerprint 用。全 object 階層のキーを code-point 昇順ソート
     * （配列は順序保持）。
     *
     * @param mixed $v
     */
    public static function canonicalJson(mixed $v): string
    {
        if ($v instanceof \stdClass) {
            $props = get_object_vars($v);
            self::guardKeys(array_keys($props));
            $keys = array_map(static fn ($k): string => (string) $k, array_keys($props));
            usort($keys, static fn (string $a, string $b): int => ExprEval::cmpCodePoints($a, $b));
            $parts = [];
            foreach ($keys as $k) {
                $parts[] = self::jsonString($k) . ':' . self::canonicalJson($props[$k]);
            }
            return '{' . implode(',', $parts) . '}';
        }
        if (is_array($v)) {
            $parts = [];
            foreach ($v as $e) {
                $parts[] = self::canonicalJson($e);
            }
            return '[' . implode(',', $parts) . ']';
        }
        return self::scalarJson($v);
    }

    // ── 内部: ネスト値の直列化（canonicalValue 用。ネスト object は挿入順）──────────────

    /** @param mixed $v */
    private static function encodeNested(mixed $v): string
    {
        if ($v instanceof \stdClass) {
            $props = get_object_vars($v);
            self::guardKeys(array_keys($props));
            $parts = [];
            foreach ($props as $k => $field) {
                $parts[] = self::jsonString((string) $k) . ':' . self::encodeNested($field);
            }
            return '{' . implode(',', $parts) . '}';
        }
        if (is_array($v)) {
            $parts = [];
            foreach ($v as $e) {
                $parts[] = self::encodeNested($e);
            }
            return '[' . implode(',', $parts) . ']';
        }
        return self::scalarJson($v);
    }

    /**
     * scalarJson — スカラ（int/float/string/bool/null）の JSON 直列化。float は pyFloatRepr。
     *
     * @param mixed $v
     */
    private static function scalarJson(mixed $v): string
    {
        if ($v === null) {
            return 'null';
        }
        if (is_bool($v)) {
            return $v ? 'true' : 'false';
        }
        if (is_string($v)) {
            return self::jsonString($v);
        }
        if (is_int($v)) {
            return (string) $v; // int: 素の 10 進整数（値層 JSON number）
        }
        if (is_float($v)) {
            return self::pyFloatRepr($v); // float: CPython repr（§4.1）
        }
        CanonicalFailure::raise('INVALID_VALUE', 'cannot serialize value of type ' . get_debug_type($v));
    }

    /**
     * jsonString — ensure_ascii=false 意味論の JSON 文字列エンコード
     * （非 ASCII は UTF-8 素通し。json.dumps(ensure_ascii=False) / JSON.stringify と一致）。
     */
    private static function jsonString(string $s): string
    {
        $out = '"';
        $len = strlen($s);
        for ($i = 0; $i < $len; $i++) {
            $c = $s[$i];
            $b = ord($c);
            if ($c === '"') {
                $out .= '\\"';
            } elseif ($c === '\\') {
                $out .= '\\\\';
            } elseif ($c === "\n") {
                $out .= '\\n';
            } elseif ($c === "\r") {
                $out .= '\\r';
            } elseif ($c === "\t") {
                $out .= '\\t';
            } elseif ($b === 0x08) {
                $out .= '\\b';
            } elseif ($b === 0x0C) {
                $out .= '\\f';
            } elseif ($b < 0x20) {
                $out .= sprintf('\\u%04x', $b);
            } else {
                $out .= $c; // UTF-8 継続バイト含め素通し
            }
        }
        return $out . '"';
    }

    /**
     * guardKeys — obj 値の own key に `"__proto__"` があれば fail-closed（FORBIDDEN_KEY）。
     * canonicalValue / canonicalJson / encodeNested の全経路で適用（expression-ir.md §2.3/§8）。
     *
     * @param array<int,int|string> $keys
     */
    private static function guardKeys(array $keys): void
    {
        foreach ($keys as $k) {
            if ((string) $k === self::FORBIDDEN_KEY) {
                CanonicalFailure::raise(
                    'FORBIDDEN_KEY',
                    'object key "' . self::FORBIDDEN_KEY . '" is forbidden (fail-closed)'
                );
            }
        }
    }
}
