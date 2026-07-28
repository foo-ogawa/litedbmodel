# Cross-language ORM benchmark

Each language runs the SAME 19 ORM-comparison ops through TWO surfaces against the same database:
**native** = the litedbmodel-generated module over the shipped runtime; **sdk** = the same logical
operation hand-written against the raw driver, litedbmodel not in the path. Both reuse prepared
statements and bind params for reads and writes alike.

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
| findAll | 100 | —/48 (—) | 130/85 (1.52×) | 32/23 (1.39×) | 212/53 (3.99×) | 129/39 (3.31×) |
| filterPaginateSort | 20 | —/599 (—) | 1319/1305 (1.01×) | 590/586 (1.01×) | 580/524 (1.11×) | 658/629 (1.05×) |
| findFirst | 1 | —/10 (—) | 13/11 (1.18×) | 5/9 (0.56×) | 25/5 (5.00×) | 13/3 (4.33×) |
| findUnique | 1 | —/2 (—) | 8/7 (1.14×) | 3/0 (—) | 21/2 (10.50×) | 13/1 (13.00×) |
| nestedFindAll | 1,100 | —/682 (—) | 2133/1108 (1.93×) | 473/342 (1.38×) | 3634/862 (4.22×) | 1820/491 (3.71×) |
| nestedFindFirst | 11 | —/23 (—) | 58/48 (1.21×) | 22/14 (1.57×) | 108/26 (4.15×) | 57/14 (4.07×) |
| nestedFindUnique | 11 | —/13 (—) | 45/35 (1.29×) | 19/6 (3.08×) | 97/20 (4.85×) | 53/10 (5.30×) |
| nestedRelations | 11,100 | —/6871 (—) | 25436/12049 (2.11×) | 5847/4259 (1.37×) | 41672/9044 (4.61×) | 24531/4976 (4.93×) |
| compositeRelations | 11,100 | —/9863 (—) | 32249/15406 (2.09×) | 7526/5708 (1.32×) | 57037/12102 (4.71×) | 27212/7322 (3.72×) |
| create | 0 | —/4 (—) | 10/7 (1.43×) | 6/3 (2.00×) | 25/3 (8.33×) | 16/3 (5.17×) |
| update | 0 | —/1 (—) | 4/3 (1.33×) | 2/0 (—) | 20/1 (20.00×) | 12/0 (—) |
| upsert | 1 | —/6 (—) | 23/20 (1.15×) | 9/3 (3.00×) | 30/8 (3.75×) | 17/5 (3.40×) |
| createMany | 0 | —/23 (—) | 70/46 (1.51×) | 31/26 (1.19×) | 47/24 (1.96×) | 28/22 (1.27×) |
| upsertMany | 0 | —/24 (—) | 59/50 (1.18×) | 33/23 (1.43×) | 44/25 (1.76×) | 33/26 (1.27×) |
| updateMany | 0 | —/39 (—) | 116/90 (1.30×) | 53/37 (1.42×) | 69/46 (1.50×) | 46/50 (0.91×) |
| nestedCreate | 1 | —/11 (—) | 26/30 (0.87×) | 14/6 (2.33×) | 86/26 (3.29×) | 33/12 (2.75×) |
| nestedUpsert | 1 | —/9 (—) | 29/31 (0.95×) | 18/9 (2.12×) | 71/19 (3.74×) | 40/13 (3.08×) |
| nestedUpdate | 1 | —/10 (—) | 28/28 (1.02×) | 10/8 (1.25×) | 70/20 (3.50×) | 35/12 (2.92×) |
| delete | 1 | —/10 (—) | 29/35 (0.83×) | 16/5 (3.20×) | 85/33 (2.58×) | 39/9 (4.33×) |

### postgres — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 719/548 (1.31×) | 384/313 (1.23×) | 400/337 (1.19×) | 1425/349 (4.09×) | 848/292 (2.91×) |
| filterPaginateSort | 20 | 905/606 (1.49×) | 1008/825 (1.22×) | 680/674 (1.01×) | 1259/586 (2.15×) | 1082/565 (1.92×) |
| findFirst | 1 | 409/329 (1.24×) | 274/223 (1.23×) | 311/316 (0.98×) | 946/327 (2.89×) | 682/247 (2.76×) |
| findUnique | 1 | 317/390 (0.81×) | 267/264 (1.01×) | 264/284 (0.93×) | 864/248 (3.48×) | 1763/278 (6.35×) |
| nestedFindAll | 1,100 | 2180/1355 (1.61×) | 2192/1051 (2.09×) | 1635/1776 (0.92×) | 5972/1766 (3.38×) | 3729/1152 (3.24×) |
| nestedFindFirst | 11 | 845/497 (1.70×) | 626/477 (1.31×) | 553/631 (0.88×) | 922/664 (1.39×) | 1412/527 (2.68×) |
| nestedFindUnique | 11 | 643/482 (1.34×) | 545/513 (1.06×) | 531/528 (1.01×) | 836/533 (1.57×) | 1634/489 (3.34×) |
| nestedRelations | 11,100 | 15112/8081 (1.87×) | 22534/6549 (3.44×) | 12080/9570 (1.26×) | 62385/12106 (5.15×) | 37860/9802 (3.86×) |
| compositeRelations | 11,100 | 19302/11319 (1.71×) | 30049/8823 (3.41×) | 16153/11587 (1.39×) | 85680/15476 (5.54×) | 47112/11590 (4.07×) |
| create | 0 | 286/342 (0.84×) | 279/267 (1.04×) | 270/265 (1.02×) | 373/280 (1.33×) | 708/216 (3.29×) |
| update | 0 | 347/321 (1.08×) | 310/283 (1.09×) | 287/291 (0.99×) | 499/284 (1.76×) | 717/235 (3.05×) |
| upsert | 1 | 353/239 (1.48×) | 233/293 (0.79×) | 269/307 (0.88×) | 532/256 (2.08×) | 688/244 (2.82×) |
| createMany | 0 | 434/272 (1.60×) | 285/350 (0.81×) | 337/336 (1.00×) | 553/296 (1.87×) | 821/341 (2.41×) |
| upsertMany | 0 | 579/454 (1.28×) | 382/431 (0.89×) | 423/407 (1.04×) | 774/373 (2.08×) | 960/461 (2.08×) |
| updateMany | 0 | 488/392 (1.24×) | 281/290 (0.97×) | 330/357 (0.92×) | 653/382 (1.71×) | 942/347 (2.71×) |
| nestedCreate | 1 | 1134/1059 (1.07×) | 803/1671 (0.48×) | 893/921 (0.97×) | 1264/957 (1.32×) | 1394/875 (1.59×) |
| nestedUpsert | 1 | 1016/1047 (0.97×) | 920/1246 (0.74×) | 972/937 (1.04×) | 1183/1213 (0.98×) | 1356/859 (1.58×) |
| nestedUpdate | 1 | 1029/1235 (0.83×) | 1029/1533 (0.67×) | 919/955 (0.96×) | 1173/968 (1.21×) | 1399/915 (1.53×) |
| delete | 1 | 946/917 (1.03×) | 830/1452 (0.57×) | 1028/874 (1.18×) | 1073/939 (1.14×) | 1469/1010 (1.45×) |

### mysql — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 440/595 (0.74×) | 328/294 (1.12×) | 583/404 (1.44×) | 1156/1065 (1.08×) | 646/401 (1.61×) |
| filterPaginateSort | 20 | 1437/1259 (1.14×) | 1281/1167 (1.10×) | 1463/1196 (1.22×) | 1554/1354 (1.15×) | 1709/1238 (1.38×) |
| findFirst | 1 | 373/400 (0.93×) | 211/242 (0.87×) | 523/272 (1.92×) | 342/440 (0.78×) | 480/214 (2.24×) |
| findUnique | 1 | 421/310 (1.36×) | 221/286 (0.77×) | 555/222 (2.50×) | 573/381 (1.50×) | 482/252 (1.92×) |
| nestedFindAll | 1,100 | 2689/2034 (1.32×) | 2796/2226 (1.26×) | 3305/1757 (1.88×) | 10791/6638 (1.63×) | 4148/2306 (1.80×) |
| nestedFindFirst | 11 | 1024/594 (1.72×) | 510/494 (1.03×) | 1052/552 (1.91×) | 1341/1127 (1.19×) | 1001/539 (1.86×) |
| nestedFindUnique | 11 | 684/1139 (0.60×) | 507/484 (1.05×) | 1156/575 (2.01×) | 795/1111 (0.72×) | 1229/483 (2.54×) |
| nestedRelations | 11,100 | 22871/15005 (1.52×) | 28378/17264 (1.64×) | 24133/15217 (1.59×) | 129981/84875 (1.53×) | 35725/16707 (2.14×) |
| compositeRelations | 11,100 | 30649/19179 (1.60×) | 34415/20230 (1.70×) | 28047/20036 (1.40×) | 157131/92020 (1.71×) | 49478/20809 (2.38×) |
| create | 0 | 403/487 (0.83×) | 295/266 (1.11×) | 515/275 (1.88×) | 328/354 (0.93×) | 644/281 (2.29×) |
| update | 0 | 299/406 (0.74×) | 242/264 (0.92×) | 482/209 (2.31×) | 400/277 (1.44×) | 471/252 (1.87×) |
| upsert | 1 | 646/601 (1.07×) | 913/507 (1.80×) | 700/551 (1.27×) | 938/561 (1.67×) | 920/459 (2.00×) |
| createMany | 0 | 515/458 (1.13×) | 413/385 (1.07×) | 665/411 (1.62×) | 458/541 (0.85×) | 739/381 (1.94×) |
| upsertMany | 0 | 739/543 (1.36×) | 388/389 (1.00×) | 638/444 (1.44×) | 526/732 (0.72×) | 840/457 (1.84×) |
| updateMany | 0 | 533/348 (1.53×) | 295/258 (1.14×) | 553/320 (1.73×) | 508/325 (1.56×) | 546/251 (2.18×) |
| nestedCreate | 1 | 1180/1335 (0.88×) | 1492/1542 (0.97×) | 1090/1037 (1.05×) | 2026/1092 (1.85×) | 1567/872 (1.80×) |
| nestedUpsert | 1 | 2096/1393 (1.50×) | 1525/1588 (0.96×) | 1470/1116 (1.32×) | 1371/1227 (1.12×) | 1557/1201 (1.30×) |
| nestedUpdate | 1 | 1142/1177 (0.97×) | 1522/1402 (1.09×) | 1054/870 (1.21×) | 1890/1176 (1.61×) | 1688/669 (2.53×) |
| delete | 1 | 1329/1593 (0.83×) | 1557/1529 (1.02×) | 1198/950 (1.26×) | 1948/1082 (1.80×) | 2183/1150 (1.90×) |

### sqlite — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | go | rust | python | php |
|----|--------:|----|----|----|----|
| findAll | 100 | 1,295/850 | 320/230 | 2,115/530 | 1,290/390 |
| filterPaginateSort | 20 | 65,925/65,225 | 29,500/29,300 | 28,975/26,200 | 32,900/31,450 |
| findFirst | 1 | 13,000/11,000 | 5,000/9,000 | 25,000/5,000 | 13,000/3,000 |
| findUnique | 1 | 8,000/7,000 | 3,000/0 | 21,000/2,000 | 13,000/1,000 |
| nestedFindAll | 1,100 | 1,939/1,007 | 430/311 | 3,304/783 | 1,655/446 |
| nestedFindFirst | 11 | 5,273/4,364 | 2,000/1,273 | 9,818/2,364 | 5,182/1,273 |
| nestedFindUnique | 11 | 4,091/3,182 | 1,682/545 | 8,818/1,818 | 4,818/909 |
| nestedRelations | 11,100 | 2,292/1,085 | 527/384 | 3,754/815 | 2,210/448 |
| compositeRelations | 11,100 | 2,905/1,388 | 678/514 | 5,138/1,090 | 2,452/660 |
| upsert | 1 | 23,000/20,000 | 9,000/3,000 | 30,000/8,000 | 17,000/5,000 |
| nestedCreate | 1 | 26,000/30,000 | 14,000/6,000 | 85,500/26,000 | 33,000/12,000 |
| nestedUpsert | 1 | 29,000/30,500 | 18,000/8,500 | 71,000/19,000 | 40,000/13,000 |
| nestedUpdate | 1 | 28,000/27,500 | 10,000/8,000 | 70,000/20,000 | 35,000/12,000 |
| delete | 1 | 29,000/35,000 | 16,000/5,000 | 85,000/33,000 | 39,000/9,000 |

### postgres — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 7,190/5,475 | 3,835/3,130 | 3,995/3,365 | 14,250/3,485 | 8,475/2,915 |
| filterPaginateSort | 20 | 45,250/30,300 | 50,400/41,225 | 34,000/33,675 | 62,925/29,275 | 54,075/28,225 |
| findFirst | 1 | 408,500/328,500 | 274,000/222,500 | 311,000/316,000 | 945,500/327,000 | 681,500/247,000 |
| findUnique | 1 | 317,000/389,500 | 266,500/264,000 | 263,500/283,500 | 863,500/248,000 | 1,762,500/277,500 |
| nestedFindAll | 1,100 | 1,982/1,232 | 1,992/955 | 1,486/1,615 | 5,429/1,605 | 3,390/1,047 |
| nestedFindFirst | 11 | 76,818/45,136 | 56,864/43,364 | 50,227/57,318 | 83,773/60,318 | 128,318/47,909 |
| nestedFindUnique | 11 | 58,455/43,773 | 49,500/46,636 | 48,273/48,000 | 75,955/48,455 | 148,545/44,409 |
| nestedRelations | 11,100 | 1,361/728 | 2,030/590 | 1,088/862 | 5,620/1,091 | 3,411/883 |
| compositeRelations | 11,100 | 1,739/1,020 | 2,707/795 | 1,455/1,044 | 7,719/1,394 | 4,244/1,044 |
| upsert | 1 | 353,000/238,500 | 232,500/292,500 | 268,500/306,500 | 531,500/255,500 | 687,500/243,500 |
| nestedCreate | 1 | 1,133,500/1,059,000 | 803,000/1,670,500 | 892,500/920,500 | 1,264,000/956,500 | 1,394,000/874,500 |
| nestedUpsert | 1 | 1,015,500/1,046,500 | 919,500/1,246,000 | 971,500/937,000 | 1,183,000/1,213,000 | 1,355,500/858,500 |
| nestedUpdate | 1 | 1,028,500/1,234,500 | 1,029,000/1,533,000 | 918,500/955,000 | 1,172,500/967,500 | 1,399,000/915,000 |
| delete | 1 | 946,000/917,000 | 830,000/1,452,000 | 1,027,500/873,500 | 1,072,500/939,000 | 1,468,500/1,009,500 |

### mysql — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 4,395/5,950 | 3,280/2,935 | 5,830/4,035 | 11,555/10,650 | 6,460/4,010 |
| filterPaginateSort | 20 | 71,850/62,925 | 64,025/58,350 | 73,125/59,775 | 77,675/67,700 | 85,450/61,875 |
| findFirst | 1 | 373,000/399,500 | 210,500/241,500 | 523,000/272,000 | 342,000/440,000 | 480,000/214,000 |
| findUnique | 1 | 420,500/309,500 | 221,000/285,500 | 554,500/221,500 | 572,500/381,000 | 482,000/251,500 |
| nestedFindAll | 1,100 | 2,445/1,849 | 2,542/2,024 | 3,004/1,597 | 9,810/6,035 | 3,771/2,096 |
| nestedFindFirst | 11 | 93,091/54,000 | 46,364/44,909 | 95,636/50,136 | 121,909/102,455 | 90,955/49,000 |
| nestedFindUnique | 11 | 62,182/103,500 | 46,091/44,000 | 105,091/52,227 | 72,227/101,000 | 111,682/43,909 |
| nestedRelations | 11,100 | 2,060/1,352 | 2,557/1,555 | 2,174/1,371 | 11,710/7,646 | 3,218/1,505 |
| compositeRelations | 11,100 | 2,761/1,728 | 3,100/1,823 | 2,527/1,805 | 14,156/8,290 | 4,457/1,875 |
| upsert | 1 | 645,500/600,500 | 913,000/506,500 | 700,000/551,000 | 938,000/560,500 | 920,000/459,000 |
| nestedCreate | 1 | 1,180,000/1,335,000 | 1,491,500/1,541,500 | 1,090,000/1,036,500 | 2,025,500/1,092,000 | 1,566,500/871,500 |
| nestedUpsert | 1 | 2,095,500/1,392,500 | 1,525,000/1,587,500 | 1,469,500/1,116,000 | 1,371,000/1,227,000 | 1,557,000/1,201,000 |
| nestedUpdate | 1 | 1,141,500/1,176,500 | 1,522,000/1,402,000 | 1,053,500/870,000 | 1,889,500/1,175,500 | 1,688,000/668,500 |
| delete | 1 | 1,328,500/1,592,500 | 1,557,000/1,528,500 | 1,197,500/949,500 | 1,947,500/1,081,500 | 2,182,500/1,149,500 |

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
typescript.sdk.sqlite @scale 1           samples=570
typescript.native.postgres @scale 1      samples=570
typescript.sdk.postgres @scale 1         samples=570
typescript.native.mysql @scale 1         samples=570
typescript.sdk.mysql @scale 1            samples=570
go.native.sqlite @scale 1                samples=570
go.sdk.sqlite @scale 1                   samples=570
go.native.postgres @scale 1              samples=570
go.sdk.postgres @scale 1                 samples=570
go.native.mysql @scale 1                 samples=570
go.sdk.mysql @scale 1                    samples=570
rust.native.sqlite @scale 1              samples=570
rust.sdk.sqlite @scale 1                 samples=570
rust.native.postgres @scale 1            samples=570
rust.sdk.postgres @scale 1               samples=570
rust.native.mysql @scale 1               samples=570
rust.sdk.mysql @scale 1                  samples=570
python.native.sqlite @scale 1            samples=570
python.sdk.sqlite @scale 1               samples=570
python.native.postgres @scale 1          samples=570
python.sdk.postgres @scale 1             samples=570
python.native.mysql @scale 1             samples=570
python.sdk.mysql @scale 1                samples=570
php.native.sqlite @scale 1               samples=570
php.sdk.sqlite @scale 1                  samples=570
php.native.postgres @scale 1             samples=570
php.sdk.postgres @scale 1                samples=570
php.native.mysql @scale 1                samples=570
php.sdk.mysql @scale 1                   samples=570
