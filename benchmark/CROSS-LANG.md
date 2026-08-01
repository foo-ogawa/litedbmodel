# Cross-language ORM benchmark

Each language runs the SAME 19 ORM-comparison ops through TWO surfaces against the same database:
**native** = the litedbmodel-generated module over the shipped runtime; **sdk** = the same logical
operation hand-written against the raw driver, litedbmodel not in the path. Both bind params for reads
and writes alike, and every SDK cell reuses its prepared statements — so does every native runtime
EXCEPT php, which prepares each statement afresh. Read the php native column knowing it pays a parse
its own SDK column does not.

What the codegen buys is **cross-language**: ONE TypeScript model declaration generates the native module
for go, rust, python and php too — that is the differentiator this table exists to measure. Within
TypeScript, `native` (codegen) versus the imperative `runtime` DBModel path is only an execution-mode
choice, not a differentiator, since the authoring language is already TypeScript.

The fixture is the one `benchmark/setup.ts` seeds for the ORM-vs-ORM bench — 1,000 users, 5,500 posts,
10,000 comments, plus the composite-key tenant graph (10 tenants, 1,000 tenant_users, 10,000 tenant_posts,
100,000 tenant_comments), 127,510 rows in all. It is re-applied before every op. The relation ops therefore
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
| findAll | 100 | —/51 (—) | 130/93 (1.40×) | 31/27 (1.15×) | 214/53 (4.04×) | 132/38 (3.47×) |
| filterPaginateSort | 20 | —/576 (—) | 1275/1261 (1.01×) | 555/588 (0.94×) | 582/507 (1.15×) | 653/612 (1.07×) |
| findFirst | 1 | —/9 (—) | 16/14 (1.14×) | 6/9 (0.67×) | 27/6 (4.50×) | 17/5 (3.40×) |
| findUnique | 1 | —/2 (—) | 9/7 (1.29×) | 3/1 (3.00×) | 23/3 (7.67×) | 14/1 (14.00×) |
| nestedFindAll | 1,100 | —/706 (—) | 2021/1120 (1.80×) | 488/336 (1.45×) | 3700/846 (4.37×) | 1882/481 (3.91×) |
| nestedFindFirst | 11 | —/20 (—) | 60/45 (1.33×) | 19/17 (1.12×) | 111/26 (4.27×) | 59/13 (4.54×) |
| nestedFindUnique | 11 | —/13 (—) | 53/39 (1.36×) | 19/8 (2.38×) | 107/20 (5.35×) | 56/10 (5.60×) |
| nestedRelations | 11,100 | —/6811 (—) | 25111/11540 (2.18×) | 5482/4063 (1.35×) | 40172/8987 (4.47×) | 20685/4806 (4.30×) |
| compositeRelations | 11,100 | —/8966 (—) | 30634/15071 (2.03×) | 7384/5197 (1.42×) | 53715/11328 (4.74×) | 27252/7226 (3.77×) |
| create | 0 | —/5 (—) | 11/8 (1.38×) | 6/3 (2.00×) | 30/4 (7.50×) | 19/3 (6.33×) |
| update | 0 | —/2 (—) | 6/4 (1.50×) | 2/1 (2.00×) | 29/2 (14.50×) | 16/1 (16.00×) |
| upsert | 1 | —/5 (—) | 17/19 (0.89×) | 11/4 (2.75×) | 36/11 (3.27×) | 26/7 (4.00×) |
| createMany | 0 | —/24 (—) | 56/46 (1.22×) | 35/26 (1.35×) | 57/29 (1.97×) | 38/24 (1.58×) |
| upsertMany | 0 | —/23 (—) | 56/48 (1.17×) | 37/28 (1.32×) | 57/31 (1.84×) | 44/30 (1.47×) |
| updateMany | 0 | —/37 (—) | 110/89 (1.24×) | 54/39 (1.38×) | 82/51 (1.61×) | 58/56 (1.04×) |
| nestedCreate | 1 | —/13 (—) | 33/32 (1.03×) | 18/8 (2.25×) | 99/28 (3.52×) | 44/11 (4.00×) |
| nestedUpsert | 1 | —/10 (—) | 36/34 (1.06×) | 19/9 (2.11×) | 89/21 (4.24×) | 45/13 (3.46×) |
| nestedUpdate | 1 | —/12 (—) | 29/27 (1.07×) | 14/9 (1.56×) | 87/22 (3.95×) | 41/14 (2.93×) |
| delete | 1 | —/9 (—) | 35/34 (1.03×) | 18/6 (3.00×) | 98/32 (3.06×) | 44/9 (4.89×) |

### postgres — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 436/442 (0.99×) | 337/301 (1.12×) | 359/332 (1.08×) | 649/414 (1.57×) | 1076/393 (2.74×) |
| filterPaginateSort | 20 | 908/637 (1.42×) | 976/942 (1.04×) | 669/684 (0.98×) | 1037/709 (1.46×) | 1035/606 (1.71×) |
| findFirst | 1 | 372/379 (0.98×) | 272/257 (1.06×) | 316/271 (1.17×) | 549/409 (1.34×) | 725/289 (2.51×) |
| findUnique | 1 | 375/388 (0.97×) | 251/281 (0.89×) | 272/253 (1.07×) | 590/228 (2.59×) | 496/267 (1.86×) |
| nestedFindAll | 1,100 | 1938/1224 (1.58×) | 2019/1010 (2.00×) | 1500/1607 (0.93×) | 5847/1705 (3.43×) | 3520/1537 (2.29×) |
| nestedFindFirst | 11 | 973/650 (1.50×) | 495/498 (0.99×) | 424/488 (0.87×) | 796/721 (1.10×) | 1015/531 (1.91×) |
| nestedFindUnique | 11 | 549/637 (0.86×) | 398/481 (0.83×) | 482/455 (1.06×) | 1070/695 (1.54×) | 1179/522 (2.26×) |
| nestedRelations | 11,100 | 13851/7878 (1.76×) | 22317/7205 (3.10×) | 11617/7774 (1.49×) | 61895/11464 (5.40×) | 32773/7274 (4.51×) |
| compositeRelations | 11,100 | 18711/11153 (1.68×) | 25469/8615 (2.96×) | 15367/10619 (1.45×) | 82049/14863 (5.52×) | 41403/10600 (3.91×) |
| create | 0 | 333/312 (1.07×) | 248/264 (0.94×) | 239/253 (0.94×) | 510/432 (1.18×) | 692/267 (2.59×) |
| update | 0 | 392/398 (0.98×) | 342/261 (1.31×) | 230/262 (0.88×) | 452/260 (1.74×) | 681/360 (1.89×) |
| upsert | 1 | 432/324 (1.33×) | 251/248 (1.01×) | 274/253 (1.08×) | 401/275 (1.46×) | 742/334 (2.22×) |
| createMany | 0 | 369/330 (1.12×) | 342/331 (1.03×) | 331/317 (1.05×) | 718/417 (1.72×) | 2402/306 (7.85×) |
| upsertMany | 0 | 577/487 (1.18×) | 407/382 (1.07×) | 462/572 (0.81×) | 1705/500 (3.41×) | 986/324 (3.05×) |
| updateMany | 0 | 326/329 (0.99×) | 297/276 (1.08×) | 289/304 (0.95×) | 1077/445 (2.42×) | 941/311 (3.03×) |
| nestedCreate | 1 | 809/764 (1.06×) | 665/1376 (0.48×) | 766/740 (1.04×) | 901/1014 (0.89×) | 1375/702 (1.96×) |
| nestedUpsert | 1 | 1128/809 (1.39×) | 734/1040 (0.71×) | 767/750 (1.02×) | 948/773 (1.23×) | 1470/692 (2.13×) |
| nestedUpdate | 1 | 852/760 (1.12×) | 723/1383 (0.52×) | 758/745 (1.02×) | 928/770 (1.21×) | 1392/697 (2.00×) |
| delete | 1 | 734/749 (0.98×) | 710/1362 (0.52×) | 913/733 (1.25×) | 1062/807 (1.32×) | 1364/723 (1.89×) |

### mysql — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 545/407 (1.34×) | 265/275 (0.96×) | 584/377 (1.55×) | 1469/738 (1.99×) | 672/371 (1.81×) |
| filterPaginateSort | 20 | 1669/1769 (0.94×) | 1157/1240 (0.93×) | 1561/1271 (1.23×) | 1960/2043 (0.96×) | 1750/1196 (1.46×) |
| findFirst | 1 | 402/394 (1.02×) | 180/259 (0.69×) | 464/279 (1.67×) | 714/314 (2.28×) | 563/260 (2.17×) |
| findUnique | 1 | 393/289 (1.36×) | 257/260 (0.99×) | 483/328 (1.47×) | 423/297 (1.42×) | 408/287 (1.42×) |
| nestedFindAll | 1,100 | 2793/2399 (1.16×) | 2933/2271 (1.29×) | 3001/2788 (1.08×) | 14684/7924 (1.85×) | 4294/2533 (1.70×) |
| nestedFindFirst | 11 | 1120/853 (1.31×) | 507/499 (1.02×) | 827/367 (2.25×) | 2921/999 (2.92×) | 1335/559 (2.39×) |
| nestedFindUnique | 11 | 658/604 (1.09×) | 539/565 (0.95×) | 840/533 (1.58×) | 1328/723 (1.84×) | 1249/585 (2.14×) |
| nestedRelations | 11,100 | 22263/15278 (1.46×) | 28506/15772 (1.81×) | 23635/16760 (1.41×) | 128126/69192 (1.85×) | 33694/15573 (2.16×) |
| compositeRelations | 11,100 | 27881/19411 (1.44×) | 34163/19422 (1.76×) | 28107/20999 (1.34×) | 132946/87070 (1.53×) | 42017/21653 (1.94×) |
| create | 0 | 322/400 (0.80×) | 278/273 (1.02×) | 492/249 (1.97×) | 535/384 (1.39×) | 469/310 (1.51×) |
| update | 0 | 371/401 (0.93×) | 279/286 (0.97×) | 508/322 (1.58×) | 573/399 (1.44×) | 553/333 (1.66×) |
| upsert | 1 | 1136/992 (1.14×) | 1017/387 (2.63×) | 603/457 (1.32×) | 631/986 (0.64×) | 1043/494 (2.11×) |
| createMany | 0 | 565/376 (1.50×) | 419/366 (1.15×) | 586/444 (1.32×) | 1261/656 (1.92×) | 714/395 (1.81×) |
| upsertMany | 0 | 631/878 (0.72×) | 451/458 (0.98×) | 884/590 (1.50×) | 878/629 (1.40×) | 777/448 (1.73×) |
| updateMany | 0 | 424/563 (0.75×) | 430/436 (0.99×) | 595/415 (1.43×) | 881/438 (2.01×) | 675/354 (1.91×) |
| nestedCreate | 1 | 1181/1167 (1.01×) | 1506/1372 (1.10×) | 1198/1121 (1.07×) | 1793/1177 (1.52×) | 1551/846 (1.83×) |
| nestedUpsert | 1 | 1250/1132 (1.10×) | 1407/1501 (0.94×) | 1108/855 (1.30×) | 1261/1151 (1.10×) | 1531/907 (1.69×) |
| nestedUpdate | 1 | 1165/1216 (0.96×) | 1506/1500 (1.00×) | 1067/886 (1.20×) | 1142/1387 (0.82×) | 1566/1051 (1.49×) |
| delete | 1 | 1172/1107 (1.06×) | 1666/1416 (1.18×) | 1329/918 (1.45×) | 3533/1133 (3.12×) | 1540/940 (1.64×) |

### sqlite — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | go | rust | python | php |
|----|--------:|----|----|----|----|
| findAll | 100 | 1,300/930 | 310/270 | 2,140/530 | 1,320/380 |
| filterPaginateSort | 20 | 63,725/63,050 | 27,725/29,400 | 29,100/25,325 | 32,650/30,575 |
| findFirst | 1 | 16,000/14,000 | 6,000/9,000 | 27,000/6,000 | 17,000/5,000 |
| findUnique | 1 | 9,000/7,000 | 3,000/1,000 | 23,000/3,000 | 14,000/1,000 |
| nestedFindAll | 1,100 | 1,837/1,018 | 444/305 | 3,364/769 | 1,710/437 |
| nestedFindFirst | 11 | 5,455/4,091 | 1,727/1,545 | 10,091/2,364 | 5,364/1,182 |
| nestedFindUnique | 11 | 4,818/3,545 | 1,727/727 | 9,727/1,818 | 5,091/909 |
| nestedRelations | 11,100 | 2,262/1,040 | 494/366 | 3,619/810 | 1,864/433 |
| compositeRelations | 11,100 | 2,760/1,358 | 665/468 | 4,839/1,021 | 2,455/651 |
| upsert | 1 | 17,000/19,000 | 11,000/4,000 | 36,000/11,000 | 26,000/6,500 |
| nestedCreate | 1 | 33,000/32,000 | 18,000/8,000 | 98,500/28,000 | 44,000/11,000 |
| nestedUpsert | 1 | 36,000/34,000 | 19,000/9,000 | 89,000/21,000 | 45,000/13,000 |
| nestedUpdate | 1 | 29,000/27,000 | 14,000/9,000 | 87,000/22,000 | 41,000/14,000 |
| delete | 1 | 35,000/34,000 | 18,000/6,000 | 98,000/32,000 | 44,000/9,000 |

### postgres — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 4,355/4,420 | 3,365/3,010 | 3,585/3,315 | 6,485/4,140 | 10,760/3,930 |
| filterPaginateSort | 20 | 45,375/31,850 | 48,775/47,100 | 33,450/34,175 | 51,850/35,425 | 51,725/30,275 |
| findFirst | 1 | 372,000/378,500 | 272,000/256,500 | 316,000/271,000 | 548,500/409,000 | 724,500/288,500 |
| findUnique | 1 | 375,000/387,500 | 251,000/280,500 | 271,500/253,000 | 589,500/227,500 | 496,000/267,000 |
| nestedFindAll | 1,100 | 1,762/1,113 | 1,835/918 | 1,363/1,460 | 5,315/1,550 | 3,200/1,397 |
| nestedFindFirst | 11 | 88,455/59,045 | 44,955/45,273 | 38,500/44,318 | 72,364/65,545 | 92,273/48,227 |
| nestedFindUnique | 11 | 49,864/57,864 | 36,136/43,682 | 43,773/41,318 | 97,273/63,182 | 107,182/47,409 |
| nestedRelations | 11,100 | 1,248/710 | 2,011/649 | 1,047/700 | 5,576/1,033 | 2,953/655 |
| compositeRelations | 11,100 | 1,686/1,005 | 2,295/776 | 1,384/957 | 7,392/1,339 | 3,730/955 |
| upsert | 1 | 431,500/324,000 | 250,500/248,000 | 273,500/253,000 | 400,500/275,000 | 742,000/333,500 |
| nestedCreate | 1 | 809,000/764,000 | 664,500/1,376,000 | 766,000/740,000 | 901,000/1,014,000 | 1,375,000/702,000 |
| nestedUpsert | 1 | 1,128,000/809,000 | 733,500/1,040,000 | 767,000/749,500 | 948,000/773,000 | 1,470,000/691,500 |
| nestedUpdate | 1 | 852,000/759,500 | 723,000/1,383,000 | 758,000/744,500 | 928,000/770,000 | 1,391,500/697,000 |
| delete | 1 | 733,500/749,000 | 709,500/1,361,500 | 912,500/732,500 | 1,062,000/806,500 | 1,363,500/722,500 |

### mysql — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 5,445/4,070 | 2,645/2,745 | 5,840/3,770 | 14,685/7,375 | 6,715/3,710 |
| filterPaginateSort | 20 | 83,450/88,450 | 57,825/61,975 | 78,050/63,525 | 97,975/102,150 | 87,500/59,800 |
| findFirst | 1 | 402,000/394,000 | 179,500/259,000 | 464,000/278,500 | 714,000/313,500 | 563,000/259,500 |
| findUnique | 1 | 393,000/289,000 | 256,500/259,500 | 483,000/328,000 | 422,500/296,500 | 408,000/287,000 |
| nestedFindAll | 1,100 | 2,539/2,181 | 2,666/2,065 | 2,728/2,534 | 13,349/7,204 | 3,904/2,303 |
| nestedFindFirst | 11 | 101,818/77,545 | 46,045/45,318 | 75,136/33,364 | 265,545/90,818 | 121,364/50,818 |
| nestedFindUnique | 11 | 59,818/54,909 | 49,000/51,318 | 76,318/48,409 | 120,727/65,682 | 113,500/53,136 |
| nestedRelations | 11,100 | 2,006/1,376 | 2,568/1,421 | 2,129/1,510 | 11,543/6,234 | 3,035/1,403 |
| compositeRelations | 11,100 | 2,512/1,749 | 3,078/1,750 | 2,532/1,892 | 11,977/7,844 | 3,785/1,951 |
| upsert | 1 | 1,135,500/992,000 | 1,016,500/387,000 | 603,000/456,500 | 630,500/985,500 | 1,043,000/494,000 |
| nestedCreate | 1 | 1,180,500/1,166,500 | 1,505,500/1,372,000 | 1,198,000/1,120,500 | 1,793,000/1,176,500 | 1,550,500/845,500 |
| nestedUpsert | 1 | 1,249,500/1,132,000 | 1,406,500/1,501,000 | 1,107,500/854,500 | 1,261,000/1,150,500 | 1,530,500/907,000 |
| nestedUpdate | 1 | 1,164,500/1,216,000 | 1,505,500/1,499,500 | 1,066,500/886,000 | 1,142,000/1,387,000 | 1,565,500/1,050,500 |
| delete | 1 | 1,172,000/1,107,000 | 1,666,000/1,416,000 | 1,329,000/917,500 | 3,533,000/1,132,500 | 1,539,500/939,500 |

### fixed overhead vs per-row cost

Not separable from ONE scale (1). Re-emit the fixture at another scale and
re-run the cells into `results/scale-<factor>/`:

```bash
npx tsx benchmark/crosslang/emit-setup.ts 0.1   # then re-run the cells → results/scale-0.1/
```

### fairness — rows/op agreement across cells

Every cell that can observe rows reports the SAME rows/op for every op × dialect.

### coverage (rows collected)

typescript.native.sqlite @scale 1        SKIP (no data)
typescript.sdk.sqlite @scale 1           samples=1140
typescript.native.postgres @scale 1      samples=1140
typescript.sdk.postgres @scale 1         samples=1140
typescript.native.mysql @scale 1         samples=1140
typescript.sdk.mysql @scale 1            samples=1140
go.native.sqlite @scale 1                samples=1140
go.sdk.sqlite @scale 1                   samples=1140
go.native.postgres @scale 1              samples=1140
go.sdk.postgres @scale 1                 samples=1140
go.native.mysql @scale 1                 samples=1140
go.sdk.mysql @scale 1                    samples=1140
rust.native.sqlite @scale 1              samples=1140
rust.sdk.sqlite @scale 1                 samples=1140
rust.native.postgres @scale 1            samples=1140
rust.sdk.postgres @scale 1               samples=1140
rust.native.mysql @scale 1               samples=1140
rust.sdk.mysql @scale 1                  samples=1140
python.native.sqlite @scale 1            samples=1140
python.sdk.sqlite @scale 1               samples=1140
python.native.postgres @scale 1          samples=1140
python.sdk.postgres @scale 1             samples=1140
python.native.mysql @scale 1             samples=1140
python.sdk.mysql @scale 1                samples=1140
php.native.sqlite @scale 1               samples=1140
php.sdk.sqlite @scale 1                  samples=1140
php.native.postgres @scale 1             samples=1140
php.sdk.postgres @scale 1                samples=1140
php.native.mysql @scale 1                samples=1140
php.sdk.mysql @scale 1                   samples=1140
