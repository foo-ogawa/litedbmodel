<?php

/**
 * !!! VENDORED — DO NOT EDIT !!!
 *
 * Mechanically vendored from behavior-contracts/php/src/CompiledIr.php by
 * scripts/vendor-behavior-contracts-php.mjs (litedbmodel#33). The SSoT is the
 * behavior-contracts repo; edit there and re-run the vendoring script. A CI drift
 * gate (npm run vendor:bc-php:check) fails if this copy diverges.
 */

/**
 * CompiledIr.php — IR の出自（provenance）ゲート（PHP port of `ts/src/provenance.ts`）。
 *
 * scp-only-authoring-contract.md §5 の token 方式。**このクラスだけ**が「compile 済み IR」の handle を
 * 作れる（コンストラクタは private ＝ 言語が forge を塞ぐ）。TS 側の保証（assertCompiled / token /
 * fingerprint 必須の loadCompiledIR）と**同じ形**を PHP ランタイムにも持たせる（#208）。
 *
 * ## PHP に compile seam は無い
 *
 * SCP→IR の compile seam は TypeScript 専用（AST リーダー）。PHP 実行時に IR が入ってくる経路は
 * **シリアライズ境界だけ**なので、consumer 向けの mint 点は 1 つ:
 *
 *   - {@see CompiledIr::load} — 生成モジュールが焼いた canonical fingerprint を**必須**で受け取り、
 *     ロード時に 1 回だけ再計算・照合してから handle を発行する（per-call skew は禁止）。手組みの
 *     stdClass は正規の fingerprint を持たないので handle を得られない: 公開の
 *     {@see CompiledIr::fingerprintComponentGraph} は handle を要求する（＝ token を持たない doc から
 *     fingerprint を取り出せない）ため、「fingerprint 必須」がそのまま「compile 済みでない IR は
 *     実行できない」になる。
 *
 *   - {@see CompiledIr::adopt} — **package 内部専用**の seam（焼き込み fingerprint を持たない
 *     package 内の入力 ＝ conformance ベクタ / 自前テストの手組み可搬 IR だけが使う）。
 *
 * handle は doc を**包む**だけで doc 自体を変更しない（fingerprint / canonical / json_encode は
 * 包まれた doc を見るので、goldens も fingerprint も byte-for-byte 不変）。
 */

declare(strict_types=1);

namespace LiteDbModel\Runtime\BehaviorContracts;

final class CompiledIr
{
    /** private ＝ handle を作れるのはこのクラスの mint 経路だけ（forge 不能の核）。 */
    private function __construct(public readonly \stdClass $doc)
    {
    }

    /**
     * assertCompiled — 出自ゲート: `$ir` が境界 loader / adopt seam を通った handle であることを
     * O(1) で照合する。手組み / 無 token / 改竄 IR は NON_COMPILED_IR で loud reject。
     *
     * @throws ProvenanceError
     */
    public static function assertCompiled(mixed $ir): self
    {
        if (!($ir instanceof self)) {
            ProvenanceError::raise(
                'IR was not produced by the compile seam or a fingerprint-gated loader: missing provenance token — '
                . 'hand-built, un-tokened, or tampered IR is rejected (NON_COMPILED_IR, fail-closed). Load serialized '
                . 'IR through CompiledIr::load($doc, IR_FINGERPRINT) — the generated module exports that constant.'
            );
        }
        return $ir;
    }

    /**
     * load — シリアライズ境界の fingerprint-gated loader。
     *
     * `$expectedFingerprint` は**必須**（省略を許すと「再計算するだけで handle を発行する」経路になり、
     * 手組みの stdClass が正規 handle を得てしまう）。正規の fingerprint は生成モジュールが焼いた定数
     * （`IR_FINGERPRINT`）からしか得られない。
     *
     * @throws ProvenanceError 形不正 / fingerprint 不一致（改竄・stale）。
     */
    public static function load(mixed $doc, string $expectedFingerprint): self
    {
        if ($expectedFingerprint === '') {
            ProvenanceError::raise(
                'CompiledIr::load: the expected fingerprint is required — pass the fingerprint the generated module '
                . 'baked in (its IR_FINGERPRINT constant). Without it the loader would mint a provenance token for any '
                . 'hand-built object, which is exactly what NON_COMPILED_IR exists to prevent (fail-closed).'
            );
        }
        if ($doc instanceof self) {
            return $doc;
        }
        self::assertIrDocShape($doc, 'CompiledIr::load');
        // ロード時 1 回だけ再計算（per-call skew は禁止）。mint は照合を通った**後**。
        $actual = Fingerprint::componentGraph($doc);
        if ($actual !== $expectedFingerprint) {
            ProvenanceError::raise(
                "CompiledIr::load: fingerprint mismatch (expected {$expectedFingerprint}, recomputed {$actual}) — "
                . 'serialized IR is stale or tampered (NON_COMPILED_IR, fail-closed)'
            );
        }
        return new self($doc);
    }

    /**
     * adopt — **package 内部専用**の adopt seam。{@see CompiledIr::load} と受理条件は同じで、違いは
     * 「照合すべき焼き込み fingerprint を持つか」だけ。持たないのは package の内側の入力に限る
     * （conformance ベクタ / 自前テストの手組み可搬 IR）。
     *
     * @throws ProvenanceError
     */
    public static function adopt(mixed $doc, string $where = 'CompiledIr::adopt'): self
    {
        if ($doc instanceof self) {
            return $doc;
        }
        self::assertIrDocShape($doc, $where);
        return new self($doc);
    }

    /**
     * fingerprintComponentGraph — canonical fingerprint（出自ゲート付きの公開版）。compile 済み handle
     * にだけ fingerprint を計算する。これが「正規 fingerprint は生成物からしか得られない」を成立させ、
     * loader の fingerprint 必須と噛み合って手組み IR の実行を塞ぐ。
     *
     * @throws ProvenanceError
     */
    public static function fingerprintComponentGraph(mixed $ir): string
    {
        return Fingerprint::componentGraph(self::assertCompiled($ir)->doc);
    }

    /** 可搬 IR ドキュメントの受理条件（形 + irVersion）。**両 mint 経路が読む唯一の定義**。 */
    private static function assertIrDocShape(mixed $doc, string $where): void
    {
        if (!($doc instanceof \stdClass)) {
            ProvenanceError::raise("{$where}: input must be a portable component-graph IR document (fail-closed)");
        }
        $irVersion = get_object_vars($doc)['irVersion'] ?? null;
        if ($irVersion !== 2 && $irVersion !== 3) {
            ProvenanceError::raise("{$where}: irVersion must be 2 or 3 (v3 adds optional nominal type names) (fail-closed)");
        }
    }
}
