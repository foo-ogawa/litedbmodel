# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [2.2.6] - 2026-08-06

**依存の脆弱性を塞ぐ。出荷コードの変更は無い。**

### Fixed

- **`overrides` の完全固定ピンが `npm audit remediate` を恒久的に赤にしていた（#269）** — ピンは
  「安全な最低バージョン」の意図で入れられたが、キャレットが無いため天井として働き、
  `brace-expansion@5.0.8` に GHSA-rgw5-rvv9-x895 (high) が出た時点で修正版 5.0.9 へ上げられなくなった。
  workflow は `package.json` の変更を拒否する設計なので、この形のピンがある限り自力で緑にできない。
  キャレット範囲へ戻し、`brace-expansion` の床は脆弱版 5.0.8 ではなく修正版 5.0.9 にした。
  再現バージョンの固定は lockfile が担う。
- **`benchmark/package-lock.json` に high 8 / moderate 2 が残っていた（#273）** — `conformance.yml` は
  `benchmark` で `npm ci` を実行するが `npm audit` を走らせるステップが無く、両 audit ゲートは
  リポジトリ直下の lockfile しか読まない。**インストールはするが監査はしない**状態だった。
  `drizzle-orm` を 0.45.2、`kysely` を 0.29.4 へ上げて解消（どちらも修正版が宣言レンジの外にあり
  lockfile だけでは届かない）。ベンチ実測値は再計測していないので `benchmark-results.csv` は据え置き。

## [2.2.5] - 2026-08-01

**Go モジュールが v2 系で初めて `go get` 可能になる。** Closes #265。

### Fixed

- **[go] モジュールパスが `/v2` で終わっておらず、v2 のタグを1つも解決できなかった（#265）** — Go は
  major 2 以上でモジュールパスが `/vN` で終わることを要求する。`go/go.mod` は
  `github.com/foo-ogawa/litedbmodel/go` を宣言したままタグだけ v2 だったため、proxy は
  `invalid version: module contains a go.mod file, so module path must match major version` を返し、
  **v2.0.0 / v2.2.0 / v2.2.3 / v2.2.4 のすべてが 404**、`@v/list` も空だった。
  5リリース連続で、誰も取得できない Go ターゲットを宣伝していたことになる。

### Changed

- **[breaking][go] import パスが `github.com/foo-ogawa/litedbmodel/go/v2` になる。**
  実害は無い — 旧パスは v2 のどのバージョンでも解決できなかったので、壊れる利用者が存在しない。
- モジュールパスを生成器が `go/go.mod` から読むようになった（`benchmark/crosslang/gen-native.sh` /
  `conformance/gen-livedb.ts`）。同じ値が3箇所にリテラルで書かれていたのが食い違いの原因だったので、
  次のメジャー更新は1行で済む。

### Added

- **`release.yml` がタグを push したあと proxy.golang.org に解決可否を問い合わせ、解決できなければ
  リリースを落とす。** これが無かったことが5回見逃した理由 — Go だけアップロード step が無いので
  **赤を出す場所が存在せず**、CI の go テストはリポジトリ内で動くのでモジュールパスを解決しない。
- `npm run verify` が python/php の native suite が import する ORM-bench seed fixture を emit する
  （CI は専用 step で実行している・#185）。新規 worktree で環境未整備をテスト失敗として報告していた。

## [2.2.4] - 2026-08-01

ベンチ再計測（#232 / #233 / #234 / #172）の過程で露出した欠陥をまとめて修正。出荷物に影響する実バグ4件を含む。
公表ベンチ（`benchmark/CROSS-LANG.md` / `docs/`）は全3方言・5言語で再計測した値に更新。
Closes #138, #249, #252, #254, #255, #256, #257, #258, #259, #260, #261, #262, #264。

### Fixed

- **[go] grouping キーが 2^63 の float と `MaxInt64` を同一バケットに入れる（#262）** — 整数値 float を
  整数キーへ畳む判定を `f == float64(int64(f))` の round-trip で書いており、`int64(f)` の範囲外変換が
  Go では実装定義。**arm64 は `MaxInt64` に飽和**し、`float64(MaxInt64)` が 2^63 に丸まるため一致してしまう
  （x86-64 は `MinInt64` になるので一致しない）。relation の子が 2^63 のキーで来ると `MaxInt64` の親にぶら下がっていた。
  rust / php と同じ明示的な範囲テストへ統一。**CI は x86-64 なので検出できず、2.2.3 まで出荷されていた。**
- **[php] native ランタイムに prepared statement キャッシュが無い（#257）** — 4 つの seam すべてが毎回
  `prepare()` を発行しており、PDO の `prepare` は PostgreSQL / MySQL で**サーバ往復1回**。`PdoDriver` が所有する
  単一の `PreparedStatements` に集約（`beginTx()` は tx ごとに新ハンドルを返すので tx 側に置くと機能しない）。
  `LiveDb.php` の mysql RETURNING 再 SELECT も statement ごとに1回だけ prepare するように。
  native÷sdk 比が **PostgreSQL 17/19 op・MySQL 17/19 op** で改善（pg `updateMany` 10.98× → 1.25×）。
- **[php] `SplObjectStorage::contains()` / `attach()` が PHP 8.5 で deprecated（#260）** — PHP 9 でエラー化する。
  `offsetExists()` / `offsetSet()`（同一操作の別名）へ。
- **[tooling] `devEngines` がリポジトリ全体を起動不能にしていた（#253）** — npm は `devEngines` を
  install だけでなく `npm run` / `npx` にも適用するため、拒否範囲に入れた npm 11.6.2（このリポジトリが要求する
  Node 24.13 の同梱版）ではすべてのゲートが起動しなかった。判定は既存の `deps:installed` 1 本へ戻した。
- **[ci] `docs-drift` が構造的に充足不能（#264）** — typedoc の source link が git remote と HEAD SHA に依存し、
  ローカル（SSH ホストエイリアス）と CI（`https://`）で必ず異なり、かつ CI 出力は SHA を埋め込むので次のコミットで
  陳腐化していた。`sourceLinkTemplate` と `gitRevision` を pin。
- **[gate][rust] run gate が live-DB でない integration テストを live と誤分類（#261）** — Rust では
  `tests/*.rs` が別ターゲットなのに live 判定をディレクトリ単位で行っていた。

### Removed

- **gate-first トランザクション解釈（#256）** — `GateRule` / `gateShortCircuit` / `ShortCircuitReason` /
  `TransactionResult.shortCircuit` / `TransactionPlan.onIdempotentHit` / `IdempotentHitPolicy`。
  5 言語のどこからも到達せず、「未知の gate は fail-closed」という安全側の主張が一度も実行されていなかった。
  `writeouttype` が全言語の write out 型へ注いでいた `shortCircuit` フィールドも除去。
  **公開型 `GateRule` / `IdempotentHitPolicy` / `ShortCircuitReason` の re-export がなくなる**が、
  これらを生成できる経路は存在しなかった。

### Changed

- **[perf][rust] SQLite seam が prepared statement を再利用（#138）** — 容量 128。sqlite の中央値で
  `findUnique` −67% / `upsert` −55% / `update` −50% / `nestedFindUnique` −47% / `delete` −47%。
  `findFirst`（唯一の `LIKE ?` op）だけ 2µs 遅くなる — SQLite の LIKE 最適化がバインド値依存の plan を持つため。
  実測表と機構は `SQLITE_STATEMENT_CACHE_CAPACITY` の docstring に記載。
- **[perf][rust] relation の親行を move（#138）** — 各レベルで行もセルも複製しない。
- 内部述語 `isBatchPlan` を 1 箇所へ統合（#259）。

### Added

- **`npm run verify`** — CI がゲートする 27 ステップを 1 コマンドで実行。一覧が CI の呼ぶ npm script を
  網羅していることを集合差で自己検査し、非 arm64 ツールチェーンを拒否する（CI は x86-64、これが arm64 側。
  #262 はその分担が必要である実証）。
- `run-cells.sh` が pinned node のネイティブモジュール load 可否を検査（#252）。
- ORM-bench セルの `LM_CPUPROFILE` / `LM_ONLY_OP`（go / rust）。

## [2.2.2] - 2026-07-29

typed-native（go/rust）が **SKIP 動的 WHERE** と **relation runaway cap** を codegen できるようになり、
cross-language livedb conformance が **4 言語（py/php/go/rust）** に復帰。`behavior-contracts` を **0.11.18**
（typed-native opt-value lowering）へ。外向き ORM API・挙動は不変（TS consumer への影響なし）。Closes #163, #191。

### Changed

- **behavior-contracts 0.11.18**: typed-native が `opt<T>` port へ非 null / nullable 値を lower 可能に
  （`optSome` / `optMapWireBox`）。これにより SKIP / guard の制御ポートを **optional な具体 struct**
  （`whereDynamic?: DynamicWherePlan | null`, `guard?: CapGuard | null`）で go/rust typed-native codegen
  （§2: bounded read / write は port 省略＝native-clean、SKIP read だけ plan、guarded child だけ cap）。
  断片は §2 の `{skipped, sql, params}` 固定 struct（cond-to-null variant を廃止）。
- **ランタイム leaf（go/rust/py/php）**: `assembleDynamicWhere`（skipped 断片を落とし、WHERE を最初の
  tail keyword の前に splice、WHERE params を base params の前に bind）+ single optional guard。4 言語 byte-parity。

### Fixed

- **go/rust livedb conformance runner を復活**（#163 で削除放置されていた）。`conformance:livedb:docker` が
  実 PostgreSQL + MySQL で 4/4 green（各 52 ベクタ、#130 の RETURNING ベクタ含む）。
- **go PG TIMESTAMP**（#195）: 列スキャン SSoT `scanValue` に `time.Time` ケースが無く pgx の TIMESTAMP が
  Go 既定表記になっていたのを canonical `%Y-%m-%d %H:%M:%S`（rust と一致）に。go leg が未実行で見逃していた。

Follow-ups: #192（§2: 境界のある述語を静的 SQL へ焼く native-clean 精緻化）, #193（executeSQL 位置固定引数 →
options / mode 構造化 + dead `bigint` port 削除）。

## [2.2.0] - 2026-07-28

**初の安定版 v2。** 2.0.x / 2.1.0 の alpha 線を安定版へ昇格し、npm `latest` を v2 に切り替える
（v1.2.10 は published のまま `latest` から外れる）。5 言語 conformance + live-DB 検証は緑。

### Added

- **宣言主キー + RETURNING write**（#130）: モデルが主キーを宣言し、RETURNING write が書き込んだ行を
  取り戻す。MySQL でも RETURNING 相当を返す（RETURNING-strip + 協調 SELECT）。
- **バッチ write の RETURNING**（#166, #167）: バッチ write が RETURNING を宣言し、各 write は行を
  キー順に整列して返す。
- **per-transaction writer override**（#134）: `TransactionOptions` でトランザクション単位に
  writer-after-tx を上書き可能。

### Changed (BREAKING)

- **bc 0.11.16 追従**（`feat(bc)!` 0.11.9〜）: wire が数値をネイティブに運び、クローンしない。IR/wire の
  境界型が変わるため、旧生成物は再生成が必要。
- **複合キー述語 = IN-subquery**（`perf(scp)!` #174）: SQLite でも相関 EXISTS ではなく IN-subquery に統一。

### Fixed

- 遅延 relation 読みで整数が 2^53 を超えると暗黙に丸められていた（#173）。INTEGER 列は
  PostgreSQL / MySQL で bc の int モデル（BigInt）として読み戻す。
- relation キー同一性の 5 つの不整合（BigInt キーが throw する等）を修正。
- bc int（BigInt）write パラメータは raw ノードではなく bc の `{int:"…"}` リテラルで渡す。
- `closeAllPools()` が SCP 経路の開いたプールを閉じず、consumer プロセスが終了できなかった。
- codegen 経路で relation の hardLimit を強制（#160）。
- 複合キー relation バッチが PostgreSQL でも 1 個のキー・タプル param をバインドする（#159）。
- プール接続の SQL がロガーに届く（全 3 ドライバ）。

### Performance

- relation grouping を、言語が許す各セルでキー化（#138）。

## [2.0.0] - 2026-07-10

**BREAKING — v2.0 系リリース。** litedbmodel は「独自 ORM」から
**behavior-contracts の汎用 SCP レイヤを consume する SQL バックエンド consumer** へ再構成された
（graphddb=DynamoDB backend と対）。公開境界は CQRS（Query/Command）契約で、TS / Python / Rust /
Go / PHP の薄い runtime が **同一 IR から同一 SQL・同一結果**を出す（5 言語 conformance）。

v1.x はメンテナンスブランチ `v1.x` で保全（別トラック）。移行は下の "Migration: v1 → v2" を参照。

### Added

- **SCP IR レイヤ**（`litedbmodel/scp`）: Authoring Parse → 内部 IR → Backend Compile（IR→dialect
  SQL）→ 薄い Runtime。コンパイル経路は1本、実行モードが3つ（TS 直接 eager / SCP 宣言ブロックの
  事前コンパイル / 多言語 runtime での実行）。
- **全 CRUD × 全方言**: Select / Insert / Update / Delete × PostgreSQL / MySQL / SQLite。
- **write-time relations + tx DAG**: 複合 write（複数 base write / nested write）を 1 トランザクション
  へ導出。各 write は名前を持ち、後続 write は先行 write の RETURNING 行を `$.ref.<name>.<field>` で
  参照する。データ依存グラフ + gate-first 制約をトポロジカルソートし、byte-identical な SQL 列を生成。
  依存サイクル / 宙ぶらりんの `$.ref` / RETURNING 欠落は loud-reject（暗黙フォールバック無し）。
- **5 言語 runtime**: Python (`litedbmodel-runtime` / PyPI)、Rust (`litedbmodel_runtime` / crates.io)、
  Go (`github.com/foo-ogawa/litedbmodel/go`、VCS タグ `go/vX.Y.Z`)、PHP (`litedbmodel/runtime` /
  Packagist)。いずれも Expression-IR 評価を behavior-contracts へ委譲。
- **モノレポ統合**: `src/`(TS SSoT) + `python/ go/ php/ rust/` を同居。単一 `conformance/` +
  単一 CI + 単一 `sync-versions.mjs`（package.json = version SSoT）。
- **codegen**: bc 共有ジェネレータに SQL catalog を供給して各言語コードを生成。
- **live-DB conformance**: 実 PostgreSQL + MySQL に対する 4 言語 runtime の live-DB 検証。

### Changed (BREAKING)

- **結果オブジェクト: DBModel インスタンス → typed-object。** クエリ結果は own props が
  データのみの typed-object になった。インスタンスメソッドは持たない。ドメインメソッドが必要なら
  `hydrate: (raw) => new Domain(raw)` で回復する（破壊度: 中〜大）。
- **カラム順の正規化**: 生成 SQL のカラム列は決定的な**アルファベット順（canonical order）**に固定
  （多言語 byte 一致のため）。SQL テキストに依存したスナップショットは影響を受ける。
- **単一コンパイル経路**: 公開 API 呼び出しも SCP 宣言も同一の Authoring Parse → 内部 IR を通る
  （別解釈系を持たない）。実行時文字列組み立ての内部経路は IR 経由に置き換わった。
- **`sql` / dbDynamic / dbRaw**: 実行時文字列から Dynamic Slot 語彙（lower 可能サブセット）へ。
- **完全動的 Raw SQL**: `execute` / `query` は「契約付き Raw SQL」（方言別 SQL 同梱・IR 不透明）に隔離。

### Preserved (v1 parity)

- CRUD + condition タプル + SKIP はほぼ不変（内部が IR 経路になっただけ）。
- `await post.author`（lazy relation）は getter として残置（事前コンパイル relation op 起動）。
- Middleware / TypeCast は Runtime 関心事として存続。

### Migration: v1 → v2

詳細は仕様書 [`docs/architecture.md`](docs/architecture.md)
§12（TS 公開 API の v1 → v2 移行）を参照。要点:

1. **結果はインスタンスではない。** `row instanceof MyModel` は成立しない。`row.someMethod()` は
   `TypeError`。ドメインメソッドは `model({ ..., hydrate: (raw) => new MyDomain(raw) })` で復元し、
   `hydrate` した戻り値に対して呼ぶ。own props はデータのみなので `{ ...row }` / `JSON` は安全。
2. **カラム順に依存しない。** SQL 文字列の完全一致を検証しているテストは、v2 の canonical
   アルファベット順に合わせて再スナップショットする。
3. **動的 SQL の見直し。** ランタイム文字列を組み立てていた箇所は Dynamic Slot 語彙へ移す。lower
   できない完全動的 SQL は契約付き Raw SQL（`execute`/`query`、方言別 SQL 同梱）へ隔離する。
4. **多言語で使う場合**は publish された §8 bundle を各言語 runtime（PyPI/crates.io/Go/Packagist）
   から呼ぶ。同一 IR → 同一 SQL・同一結果（conformance で保証）。
5. **v1 のまま留まる場合**は `v1.x` メンテナンスブランチを使う（`litedbmodel@^1`）。

[2.0.0]: https://github.com/foo-ogawa/litedbmodel/releases/tag/v2.0.0
