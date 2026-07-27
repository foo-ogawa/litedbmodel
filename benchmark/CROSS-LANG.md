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
| findAll | 100 | —/51 (—) | 131/93 (1.40×) | 32/22 (1.45×) | 208/58 (3.62×) | 154/35 (4.39×) |
| filterPaginateSort | 20 | —/599 (—) | 1291/1307 (0.99×) | 582/592 (0.98×) | 608/528 (1.15×) | 652/644 (1.01×) |
| findFirst | 1 | —/7 (—) | 13/10 (1.30×) | 5/6 (0.83×) | 25/5 (4.90×) | 13/3 (4.33×) |
| findUnique | 1 | —/2 (—) | 8/6 (1.33×) | 2/1 (4.00×) | 23/2 (11.50×) | 12/1 (12.00×) |
| nestedFindAll | 1,100 | —/674 (—) | 2133/1135 (1.88×) | 507/335 (1.52×) | 3617/956 (3.78×) | 1922/461 (4.17×) |
| nestedFindFirst | 11 | —/21 (—) | 54/38 (1.42×) | 18/13 (1.35×) | 113/25 (4.52×) | 53/12 (4.42×) |
| nestedFindUnique | 11 | —/14 (—) | 53/34 (1.56×) | 17/6 (2.75×) | 96/22 (4.36×) | 54/8 (6.69×) |
| nestedRelations | 11,100 | —/6952 (—) | 27926/12205 (2.29×) | 6055/4307 (1.41×) | 41745/10008 (4.17×) | 23005/5389 (4.27×) |
| compositeRelations | 11,100 | —/9394 (—) | 34676/15211 (2.28×) | 7889/5578 (1.41×) | 57157/12159 (4.70×) | 29318/8291 (3.54×) |
| create | 0 | —/3 (—) | 8/6 (1.33×) | 4/2 (2.00×) | 22/3 (7.33×) | 14/3 (4.67×) |
| update | 0 | —/1 (—) | 4/3 (1.33×) | 2/0 (—) | 20/1 (20.00×) | 10/0 (—) |
| upsert | 1 | —/5 (—) | 27/22 (1.23×) | 8/3 (2.67×) | 28/8 (3.50×) | 19/5 (3.80×) |
| createMany | 0 | —/23 (—) | 61/53 (1.15×) | 28/23 (1.24×) | 42/24 (1.75×) | 32/21 (1.54×) |
| upsertMany | 0 | —/20 (—) | 59/46 (1.27×) | 28/23 (1.22×) | 45/27 (1.70×) | 35/26 (1.35×) |
| updateMany | 0 | —/41 (—) | 121/88 (1.38×) | 48/31 (1.55×) | 71/48 (1.47×) | 49/51 (0.96×) |
| nestedCreate | 1 | —/11 (—) | 31/33 (0.92×) | 17/6 (2.75×) | 82/25 (3.28×) | 33/10 (3.47×) |
| nestedUpsert | 1 | —/10 (—) | 36/34 (1.04×) | 15/6 (2.50×) | 71/21 (3.38×) | 38/10 (3.80×) |
| nestedUpdate | 1 | —/10 (—) | 25/27 (0.93×) | 10/7 (1.43×) | 76/19 (4.00×) | 32/11 (2.91×) |
| delete | 1 | —/8 (—) | 30/32 (0.95×) | 16/4 (3.88×) | 100/32 (3.17×) | 38/7 (5.43×) |

### postgres — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 498/385 (1.29×) | 361/343 (1.05×) | 376/434 (0.87×) | 714/327 (2.18×) | 917/283 (3.24×) |
| filterPaginateSort | 20 | 730/850 (0.86×) | 810/930 (0.87×) | 688/675 (1.02×) | 919/682 (1.35×) | 1237/640 (1.93×) |
| findFirst | 1 | 328/300 (1.09×) | 302/300 (1.01×) | 273/289 (0.94×) | 353/357 (0.99×) | 693/297 (2.34×) |
| findUnique | 1 | 322/333 (0.97×) | 279/233 (1.20×) | 264/251 (1.05×) | 359/363 (0.99×) | 740/270 (2.74×) |
| nestedFindAll | 1,100 | 1943/1456 (1.33×) | 2249/1143 (1.97×) | 1693/1820 (0.93×) | 5831/1984 (2.94×) | 3700/1139 (3.25×) |
| nestedFindFirst | 11 | 681/614 (1.11×) | 598/609 (0.98×) | 583/579 (1.01×) | 1349/662 (2.04×) | 1371/493 (2.78×) |
| nestedFindUnique | 11 | 662/680 (0.97×) | 552/677 (0.81×) | 583/572 (1.02×) | 774/512 (1.51×) | 1685/493 (3.42×) |
| nestedRelations | 11,100 | 15742/15569 (1.01×) | 22597/5922 (3.82×) | 12257/8636 (1.42×) | 54379/12227 (4.45×) | 36758/8380 (4.39×) |
| compositeRelations | 11,100 | 21059/18133 (1.16×) | 26389/8720 (3.03×) | 15667/11776 (1.33×) | 72810/16143 (4.51×) | 44591/11090 (4.02×) |
| create | 0 | 310/313 (0.99×) | 281/202 (1.39×) | 247/253 (0.98×) | 449/320 (1.40×) | 767/272 (2.82×) |
| update | 0 | 336/350 (0.96×) | 269/295 (0.91×) | 277/281 (0.99×) | 470/320 (1.47×) | 748/295 (2.54×) |
| upsert | 1 | 381/404 (0.94×) | 284/283 (1.01×) | 310/293 (1.06×) | 741/350 (2.12×) | 1140/279 (4.09×) |
| createMany | 0 | 485/459 (1.06×) | 384/350 (1.10×) | 381/394 (0.97×) | 637/402 (1.59×) | 1044/300 (3.48×) |
| upsertMany | 0 | 472/460 (1.03×) | 437/403 (1.09×) | 505/418 (1.21×) | 666/485 (1.37×) | 1596/357 (4.47×) |
| updateMany | 0 | 959/381 (2.52×) | 357/304 (1.17×) | 271/317 (0.86×) | 630/283 (2.23×) | 1156/315 (3.67×) |
| nestedCreate | 1 | 1168/893 (1.31×) | 982/1743 (0.56×) | 1163/1314 (0.89×) | 1533/897 (1.71×) | 1350/998 (1.35×) |
| nestedUpsert | 1 | 1055/924 (1.14×) | 913/1376 (0.66×) | 1016/1100 (0.92×) | 1089/1200 (0.91×) | 1853/954 (1.94×) |
| nestedUpdate | 1 | 1218/1259 (0.97×) | 928/1727 (0.54×) | 1090/1168 (0.93×) | 1406/1114 (1.26×) | 1421/967 (1.47×) |
| delete | 1 | 1224/1488 (0.82×) | 975/1597 (0.61×) | 1423/1123 (1.27×) | 1279/1103 (1.16×) | 1667/889 (1.88×) |

### mysql — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 519/602 (0.86×) | 327/310 (1.05×) | 675/496 (1.36×) | 1125/937 (1.20×) | 616/394 (1.57×) |
| filterPaginateSort | 20 | 1593/1358 (1.17×) | 1257/1301 (0.97×) | 1582/1209 (1.31×) | 2418/1477 (1.64×) | 1543/1258 (1.23×) |
| findFirst | 1 | 492/472 (1.04×) | 257/254 (1.01×) | 508/232 (2.19×) | 376/464 (0.81×) | 701/257 (2.73×) |
| findUnique | 1 | 352/418 (0.84×) | 252/262 (0.96×) | 478/224 (2.14×) | 379/406 (0.93×) | 656/227 (2.90×) |
| nestedFindAll | 1,100 | 2814/2418 (1.16×) | 3032/1814 (1.67×) | 3095/2411 (1.28×) | 10529/7273 (1.45×) | 3941/2997 (1.31×) |
| nestedFindFirst | 11 | 1013/1078 (0.94×) | 560/512 (1.09×) | 999/550 (1.82×) | 984/961 (1.02×) | 1290/481 (2.68×) |
| nestedFindUnique | 11 | 1023/662 (1.55×) | 582/487 (1.19×) | 1003/595 (1.69×) | 832/1269 (0.66×) | 1366/569 (2.40×) |
| nestedRelations | 11,100 | 23518/16780 (1.40×) | 29291/15299 (1.91×) | 24505/16527 (1.48×) | 109209/68440 (1.60×) | 35586/17035 (2.09×) |
| compositeRelations | 11,100 | 30424/19946 (1.53×) | 35366/18229 (1.94×) | 29859/20404 (1.46×) | 132147/78252 (1.69×) | 47311/20457 (2.31×) |
| create | 0 | 374/516 (0.72×) | 345/320 (1.08×) | 613/278 (2.21×) | 372/584 (0.64×) | 494/313 (1.58×) |
| update | 0 | 330/319 (1.03×) | 268/246 (1.09×) | 485/320 (1.51×) | 388/340 (1.14×) | 538/246 (2.18×) |
| upsert | 1 | 989/671 (1.47×) | 995/530 (1.88×) | 754/563 (1.34×) | 1136/623 (1.82×) | 1205/505 (2.39×) |
| createMany | 0 | 476/562 (0.85×) | 450/366 (1.23×) | 594/389 (1.53×) | 474/462 (1.02×) | 880/382 (2.30×) |
| upsertMany | 0 | 616/490 (1.26×) | 565/389 (1.45×) | 799/488 (1.64×) | 532/560 (0.95×) | 736/450 (1.64×) |
| updateMany | 0 | 484/398 (1.21×) | 318/402 (0.79×) | 535/360 (1.48×) | 597/469 (1.27×) | 670/289 (2.32×) |
| nestedCreate | 1 | 1263/1312 (0.96×) | 1583/1710 (0.93×) | 1195/979 (1.22×) | 1862/1151 (1.62×) | 1647/1033 (1.59×) |
| nestedUpsert | 1 | 1629/1354 (1.20×) | 1594/1637 (0.97×) | 1326/1078 (1.23×) | 1354/1153 (1.17×) | 1732/1174 (1.48×) |
| nestedUpdate | 1 | 2084/1163 (1.79×) | 1621/1670 (0.97×) | 1220/1252 (0.97×) | 1511/1563 (0.97×) | 1441/1146 (1.26×) |
| delete | 1 | 2207/1873 (1.18×) | 1660/1687 (0.98×) | 1189/1209 (0.98×) | 1563/1544 (1.01×) | 1766/1316 (1.34×) |

### sqlite — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | go | rust | python | php |
|----|--------:|----|----|----|----|
| findAll | 100 | 1,305/930 | 320/220 | 2,080/575 | 1,535/350 |
| filterPaginateSort | 20 | 64,525/65,325 | 29,100/29,575 | 30,400/26,375 | 32,600/32,200 |
| findFirst | 1 | 13,000/10,000 | 5,000/6,000 | 24,500/5,000 | 13,000/3,000 |
| findUnique | 1 | 8,000/6,000 | 2,000/500 | 23,000/2,000 | 12,000/1,000 |
| nestedFindAll | 1,100 | 1,939/1,031 | 461/304 | 3,288/869 | 1,747/419 |
| nestedFindFirst | 11 | 4,909/3,455 | 1,591/1,182 | 10,273/2,273 | 4,818/1,091 |
| nestedFindUnique | 11 | 4,818/3,091 | 1,500/545 | 8,727/2,000 | 4,864/727 |
| nestedRelations | 11,100 | 2,516/1,100 | 545/388 | 3,761/902 | 2,073/485 |
| compositeRelations | 11,100 | 3,124/1,370 | 711/503 | 5,149/1,095 | 2,641/747 |
| upsert | 1 | 27,000/22,000 | 8,000/3,000 | 28,000/8,000 | 19,000/5,000 |
| nestedCreate | 1 | 30,500/33,000 | 16,500/6,000 | 82,000/25,000 | 33,000/9,500 |
| nestedUpsert | 1 | 35,500/34,000 | 15,000/6,000 | 71,000/21,000 | 38,000/10,000 |
| nestedUpdate | 1 | 25,000/27,000 | 10,000/7,000 | 76,000/19,000 | 32,000/11,000 |
| delete | 1 | 30,000/31,500 | 15,500/4,000 | 100,000/31,500 | 38,000/7,000 |

### postgres — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 4,975/3,850 | 3,605/3,430 | 3,755/4,335 | 7,140/3,270 | 9,165/2,830 |
| filterPaginateSort | 20 | 36,475/42,475 | 40,500/46,475 | 34,375/33,750 | 45,925/34,075 | 61,825/32,000 |
| findFirst | 1 | 327,500/299,500 | 302,000/299,500 | 272,500/289,000 | 353,000/356,500 | 693,000/296,500 |
| findUnique | 1 | 321,500/333,000 | 279,000/232,500 | 263,500/250,500 | 359,000/362,500 | 740,000/270,000 |
| nestedFindAll | 1,100 | 1,766/1,323 | 2,044/1,039 | 1,539/1,655 | 5,301/1,804 | 3,364/1,035 |
| nestedFindFirst | 11 | 61,909/55,818 | 54,318/55,318 | 52,955/52,591 | 122,591/60,136 | 124,591/44,818 |
| nestedFindUnique | 11 | 60,182/61,773 | 50,136/61,545 | 53,000/51,955 | 70,364/46,500 | 153,136/44,773 |
| nestedRelations | 11,100 | 1,418/1,403 | 2,036/534 | 1,104/778 | 4,899/1,101 | 3,311/755 |
| compositeRelations | 11,100 | 1,897/1,634 | 2,377/786 | 1,411/1,061 | 6,559/1,454 | 4,017/999 |
| upsert | 1 | 381,000/404,000 | 284,000/282,500 | 310,000/293,000 | 740,500/350,000 | 1,140,000/279,000 |
| nestedCreate | 1 | 1,167,500/893,000 | 981,500/1,743,000 | 1,162,500/1,313,500 | 1,533,000/896,500 | 1,350,000/998,000 |
| nestedUpsert | 1 | 1,055,000/923,500 | 912,500/1,376,000 | 1,016,000/1,100,000 | 1,089,000/1,200,000 | 1,852,500/954,000 |
| nestedUpdate | 1 | 1,218,000/1,258,500 | 928,000/1,726,500 | 1,089,500/1,168,000 | 1,405,500/1,113,500 | 1,420,500/967,000 |
| delete | 1 | 1,223,500/1,488,000 | 975,000/1,597,000 | 1,423,000/1,123,000 | 1,278,500/1,102,500 | 1,667,000/888,500 |

### mysql — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 5,185/6,015 | 3,265/3,100 | 6,750/4,960 | 11,250/9,370 | 6,160/3,935 |
| filterPaginateSort | 20 | 79,625/67,900 | 62,825/65,025 | 79,075/60,425 | 120,875/73,850 | 77,125/62,900 |
| findFirst | 1 | 492,000/472,000 | 256,500/254,000 | 507,500/231,500 | 375,500/464,000 | 701,000/256,500 |
| findUnique | 1 | 351,500/417,500 | 251,500/261,500 | 478,000/223,500 | 379,000/405,500 | 656,000/226,500 |
| nestedFindAll | 1,100 | 2,558/2,198 | 2,756/1,649 | 2,813/2,192 | 9,571/6,611 | 3,583/2,725 |
| nestedFindFirst | 11 | 92,045/98,000 | 50,909/46,500 | 90,773/49,955 | 89,409/87,364 | 117,227/43,727 |
| nestedFindUnique | 11 | 93,000/60,136 | 52,864/44,273 | 91,182/54,045 | 75,591/115,364 | 124,182/51,727 |
| nestedRelations | 11,100 | 2,119/1,512 | 2,639/1,378 | 2,208/1,489 | 9,839/6,166 | 3,206/1,535 |
| compositeRelations | 11,100 | 2,741/1,797 | 3,186/1,642 | 2,690/1,838 | 11,905/7,050 | 4,262/1,843 |
| upsert | 1 | 989,000/671,000 | 995,000/529,500 | 754,000/562,500 | 1,136,000/623,000 | 1,205,000/504,500 |
| nestedCreate | 1 | 1,263,000/1,312,000 | 1,583,000/1,710,000 | 1,195,000/979,000 | 1,861,500/1,150,500 | 1,646,500/1,033,000 |
| nestedUpsert | 1 | 1,629,000/1,354,000 | 1,594,000/1,637,000 | 1,326,000/1,077,500 | 1,353,500/1,153,000 | 1,732,000/1,173,500 |
| nestedUpdate | 1 | 2,083,500/1,163,000 | 1,621,000/1,669,500 | 1,220,000/1,251,500 | 1,511,000/1,562,500 | 1,440,500/1,145,500 |
| delete | 1 | 2,207,000/1,872,500 | 1,660,000/1,686,500 | 1,188,500/1,209,000 | 1,563,000/1,544,000 | 1,765,500/1,315,500 |

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
