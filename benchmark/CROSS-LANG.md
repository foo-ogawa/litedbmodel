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
| findAll | 100 | —/70 (—) | 152/97 (1.56×) | 45/34 (1.32×) | 322/86 (3.74×) | 241/51 (4.72×) |
| filterPaginateSort | 20 | —/846 (—) | 1319/1273 (1.04×) | 819/763 (1.07×) | 1367/1233 (1.11×) | 1123/837 (1.34×) |
| findFirst | 1 | —/13 (—) | 18/14 (1.29×) | 7/11 (0.64×) | 45/10 (4.50×) | 23/5 (4.60×) |
| findUnique | 1 | —/3 (—) | 11/8 (1.38×) | 5/1 (5.00×) | 36/4 (9.00×) | 27/2 (13.50×) |
| nestedFindAll | 1,100 | —/1159 (—) | 2787/1521 (1.83×) | 1000/741 (1.35×) | 6683/2208 (3.03×) | 3971/986 (4.03×) |
| nestedFindFirst | 11 | —/329 (—) | 544/543 (1.00×) | 344/362 (0.95×) | 1037/948 (1.09×) | 406/331 (1.23×) |
| nestedFindUnique | 11 | —/306 (—) | 544/547 (1.00×) | 353/370 (0.95×) | 1043/902 (1.16×) | 401/326 (1.23×) |
| nestedRelations | 11,100 | —/8586 (—) | 31249/12320 (2.54×) | 8558/5681 (1.51×) | 63844/16311 (3.91×) | 47600/8635 (5.51×) |
| compositeRelations | 11,100 | —/19272 (—) | 62263/39016 (1.60×) | 22192/17587 (1.26×) | 100614/35778 (2.81×) | 67354/22195 (3.03×) |
| create | 0 | —/6 (—) | 17/9 (1.89×) | 8/4 (2.00×) | 35/6 (5.83×) | 28/5 (5.60×) |
| update | 0 | —/2 (—) | 11/4 (2.75×) | 3/0 (—) | 31/2 (15.50×) | 23/1 (23.00×) |
| upsert | 1 | —/8 (—) | 25/21 (1.22×) | 17/17 (0.97×) | 47/16 (2.94×) | 34/9 (3.72×) |
| createMany | 0 | —/33 (—) | 63/44 (1.42×) | 38/41 (0.93×) | 68/45 (1.51×) | 48/36 (1.35×) |
| upsertMany | 0 | —/28 (—) | 75/57 (1.33×) | 42/36 (1.17×) | 75/46 (1.63×) | 57/35 (1.61×) |
| updateMany | 0 | —/48 (—) | 142/120 (1.18×) | 68/56 (1.23×) | 120/83 (1.44×) | 77/78 (0.99×) |
| nestedCreate | 1 | —/14 (—) | 42/31 (1.34×) | 19/9 (2.11×) | 126/39 (3.22×) | 58/14 (4.14×) |
| nestedUpsert | 1 | —/13 (—) | 53/39 (1.38×) | 27/10 (2.70×) | 102/32 (3.19×) | 60/14 (4.29×) |
| nestedUpdate | 1 | —/188 (—) | 313/282 (1.11×) | 168/172 (0.98×) | 452/391 (1.16×) | 344/170 (2.02×) |
| delete | 1 | —/14 (—) | 37/27 (1.37×) | 16/8 (2.00×) | 107/38 (2.82×) | 61/11 (5.50×) |

### postgres — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript | go | rust | python | php |
|----|--------:|----|----|----|----|----|
| findAll | 100 | —/626 (—) | 472/289 (1.63×) | 421/440 (0.96×) | 1901/1162 (1.64×) | 1042/369 (2.82×) |
| filterPaginateSort | 20 | —/951 (—) | 949/1059 (0.90×) | 799/785 (1.02×) | 1644/1218 (1.35×) | 1279/732 (1.75×) |
| findFirst | 1 | —/272 (—) | 313/286 (1.09×) | 254/266 (0.95×) | 463/306 (1.51×) | 708/250 (2.83×) |
| findUnique | 1 | —/374 (—) | 263/252 (1.05×) | 292/303 (0.97×) | 575/500 (1.15×) | 741/274 (2.71×) |
| nestedFindAll | 1,100 | —/3081 (—) | 3676/2899 (1.27×) | 3551/3204 (1.11×) | 18745/11917 (1.57×) | 6448/2792 (2.31×) |
| nestedFindFirst | 11 | —/981 (—) | 983/1168 (0.84×) | 1045/4237 (0.25×) | 1535/1067 (1.44×) | 1783/951 (1.88×) |
| nestedFindUnique | 11 | —/967 (—) | 1112/1109 (1.00×) | 983/2886 (0.34×) | 1468/1021 (1.44×) | 1962/881 (2.23×) |
| nestedRelations | 11,100 | —/19597 (—) | 43317/17320 (2.50×) | 30215/29834 (1.01×) | 171972/122837 (1.40×) | 59811/23492 (2.55×) |
| compositeRelations | 11,100 | —/16919 (—) | 40196/16057 (2.50×) | 24458/24042 (1.02×) | 217268/148227 (1.47×) | 78579/17708 (4.44×) |
| create | 0 | —/258 (—) | 286/263 (1.09×) | 269/1110 (0.24×) | 356/296 (1.20×) | 647/265 (2.44×) |
| update | 0 | —/284 (—) | 284/243 (1.17×) | 295/1316 (0.22×) | 360/322 (1.12×) | 680/226 (3.01×) |
| upsert | 1 | —/280 (—) | 281/260 (1.08×) | 323/977 (0.33×) | 405/416 (0.97×) | 897/243 (3.70×) |
| createMany | 0 | —/337 (—) | 349/459 (0.76×) | 335/442 (0.76×) | 730/378 (1.93×) | 904/292 (3.10×) |
| upsertMany | 0 | —/414 (—) | 359/417 (0.86×) | 356/1596 (0.22×) | 783/439 (1.78×) | 873/339 (2.58×) |
| updateMany | 0 | —/345 (—) | 317/285 (1.11×) | 285/1288 (0.22×) | 741/401 (1.85×) | 803/226 (3.55×) |
| nestedCreate | 1 | —/1058 (—) | 863/10511 (0.08×) | 973/4587 (0.21×) | 1187/1133 (1.05×) | 1543/833 (1.85×) |
| nestedUpsert | 1 | —/1037 (—) | 1012/10060 (0.10×) | 1155/5921 (0.20×) | 1239/1298 (0.95×) | 1553/866 (1.79×) |
| nestedUpdate | 1 | —/1456 (—) | 1531/12476 (0.12×) | 1275/2258 (0.56×) | 1796/1771 (1.01×) | 2159/1308 (1.65×) |
| delete | 1 | —/992 (—) | 900/10722 (0.08×) | 969/2938 (0.33×) | 1430/1368 (1.04×) | 1661/809 (2.05×) |

### mysql — native_p50µs / sdk_p50µs (native÷sdk)

| op | rows/op | typescript |
|----|--------:|----|
| findAll | 100 | 574/— (—) |
| filterPaginateSort | 20 | 2327/— (—) |
| findFirst | 1 | 382/— (—) |
| findUnique | 1 | 357/— (—) |
| nestedFindAll | 1,100 | 4090/— (—) |
| nestedFindFirst | 11 | 1867/— (—) |
| nestedFindUnique | 11 | 1551/— (—) |
| nestedRelations | 11,100 | 25877/— (—) |
| compositeRelations | 11,100 | 3570929/— (—) |
| create | 0 | 361/— (—) |
| update | 0 | 315/— (—) |
| upsert | 1 | 688/— (—) |
| createMany | 0 | 614/— (—) |
| upsertMany | 0 | 649/— (—) |
| updateMany | 0 | 408/— (—) |
| nestedCreate | 1 | 1639/— (—) |
| nestedUpsert | 1 | 1582/— (—) |
| nestedUpdate | 1 | 3399/— (—) |
| delete | 1 | 1831/— (—) |

### sqlite — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | go | rust | python | php |
|----|--------:|----|----|----|----|
| findAll | 100 | 1,515/970 | 450/340 | 3,220/860 | 2,405/510 |
| filterPaginateSort | 20 | 65,950/63,625 | 40,950/38,150 | 68,325/61,625 | 56,150/41,825 |
| findFirst | 1 | 18,000/14,000 | 7,000/11,000 | 45,000/10,000 | 23,000/5,000 |
| findUnique | 1 | 11,000/8,000 | 5,000/1,000 | 36,000/4,000 | 27,000/2,000 |
| nestedFindAll | 1,100 | 2,533/1,383 | 909/674 | 6,075/2,007 | 3,610/896 |
| nestedFindFirst | 11 | 49,455/49,364 | 31,273/32,864 | 94,227/86,182 | 36,864/30,091 |
| nestedFindUnique | 11 | 49,455/49,682 | 32,045/33,636 | 94,818/82,000 | 36,409/29,636 |
| nestedRelations | 11,100 | 2,815/1,110 | 771/512 | 5,752/1,469 | 4,288/778 |
| compositeRelations | 11,100 | 5,609/3,515 | 1,999/1,584 | 9,064/3,223 | 6,068/2,000 |
| upsert | 1 | 25,000/20,500 | 16,500/17,000 | 47,000/16,000 | 33,500/9,000 |
| nestedCreate | 1 | 41,500/31,000 | 19,000/9,000 | 125,500/39,000 | 58,000/14,000 |
| nestedUpsert | 1 | 53,000/38,500 | 27,000/10,000 | 102,000/32,000 | 60,000/14,000 |
| nestedUpdate | 1 | 312,500/282,000 | 168,000/171,500 | 452,000/390,500 | 344,000/170,000 |
| delete | 1 | 37,000/27,000 | 16,000/8,000 | 107,000/38,000 | 60,500/11,000 |

### postgres — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | go | rust | python | php |
|----|--------:|----|----|----|----|
| findAll | 100 | 4,715/2,885 | 4,210/4,395 | 19,005/11,615 | 10,420/3,690 |
| filterPaginateSort | 20 | 47,450/52,950 | 39,925/39,225 | 82,175/60,900 | 63,925/36,575 |
| findFirst | 1 | 312,500/285,500 | 253,500/265,500 | 463,000/306,000 | 708,000/250,000 |
| findUnique | 1 | 263,000/251,500 | 292,000/302,500 | 574,500/499,500 | 740,500/273,500 |
| nestedFindAll | 1,100 | 3,341/2,635 | 3,228/2,912 | 17,040/10,833 | 5,861/2,538 |
| nestedFindFirst | 11 | 89,318/106,182 | 95,000/385,136 | 139,500/97,000 | 162,045/86,409 |
| nestedFindUnique | 11 | 101,045/100,818 | 89,364/262,318 | 133,409/92,818 | 178,364/80,091 |
| nestedRelations | 11,100 | 3,902/1,560 | 2,722/2,688 | 15,493/11,066 | 5,388/2,116 |
| compositeRelations | 11,100 | 3,621/1,447 | 2,203/2,166 | 19,574/13,354 | 7,079/1,595 |
| upsert | 1 | 281,000/260,000 | 322,500/977,000 | 405,000/415,500 | 896,500/242,500 |
| nestedCreate | 1 | 862,500/10,511,000 | 973,000/4,586,500 | 1,187,000/1,133,000 | 1,543,000/833,000 |
| nestedUpsert | 1 | 1,011,500/10,059,500 | 1,155,000/5,921,000 | 1,238,500/1,298,000 | 1,553,000/865,500 |
| nestedUpdate | 1 | 1,531,000/12,475,500 | 1,274,500/2,258,000 | 1,795,500/1,770,500 | 2,158,500/1,308,000 |
| delete | 1 | 899,500/10,722,000 | 969,000/2,938,000 | 1,429,500/1,368,000 | 1,660,500/808,500 |

### mysql — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | typescript |
|----|--------:|----|
| findAll | 100 | 5,735/— |
| filterPaginateSort | 20 | 116,350/— |
| findFirst | 1 | 381,500/— |
| findUnique | 1 | 356,500/— |
| nestedFindAll | 1,100 | 3,718/— |
| nestedFindFirst | 11 | 169,727/— |
| nestedFindUnique | 11 | 141,000/— |
| nestedRelations | 11,100 | 2,331/— |
| compositeRelations | 11,100 | 321,705/— |
| upsert | 1 | 688,000/— |
| nestedCreate | 1 | 1,639,000/— |
| nestedUpsert | 1 | 1,582,000/— |
| nestedUpdate | 1 | 3,399,000/— |
| delete | 1 | 1,831,000/— |

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
typescript.sdk.sqlite @scale 1           samples=570
typescript.native.postgres @scale 1      SKIP (no data)
typescript.sdk.postgres @scale 1         samples=570
typescript.native.mysql @scale 1         samples=570
typescript.sdk.mysql @scale 1            SKIP (no data)
go.native.sqlite @scale 1                samples=570
go.sdk.sqlite @scale 1                   samples=570
go.native.postgres @scale 1              samples=570
go.sdk.postgres @scale 1                 samples=570
go.native.mysql @scale 1                 SKIP (no data)
go.sdk.mysql @scale 1                    SKIP (no data)
rust.native.sqlite @scale 1              samples=570
rust.sdk.sqlite @scale 1                 samples=570
rust.native.postgres @scale 1            samples=570
rust.sdk.postgres @scale 1               samples=570
rust.native.mysql @scale 1               SKIP (no data)
rust.sdk.mysql @scale 1                  SKIP (no data)
python.native.sqlite @scale 1            samples=570
python.sdk.sqlite @scale 1               samples=570
python.native.postgres @scale 1          samples=570
python.sdk.postgres @scale 1             samples=570
python.native.mysql @scale 1             SKIP (no data)
python.sdk.mysql @scale 1                SKIP (no data)
php.native.sqlite @scale 1               samples=570
php.sdk.sqlite @scale 1                  samples=570
php.native.postgres @scale 1             samples=570
php.sdk.postgres @scale 1                samples=570
php.native.mysql @scale 1                SKIP (no data)
php.sdk.mysql @scale 1                   SKIP (no data)
