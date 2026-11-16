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
| findAll | 100 | 167/140 (1.20×) | 179/143 (1.25×) | 183/128 (1.43×) | 226/186 (1.22×) | 93/77 (1.21×) |
| filterPaginateSort | 20 | 652/640 (1.02×) | 670/652 (1.03×) | 694/624 (1.11×) | 695/669 (1.04×) | 584/590 (0.99×) |
| findFirst | 1 | 89/78 (1.14×) | 110/111 (0.99×) | 114/106 (1.07×) | 65/57 (1.13×) | 55/49 (1.13×) |
| findUnique | 1 | 92/76 (1.20×) | 113/109 (1.04×) | 112/105 (1.07×) | 64/58 (1.10×) | 54/49 (1.10×) |
| nestedFindAll | 1,100 | 1197/777 (1.54×) | 1548/914 (1.69×) | 1262/880 (1.43×) | 2689/2053 (1.31×) | 999/773 (1.29×) |
| nestedFindFirst | 11 | 190/164 (1.16×) | 257/236 (1.09×) | 259/229 (1.13×) | 183/148 (1.24×) | 121/107 (1.13×) |
| nestedFindUnique | 11 | 194/156 (1.24×) | 259/243 (1.07×) | 266/232 (1.15×) | 183/157 (1.17×) | 123/111 (1.11×) |
| nestedRelations | 11,100 | 12091/6901 (1.75×) | 16170/7415 (2.18×) | 10005/7107 (1.41×) | 26749/19126 (1.40×) | 10974/7659 (1.43×) |
| compositeRelations | 11,100 | 15744/9089 (1.73×) | 19940/9236 (2.16×) | 12694/8916 (1.42×) | 35118/23008 (1.53×) | 14309/10209 (1.40×) |
| create | 0 | 86/84 (1.02×) | 160/129 (1.24×) | 146/108 (1.35×) | 95/91 (1.04×) | 101/68 (1.48×) |
| update | 0 | 107/91 (1.18×) | 125/146 (0.86×) | 149/113 (1.31×) | 88/81 (1.08×) | 71/64 (1.11×) |
| upsert | 1 | 314/144 (2.18×) | 660/238 (2.77×) | 468/222 (2.11×) | 222/163 (1.37×) | 194/113 (1.72×) |
| createMany | 0 | 146/124 (1.17×) | 170/165 (1.03×) | 179/153 (1.17×) | 116/115 (1.01×) | 97/100 (0.97×) |
| upsertMany | 0 | 200/180 (1.11×) | 247/221 (1.12×) | 244/220 (1.11×) | 184/164 (1.12×) | 155/149 (1.04×) |
| updateMany | 0 | 140/128 (1.09×) | 176/174 (1.01×) | 185/155 (1.19×) | 112/107 (1.04×) | 99/89 (1.12×) |
| nestedCreate | 1 | 394/312 (1.26×) | 914/884 (1.03×) | 551/529 (1.04×) | 290/255 (1.14×) | 357/218 (1.64×) |
| nestedUpsert | 1 | 371/300 (1.24×) | 903/932 (0.97×) | 554/530 (1.04×) | 295/251 (1.18×) | 357/216 (1.66×) |
| nestedUpdate | 1 | 488/365 (1.34×) | 1106/1121 (0.99×) | 682/615 (1.11×) | 361/307 (1.18×) | 462/272 (1.70×) |
| delete | 1 | 375/322 (1.17×) | 891/913 (0.98×) | 568/525 (1.08×) | 303/266 (1.14×) | 368/224 (1.64×) |

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
| findAll | 100 | 1,670/1,395 | 1,785/1,430 | 1,830/1,280 | 2,255/1,855 | 930/770 |
| filterPaginateSort | 20 | 32,600/32,000 | 33,500/32,600 | 34,700/31,200 | 34,725/33,450 | 29,200/29,475 |
| findFirst | 1 | 89,000/78,000 | 110,000/111,000 | 113,500/106,000 | 64,500/57,000 | 55,000/48,500 |
| findUnique | 1 | 91,500/76,000 | 113,000/108,500 | 112,000/105,000 | 64,000/58,000 | 54,000/49,000 |
| nestedFindAll | 1,100 | 1,088/706 | 1,407/831 | 1,147/800 | 2,445/1,866 | 908/702 |
| nestedFindFirst | 11 | 17,273/14,909 | 23,318/21,455 | 23,545/20,773 | 16,636/13,455 | 10,955/9,727 |
| nestedFindUnique | 11 | 17,591/14,182 | 23,500/22,045 | 24,182/21,091 | 16,636/14,273 | 11,182/10,091 |
| nestedRelations | 11,100 | 1,089/622 | 1,457/668 | 901/640 | 2,410/1,723 | 989/690 |
| compositeRelations | 11,100 | 1,418/819 | 1,796/832 | 1,144/803 | 3,164/2,073 | 1,289/920 |
| upsert | 1 | 314,000/144,000 | 659,500/238,000 | 468,000/222,000 | 222,000/162,500 | 194,000/112,500 |
| nestedCreate | 1 | 394,000/311,500 | 913,500/883,500 | 551,000/529,000 | 290,000/255,000 | 356,500/217,500 |
| nestedUpsert | 1 | 370,500/300,000 | 902,500/932,000 | 553,500/530,000 | 294,500/250,500 | 357,000/215,500 |
| nestedUpdate | 1 | 487,500/365,000 | 1,106,000/1,121,000 | 682,000/614,500 | 361,000/306,500 | 461,500/272,000 |
| delete | 1 | 375,000/321,500 | 890,500/913,000 | 568,000/524,500 | 303,000/265,500 | 367,500/223,500 |

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
