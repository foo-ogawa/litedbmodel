# litedbmodel v2 アーキテクチャ仕様 — SCP / 多言語 CQRS

litedbmodel v2 は **behavior-contracts（bc）の汎用 SCP レイヤを consume する SQL バックエンド** である。
graphddb（DynamoDB バックエンド）と同型で、差分は **SQL 方言のコンパイルと実行の層だけ**。本書はその
確定アーキテクチャの正式仕様であり、記述はすべて `07679b2` 時点の実装に対して裏取りされている（節ごとに
`` `symbol` (`file`) `` の形でコードを引用する）。コードが SoT であり、本書が食い違ったらコードを正とする。

対象言語は **TypeScript + Rust + Python + Go + PHP の5言語 parity**。方言は **PostgreSQL / MySQL / SQLite**。

> **本書の節番号はコードから参照される。** `src/scp/**` の複数ファイルが `spec §1` / `spec §4.1` /
> `spec §5` / `spec §6` / `spec §8` / `spec §10` / `spec §11` / `spec §13` を doc-comment とエラーメッセージ
> で引用している（`` `scripts/check-spec-refs.mjs` `` がその整合を機械検証する — §10）。節を renumber しない。

---

## 0. 要約（TL;DR）

- litedbmodel v2 は **新しい DSL を作らない**。bc の Behavior / Component / Port / Wire + Expression IR +
  runtime-core を consume する **SQL バックエンド consumer** になる。
- **コンパイル経路は1本**（§9）。ORM ユーザはデコレータでモデルと **宣言エンドポイント**（SQL を書かない）
  を書き、`` `emitBehaviorModule` (`src/scp/emit/emitter.ts`) `` が **SCP 制限 TS**（`@behavior static`
  メソッドが唯一のリーフカタログ `Db` を呼ぶ形）へ lowering し、`bc generate --from` がそれを読んで
  go / rust / py / php / ts の native モジュールを生成する。リーフへの配線は bc が自動生成する。
- **実行時のサーフェスは3本の op 非依存リーフだけ**: `` `Db.executeSQL` / `Db.pluck` / `Db.group`
  (`src/scp/leaf-transport.ts`) ``。方言 SQL はこの3本が運ぶテキスト＋パラメータに閉じる。
- 形が実行時にしか決まらない **真のアドホッククエリ**（`find({ where })`）は静的 SQL を持たないので、
  codegen 経路ではなく **v1 命令パス**で走る（§9）。
- litedbmodel は **可搬 IR ドキュメントを emit しない**（§8）。方言は TS 側で一度だけ解決され、方言別の
  SQL が emit 時に SCP 制限 TS へ焼き込まれる。
- **多言語 conformance** は「方言 3 × 言語 5」の格子を **3 + 5** に分解する（§10）。
- v2.0 系は破壊的変更。v1.x はメンテブランチ `v1.x` で保全。

---

## 1. 位置づけ — litedbmodel は SCP の SQL バックエンド consumer

behavior-contracts は SCP を **汎用化**し、consumer が差し込む拡張点を確定させている。litedbmodel v2 は
graphddb と並ぶ SQL backend の consumer である。`` `src/scp/index.ts` `` の先頭が公開サーフェスを4点に
確定している（`litedbmodel supplies exactly four things and nothing else`）:

1. **リーフ転送宣言** — `Db`（`@leaf static executeSQL / pluck / group`）。`bc generate --from` が読む、
   リポジトリで唯一のリーフカタログ（`src/scp/leaf-transport.ts`）。
2. **リーフ転送実装** — `` `leafHandlers` / `leafHandlersAsync` (`src/scp/leaves.ts`) ``。bc 生成 TS
   モジュールの `bind(handlers)` / `bindAsync(handlers)` が consume する TS 実行シーム。
3. **チューニング済み SQL** — `src/scp/makesql` サブツリー（方言別 SELECT / INSERT / UPDATE / DELETE /
   relation / batch ビルダ、v1 ビルダと byte 一致）と、その上の write bundle / transaction plan。
4. **各言語ランタイム** — 実行コンテキスト（接続ルーティング・middleware・transaction）、relation grouping、
   列型 de-box の SoT、typed-object 読み出しサーフェス。

**配線は自動**。behavior は TS で宣言され bc がコンパイルし、言語別の手配線は「ハーネスが生成メソッドを
リーフハンドラ付きで呼ぶ」部分だけ。**ランタイム IR も、プログラム的コンパイルも、ランタイム behavior
ディスパッチも、このパッケージには存在しない**（`src/scp/index.ts`）。

**litedbmodel v2 が実装する拡張点（これ以外は bc から得る）:**

| 拡張点 | litedbmodel v2 での中身 |
|---|---|
| **Catalog leaf** | `makeSQL(sql, params, skip?)`（bc catalog leaf。`src/scp/makesql/makesql.ts`）と、codegen 経路の3本 op 非依存リーフ `Db`（§8/§11） |
| **Authoring** | デコレータ付きモデル + 宣言エンドポイント（`src/scp/emit/endpoint.ts`）→ SCP 制限 TS |
| **Backend Compile** | 宣言エンドポイント → 方言 SQL テキスト + `?` パラメータ（`src/scp/makesql`）。`?`→`$N` は runtime 最終1パス |
| **Handler** | catalog leaf → driver 実行 + 行→論理モデル assembly（`src/scp/makesql/handler.ts`） |
| **Error Mapping** | driver エラー → SCP Failure（`src/scp/errors.ts`） |

---

## 2. 利用モード（authoring サーフェス）

### 2.1 モデル定義（デコレータ）

`@model(table)` / `@column(...)` で物理対応を宣言する（v1 継承）。結果は **typed-object**（DBModel
インスタンスではない・§4 / §12）。列型は SQL 型を SoT とする（§4.1）。

```ts
@model('posts')
export class PostModel extends DBModel {
  @column({ primaryKey: true }) id!: number;
  @column() author_id!: number;
  @column() title!: string;

  @belongsTo(() => [Post.author_id, User.id]) declare author: User | null;
}
export const Post = PostModel.asModel();
```

### 2.2 宣言エンドポイント（抽象 API・SQL を書かない）

静的に形が決まるクエリは **宣言エンドポイント**として書く。エンドポイントの語彙は
`` `Endpoint` (`src/scp/emit/endpoint.ts`) `` が確定させており、**SQL を一切含まない**: 述語はモデルの
**列**と**パラメータ**を名指し、relation は `@hasMany`/`@belongsTo`/`@hasOne` プロパティを名指し、書込は
束ねる列を名指す。方言 SQL は emitter が `makesql` ビルダから生成し、パラメータ型はモデルの `@column`
メタから解決する（手書きしない）。

宣言できるエンドポイント種別は **7つに閉じている**（`Endpoint` union）:
`read` / `create` / `update` / `delete` / `createMany` / `updateMany` / `deleteMany`。

述語（`Predicate` union）は列 op パラメータ比較（`ComparePredicate`）、IN リスト（`InPredicate`）、
複合キー IN（`TupleInPredicate`）、NULL 判定（`NullPredicate`）、相関 EXISTS（`ExistsPredicate`）、
型付きサブクエリ（`SubqueryPredicate`）。`ComparePredicate.optional` を立てた述語だけが **SKIP メンバー**
になる（§8）。

```ts
// 宣言エンドポイントの集合 = 1つの emit された @behavior クラス（EndpointSet）
const PostQueries: EndpointSet = {
  search: {
    kind: 'read',
    model: Post,
    where: [
      { column: 'author_id', op: 'eq', param: 'authorId' },
      { column: 'status', op: 'eq', param: 'status', optional: true }, // optional → SKIP メンバー
      { column: 'created_at', op: 'ge', param: 'since' },
    ],
    order: 'created_at DESC',
    limit: { param: 'limit' },
    with: ['author'],           // relation は宣言 select（batch, N+1-free）
  },
  createPost: {
    kind: 'create',
    model: Post,
    values: [{ column: 'author_id', param: 'authorId' }, { column: 'title', param: 'title' }],
    returning: ['id', 'title'],
  },
};
```

### 2.3 TS 直接利用（公開 API・eager）

従来どおり公開 API を直接呼ぶ。静的に宣言したエンドポイントは codegen 経路（§9）に載るが、形が実行時に
しか決まらない **真のアドホッククエリ**（`find({ where: { age: { gt: x } } })`）は静的 SQL を持たないので
**v1 命令パス**で走る（`Endpoint` の doc-comment: `an ad-hoc find({ where }) has no static SQL and
runs the v1 imperative path`）。複数文をまたぐ書込の原子性は利用者が `DBModel.transaction(fn)` で明示的に
束ねる（§6）。

### 2.4 多言語利用（生成物を各言語 runtime で）

`bc generate` が publish した native モジュールを、各言語の薄い runtime（bc runtime-core + litedbmodel
SQL runtime）が読み、**同一 SQL・同一結果**を実行する。生成エントリは authored メソッドの 1:1 写像で、
宣言クラスが名前空間・引数がその順の位置引数（シグネチャ直呼び）:

```go
rows, _ := postQueries.Search(ctx, db, SearchInput{AuthorID: 7, Since: "2026-01-01"})
```

---

## 3. レイヤ構成

```
デコレータ付きモデル + 宣言エンドポイント（SQL なし）        ← src/decorators.ts + src/scp/emit/endpoint.ts
   ↓  emitBehaviorModule（lowering）                        ← src/scp/emit/emitter.ts
SCP 制限 TS: @behavior static メソッド（方言 SQL は makesql で焼き込み済み）が唯一の @leaf カタログ Db を呼ぶ
   ↓  bc generate --from
go / rust / py / php / ts native モジュール（リーフ配線は bc が自動生成）
   ↓  実行時
薄い Runtime: 3本の op 非依存リーフ（executeSQL / pluck / group）— §8/§9
```

**汎用（behavior-contracts）と SQL backend（litedbmodel）の分界:**

| 汎用（behavior-contracts） | SQL backend（litedbmodel v2） |
|---|---|
| Component-graph IR 構造 / Execution Plan / Expression IR 評価 | 方言 SQL の Backend Compile（`src/scp/makesql`） |
| `runBehavior` / `evaluateExpression` / `validateEnvelope` / codegen 基盤 | catalog leaf handler + 行→論理モデル assembly（`src/scp/makesql/handler.ts`） |
| conformance runner 基盤（言語軸） | 方言別 SQL 生成（§13 の closeable convention 含む）・型 hydration・接続/プール/tx |

---

## 4. モデル定義

- `@model(table)` / `@column(...)` で物理対応（v1 継承）。読み出し結果は **typed-object**（own props は
  データのみ・DBModel インスタンスではない。`src/scp/typed-object.ts`）。
- 論理モデル ↔ 物理配置（table/column/PK/index）はモデル定義が吸収する。

### 4.1 型システム（SQL 型ベース・SSoT）

litedbmodel は SQL バックエンド consumer なので **列型は SQL 型を SoT とする**（TS の `number` は
INTEGER/REAL を区別できないため型の権威にしない）。型は `schema.sql`（DDL）から確定し、typed codegen
（bc typed-raw 脱 box）の `outType` 注記に使う。**曖昧/未知は error（no-assume・no-fallback）** — 既定値へ
潰さない。変換は `` `sqlTypeToBcScalar` (`src/scp/coltype.ts`) `` が SSoT。

**SQL 型 → bc outType スカラ（正規対応表・`sqlTypeToBcScalar`）**

| SQL 型 | bc outType | 備考 |
|---|---|---|
| INTEGER / INT / BIGINT / SMALLINT / TINYINT / SERIAL 系 | `int` | int は既定 **64bit**。狭いサイズ制限は列制約で表現し別型にしない |
| REAL / FLOAT / DOUBLE | `float` | int と real は明確に分離 |
| DECIMAL / NUMERIC / MONEY | `string` | 精度保持のため文字列表現 |
| TEXT / VARCHAR / CHAR / CHARACTER (VARYING) / CLOB / UUID | `string` | |
| BOOLEAN / BOOL | `bool` | |
| DATE / TIMESTAMP / TIMESTAMPTZ / DATETIME / TIME | `string` | 一旦 string（bc の date scalar は未導入）。DB は行ごとに別 TZ を保存しない |
| JSON / JSONB | `string` | 表現は JSON テキスト＝文字列 |

nullability は基底スカラと直交する（`` `sqlTypeIsNotNull` (`src/scp/coltype.ts`) ``）: `NOT NULL` 列は
読みセルが非 null 確定なので `opt` ラップ無しの生スカラ、既定は nullable。

**TS 読み出しの materialization（`sqlTypeToMaterializeClass` / `materializeCell`）**

bc outType（可搬型）に加え、TS/driver の読み経路では `int` スカラを SQL 幅で分割し、`date`/`bool` を
正確な JS 形へ矯正する（JS `number` は i64 を保持できず、driver は `string` outType に反する `Date`/`0|1`
を返し得るため）。クラスは `` `MaterializeClass` (`src/scp/coltype.ts`) ``:

- `int32`（INT/INTEGER/SMALLINT/…）→ JS `number`（範囲が収まる）。
- `int64`（BIGINT/INT8/BIGSERIAL）→ **値保存の10進文字列**（JS number は 2^53 超で丸む・JSON 安全）。
- `date`（DATE/TIMESTAMP/…）→ **TZ 付き文字列**（`string` outType に整合。全言語同一、TS も Date にしない）。
- `bool` → JS `boolean`。
- `passthrough`（float / text / decimal→string / json / uuid / 配列列）→ 無変換。

読み出しは fail-closed の resolver（`` `failClosedMaterializeResolverFromColumnMap` (`src/scp/coltype.ts`) ``）
で常時 de-box され、宣言されていない列は throw する（未型付き列を silent に box しない）。

**脱 box は READ / WRITE 両方を覆う（codegen 面・§9）**

- **READ**: SELECT projection を行 obj 型へ型付け（`` `deriveReadRow` (`src/scp/makesql/outtype.ts`) ``）→
  bc typed-raw が具体的な行 struct を materialize。
- **WRITE**: 書込出力＝`TransactionResult` の typed shape（`` `deriveWriteOutputType`
  (`src/scp/makesql/writeouttype.ts`) ``）:
  `obj{ committed:bool, executed:arr<string>, shortCircuit:opt<obj{statementId:string, reason:string}>,
  entity:opt<ROW>, returnedRows:opt<arr<arr<ROW>>> }`。ROW は書込対象テーブルの RETURNING 列を **READ と
  同一の列型 resolver**で型付けする。脱 box できない write shape は error（no-assume・no-fallback）。

**規律**: 型が曖昧/未指定なら error。SoT は `schema.sql` の SQL 型（`` `parseSchemaColumnTypes`
(`src/scp/coltype.ts`) `` が DDL を `table → (column → SQL 型)` へパース）。

---

## 5. Relation — Read 系

Relation は **SQL JOIN を既定にしない**（`src/scp/relation.ts` の doc-comment: `Relations are NOT SQL
JOINs by default`）。v1 `LazyRelation` と同型の **staged batch query-composition + object assembly**:
結果ページの親キー集合を集め、dedup した親キーで **ONE batched child SELECT** を撃ち、子行を親へ分配する
（relation エッジごとに1クエリ・N+1 なし）。

- `` `RelationOp` (`src/scp/relation.ts`) `` はモデル `RelationDecl` から **一度だけ**静的 `makeSQL` batch
  SELECT へコンパイルされる（`` `compileRelationOp` (`src/scp/relation.ts`) ``）。PG は元 `LazyRelation` SQL
  と byte 一致（`= ANY(?::type[])`, `CROSS JOIN LATERAL`, `UNNEST`）、MySQL/SQLite は単一 JSON パラメータの
  サーバ側展開（`json_each` / `JSON_TABLE`）。dedup 済みキー配列は **ONE param・静的テキスト**で束ねる
  （プレースホルダ件数展開なし）ので `op.sql` は値非依存で固定。
- **2つの読みサーフェスが同一 op を撃つ**（`` `runRelationOp` (`src/scp/relation.ts`) ``）:
  - **宣言 select**（`with: ['author']`）… ページ全体を batch 先読み。
  - **lazy**（`await post.author`）… prototype getter が兄弟集合に同一 op を撃つ
    （`src/scp/typed-object.ts` の非列挙 Symbol batch context）。
- **暴走ガード**: guarded relation の子フェッチは runaway cap（`` `CapGuard` (`src/scp/leaf-transport.ts`) ``）
  を運び、リーフが生の子行件数を cap に照合して超過時 `LimitExceededError` を投げる（RAW 子行が存在するのは
  この場所だけ・SCP に throw が無いため）。
- **cross-DB relation**: 文が属する DB 名（`ExecOptions.db`）は relation の **target モデル**から解決され
  （`` `connectionOf` (`src/scp/decorator-adapter.ts`) ``）、接続ルーティング（`src/scp/connection-routing.ts`）
  が named connection の reader/writer 対を選ぶ。未登録名は loud（silent に別 DB へ走らせない）。
- ホストオブジェクト化は graphddb と同形の `` `hydrate` (`src/scp/typed-object.ts`) `` factory
  （relation 解決の後・`null` には適用しない）。

---

## 6. 書込 — 単文エンドポイント / バッチ / 手続きトランザクション

書込は宣言エンドポイントとして表現する。ライブラリが関連への波及を自動導出することはしない（波及が要るなら
利用者が書く）。

- **単文書込** — `create` / `update` / `delete`。方言別 SQL は makesql で焼き込まれ、`RETURNING` を宣言
  すれば書込んだ行を返す（MySQL は RETURNING 非対応のため接続アダプタが宣言 PK で再 SELECT する・
  `src/scp/makesql/mysql-returning.ts`）。
- **バッチ書込** — `createMany` / `updateMany` / `deleteMany`。1論理オペレーションが N 個のグループ文を
  生む。バッチ SQL は v1 ビルダから byte-copy し、**gate-free** な transaction plan（`` `deriveBatchPlan`
  (`src/scp/makesql/tx.ts`) ``。`entityFrom` null・全文 `role:'body'`）へ落として、全言語 runtime が同一の
  per-statement tx ループで実行する。書込列順は **canonical（アルファベット）**に正規化される（v2 write 経路
  の SSoT・命令 `DBModel._insert` と一致。`src/scp/makesql/compile-crud.ts` / `src/scp/makesql/tx.ts`）。
- **複数文をまたぐ原子性** — 利用者の `DBModel.transaction(fn)` 手続き境界で束ねる。境界内は
  read-your-writes（未コミット行が同一接続で見える）と rollback を保証するので、「前提の読み → その結果に
  依存する書込 → 例外での短絡」は手で書く（宣言的な gate-first / tx-DAG 導出は持たない）。実行は
  `` `executeTransactionAsync` (`src/scp/makesql/tx.ts`) `` — ランタイムは per-statement のゲート短絡
  primitive（`GateRule`）を運べるが、宣言エンドポイントはゲートを一切 emit しない（batch plan は gate-free）。

```ts
await DBModel.transaction(async () => {
  const author = await User.findOne([[User.email, 'a@x.com']]); // 前提の読み
  if (!author) throw new Error('author not found');              // 短絡 = throw → 全体 rollback
  const post = await Post.create({ author_id: author.id, title: 't' }, { returning: true });
  await Comment.create({ post_id: post.id, body: 'c' });         // 直前の書込の id に依存
});
```

---

## 7. 宣言 → SCP 制限 TS → 生成物

宣言エンドポイント（§2.2）は `` `emitBehaviorModule` (`src/scp/emit/emitter.ts`) `` で **SCP 制限 TS** へ
lowering される。emitter は **自分では何もコンパイルしない**: emit される全成果物は既存の集約点が生み、
emitter はそれを TypeScript として **RENDER するだけ**である。

| emit される物 | 由来 |
|---|---|
| read SQL + param 順 | `` `compileSelect` (`src/scp/makesql/compile-select.ts`) `` |
| WHERE テキスト（全体/断片） | `` `compileWhere` (`src/scp/makesql/compile.ts`) `` |
| 静的 IN リストの membership | `` `inListPredicate` (`src/scp/makesql/json-array.ts`) ``（PG `= ANY(?)`） |
| write SQL + param 順 | `` `compileWriteNode` (`src/scp/makesql/tx.ts`) `` |
| relation batch SQL + キー | `` `compileRelationOp` (`src/scp/relation.ts`) `` |
| 行型 | `` `deriveReadRow` (`src/scp/makesql/outtype.ts`) `` |
| 列 SQL 型 | `` `deriveModelColumns` (`src/scp/decorator-adapter.ts`) `` |
| リーフカタログ | `` `Db` (`src/scp/leaf-transport.ts`) `` |

生成された SCP 制限 TS は `bc generate --from` が読み、go / rust / py / php / ts の native モジュールへ
落ちる（リーフ配線は bc が自動生成）。**制御構造は bc 準拠のネイティブ TS**（`?:` / `&&` / `.map`）で、
新語彙を足さない。lower 可能サブセット外の自由 SQL は **契約付き Raw SQL**（`QueryView` #98 の派生 CTE
= `WITH <alias> AS (<query>) SELECT … FROM <alias>` を含む・`src/scp/emit/endpoint.ts` の `QueryView`）。

---

## 8. 生成物と実行時の断片モデル（可搬 IR は emit しない）

**litedbmodel は可搬 IR ドキュメントを emit しない**（`src/scp/index.ts`: `no runtime IR, no programmatic
compile`）。「中間 IR の形」ではなく、次の2つが実体である:

1. **静的宣言エンドポイント**（read + 単文 write）は `emitBehaviorModule` が **方言 SQL を焼き込んだ SCP
   制限 TS** へ落とし、`bc generate` が native 化する。component-graph IR は bc が所有し、litedbmodel は
   SCP 制限 TS を生むだけ。方言は **TS 側で一度だけ**解決される（§10）。
2. **ランタイム write/tx 経路**（`DBModel.transaction` と batch）は bc catalog leaf
   `` `makeSQL` (`src/scp/makesql/makesql.ts`) `` を通る。`makeSQL(sql, params, skip?)` は **1つの** catalog
   component で、`sql` はチューニング済み方言テキスト（`?` プレースホルダ、v1 と byte 一致）、`params` は
   束ねる値または **ネストした `makeSQL`**（サブクエリ）、`skip?` は presence 条件。`= ANY` / `LATERAL` /
   `UNNEST` / cast / batch は **全て `sql` 内のテキスト**でモデル化しない（`makesql.ts`: `never modeled`）。

**動的 WHERE（SKIP）の断片語彙**（CLAUDE.md §2 準拠・`src/scp/leaf-transport.ts`）:

- 断片は **SQL テキスト + params + SKIP フラグ**だけ（中間 IR 語彙を作らない）。1断片 =
  `` `DynamicWhereFrag` (`src/scp/leaf-transport.ts`) `` = `{ skipped, sql, params }` の均質な struct で、
  `cond`→null のバリアント要素にしない（native-codegen エミッタが拒否する形）。
- optional 述語を宣言した read だけが `` `DynamicWherePlan` (`src/scp/leaf-transport.ts`) `` を運ぶ。bounded
  述語は emit 時に静的 WHERE へ lower される（native-clean）。plan は head / lead / tail / tailParams を持ち、
  リーフ（`` `assembleDynamicWhere` (`src/scp/leaves.ts`) ``）が生存断片を連結する（文字列 scan はしない）。
- **`?`→`$N` はプレースホルダ変換であって最終 SQL 確定後**（PG のみ・左から機械変換1パス）。SKIP で形が
  変わるため生成段では確定できない。`` `toDollarPlaceholders` (`src/scp/dialect.ts`) `` が最終フラットテキストを
  一度だけ走査する（番号振り直し問題は設計から消滅）。ランタイムの `` `renderPlaceholders`
  (`src/scp/makesql/handler.ts`) `` は quote-aware（文字列リテラル内の `?` はプレースホルダにしない）。
- **IN リストの件数展開もランタイム/ドライバ側**: 非空配列は方言のサーバ側展開（PG `= ANY(?)`・MySQL
  `JSON_TABLE`・SQLite `json_each`）で **ONE param・静的テキスト**、**空配列は `1 = 0`**（param なし・v1 と一致。
  `src/scp/makesql/json-array.ts`）。

---

## 9. 実行経路 — コンパイル経路は1本

**コンパイル経路は1本**（CLAUDE.md §1）: デコレータ付きモデル + 宣言エンドポイント →
`emitBehaviorModule` → SCP 制限 TS → `bc generate --from` → go / rust / py / php / ts native。リーフ配線は
bc が自動生成する。実行時のサーフェスは **3本の op 非依存リーフ**（`src/scp/leaf-transport.ts` の
`Db.executeSQL` / `Db.pluck` / `Db.group`）に閉じ、方言 SQL はこの3本が運ぶテキスト＋パラメータで表現する。

- **`executeSQL`** — 唯一の SQL 転送。`sql` + `params` に加えて任意の1制御 struct `ExecOptions`（どの DB で
  走るか・read/write モード・SKIP plan・relation ガード）を運ぶ。plain read は `opts` を省略（native-clean）。
- **`pluck`** — relation キー抽出（dedup・非 null のキー集合）。
- **`group`** — relation 整形（子を親の `into` にネスト・N+1 なしにする in-memory grouping）。

**真のアドホッククエリ**（形が実行時にしか決まらない `find({ where })`）は静的 SQL を持たないので **v1
命令パス**で走る（`src/scp/emit/endpoint.ts`）。SKIP は「動的だから v1」ではない — optional 述語は §8 の
断片モデルで codegen 経路に載る。

3言語グループの実行モデルは bc の native codegen が決める（go/rust は typed-native の直呼び、py/php は bc
runtime-core `runBehavior` に生成モジュールの IR リテラルを渡す形）。いずれも **同一コンパイラ・同一 native
モジュール**を共有するので、経路差による意味論のズレは構造上生じない。

---

## 10. 多言語 Runtime と Conformance

- 各言語 runtime = **bc runtime-core（共有）+ litedbmodel SQL runtime**（driver + assembly + dialect）。
- Conformance（bc の golden 方式）: 同一エンドポイント + 同一入力 → **同一 SQL テキスト + 同一 assembly 結果**。
- **分解**: 方言軸はコンパイル時に **TS 側で1回検証**（`src/scp/dialect.ts` の doc-comment: `方言軸は
  コンパイル時に TS 側で1回検証`。既存 SqlBuilder 資産 + golden SQL）。言語軸は「同一入力 → 同一 SQL +
  同一結果」の機械検証。→ conformance 行列が **「方言 3 × 言語 5」から「3 + 5」に分解**する。
- 実 DB conformance は dockerized PostgreSQL + MySQL（SQLite はインプロセス参照）で、5言語 runtime が同一
  ベクタを replay する。

---

## 11. Consumer 実装点（litedbmodel が書くもの / bc から得るもの）

**litedbmodel v2 が実装する（`src/scp/index.ts` の4点の具体化）:**

1. **Catalog leaf**: ランタイム経路の `` `makeSQL` (`src/scp/makesql/makesql.ts`) ``（1 component）と、codegen
   経路の3本 op 非依存リーフ `` `Db` (`src/scp/leaf-transport.ts`) ``。
2. **Handler**: catalog leaf の唯一の consumer 実装点（`` `renderPlaceholders` を含む
   `src/scp/makesql/handler.ts` ``）— bind params → SQL 実行 → 行→論理モデル assembly。副作用/driver/接続は
   ここに閉じる（IR は実装を運ばない）。
3. **Backend Compile**: 宣言エンドポイント → 方言 SQL + param 順（`src/scp/makesql` の `compile-*`）。
4. **Error Mapping**: driver エラー → SCP Failure。`` `SqlFailure` (`src/scp/errors.ts`) `` は安定した `kind`
   （`constraint_violation` / `foreign_key_violation` / `retryable` / `driver_error`）と bc の `PolicyKind`
   （fail / retry / continue）を運ぶ。未知コードは loud（silent catch-all にしない）。
5. **各言語ランタイム**: 実行コンテキスト・接続ルーティング・relation grouping・列型 de-box・typed-object。

**bc から得る（実装しない）:** component-graph IR 構造・Expression 評価・Execution Plan 実行・
`runBehavior` / `validateEnvelope`・codegen 基盤・conformance runner。

---

## 12. TS 公開 API の v1 → v2 移行（破壊的）

| 面 | v1 | v2 |
|---|---|---|
| CRUD + condition タプル + SKIP | Active Record | ほぼ不変（内部が codegen/命令 経路に分かれる） |
| `await post.author`（lazy） | prototype getter（Promise） | 残す（getter → 事前コンパイル relation op 起動・§5） |
| 結果オブジェクト | DBModel インスタンス | **typed-object**（own props はデータのみ・§4） |
| インスタンスメソッド | クラスメソッド | typed-object には無い → `hydrate: (raw)=>new Domain(raw)` で回復 |
| 完全動的 Raw SQL | `execute`/`query` | 契約付き Raw SQL（`QueryView` / v1 命令パス） |
| 書込列順 | 挿入順（v1.x で保全） | **canonical アルファベット順**（v2 write 経路の SSoT・§6） |

破壊の中心は「結果がインスタンス → typed-object」。メソッドは `hydrate` で回復。v1.x はメンテブランチ
`v1.x` で保全する。

---

## 13. DB 挙動差 — SQL テキストを超える差の closeable-by-convention 線

SQL テキストが一致しても DB 挙動が一致するとは限らない（NULL 順序・照合・timezone・浮動小数）。これらは
**「方言コンパイル時規約」で閉じられる線の内側だけ**を仕様が保証する（`src/scp/dialect.ts` の doc-comment:
`spec §13 closeable-by-convention line`）。

- **機械的に閉じる規約は NULL 順序の決定性1つ**: `` `orderByNulls` (`src/scp/dialect.ts`) `` が
  `ORDER BY … NULLS FIRST/LAST` 要件を方言別にレンダーする。PostgreSQL / SQLite(3.30+) は native
  `NULLS FIRST/LAST`、MySQL は先頭に `<expr> IS NULL` ソートキーを足して等価に emulate する。
- **照合（collation）・timezone・浮動小数の意味は明示的にスコープ外**（silent に既定へ潰さず、規約の外だと
  ドキュメントする）。
- プレースホルダ・INSERT conflict 節・guard INSERT など、SQL テキストの方言差はすべて `Dialect` 戦略
  （`src/scp/dialect.ts` の凍結レコード `SQLITE` / `POSTGRES` / `MYSQL`）に閉じ、エンジンコードに散在する
  `?:` を置かない。

---

## 14. バージョニング / エコシステム位置づけ

- **v2.0 系（破壊的）**。v1.x はメンテブランチ `v1.x` で保全（別トラック・v1 の SQL は byte 保全）。
- litedbmodel v2 = behavior-contracts の **SQL バックエンド consumer**（graphddb=DynamoDB と対）。IR /
  Expression / runtime-core / codegen / conformance を共有し、Backend Compile + Handler + Catalog leaf +
  Error Mapping のみを供給する。
- リリースは **5レジストリ**（npm / crates.io / PyPI / Go-tag / Packagist）。
