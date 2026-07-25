# litedbmodel — 確定アーキテクチャ（決着済み・蒸し返し禁止）

この節はオーナーが**複数セッションにわたり繰り返し明示**した確定事項。再検討・再質問・再エスカレーションは禁止。
「コンテキストを忘れて勝手に設計を変える」ことが最大の禁止事項。迷ったらここを読む。原文引用付き。

## 1. 全体の流れ

```
ORMユーザ  : ライブラリのデコレータでモデル＋宣言エンドポイントを書くだけ（SQLは書かない）
   ↓ litedbmodel が lowering: デコレータ/メタ → SCP制限TS
     （@behavior static メソッド、本体は @leaf static 呼び出し、方言SQLは makesql で焼き込み済み）
   ↓ bc generate --from がそのTSを読む → IR → go/rust/py/php/ts ネイティブ
     リーフへの配線は BC が自動生成する
```

> 「ライブラリ側が言語別リーフノードを実装／ライブラリがloweringしてリーフノードへ変換／**ライブラリコンシューマはライブラリのデコレータを指定するだけ**」

> 「**リーフはconsumerが提供する単一の関数。BCの自動コンパイルでそこに接続するネイティブコードを自動生成・配線する。これ最初から言ってること**」

> 「**bcにcodegenは委ねる、リーフノードのところだけ正しく繋がるようにする。やることはこれだけ**」

## 2. SKIP（動的WHERE）= native/leaf 側で展開 ★最頻出の蒸し返し論点

> 「**SKIPは、SQLと params、SKIPフラグを受け取ってnative側で展開でしょ**。何言っんの？前、そう言う話をしていたが」

> 「**中途はんぱなIRの語彙作るな。SQL文字＋パラメータ＋SKIP（スキップ時は省略）**。あとは、パラメータで、上記のセットを入れればよいでしょ？この断片の組み合わせだけだよ」

> 「フラグメントが必要なのって**SKIPだけ**でしょ？他になんか有る？」

> 「これは**SKIP解決後に実施する必要があるので、runtime側での実装**だろうが。前もそうだったと思うが」

> 「`?`→`$N` は生成段で解決…これは**SKIPなどで部分SQLを展開しきれなかった場合**とか大丈夫でしょうか？**runtime側で最終のSQL確定後に変換**する必要があるように思えます」

> IN リスト / multi-VALUES の件数展開 → 「**これはドライバー側で展開して。いずれにしろ文字列だけだろ**」

**確定仕様**

1. 断片の語彙は **SQLテキスト + params + SKIPフラグ（skip時は省略）だけ**。中間IR語彙を作るな。
2. **最終結合は leaf / native / runtime 側**（実行時）。emitter は断片を渡すだけ。
   **v1命令パスに逃がすな。bcにエスカレーションするな。**「動的だから無理」ではない。
3. **`?`→`$N` のプレースホルダ変換は「最終SQL確定後」＝ runtime 側**。SKIP で形が変わるため生成段では確定できない。
4. IN リスト・multi-VALUES の件数展開も **ドライバー側**。

**実装参照**（移行前に存在。0.11.2 移行で一度落ちた）: `git show 3e80592:src/scp/leaves.ts`
`DynamicWhereFrag`(:128) / `assembleDynamicWhere`(:140, 約10行) / `whereDynamic` optional ポート(:252)。
境界のある述語は emit 時に静的SQLへ lower（native-clean）。**実際に optional な述語だけ** plan を積む。経路は1本。

## 3. 責務境界（言語別に何を書いてよいか）

> 「**言語別の手配線は、ベンチハーネスからcodegenしたネイティブメソッドを呼び出す部分のみ。それ以外は、なんらかの不正な実装**」

> 「**ベンチハーネスとは、ベンチロジックを含まない、ただの計測・呼び出し用のコードのみ**」

> 「リーフノードのハンドラを手書きする分には問題ない。問題なのは、**本来BCでコンパイル・ファイル生成すべき部分まで手書きで捏造すること**」

- **方言は TS の authoring で一度だけ解決**され、方言別生成物として各言語へ降りる。
  **言語側に方言分岐を書くな。** 各言語ランタイムは pg/mysql 接続を既に保有:
  rust `livedb.rs` / go `livedb.go`+`pool_factory.go` / python `driver.py` / php `LiveDb.php`。
- リーフ（言語別ネイティブ実装）は**言語ごとに1度だけ**手書き。これは sanctioned。
- 「go に pq を、php に pgsql を」と言語ごとに配線を書き足すのは**直交分解の破壊＝不正**。

### 3.1 生成物の呼び方（bc typed-native）— 迷ったら bc の docs と完動サンプルを読め

**bc の生成エントリは authored メソッドの 1:1 写像。宣言クラスが名前空間、authored 引数がその順の位置引数。
transport / wire の配線は `--leaf-transport-import` / `--shared-types-import` で generate 時に焼き込まれ、
呼び出し側にランタイム注入は無い。ハーネスは「シグネチャで直呼びするだけ」。**

```go
rows, err := userrepo.FindByEmail("a@b.c")   // go
```
```rust
let rows = findByEmail("a@b.c".to_string())?; // rust
```

一次ソース: `behavior-contracts/README.md` §「3. Call the generated entry point」。
**完動サンプル `behavior-contracts/examples/using-a-bc-library/`**（1モデルを TS 直実行 + go/rust の
`bc generate` 実行で同じ行を出す）。go/rust の呼び方に迷ったら**まずこれを読む**。

- **typed-native に「名前引きエントリ（`bind` 相当）」を要求するな。** ランタイム辞書 lookup を生成物に
  持ち込むことになり、「codegen 出力は静的に端まで追える直呼びのみ」に反する。`bind(handlers)` を出すのは
  literal エミッタ（`typescript` / `python` / `php`）だけで、それは interpreter レグの実行モデルだから。
  go / rust に literal エミッタは無い（登録エミッタ7種）。
- **conformance / bench の runner は「ハーネス」。生成メソッドをシグネチャ直呼びする `switch` は §3 が
  認めている形**（`go/lm_bench/lm_orm_native/main.go` の `op()` が既にその形）。
  これを「per-endpoint の手書き＝不正コード」と誤判定して bc に機能要求を投げた事故がある
  （2026-07-26・#163／bc#223 は取り下げ）。**docs を読まずに「bc に機能が無い」と結論するな。**

## 4. 静的 / 動的の切り分け

- **静的な宣言エンドポイント → codegen**
- **実行時にしか形が決まらない真のアドホッククエリ**（`find({where:{age:{gt:x}}})`）→ **v1 命令パス**
- ただし **SKIP は「動的だから v1」ではない**（§2 のとおり leaf 側展開で codegen 経路に載る）

## 5. litedbmodel が提供するもの（これだけ）

1. **デコレータ** — メタ収集のみ。SCP も IR も作らない。
2. **`@leaf static` 転送宣言** — `src/scp/leaf-transport.ts` の `Db`（`executeSQL` / `pluck` / `group`）。
   **リポジトリ内で唯一のリーフカタログ**。bench の `native-model.ts` もこれを import する（再宣言禁止）。
3. **lowering**（デコレータ → SCP制限TS）＋ **makesql**（方言SQL生成・v1 byte-parity、約4700行）
4. **各言語ランタイム**（driver / exec-context / grouping / de-box）

## 6. ベンチは本体に従属する（仕様を捻じ曲げるな）

- **ベンチは litedbmodel の consumer**。ライブラリ本体の仕様は **ORM としての要件**（デコレータ → lowering → codegen）で決まる。
- **ベンチの都合で本体の仕様を捻じ曲げるな。** ベンチが困るなら**ベンチを合わせる**。逆をやらない。
- `benchmark/crosslang/native-model.ts` は**ベンチ用に手書きした @behavior**であって、**本体の正典ではない**。
  エミッタ（#152）の設計を native-model.ts の形から逆算するな。本体は「デコレータ付きモデル → SCP制限TS」を
  ORM の要件から設計し、ベンチはその出力を**呼ぶだけ**の側に回る。
- 本体が固まる前にベンチを触らない（authoring・生成物・リーフの形が変わるたびに作り直しになる）。
- ベンチは言語別ハーネスを持つのが当然（consumer なので）。本体の内部規律をベンチにそのまま当てはめるな。

## 7. 作業の進め方（必須）

- **1タスク = 1 issue = 1 コミット = 即クローズ。** 実装してコミットが入ったら、その issue を**その場で**クローズする。
  最後にまとめて巨大コミット、完了済みなのに issue が開いたまま、は禁止。
- コミットメッセージに issue 番号を入れる。
- クローズ時のコメントには**実証拠**（コマンド出力・生成SQL・テスト結果）を貼る。主張だけを書かない。
- ブロックされた／確定アーキの中で実現不能と判明した場合は、**その issue に**最小再現と実エラーを書く。
  黙って別タスクに畳み込まない。確定済みの設計論点を再検討しない（§1-§5）。

## 7. 禁止事項

- **IRを直接組み立てない**（宣言は必ず BC 経由）。post-compile の IR 手術も禁止。
- 生成すべきものを手書きで捏造しない。
- 同種処理を二箇所に書かない（SSoT）。既存1本を直す。隣に経路/分岐/フォールバックを足さない。
- 行数チェックだけで正しさを主張しない（relation が空構造体を返すバグを全テストがすり抜けた前例あり — #150）。
