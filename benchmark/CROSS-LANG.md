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
| findAll | 100 | —/52 (—) | 129/94 (1.37×) | 30/28 (1.07×) | 211/56 (3.77×) | 134/39 (3.44×) |
| filterPaginateSort | 20 | —/592 (—) | 1312/1245 (1.05×) | 559/583 (0.96×) | 580/531 (1.09×) | 693/627 (1.11×) |
| findFirst | 1 | —/8 (—) | 16/14 (1.14×) | 10/8 (1.25×) | 27/7 (3.86×) | 13/5 (2.60×) |
| findUnique | 1 | —/3 (—) | 9/7 (1.29×) | 1/1 (1.00×) | 23/3 (7.67×) | 9/1 (9.00×) |
| nestedFindAll | 1,100 | —/674 (—) | 2008/1093 (1.84×) | 457/338 (1.35×) | 3546/896 (3.96×) | 1903/468 (4.07×) |
| nestedFindFirst | 11 | —/21 (—) | 59/45 (1.31×) | 23/17 (1.39×) | 111/26 (4.27×) | 50/12 (4.17×) |
| nestedFindUnique | 11 | —/14 (—) | 53/39 (1.36×) | 12/8 (1.50×) | 103/21 (4.90×) | 44/8 (5.50×) |
| nestedRelations | 11,100 | —/6663 (—) | 25206/11809 (2.13×) | 5421/3928 (1.38×) | 39966/8959 (4.46×) | 22326/4904 (4.55×) |
| compositeRelations | 11,100 | —/9203 (—) | 32836/14785 (2.22×) | 6957/5168 (1.35×) | 54183/11371 (4.76×) | 31871/7800 (4.09×) |
| create | 0 | —/5 (—) | 11/8 (1.31×) | 4/3 (1.33×) | 30/4 (7.50×) | 18/3 (6.00×) |
| update | 0 | —/2 (—) | 6/4 (1.50×) | 1/0 (—) | 29/2 (14.50×) | 15/1 (15.00×) |
| upsert | 1 | —/5 (—) | 19/15 (1.27×) | 5/4 (1.25×) | 36/10 (3.60×) | 17/7 (2.43×) |
| createMany | 0 | —/23 (—) | 58/42 (1.38×) | 30/26 (1.15×) | 55/30 (1.83×) | 38/25 (1.52×) |
| upsertMany | 0 | —/28 (—) | 60/47 (1.28×) | 31/28 (1.11×) | 56/30 (1.87×) | 36/29 (1.24×) |
| updateMany | 0 | —/38 (—) | 115/88 (1.31×) | 50/39 (1.28×) | 85/54 (1.58×) | 62/56 (1.11×) |
| nestedCreate | 1 | —/12 (—) | 32/31 (1.03×) | 13/9 (1.39×) | 96/33 (2.91×) | 56/13 (4.31×) |
| nestedUpsert | 1 | —/12 (—) | 36/34 (1.06×) | 12/9 (1.33×) | 89/22 (4.05×) | 53/13 (4.08×) |
| nestedUpdate | 1 | —/12 (—) | 29/27 (1.07×) | 13/8 (1.63×) | 93/23 (4.04×) | 46/14 (3.29×) |
| delete | 1 | —/9 (—) | 35/34 (1.04×) | 9/6 (1.50×) | 97/33 (2.94×) | 59/10 (5.90×) |

### postgres — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 560/376 (1.49×) | 313/274 (1.14×) | 368/321 (1.15×) | 673/346 (1.94×) | 598/238 (2.51×) |
| filterPaginateSort | 20 | 707/843 (0.84×) | 840/1625 (0.52×) | 676/575 (1.18×) | 847/648 (1.31×) | 795/524 (1.52×) |
| findFirst | 1 | 348/373 (0.93×) | 369/467 (0.79×) | 377/266 (1.42×) | 742/280 (2.65×) | 357/544 (0.66×) |
| findUnique | 1 | 464/336 (1.38×) | 228/214 (1.07×) | 258/297 (0.87×) | 798/363 (2.20×) | 343/167 (2.05×) |
| nestedFindAll | 1,100 | 2030/1194 (1.70×) | 2122/928 (2.29×) | 1564/1215 (1.29×) | 5521/1531 (3.61×) | 3202/1114 (2.88×) |
| nestedFindFirst | 11 | 837/698 (1.20×) | 549/2561 (0.21×) | 520/516 (1.01×) | 812/600 (1.35×) | 671/592 (1.13×) |
| nestedFindUnique | 11 | 559/467 (1.20×) | 454/484 (0.94×) | 490/530 (0.93×) | 663/630 (1.05×) | 694/483 (1.44×) |
| nestedRelations | 11,100 | 13909/7649 (1.82×) | 21502/5738 (3.75×) | 12013/7611 (1.58×) | 61643/11439 (5.39×) | 31862/7282 (4.38×) |
| compositeRelations | 11,100 | 18636/10900 (1.71×) | 30682/7667 (4.00×) | 15649/10673 (1.47×) | 81503/15427 (5.28×) | 43715/12849 (3.40×) |
| create | 0 | 282/311 (0.91×) | 251/189 (1.33×) | 205/257 (0.80×) | 388/342 (1.13×) | 292/458 (0.64×) |
| update | 0 | 382/277 (1.38×) | 227/214 (1.06×) | 267/226 (1.18×) | 658/290 (2.27×) | 307/276 (1.11×) |
| upsert | 1 | 313/310 (1.01×) | 283/247 (1.15×) | 262/289 (0.91×) | 411/477 (0.86×) | 310/283 (1.10×) |
| createMany | 0 | 517/350 (1.48×) | 301/304 (0.99×) | 299/336 (0.89×) | 699/411 (1.70×) | 378/348 (1.09×) |
| upsertMany | 0 | 487/452 (1.08×) | 418/348 (1.20×) | 449/427 (1.05×) | 774/442 (1.75×) | 409/357 (1.14×) |
| updateMany | 0 | 540/358 (1.51×) | 340/294 (1.16×) | 299/312 (0.96×) | 767/473 (1.62×) | 362/289 (1.25×) |
| nestedCreate | 1 | 739/746 (0.99×) | 788/1455 (0.54×) | 752/1678 (0.45×) | 890/1270 (0.70×) | 1294/694 (1.87×) |
| nestedUpsert | 1 | 768/779 (0.99×) | 681/1607 (0.42×) | 775/1833 (0.42×) | 951/739 (1.29×) | 1455/937 (1.55×) |
| nestedUpdate | 1 | 950/762 (1.25×) | 713/1627 (0.44×) | 963/804 (1.20×) | 1057/595 (1.78×) | 1408/778 (1.81×) |
| delete | 1 | 796/760 (1.05×) | 660/2480 (0.27×) | 737/1624 (0.45×) | 1247/716 (1.74×) | 1373/729 (1.88×) |

### mysql — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 696/344 (2.03×) | 575/292 (1.97×) | 467/353 (1.32×) | 1090/789 (1.38×) | 681/560 (1.22×) |
| filterPaginateSort | 20 | 1838/1441 (1.28×) | 1093/1099 (0.99×) | 1491/1124 (1.33×) | 1600/1513 (1.06×) | 1400/1168 (1.20×) |
| findFirst | 1 | 307/456 (0.67×) | 313/190 (1.65×) | 434/244 (1.78×) | 380/259 (1.47×) | 466/203 (2.30×) |
| findUnique | 1 | 334/300 (1.12×) | 312/283 (1.10×) | 493/296 (1.66×) | 420/315 (1.33×) | 305/191 (1.60×) |
| nestedFindAll | 1,100 | 2878/2908 (0.99×) | 2824/1904 (1.48×) | 10891/3259 (3.34×) | 13547/7635 (1.77×) | 3616/1824 (1.98×) |
| nestedFindFirst | 11 | 748/584 (1.28×) | 517/526 (0.98×) | 818/916 (0.89×) | 710/1377 (0.52×) | 507/486 (1.04×) |
| nestedFindUnique | 11 | 615/689 (0.89×) | 406/475 (0.85×) | 1000/1175 (0.85×) | 1007/957 (1.05×) | 788/533 (1.48×) |
| nestedRelations | 11,100 | 21687/15718 (1.38×) | 29435/15170 (1.94×) | 23047/15662 (1.47×) | 126046/75964 (1.66×) | 32006/16731 (1.91×) |
| compositeRelations | 11,100 | 27755/19939 (1.39×) | 35519/19220 (1.85×) | 29395/19114 (1.54×) | 151375/80956 (1.87×) | 40980/21110 (1.94×) |
| create | 0 | 494/340 (1.46×) | 267/299 (0.89×) | 508/624 (0.81×) | 396/417 (0.95×) | 415/281 (1.48×) |
| update | 0 | 371/371 (1.00×) | 294/298 (0.98×) | 713/723 (0.99×) | 392/377 (1.04×) | 326/275 (1.19×) |
| upsert | 1 | 578/622 (0.93×) | 907/524 (1.73×) | 760/541 (1.41×) | 811/1012 (0.80×) | 590/571 (1.03×) |
| createMany | 0 | 535/426 (1.26×) | 334/360 (0.93×) | 544/359 (1.51×) | 456/603 (0.76×) | 448/404 (1.11×) |
| upsertMany | 0 | 489/588 (0.83×) | 536/418 (1.28×) | 699/582 (1.20×) | 587/914 (0.64×) | 520/467 (1.11×) |
| updateMany | 0 | 469/410 (1.14×) | 369/339 (1.09×) | 631/337 (1.87×) | 482/674 (0.72×) | 367/350 (1.05×) |
| nestedCreate | 1 | 1191/1584 (0.75×) | 1508/1489 (1.01×) | 1199/3142 (0.38×) | 1260/1068 (1.18×) | 1481/970 (1.53×) |
| nestedUpsert | 1 | 1177/1262 (0.93×) | 1524/1370 (1.11×) | 1130/884 (1.28×) | 1276/1534 (0.83×) | 1488/969 (1.54×) |
| nestedUpdate | 1 | 1238/1235 (1.00×) | 1627/1623 (1.00×) | 1146/980 (1.17×) | 1393/1727 (0.81×) | 1556/1024 (1.52×) |
| delete | 1 | 1236/1321 (0.94×) | 1676/2332 (0.72×) | 1166/1025 (1.14×) | 1418/1230 (1.15×) | 1422/914 (1.56×) |

### sqlite — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | go | rust | python | php |
|----|--------:|----|----|----|----|
| findAll | 100 | 1,290/940 | 300/280 | 2,110/560 | 1,340/390 |
| filterPaginateSort | 20 | 65,600/62,250 | 27,950/29,125 | 29,000/26,525 | 34,650/31,350 |
| findFirst | 1 | 16,000/14,000 | 10,000/8,000 | 27,000/7,000 | 13,000/5,000 |
| findUnique | 1 | 9,000/7,000 | 1,000/1,000 | 23,000/3,000 | 9,000/1,000 |
| nestedFindAll | 1,100 | 1,825/993 | 415/307 | 3,223/815 | 1,730/425 |
| nestedFindFirst | 11 | 5,364/4,091 | 2,091/1,500 | 10,091/2,364 | 4,545/1,091 |
| nestedFindUnique | 11 | 4,818/3,545 | 1,091/727 | 9,364/1,909 | 4,000/727 |
| nestedRelations | 11,100 | 2,271/1,064 | 488/354 | 3,600/807 | 2,011/442 |
| compositeRelations | 11,100 | 2,958/1,332 | 627/466 | 4,881/1,024 | 2,871/703 |
| upsert | 1 | 19,000/15,000 | 5,000/4,000 | 36,000/10,000 | 17,000/7,000 |
| nestedCreate | 1 | 32,000/31,000 | 12,500/9,000 | 96,000/33,000 | 56,000/13,000 |
| nestedUpsert | 1 | 36,000/34,000 | 12,000/9,000 | 89,000/22,000 | 53,000/13,000 |
| nestedUpdate | 1 | 29,000/27,000 | 13,000/8,000 | 93,000/23,000 | 46,000/14,000 |
| delete | 1 | 35,000/33,500 | 9,000/6,000 | 97,000/33,000 | 59,000/10,000 |

### postgres — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 5,595/3,755 | 3,130/2,735 | 3,675/3,205 | 6,725/3,460 | 5,980/2,380 |
| filterPaginateSort | 20 | 35,350/42,150 | 41,975/81,250 | 33,775/28,725 | 42,350/32,400 | 39,750/26,175 |
| findFirst | 1 | 348,000/373,000 | 369,000/466,500 | 377,000/266,000 | 741,500/280,000 | 357,000/544,000 |
| findUnique | 1 | 463,500/335,500 | 228,000/214,000 | 257,500/296,500 | 798,000/362,500 | 342,500/167,000 |
| nestedFindAll | 1,100 | 1,845/1,085 | 1,929/843 | 1,421/1,104 | 5,019/1,391 | 2,910/1,012 |
| nestedFindFirst | 11 | 76,045/63,409 | 49,909/232,773 | 47,273/46,909 | 73,818/54,500 | 60,955/53,818 |
| nestedFindUnique | 11 | 50,818/42,409 | 41,227/44,000 | 44,545/48,136 | 60,227/57,273 | 63,091/43,864 |
| nestedRelations | 11,100 | 1,253/689 | 1,937/517 | 1,082/686 | 5,553/1,030 | 2,870/656 |
| compositeRelations | 11,100 | 1,679/982 | 2,764/691 | 1,410/961 | 7,343/1,390 | 3,938/1,158 |
| upsert | 1 | 313,000/310,000 | 283,000/247,000 | 261,500/288,500 | 411,000/476,500 | 310,000/282,500 |
| nestedCreate | 1 | 738,500/745,500 | 787,500/1,454,500 | 752,000/1,678,000 | 889,500/1,270,000 | 1,293,500/693,500 |
| nestedUpsert | 1 | 768,000/779,000 | 680,500/1,607,000 | 775,000/1,833,000 | 950,500/738,500 | 1,454,500/936,500 |
| nestedUpdate | 1 | 950,000/762,000 | 713,000/1,626,500 | 962,500/803,500 | 1,057,000/594,500 | 1,408,000/777,500 |
| delete | 1 | 796,000/760,000 | 660,000/2,479,500 | 737,000/1,624,000 | 1,246,500/716,000 | 1,373,000/729,000 |

### mysql — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 6,960/3,435 | 5,750/2,915 | 4,670/3,525 | 10,900/7,890 | 6,805/5,595 |
| filterPaginateSort | 20 | 91,900/72,050 | 54,650/54,925 | 74,550/56,200 | 80,000/75,625 | 70,000/58,400 |
| findFirst | 1 | 307,000/455,500 | 313,000/190,000 | 434,000/244,000 | 379,500/259,000 | 465,500/202,500 |
| findUnique | 1 | 334,000/299,500 | 311,500/283,000 | 492,500/296,000 | 419,500/315,000 | 305,000/190,500 |
| nestedFindAll | 1,100 | 2,616/2,644 | 2,567/1,730 | 9,900/2,963 | 12,315/6,941 | 3,287/1,658 |
| nestedFindFirst | 11 | 67,955/53,091 | 46,955/47,773 | 74,318/83,227 | 64,500/125,182 | 46,045/44,182 |
| nestedFindUnique | 11 | 55,864/62,591 | 36,864/43,136 | 90,909/106,773 | 91,545/87,000 | 71,636/48,455 |
| nestedRelations | 11,100 | 1,954/1,416 | 2,652/1,367 | 2,076/1,411 | 11,355/6,844 | 2,883/1,507 |
| compositeRelations | 11,100 | 2,500/1,796 | 3,200/1,731 | 2,648/1,722 | 13,637/7,293 | 3,692/1,902 |
| upsert | 1 | 577,500/621,500 | 906,500/524,000 | 760,000/540,500 | 810,500/1,011,500 | 589,500/570,500 |
| nestedCreate | 1 | 1,191,000/1,583,500 | 1,507,500/1,488,500 | 1,199,000/3,142,000 | 1,260,000/1,067,500 | 1,480,500/969,500 |
| nestedUpsert | 1 | 1,177,000/1,262,000 | 1,523,500/1,369,500 | 1,130,000/884,000 | 1,276,000/1,533,500 | 1,488,000/968,500 |
| nestedUpdate | 1 | 1,238,000/1,235,000 | 1,627,000/1,622,500 | 1,146,000/980,000 | 1,393,000/1,727,000 | 1,555,500/1,024,000 |
| delete | 1 | 1,235,500/1,320,500 | 1,676,000/2,331,500 | 1,166,000/1,025,000 | 1,417,500/1,229,500 | 1,422,000/914,000 |

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
