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
| findAll | 100 | —/72 (—) | 166/102 (1.64×) | 117/35 (3.34×) | 372/58 (6.41×) | 247/37 (6.66×) |
| filterPaginateSort | 20 | —/897 (—) | 1270/1344 (0.95×) | 883/792 (1.12×) | 1386/1236 (1.12×) | 1202/867 (1.39×) |
| findFirst | 1 | —/14 (—) | 19/15 (1.23×) | 9/11 (0.82×) | 42/9 (4.61×) | 21/4 (5.25×) |
| findUnique | 1 | —/3 (—) | 14/9 (1.56×) | 6/1 (6.00×) | 35/4 (8.75×) | 21/2 (10.25×) |
| nestedFindAll | 1,100 | —/1468 (—) | 5623/1526 (3.68×) | 4464/791 (5.64×) | 7408/2310 (3.21×) | 4114/1024 (4.02×) |
| nestedFindFirst | 11 | —/326 (—) | 646/606 (1.07×) | 372/376 (0.99×) | 1854/1023 (1.81×) | 486/393 (1.24×) |
| nestedFindUnique | 11 | —/322 (—) | 736/604 (1.22×) | 364/375 (0.97×) | 1089/968 (1.12×) | 450/379 (1.19×) |
| nestedRelations | 11,100 | —/11078 (—) | 33545/14023 (2.39×) | 72578/6099 (11.90×) | 74354/17447 (4.26×) | 46512/9365 (4.97×) |
| compositeRelations | 11,100 | —/21339 (—) | 73308/47363 (1.55×) | 114355/19796 (5.78×) | 106754/38072 (2.80×) | 70146/25774 (2.72×) |
| create | 0 | —/8 (—) | 16/10 (1.60×) | 9/4 (2.25×) | 38/6 (6.33×) | 24/6 (4.36×) |
| update | 0 | —/3 (—) | 12/5 (2.30×) | 4/1 (4.00×) | 36/2 (17.75×) | 34/1 (33.50×) |
| upsert | 1 | —/10 (—) | 28/21 (1.37×) | 16/6 (2.67×) | 52/18 (2.86×) | 31/10 (3.10×) |
| createMany | 0 | —/38 (—) | 63/49 (1.29×) | 46/39 (1.18×) | 87/43 (2.02×) | 52/36 (1.45×) |
| upsertMany | 0 | —/35 (—) | 85/59 (1.45×) | 51/37 (1.38×) | 79/47 (1.67×) | 55/39 (1.40×) |
| updateMany | 0 | —/54 (—) | 145/120 (1.20×) | 79/56 (1.41×) | 124/91 (1.36×) | 82/95 (0.86×) |
| nestedCreate | 1 | —/18 (—) | 53/36 (1.46×) | 25/10 (2.63×) | 119/41 (2.93×) | 54/15 (3.57×) |
| nestedUpsert | 1 | —/22 (—) | 69/46 (1.50×) | 25/9 (2.78×) | 121/33 (3.65×) | 101/16 (6.28×) |
| nestedUpdate | 1 | —/213 (—) | 356/310 (1.15×) | 249/182 (1.37×) | 484/440 (1.10×) | 411/197 (2.09×) |
| delete | 1 | —/15 (—) | 44/33 (1.34×) | 21/8 (2.63×) | 117/49 (2.38×) | 51/12 (4.25×) |

### postgres — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | —/1518 (—) | 952/417 (2.28×) | 516/550 (0.94×) | 1936/1448 (1.34×) | 2345/460 (5.10×) |
| filterPaginateSort | 20 | —/1936 (—) | 2468/1417 (1.74×) | 789/722 (1.09×) | 1768/1397 (1.27×) | 1897/718 (2.64×) |
| findFirst | 1 | —/1496 (—) | 1454/746 (1.95×) | 452/274 (1.65×) | 644/577 (1.12×) | 786/280 (2.81×) |
| findUnique | 1 | —/381 (—) | 1253/283 (4.43×) | 524/267 (1.97×) | 767/508 (1.51×) | 647/238 (2.72×) |
| nestedFindAll | 1,100 | —/6094 (—) | 12049/5003 (2.41×) | 10587/3074 (3.44×) | 18894/13012 (1.45×) | 6261/2964 (2.11×) |
| nestedFindFirst | 11 | —/985 (—) | 2890/1848 (1.56×) | 1408/934 (1.51×) | 1659/4022 (0.41×) | 2329/1005 (2.32×) |
| nestedFindUnique | 11 | —/1544 (—) | 1465/1174 (1.25×) | 2461/967 (2.54×) | 1925/2017 (0.95×) | 2281/1114 (2.05×) |
| nestedRelations | 11,100 | —/25832 (—) | 35768/22751 (1.57×) | 113373/20041 (5.66×) | 188785/127257 (1.48×) | 58083/24811 (2.34×) |
| compositeRelations | 11,100 | —/26838 (—) | 48391/31896 (1.52×) | 113939/17786 (6.41×) | 233955/145119 (1.61×) | 74102/20573 (3.60×) |
| create | 0 | —/341 (—) | 329/286 (1.15×) | 1314/298 (4.42×) | 529/377 (1.40×) | 946/321 (2.95×) |
| update | 0 | —/567 (—) | 417/372 (1.12×) | 3143/299 (10.51×) | 542/334 (1.62×) | 1050/264 (3.98×) |
| upsert | 1 | —/330 (—) | 251/436 (0.57×) | 1673/303 (5.53×) | 465/422 (1.10×) | 838/247 (3.39×) |
| createMany | 0 | —/490 (—) | 453/623 (0.73×) | 939/426 (2.20×) | 1022/427 (2.40×) | 989/319 (3.11×) |
| upsertMany | 0 | —/642 (—) | 496/593 (0.84×) | 2398/407 (5.90×) | 1012/522 (1.94×) | 1103/436 (2.53×) |
| updateMany | 0 | —/438 (—) | 357/350 (1.02×) | 789/356 (2.22×) | 940/407 (2.31×) | 1066/439 (2.43×) |
| nestedCreate | 1 | —/4072 (—) | 2321/15263 (0.15×) | 3001/1265 (2.37×) | 1817/1417 (1.28×) | 1662/2969 (0.56×) |
| nestedUpsert | 1 | —/1307 (—) | 1152/14181 (0.08×) | 4564/1069 (4.27×) | 1776/1599 (1.11×) | 2040/1466 (1.39×) |
| nestedUpdate | 1 | —/1657 (—) | 2182/24206 (0.09×) | 16153/1646 (9.81×) | 2198/1985 (1.11×) | 2498/2477 (1.01×) |
| delete | 1 | —/1330 (—) | 1565/14392 (0.11×) | 14897/1469 (10.14×) | 1495/1320 (1.13×) | 1820/3905 (0.47×) |

### mysql — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python |
|----|--------:|----|----|----|----|
| findAll | 100 | —/977 (—) | —/1079 (—) | 1073/480 (2.24×) | 3471/— (—) |
| filterPaginateSort | 20 | —/2343 (—) | —/4120 (—) | 2429/4181 (0.58×) | 6779/— (—) |
| findFirst | 1 | —/426 (—) | —/1683 (—) | 693/1799 (0.39×) | 1775/— (—) |
| findUnique | 1 | —/395 (—) | —/1688 (—) | 571/575 (0.99×) | 1314/— (—) |
| nestedFindAll | 1,100 | —/5712 (—) | —/6746 (—) | 7350/5944 (1.24×) | 23229/— (—) |
| nestedFindFirst | 11 | —/1972 (—) | —/5396 (—) | 2302/3781 (0.61×) | 7615/— (—) |
| nestedFindUnique | 11 | —/1799 (—) | —/6318 (—) | 2983/3998 (0.75×) | 5644/— (—) |
| nestedRelations | 11,100 | —/24256 (—) | —/26856 (—) | 96756/19323 (5.01×) | 295355/— (—) |
| compositeRelations | 11,100 | —/3807784 (—) | —/3843443 (—) | 4679573/5077199 (0.92×) | 4470925/— (—) |
| create | 0 | —/698 (—) | —/339 (—) | 671/1046 (0.64×) | 824/— (—) |
| update | 0 | —/436 (—) | —/352 (—) | 822/574 (1.43×) | 938/— (—) |
| upsert | 1 | —/980 (—) | —/603 (—) | 1375/2516 (0.55×) | 1984/— (—) |
| createMany | 0 | —/1304 (—) | —/516 (—) | 1048/1549 (0.68×) | 989/— (—) |
| upsertMany | 0 | —/3930 (—) | —/482 (—) | 1005/1426 (0.70×) | 1585/— (—) |
| updateMany | 0 | —/913 (—) | —/427 (—) | 908/678 (1.34×) | 563/— (—) |
| nestedCreate | 1 | —/2563 (—) | —/1458 (—) | 1741/4667 (0.37×) | 2485/— (—) |
| nestedUpsert | 1 | —/1997 (—) | —/1421 (—) | 1589/2615 (0.61×) | 3634/— (—) |
| nestedUpdate | 1 | —/4904 (—) | —/3252 (—) | 5171/7387 (0.70×) | 4405/— (—) |
| delete | 1 | —/2107 (—) | —/2434 (—) | 4646/7411 (0.63×) | 5149/— (—) |

### sqlite — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | go | rust | python | php |
|----|--------:|----|----|----|----|
| findAll | 100 | 1,660/1,015 | 1,170/350 | 3,715/580 | 2,465/370 |
| filterPaginateSort | 20 | 63,500/67,175 | 44,150/39,575 | 69,300/61,800 | 60,075/43,325 |
| findFirst | 1 | 18,500/15,000 | 9,000/11,000 | 41,500/9,000 | 21,000/4,000 |
| findUnique | 1 | 14,000/9,000 | 6,000/1,000 | 35,000/4,000 | 20,500/2,000 |
| nestedFindAll | 1,100 | 5,112/1,387 | 4,058/719 | 6,734/2,100 | 3,740/931 |
| nestedFindFirst | 11 | 58,727/55,091 | 33,773/34,182 | 168,500/93,000 | 44,136/35,727 |
| nestedFindUnique | 11 | 66,909/54,864 | 33,045/34,045 | 98,955/88,000 | 40,864/34,409 |
| nestedRelations | 11,100 | 3,022/1,263 | 6,539/549 | 6,699/1,572 | 4,190/844 |
| compositeRelations | 11,100 | 6,604/4,267 | 10,302/1,783 | 9,617/3,430 | 6,319/2,322 |
| upsert | 1 | 28,000/20,500 | 16,000/6,000 | 51,500/18,000 | 31,000/10,000 |
| nestedCreate | 1 | 52,500/36,000 | 25,000/9,500 | 118,500/40,500 | 53,500/15,000 |
| nestedUpsert | 1 | 69,000/46,000 | 25,000/9,000 | 120,500/33,000 | 100,500/16,000 |
| nestedUpdate | 1 | 356,000/309,500 | 249,000/182,000 | 483,500/439,500 | 411,000/196,500 |
| delete | 1 | 43,500/32,500 | 21,000/8,000 | 116,500/49,000 | 51,000/12,000 |

### postgres — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | go | rust | python | php |
|----|--------:|----|----|----|----|
| findAll | 100 | 9,520/4,170 | 5,155/5,495 | 19,355/14,480 | 23,450/4,600 |
| filterPaginateSort | 20 | 123,375/70,825 | 39,425/36,075 | 88,400/69,850 | 94,825/35,875 |
| findFirst | 1 | 1,454,000/745,500 | 452,000/274,000 | 644,000/576,500 | 786,000/279,500 |
| findUnique | 1 | 1,252,500/283,000 | 524,000/266,500 | 766,500/508,000 | 646,500/238,000 |
| nestedFindAll | 1,100 | 10,953/4,548 | 9,625/2,794 | 17,176/11,829 | 5,692/2,694 |
| nestedFindFirst | 11 | 262,727/167,955 | 127,955/84,909 | 150,818/365,636 | 211,727/91,364 |
| nestedFindUnique | 11 | 133,136/106,727 | 223,727/87,909 | 174,955/183,318 | 207,364/101,273 |
| nestedRelations | 11,100 | 3,222/2,050 | 10,214/1,805 | 17,008/11,465 | 5,233/2,235 |
| compositeRelations | 11,100 | 4,360/2,874 | 10,265/1,602 | 21,077/13,074 | 6,676/1,853 |
| upsert | 1 | 250,500/436,000 | 1,673,000/302,500 | 464,500/422,000 | 837,500/247,000 |
| nestedCreate | 1 | 2,321,000/15,263,000 | 3,001,000/1,265,000 | 1,817,000/1,416,500 | 1,662,000/2,968,500 |
| nestedUpsert | 1 | 1,152,000/14,181,000 | 4,563,500/1,069,000 | 1,776,000/1,599,000 | 2,040,000/1,466,000 |
| nestedUpdate | 1 | 2,182,000/24,206,000 | 16,153,000/1,646,000 | 2,198,000/1,985,000 | 2,498,000/2,477,000 |
| delete | 1 | 1,564,500/14,392,000 | 14,897,000/1,469,000 | 1,495,000/1,320,000 | 1,819,500/3,905,000 |

### mysql — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | rust | python |
|----|--------:|----|----|
| findAll | 100 | 10,730/4,795 | 34,705/— |
| filterPaginateSort | 20 | 121,450/209,025 | 338,950/— |
| findFirst | 1 | 693,000/1,798,500 | 1,775,000/— |
| findUnique | 1 | 570,500/574,500 | 1,313,500/— |
| nestedFindAll | 1,100 | 6,681/5,403 | 21,117/— |
| nestedFindFirst | 11 | 209,227/343,682 | 692,273/— |
| nestedFindUnique | 11 | 271,136/363,455 | 513,045/— |
| nestedRelations | 11,100 | 8,717/1,741 | 26,609/— |
| compositeRelations | 11,100 | 421,583/457,405 | 402,786/— |
| upsert | 1 | 1,374,500/2,515,500 | 1,983,500/— |
| nestedCreate | 1 | 1,740,500/4,667,000 | 2,485,000/— |
| nestedUpsert | 1 | 1,589,000/2,614,500 | 3,634,000/— |
| nestedUpdate | 1 | 5,170,500/7,387,000 | 4,405,000/— |
| delete | 1 | 4,645,500/7,411,000 | 5,148,500/— |

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

No row-observing seam (reported as `—`, never as 0): typescript.v1

### coverage (rows collected)

typescript.native.sqlite @scale 1        SKIP (no data)
typescript.sdk.sqlite @scale 1           samples=190
typescript.native.postgres @scale 1      SKIP (no data)
typescript.sdk.postgres @scale 1         samples=190
typescript.native.mysql @scale 1         SKIP (no data)
typescript.sdk.mysql @scale 1            samples=190
go.native.sqlite @scale 1                samples=190
go.sdk.sqlite @scale 1                   samples=190
go.native.postgres @scale 1              samples=190
go.sdk.postgres @scale 1                 samples=190
go.native.mysql @scale 1                 SKIP (no data)
go.sdk.mysql @scale 1                    samples=190
rust.native.sqlite @scale 1              samples=190
rust.sdk.sqlite @scale 1                 samples=190
rust.native.postgres @scale 1            samples=190
rust.sdk.postgres @scale 1               samples=190
rust.native.mysql @scale 1               samples=190
rust.sdk.mysql @scale 1                  samples=190
python.native.sqlite @scale 1            samples=190
python.sdk.sqlite @scale 1               samples=190
python.native.postgres @scale 1          samples=190
python.sdk.postgres @scale 1             samples=190
python.native.mysql @scale 1             samples=190
python.sdk.mysql @scale 1                SKIP (no data)
php.native.sqlite @scale 1               samples=190
php.sdk.sqlite @scale 1                  samples=190
php.native.postgres @scale 1             samples=190
php.sdk.postgres @scale 1                samples=190
php.native.mysql @scale 1                SKIP (no data)
php.sdk.mysql @scale 1                   SKIP (no data)
