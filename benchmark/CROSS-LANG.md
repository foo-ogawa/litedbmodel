# Cross-language ORM benchmark

Each language runs the SAME 19 ORM-comparison ops through TWO surfaces against the same database:
**native** = the litedbmodel-generated module over the shipped runtime; **sdk** = the same logical
operation hand-written against the raw driver, litedbmodel not in the path. Both reuse prepared
statements and bind params for reads and writes alike.

The fixture is the one `benchmark/setup.ts` seeds for the ORM-vs-ORM bench — 1,000 users, 5,500 posts,
10,000 comments, plus the composite-key tenant graph (500 tenant_users, 5,000 tenant_posts, 50,000
tenant_comments), 72,000 rows in all. It is re-applied before every op. The relation ops therefore
traverse 100 parents → 1,000 children → 10,000 grandchildren, the same window that bench measures.

**rows/op is measured, per cell, at that cell's own exec seam** — the total rows the op moved across the
DB→client boundary, summed over its statements. Every cell of every language runs byte-identical SQL over
the one shared fixture, so cells that disagree on rows/op are doing different work; the fairness section
reports that rather than averaging it away. A cell with no row-observing seam reports a dash, never a zero.
Latency is p50 over the timed iterations; the row count comes from one un-timed probe per op, so the
published latencies do not pay for the observation.

Each language uses its own real driver per dialect (TypeScript: better-sqlite3 / pg / mysql2; Python:
sqlite3 / psycopg 3 / PyMySQL; PHP: PDO; Rust: rusqlite / tokio-postgres / sqlx; Go: modernc.org/sqlite /
pgx / go-sql-driver). Cross-language absolute times therefore carry a driver caveat; within a language the
native and sdk columns are directly comparable. PostgreSQL and MySQL are network round-trips and converge
across languages — the client-side cost is the larger fraction on SQLite in-proc.

Reproduce:

```bash
npx tsx benchmark/crosslang/emit-setup.ts
./benchmark/crosslang/run-cells.sh sqlite
node benchmark/crosslang/results/aggregate.mjs
```

### sqlite — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | —/97 (—) | 153/91 (1.68×) | 62/36 (1.75×) | 328/60 (5.47×) | 265/34 (7.78×) |
| filterPaginateSort | 20 | —/884 (—) | 1248/1205 (1.04×) | 796/771 (1.03×) | 1356/1233 (1.10×) | 1146/864 (1.33×) |
| findFirst | 1 | —/13 (—) | 18/15 (1.20×) | 8/12 (0.63×) | 38/10 (4.00×) | 26/5 (5.20×) |
| findUnique | 1 | —/5 (—) | 13/9 (1.39×) | 5/1 (5.00×) | 48/4 (12.00×) | 19/1 (19.00×) |
| nestedFindAll | 1,100 | —/1243 (—) | 2663/1577 (1.69×) | 2156/731 (2.95×) | 8231/2306 (3.57×) | 4189/948 (4.42×) |
| nestedFindFirst | 11 | —/367 (—) | 523/521 (1.00×) | 366/341 (1.07×) | 1181/939 (1.26×) | 515/322 (1.60×) |
| nestedFindUnique | 11 | —/330 (—) | 534/507 (1.05×) | 361/340 (1.06×) | 1150/967 (1.19×) | 484/305 (1.59×) |
| nestedRelations | 11,100 | —/10743 (—) | 30315/12608 (2.40×) | 25647/6713 (3.82×) | 74689/17799 (4.20×) | 48305/8606 (5.61×) |
| compositeRelations | 11,100 | —/21078 (—) | 61258/39239 (1.56×) | 43173/19117 (2.26×) | 101371/33579 (3.02×) | 73941/22004 (3.36×) |
| create | 0 | —/9 (—) | 16/12 (1.39×) | 8/4 (2.00×) | 36/8 (4.44×) | 23/5 (4.60×) |
| update | 0 | —/3 (—) | 11/6 (1.83×) | 4/1 (8.00×) | 33/2 (16.50×) | 19/2 (9.50×) |
| upsert | 1 | —/10 (—) | 30/18 (1.67×) | 15/6 (2.50×) | 57/17 (3.32×) | 34/10 (3.58×) |
| createMany | 0 | —/40 (—) | 63/50 (1.26×) | 40/38 (1.07×) | 69/47 (1.47×) | 48/31 (1.56×) |
| upsertMany | 0 | —/32 (—) | 69/58 (1.20×) | 43/41 (1.06×) | 72/47 (1.53×) | 50/34 (1.46×) |
| updateMany | 0 | —/57 (—) | 154/122 (1.26×) | 74/51 (1.45×) | 127/92 (1.38×) | 75/82 (0.92×) |
| nestedCreate | 1 | —/18 (—) | 54/31 (1.73×) | 21/9 (2.28×) | 109/38 (2.87×) | 58/14 (4.14×) |
| nestedUpsert | 1 | —/17 (—) | 58/41 (1.41×) | 22/10 (2.15×) | 103/33 (3.12×) | 57/15 (3.90×) |
| nestedUpdate | 1 | —/208 (—) | 319/282 (1.13×) | 173/163 (1.06×) | 455/411 (1.11×) | 341/190 (1.79×) |
| delete | 1 | —/15 (—) | 44/30 (1.49×) | 25/8 (3.06×) | 105/35 (3.00×) | 50/12 (4.17×) |

### postgres — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | —/675 (—) | 847/451 (1.88×) | 648/497 (1.30×) | 1907/1862 (1.02×) | 1264/446 (2.83×) |
| filterPaginateSort | 20 | —/927 (—) | 1009/934 (1.08×) | 908/800 (1.14×) | 2513/2302 (1.09×) | 3074/854 (3.60×) |
| findFirst | 1 | —/713 (—) | 377/328 (1.15×) | 268/295 (0.91×) | 899/872 (1.03×) | 2004/279 (7.19×) |
| findUnique | 1 | —/275 (—) | 903/312 (2.90×) | 267/318 (0.84×) | 1878/519 (3.62×) | 1090/440 (2.48×) |
| nestedFindAll | 1,100 | —/3254 (—) | 4677/3930 (1.19×) | 4336/4025 (1.08×) | 18729/12018 (1.56×) | 18408/2780 (6.62×) |
| nestedFindFirst | 11 | —/1057 (—) | 1319/1286 (1.03×) | 1575/979 (1.61×) | 4420/1561 (2.83×) | 5197/925 (5.62×) |
| nestedFindUnique | 11 | —/1076 (—) | 1412/1336 (1.06×) | 1040/1035 (1.00×) | 3957/1325 (2.99×) | 5620/986 (5.70×) |
| nestedRelations | 11,100 | —/21063 (—) | 36185/18952 (1.91×) | 50259/20251 (2.48×) | 173430/102714 (1.69×) | 81555/25800 (3.16×) |
| compositeRelations | 11,100 | —/18030 (—) | 36454/15323 (2.38×) | 44272/19217 (2.30×) | 215182/133599 (1.61×) | 121128/19309 (6.27×) |
| create | 0 | —/402 (—) | 266/341 (0.78×) | 718/322 (2.23×) | 706/1495 (0.47×) | 2968/282 (10.54×) |
| update | 0 | —/371 (—) | 358/309 (1.16×) | 402/287 (1.40×) | 680/973 (0.70×) | 1733/300 (5.79×) |
| upsert | 1 | —/366 (—) | 345/306 (1.13×) | 298/815 (0.37×) | 834/1308 (0.64×) | 2022/336 (6.03×) |
| createMany | 0 | —/423 (—) | 362/399 (0.91×) | 331/364 (0.91×) | 1656/1365 (1.21×) | 2326/289 (8.06×) |
| upsertMany | 0 | —/554 (—) | 403/456 (0.88×) | 385/461 (0.83×) | 1888/576 (3.28×) | 2467/565 (4.37×) |
| updateMany | 0 | —/467 (—) | 305/420 (0.73×) | 359/401 (0.90×) | 1308/654 (2.00×) | 2170/407 (5.34×) |
| nestedCreate | 1 | —/1085 (—) | 1141/9573 (0.12×) | 1075/991 (1.09×) | 2794/2922 (0.96×) | 9458/846 (11.18×) |
| nestedUpsert | 1 | —/1276 (—) | 997/9753 (0.10×) | 985/1531 (0.64×) | 4034/2349 (1.72×) | 5131/1046 (4.90×) |
| nestedUpdate | 1 | —/1571 (—) | 3408/11066 (0.31×) | 1489/1660 (0.90×) | 3115/5186 (0.60×) | 5606/1416 (3.96×) |
| delete | 1 | —/1335 (—) | 1147/9253 (0.12×) | 1090/3846 (0.28×) | 3091/2394 (1.29×) | 5167/944 (5.48×) |

### mysql — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript |
|----|--------:|----|
| findAll | 100 | 1342/— (—) |
| filterPaginateSort | 20 | 3116/— (—) |
| findFirst | 1 | 695/— (—) |
| findUnique | 1 | 852/— (—) |
| nestedFindAll | 1,100 | 5996/— (—) |
| nestedFindFirst | 11 | 2433/— (—) |
| nestedFindUnique | 11 | 2365/— (—) |
| nestedRelations | 11,100 | 26144/— (—) |
| compositeRelations | 11,100 | 3655307/— (—) |
| create | 0 | 481/— (—) |
| update | 0 | 375/— (—) |
| upsert | 1 | 928/— (—) |
| createMany | 0 | 902/— (—) |
| upsertMany | 0 | 766/— (—) |
| updateMany | 0 | 662/— (—) |
| nestedCreate | 1 | 2067/— (—) |
| nestedUpsert | 1 | 2082/— (—) |
| nestedUpdate | 1 | 3759/— (—) |
| delete | 1 | 2488/— (—) |

### sqlite — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | go | rust | python | php |
|----|--------:|----|----|----|----|
| findAll | 100 | 1,525/910 | 620/355 | 3,280/600 | 2,645/340 |
| filterPaginateSort | 20 | 62,400/60,225 | 39,775/38,550 | 67,800/61,625 | 57,275/43,175 |
| findFirst | 1 | 18,000/15,000 | 7,500/12,000 | 38,000/9,500 | 26,000/5,000 |
| findUnique | 1 | 12,500/9,000 | 5,000/1,000 | 48,000/4,000 | 19,000/1,000 |
| nestedFindAll | 1,100 | 2,421/1,433 | 1,960/664 | 7,483/2,096 | 3,808/861 |
| nestedFindFirst | 11 | 47,545/47,318 | 33,227/30,955 | 107,364/85,364 | 46,818/29,273 |
| nestedFindUnique | 11 | 48,500/46,091 | 32,818/30,864 | 104,500/87,864 | 43,955/27,682 |
| nestedRelations | 11,100 | 2,731/1,136 | 2,310/605 | 6,729/1,604 | 4,352/775 |
| compositeRelations | 11,100 | 5,519/3,535 | 3,889/1,722 | 9,133/3,025 | 6,661/1,982 |
| upsert | 1 | 30,000/18,000 | 15,000/6,000 | 56,500/17,000 | 34,000/9,500 |
| nestedCreate | 1 | 53,500/31,000 | 20,500/9,000 | 109,000/38,000 | 58,000/14,000 |
| nestedUpsert | 1 | 58,000/41,000 | 21,500/10,000 | 103,000/33,000 | 56,500/14,500 |
| nestedUpdate | 1 | 319,000/281,500 | 172,500/162,500 | 454,500/410,500 | 340,500/190,000 |
| delete | 1 | 44,000/29,500 | 24,500/8,000 | 105,000/35,000 | 50,000/12,000 |

### postgres — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | go | rust | python | php |
|----|--------:|----|----|----|----|
| findAll | 100 | 8,465/4,510 | 6,475/4,965 | 19,065/18,615 | 12,635/4,460 |
| filterPaginateSort | 20 | 50,425/46,700 | 45,400/40,000 | 125,625/115,100 | 153,675/42,700 |
| findFirst | 1 | 376,500/327,500 | 267,500/295,000 | 899,000/871,500 | 2,003,500/278,500 |
| findUnique | 1 | 903,000/311,500 | 266,500/318,000 | 1,877,500/519,000 | 1,090,000/439,500 |
| nestedFindAll | 1,100 | 4,252/3,573 | 3,942/3,659 | 17,026/10,925 | 16,735/2,527 |
| nestedFindFirst | 11 | 119,864/116,864 | 143,182/89,000 | 401,818/141,909 | 472,455/84,045 |
| nestedFindUnique | 11 | 128,364/121,409 | 94,545/94,091 | 359,682/120,455 | 510,864/89,591 |
| nestedRelations | 11,100 | 3,260/1,707 | 4,528/1,824 | 15,624/9,254 | 7,347/2,324 |
| compositeRelations | 11,100 | 3,284/1,380 | 3,988/1,731 | 19,386/12,036 | 10,912/1,740 |
| upsert | 1 | 344,500/305,500 | 298,000/815,000 | 834,000/1,307,500 | 2,022,000/335,500 |
| nestedCreate | 1 | 1,140,500/9,573,000 | 1,075,000/990,500 | 2,794,000/2,922,000 | 9,458,000/846,000 |
| nestedUpsert | 1 | 996,500/9,752,500 | 985,000/1,531,000 | 4,033,500/2,348,500 | 5,130,500/1,046,000 |
| nestedUpdate | 1 | 3,408,000/11,066,000 | 1,489,000/1,660,000 | 3,114,500/5,186,000 | 5,606,000/1,415,500 |
| delete | 1 | 1,146,500/9,252,500 | 1,090,000/3,846,000 | 3,090,500/2,394,000 | 5,167,000/943,500 |

### mysql — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | typescript |
|----|--------:|----|
| findAll | 100 | 13,415/— |
| filterPaginateSort | 20 | 155,775/— |
| findFirst | 1 | 694,500/— |
| findUnique | 1 | 852,000/— |
| nestedFindAll | 1,100 | 5,451/— |
| nestedFindFirst | 11 | 221,182/— |
| nestedFindUnique | 11 | 215,000/— |
| nestedRelations | 11,100 | 2,355/— |
| compositeRelations | 11,100 | 329,307/— |
| upsert | 1 | 927,500/— |
| nestedCreate | 1 | 2,066,500/— |
| nestedUpsert | 1 | 2,081,500/— |
| nestedUpdate | 1 | 3,758,500/— |
| delete | 1 | 2,488,000/— |

### fixed overhead vs per-row cost

Not separable from ONE scale (1). Re-emit the fixture at another scale and
re-run the cells into `results/scale-<factor>/`:

```bash
npx tsx benchmark/crosslang/emit-setup.ts 0.1   # then re-run the cells → results/scale-0.1/
```

### fairness — rows/op agreement across cells

CELLS DISAGREE on the rows an op moves — they are NOT running the same work:

| dialect | op | rows → cells |
|---------|----|--------------|
| postgres | findAll | **100**: typescript.sdk, go.native, go.sdk, rust.native, rust.sdk, python.native, python.sdk, php.native, php.sdk; **0**: typescript.v1 |
| postgres | filterPaginateSort | **20**: typescript.sdk, go.native, go.sdk, rust.native, rust.sdk, python.native, python.sdk, php.native, php.sdk; **0**: typescript.v1 |
| postgres | findFirst | **1**: typescript.sdk, go.native, go.sdk, rust.native, rust.sdk, python.native, python.sdk, php.native, php.sdk; **0**: typescript.v1 |
| postgres | findUnique | **1**: typescript.sdk, go.native, go.sdk, rust.native, rust.sdk, python.native, python.sdk, php.native, php.sdk; **0**: typescript.v1 |
| postgres | nestedFindAll | **1,100**: typescript.sdk, go.native, go.sdk, rust.native, rust.sdk, python.native, python.sdk, php.native, php.sdk; **0**: typescript.v1 |
| postgres | nestedFindFirst | **11**: typescript.sdk, go.native, go.sdk, rust.native, rust.sdk, python.native, python.sdk, php.native, php.sdk; **0**: typescript.v1 |
| postgres | nestedFindUnique | **11**: typescript.sdk, go.native, go.sdk, rust.native, rust.sdk, python.native, python.sdk, php.native, php.sdk; **0**: typescript.v1 |
| postgres | nestedRelations | **11,100**: typescript.sdk, go.native, go.sdk, rust.native, rust.sdk, python.native, python.sdk, php.native, php.sdk; **0**: typescript.v1 |
| postgres | compositeRelations | **11,100**: typescript.sdk, go.native, go.sdk, rust.native, rust.sdk, python.native, python.sdk, php.native, php.sdk; **0**: typescript.v1 |
| postgres | upsert | **1**: typescript.sdk, go.native, go.sdk, rust.native, rust.sdk, python.native, python.sdk, php.native, php.sdk; **0**: typescript.v1 |
| postgres | nestedCreate | **1**: typescript.sdk, go.native, go.sdk, rust.native, rust.sdk, python.native, python.sdk, php.native, php.sdk; **0**: typescript.v1 |
| postgres | nestedUpsert | **1**: typescript.sdk, go.native, go.sdk, rust.native, rust.sdk, python.native, python.sdk, php.native, php.sdk; **0**: typescript.v1 |
| postgres | nestedUpdate | **1**: typescript.sdk, go.native, go.sdk, rust.native, rust.sdk, python.native, python.sdk, php.native, php.sdk; **0**: typescript.v1 |
| postgres | delete | **1**: typescript.sdk, go.native, go.sdk, rust.native, rust.sdk, python.native, python.sdk, php.native, php.sdk; **0**: typescript.v1 |
| mysql | findAll | **100**: typescript.native; **0**: typescript.v1 |
| mysql | filterPaginateSort | **20**: typescript.native; **0**: typescript.v1 |
| mysql | findFirst | **1**: typescript.native; **0**: typescript.v1 |
| mysql | findUnique | **1**: typescript.native; **0**: typescript.v1 |
| mysql | nestedFindAll | **1,100**: typescript.native; **0**: typescript.v1 |
| mysql | nestedFindFirst | **11**: typescript.native; **0**: typescript.v1 |
| mysql | nestedFindUnique | **11**: typescript.native; **0**: typescript.v1 |
| mysql | nestedRelations | **11,100**: typescript.native; **0**: typescript.v1 |
| mysql | compositeRelations | **11,100**: typescript.native; **0**: typescript.v1 |
| mysql | upsert | **1**: typescript.native; **0**: typescript.v1 |
| mysql | nestedCreate | **1**: typescript.native; **0**: typescript.v1 |
| mysql | nestedUpsert | **1**: typescript.native; **0**: typescript.v1 |
| mysql | nestedUpdate | **1**: typescript.native; **0**: typescript.v1 |
| mysql | delete | **1**: typescript.native; **0**: typescript.v1 |

No row-observing seam (reported as `—`, never as 0): typescript.v1

### coverage (rows collected)

typescript.native.sqlite @scale 1        SKIP (no data)
typescript.sdk.sqlite @scale 1           samples=190
typescript.native.postgres @scale 1      SKIP (no data)
typescript.sdk.postgres @scale 1         samples=190
typescript.native.mysql @scale 1         samples=190
typescript.sdk.mysql @scale 1            SKIP (no data)
go.native.sqlite @scale 1                samples=190
go.sdk.sqlite @scale 1                   samples=190
go.native.postgres @scale 1              samples=190
go.sdk.postgres @scale 1                 samples=190
go.native.mysql @scale 1                 SKIP (no data)
go.sdk.mysql @scale 1                    SKIP (no data)
rust.native.sqlite @scale 1              samples=190
rust.sdk.sqlite @scale 1                 samples=190
rust.native.postgres @scale 1            samples=190
rust.sdk.postgres @scale 1               samples=190
rust.native.mysql @scale 1               SKIP (no data)
rust.sdk.mysql @scale 1                  SKIP (no data)
python.native.sqlite @scale 1            samples=190
python.sdk.sqlite @scale 1               samples=190
python.native.postgres @scale 1          samples=190
python.sdk.postgres @scale 1             samples=190
python.native.mysql @scale 1             SKIP (no data)
python.sdk.mysql @scale 1                SKIP (no data)
php.native.sqlite @scale 1               samples=190
php.sdk.sqlite @scale 1                  samples=190
php.native.postgres @scale 1             samples=190
php.sdk.postgres @scale 1                samples=190
php.native.mysql @scale 1                SKIP (no data)
php.sdk.mysql @scale 1                   SKIP (no data)
