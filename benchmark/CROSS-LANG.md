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
sqlite3 / psycopg 3 / PyMySQL; PHP: PDO; Rust: rusqlite / tokio-postgres / sqlx, its sdk cell rusqlite /
postgres / mysql; Go: modernc.org/sqlite / pgx / go-sql-driver). Cross-language absolute times therefore carry
a driver caveat; within a language the native and sdk columns run the same driver, except Rust on PostgreSQL
and MySQL. PostgreSQL and MySQL are network round-trips and converge
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
| findAll | 100 | —/42 (—) | 71/41 (1.73×) | 14/12 (1.17×) | 48/31 (1.55×) | 38/23 (1.65×) |
| filterPaginateSort | 20 | —/353 (—) | 938/936 (1.00×) | 350/339 (1.03×) | 434/413 (1.05×) | 426/417 (1.02×) |
| findFirst | 1 | —/6 (—) | 10/9 (1.11×) | 4/3 (1.33×) | 8/5 (1.60×) | 6/4 (1.50×) |
| findUnique | 1 | —/2 (—) | 6/4 (1.50×) | 0/0 (—) | 3/1 (3.00×) | 3/1 (3.00×) |
| nestedFindAll | 1,100 | —/440 (—) | 1203/581 (2.07×) | 248/188 (1.32×) | 978/489 (2.00×) | 554/304 (1.82×) |
| nestedFindFirst | 11 | —/16 (—) | 41/28 (1.45×) | 9/7 (1.29×) | 25/12 (2.08×) | 21/12 (1.75×) |
| nestedFindUnique | 11 | —/11 (—) | 35/26 (1.35×) | 5/4 (1.25×) | 20/9 (2.22×) | 17/7 (2.43×) |
| nestedRelations | 11,100 | —/4404 (—) | 14978/6063 (2.47×) | 2619/2046 (1.28×) | 10577/5055 (2.09×) | 6323/3024 (2.09×) |
| compositeRelations | 11,100 | —/6311 (—) | 19079/7787 (2.45×) | 3538/2755 (1.28×) | 16046/6716 (2.39×) | 9016/4544 (1.98×) |
| create | 0 | —/4 (—) | 11/10 (1.10×) | 2/1 (2.00×) | 6/2 (3.00×) | 6/2 (3.00×) |
| update | 0 | —/1 (—) | 4/3 (1.33×) | 0/0 (—) | 4/1 (4.00×) | 4/1 (4.00×) |
| upsert | 1 | —/4 (—) | 20/17 (1.15×) | 3/2 (1.50×) | 8/3 (2.67×) | 8/4 (2.00×) |
| createMany | 0 | —/20 (—) | 49/42 (1.17×) | 12/12 (1.00×) | 19/16 (1.19×) | 19/14 (1.36×) |
| upsertMany | 0 | —/20 (—) | 48/43 (1.12×) | 13/13 (1.00×) | 20/16 (1.25×) | 21/17 (1.24×) |
| updateMany | 0 | —/27 (—) | 75/61 (1.23×) | 23/21 (1.10×) | 36/29 (1.24×) | 35/32 (1.11×) |
| nestedCreate | 1 | —/9 (—) | 30/26 (1.15×) | 5/4 (1.25×) | 19/6 (3.17×) | 28/8 (3.50×) |
| nestedUpsert | 1 | —/8 (—) | 32/28 (1.14×) | 5/5 (1.00×) | 19/7 (2.71×) | 30/8 (3.75×) |
| nestedUpdate | 1 | —/9 (—) | 22/19 (1.16×) | 5/4 (1.25×) | 16/6 (2.67×) | 22/5 (4.40×) |
| delete | 1 | —/7 (—) | 27/25 (1.08×) | 4/3 (1.33×) | 17/5 (3.40×) | 30/6 (5.00×) |

### postgres — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 170/136 (1.25×) | 166/139 (1.20×) | 139/130 (1.07×) | 116/67 (1.73×) | 86/67 (1.29×) |
| filterPaginateSort | 20 | 299/268 (1.11×) | 468/473 (0.99×) | 290/288 (1.01×) | 255/208 (1.23×) | 232/218 (1.06×) |
| findFirst | 1 | 96/83 (1.16×) | 126/115 (1.10×) | 110/122 (0.91×) | 59/47 (1.24×) | 60/52 (1.14×) |
| findUnique | 1 | 89/70 (1.27×) | 115/106 (1.08×) | 108/104 (1.04×) | 55/37 (1.49×) | 48/42 (1.13×) |
| nestedFindAll | 1,100 | 955/556 (1.72×) | 1203/516 (2.33×) | 646/498 (1.30×) | 1241/497 (2.50×) | 649/398 (1.63×) |
| nestedFindFirst | 11 | 185/148 (1.25×) | 246/249 (0.99×) | 223/219 (1.02×) | 139/88 (1.57×) | 112/91 (1.23×) |
| nestedFindUnique | 11 | 175/128 (1.37×) | 232/224 (1.04×) | 215/225 (0.95×) | 135/78 (1.73×) | 101/82 (1.23×) |
| nestedRelations | 11,100 | 8921/4354 (2.05×) | 11814/3384 (3.49×) | 4548/3210 (1.42×) | 12489/4544 (2.75×) | 6558/3450 (1.90×) |
| compositeRelations | 11,100 | 12267/6911 (1.77×) | 14727/4420 (3.33×) | 7079/5031 (1.41×) | 18680/6176 (3.02×) | 9624/5349 (1.80×) |
| create | 0 | 93/76 (1.22×) | 110/110 (1.00×) | 102/109 (0.94×) | 49/38 (1.29×) | 55/45 (1.22×) |
| update | 0 | 96/61 (1.57×) | 112/110 (1.02×) | 106/104 (1.02×) | 50/39 (1.28×) | 55/46 (1.20×) |
| upsert | 1 | 96/74 (1.30×) | 128/114 (1.12×) | 110/107 (1.03×) | 56/42 (1.33×) | 57/49 (1.16×) |
| createMany | 0 | 129/97 (1.33×) | 148/148 (1.00×) | 133/130 (1.02×) | 86/73 (1.17×) | 76/70 (1.09×) |
| upsertMany | 0 | 134/94 (1.43×) | 150/155 (0.97×) | 137/131 (1.05×) | 85/70 (1.21×) | 83/74 (1.12×) |
| updateMany | 0 | 120/79 (1.52×) | 143/136 (1.05×) | 127/128 (1.00×) | 86/59 (1.45×) | 70/63 (1.11×) |
| nestedCreate | 1 | 271/214 (1.26×) | 435/866 (0.50×) | 419/403 (1.04×) | 151/154 (0.98×) | 294/146 (2.01×) |
| nestedUpsert | 1 | 241/216 (1.11×) | 436/664 (0.66×) | 473/402 (1.18×) | 204/152 (1.34×) | 309/145 (2.13×) |
| nestedUpdate | 1 | 264/204 (1.29×) | 447/878 (0.51×) | 436/406 (1.07×) | 202/160 (1.26×) | 310/149 (2.09×) |
| delete | 1 | 235/189 (1.24×) | 434/856 (0.51×) | 423/409 (1.03×) | 193/151 (1.27×) | 293/217 (1.35×) |

### mysql — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 173/127 (1.36×) | 173/148 (1.17×) | 168/137 (1.22×) | 242/209 (1.16×) | 102/92 (1.11×) |
| filterPaginateSort | 20 | 690/687 (1.00×) | 664/675 (0.98×) | 671/641 (1.05×) | 730/671 (1.09×) | 681/755 (0.90×) |
| findFirst | 1 | 115/83 (1.39×) | 120/120 (1.00×) | 106/108 (0.98×) | 69/59 (1.16×) | 98/56 (1.74×) |
| findUnique | 1 | 103/79 (1.31×) | 121/113 (1.07×) | 111/111 (1.00×) | 72/73 (0.99×) | 121/51 (2.37×) |
| nestedFindAll | 1,100 | 1427/800 (1.78×) | 1557/958 (1.63×) | 1217/867 (1.40×) | 2809/2103 (1.34×) | 1396/867 (1.61×) |
| nestedFindFirst | 11 | 224/169 (1.33×) | 269/244 (1.10×) | 245/256 (0.96×) | 203/189 (1.07×) | 125/123 (1.02×) |
| nestedFindUnique | 11 | 218/161 (1.35×) | 272/245 (1.11×) | 252/234 (1.08×) | 190/157 (1.21×) | 132/185 (0.71×) |
| nestedRelations | 11,100 | 12948/8560 (1.51×) | 16840/7681 (2.19×) | 10116/7224 (1.40×) | 30892/21086 (1.47×) | 19455/9482 (2.05×) |
| compositeRelations | 11,100 | 18067/10887 (1.66×) | 20800/9937 (2.09×) | 13050/9653 (1.35×) | 38392/26469 (1.45×) | 18030/12007 (1.50×) |
| create | 0 | 106/110 (0.96×) | 161/140 (1.15×) | 140/121 (1.16×) | 115/93 (1.24×) | 113/76 (1.49×) |
| update | 0 | 115/123 (0.93×) | 132/141 (0.94×) | 131/137 (0.96×) | 78/63 (1.24×) | 68/53 (1.30×) |
| upsert | 1 | 328/315 (1.04×) | 726/728 (1.00×) | 463/432 (1.07×) | 253/213 (1.19×) | 194/272 (0.71×) |
| createMany | 0 | 187/136 (1.38×) | 179/173 (1.03×) | 160/175 (0.92×) | 134/132 (1.02×) | 120/134 (0.90×) |
| upsertMany | 0 | 208/192 (1.09×) | 236/221 (1.07×) | 218/232 (0.94×) | 195/171 (1.14×) | 181/167 (1.08×) |
| updateMany | 0 | 161/125 (1.29×) | 183/204 (0.89×) | 159/157 (1.02×) | 134/111 (1.21×) | 126/107 (1.18×) |
| nestedCreate | 1 | 425/346 (1.23×) | 962/938 (1.03×) | 503/530 (0.95×) | 333/263 (1.26×) | 400/685 (0.58×) |
| nestedUpsert | 1 | 388/348 (1.12×) | 974/1228 (0.79×) | 484/623 (0.78×) | 317/264 (1.20×) | 519/235 (2.21×) |
| nestedUpdate | 1 | 456/400 (1.14×) | 1217/1183 (1.03×) | 650/728 (0.89×) | 389/345 (1.13×) | 503/267 (1.88×) |
| delete | 1 | 465/343 (1.36×) | 919/927 (0.99×) | 568/596 (0.95×) | 320/273 (1.17×) | 492/238 (2.07×) |

### sqlite — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | go | rust | python | php |
|----|--------:|----|----|----|----|
| findAll | 100 | 710/410 | 140/120 | 480/310 | 380/230 |
| filterPaginateSort | 20 | 46,900/46,800 | 17,500/16,950 | 21,700/20,625 | 21,300/20,850 |
| findFirst | 1 | 10,000/9,000 | 4,000/3,000 | 8,000/5,000 | 6,000/4,000 |
| findUnique | 1 | 6,000/4,000 | 0/0 | 3,000/1,000 | 3,000/1,000 |
| nestedFindAll | 1,100 | 1,093/528 | 225/171 | 889/445 | 504/276 |
| nestedFindFirst | 11 | 3,682/2,545 | 818/636 | 2,273/1,091 | 1,909/1,091 |
| nestedFindUnique | 11 | 3,182/2,364 | 455/364 | 1,818/818 | 1,545/636 |
| nestedRelations | 11,100 | 1,349/546 | 236/184 | 953/455 | 570/272 |
| compositeRelations | 11,100 | 1,719/701 | 319/248 | 1,446/605 | 812/409 |
| upsert | 1 | 19,500/17,000 | 3,000/2,000 | 8,000/3,000 | 8,000/4,000 |
| nestedCreate | 1 | 30,000/26,000 | 5,000/4,000 | 19,000/6,000 | 28,000/8,000 |
| nestedUpsert | 1 | 32,000/28,000 | 5,000/5,000 | 19,000/7,000 | 30,000/8,000 |
| nestedUpdate | 1 | 22,000/19,000 | 5,000/4,000 | 16,000/6,000 | 22,000/5,000 |
| delete | 1 | 27,000/25,000 | 4,000/3,000 | 17,000/5,000 | 30,000/6,000 |

### postgres — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 1,700/1,355 | 1,660/1,385 | 1,385/1,300 | 1,160/670 | 860/665 |
| filterPaginateSort | 20 | 14,925/13,400 | 23,400/23,650 | 14,475/14,400 | 12,750/10,400 | 11,575/10,900 |
| findFirst | 1 | 96,000/82,500 | 126,000/115,000 | 110,000/121,500 | 58,500/47,000 | 59,500/52,000 |
| findUnique | 1 | 89,000/70,000 | 114,500/106,000 | 108,000/103,500 | 55,000/37,000 | 47,500/42,000 |
| nestedFindAll | 1,100 | 868/505 | 1,094/469 | 587/452 | 1,128/452 | 590/362 |
| nestedFindFirst | 11 | 16,818/13,409 | 22,364/22,591 | 20,273/19,909 | 12,591/8,000 | 10,182/8,273 |
| nestedFindUnique | 11 | 15,909/11,636 | 21,091/20,364 | 19,500/20,455 | 12,273/7,091 | 9,182/7,455 |
| nestedRelations | 11,100 | 804/392 | 1,064/305 | 410/289 | 1,125/409 | 591/311 |
| compositeRelations | 11,100 | 1,105/623 | 1,327/398 | 638/453 | 1,683/556 | 867/482 |
| upsert | 1 | 95,500/73,500 | 127,500/114,000 | 110,000/107,000 | 56,000/42,000 | 57,000/49,000 |
| nestedCreate | 1 | 270,500/214,000 | 435,000/866,000 | 419,000/402,500 | 150,500/153,500 | 293,500/146,000 |
| nestedUpsert | 1 | 240,500/216,000 | 435,500/663,500 | 473,000/401,500 | 203,500/152,000 | 309,000/145,000 |
| nestedUpdate | 1 | 263,500/204,000 | 447,000/878,000 | 436,000/406,000 | 201,500/160,000 | 310,000/148,500 |
| delete | 1 | 234,500/189,000 | 433,500/855,500 | 422,500/409,000 | 192,500/151,000 | 293,000/216,500 |

### mysql — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | 1,725/1,270 | 1,725/1,475 | 1,675/1,370 | 2,420/2,090 | 1,020/920 |
| filterPaginateSort | 20 | 34,500/34,350 | 33,200/33,750 | 33,550/32,050 | 36,500/33,525 | 34,050/37,725 |
| findFirst | 1 | 115,000/83,000 | 120,000/119,500 | 106,000/108,000 | 68,500/59,000 | 97,500/56,000 |
| findUnique | 1 | 102,500/78,500 | 121,000/113,000 | 111,000/111,000 | 72,000/72,500 | 121,000/51,000 |
| nestedFindAll | 1,100 | 1,297/727 | 1,415/870 | 1,106/788 | 2,554/1,912 | 1,269/788 |
| nestedFindFirst | 11 | 20,318/15,318 | 24,455/22,136 | 22,273/23,273 | 18,409/17,136 | 11,318/11,136 |
| nestedFindUnique | 11 | 19,818/14,636 | 24,727/22,273 | 22,909/21,273 | 17,273/14,227 | 12,000/16,818 |
| nestedRelations | 11,100 | 1,166/771 | 1,517/692 | 911/651 | 2,783/1,900 | 1,753/854 |
| compositeRelations | 11,100 | 1,628/981 | 1,874/895 | 1,176/870 | 3,459/2,385 | 1,624/1,082 |
| upsert | 1 | 328,000/314,500 | 725,500/728,000 | 462,500/432,000 | 253,000/213,000 | 194,000/272,000 |
| nestedCreate | 1 | 425,000/346,000 | 962,000/937,500 | 502,500/529,500 | 332,500/263,000 | 400,000/685,000 |
| nestedUpsert | 1 | 387,500/347,500 | 974,000/1,227,500 | 483,500/623,000 | 317,000/264,000 | 519,000/234,500 |
| nestedUpdate | 1 | 455,500/400,000 | 1,216,500/1,182,500 | 650,000/728,000 | 388,500/344,500 | 502,500/267,000 |
| delete | 1 | 464,500/342,500 | 918,500/927,000 | 568,000/596,000 | 319,500/272,500 | 491,500/237,500 |

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
