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
| findAll | 100 | —/74 (—) | 179/121 (1.48×) | 119/36 (3.29×) | 344/57 (6.04×) | 248/37 (6.70×) |
| filterPaginateSort | 20 | —/899 (—) | 1556/1304 (1.19×) | 816/787 (1.04×) | 1394/1277 (1.09×) | 1180/880 (1.34×) |
| findFirst | 1 | —/14 (—) | 20/15 (1.33×) | 9/11 (0.82×) | 43/9 (4.78×) | 22/6 (3.67×) |
| findUnique | 1 | —/4 (—) | 14/9 (1.56×) | 7/1 (7.00×) | 36/4 (8.88×) | 21/1 (20.50×) |
| nestedFindAll | 1,100 | —/1528 (—) | 4789/1537 (3.12×) | 4007/741 (5.41×) | 7153/2311 (3.10×) | 4060/959 (4.23×) |
| nestedFindFirst | 11 | —/450 (—) | 555/566 (0.98×) | 441/349 (1.26×) | 1077/966 (1.11×) | 458/355 (1.29×) |
| nestedFindUnique | 11 | —/425 (—) | 567/587 (0.97×) | 445/331 (1.35×) | 1120/945 (1.19×) | 446/358 (1.25×) |
| nestedRelations | 11,100 | —/11366 (—) | 36060/13622 (2.65×) | 65890/6028 (10.93×) | 70810/17365 (4.08×) | 50376/8033 (6.27×) |
| compositeRelations | 11,100 | —/23290 (—) | 72819/42054 (1.73×) | 99789/18887 (5.28×) | 108946/37464 (2.91×) | 72908/21980 (3.32×) |
| create | 0 | —/7 (—) | 17/10 (1.74×) | 9/4 (2.25×) | 37/6 (6.08×) | 24/5 (4.80×) |
| update | 0 | —/3 (—) | 12/6 (2.18×) | 4/1 (4.00×) | 35/3 (14.00×) | 19/1 (19.00×) |
| upsert | 1 | —/12 (—) | 29/21 (1.39×) | 17/6 (2.83×) | 60/19 (3.22×) | 32/10 (3.20×) |
| createMany | 0 | —/41 (—) | 73/47 (1.54×) | 46/39 (1.19×) | 79/45 (1.76×) | 51/32 (1.58×) |
| upsertMany | 0 | —/37 (—) | 77/60 (1.29×) | 52/38 (1.37×) | 76/71 (1.08×) | 55/37 (1.49×) |
| updateMany | 0 | —/54 (—) | 150/119 (1.26×) | 79/51 (1.55×) | 149/92 (1.62×) | 82/84 (0.98×) |
| nestedCreate | 1 | —/18 (—) | 50/38 (1.32×) | 24/11 (2.18×) | 125/42 (3.00×) | 57/14 (4.04×) |
| nestedUpsert | 1 | —/18 (—) | 58/39 (1.47×) | 27/10 (2.70×) | 111/35 (3.20×) | 60/15 (4.00×) |
| nestedUpdate | 1 | —/231 (—) | 314/336 (0.93×) | 178/168 (1.06×) | 475/399 (1.19×) | 370/191 (1.94×) |
| delete | 1 | —/16 (—) | 41/30 (1.37×) | 21/8 (2.56×) | 134/921 (0.15×) | 53/13 (4.04×) |

### sqlite — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | go | rust | python | php |
|----|--------:|----|----|----|----|
| findAll | 100 | 1,785/1,205 | 1,185/360 | 3,440/570 | 2,480/370 |
| filterPaginateSort | 20 | 77,800/65,200 | 40,800/39,350 | 69,675/63,850 | 58,975/44,000 |
| findFirst | 1 | 20,000/15,000 | 9,000/11,000 | 43,000/9,000 | 22,000/6,000 |
| findUnique | 1 | 14,000/9,000 | 7,000/1,000 | 35,500/4,000 | 20,500/1,000 |
| nestedFindAll | 1,100 | 4,353/1,397 | 3,642/673 | 6,503/2,101 | 3,690/872 |
| nestedFindFirst | 11 | 50,455/51,455 | 40,045/31,682 | 97,864/87,818 | 41,636/32,227 |
| nestedFindUnique | 11 | 51,545/53,318 | 40,455/30,045 | 101,773/85,864 | 40,545/32,500 |
| nestedRelations | 11,100 | 3,249/1,227 | 5,936/543 | 6,379/1,564 | 4,538/724 |
| compositeRelations | 11,100 | 6,560/3,789 | 8,990/1,701 | 9,815/3,375 | 6,568/1,980 |
| upsert | 1 | 28,500/20,500 | 17,000/6,000 | 59,500/18,500 | 32,000/10,000 |
| nestedCreate | 1 | 50,000/38,000 | 24,000/11,000 | 124,500/41,500 | 56,500/14,000 |
| nestedUpsert | 1 | 57,500/39,000 | 27,000/10,000 | 110,500/34,500 | 60,000/15,000 |
| nestedUpdate | 1 | 313,500/336,000 | 177,500/167,500 | 475,000/399,000 | 370,000/190,500 |
| delete | 1 | 41,000/30,000 | 20,500/8,000 | 134,000/920,500 | 52,500/13,000 |

### fixed overhead vs per-row cost

Not separable from ONE scale (1). Re-emit the fixture at another scale and
re-run the cells into `results/scale-<factor>/`:

```bash
npx tsx benchmark/crosslang/emit-setup.ts 0.1   # then re-run the cells → results/scale-0.1/
```

### fairness — rows/op agreement across cells

Every cell that can observe rows reports the SAME rows/op for every op × dialect.

No row-observing seam (reported as `—`, never as 0): typescript.v1

### coverage (rows collected)

typescript.native.sqlite @scale 1        SKIP (no data)
typescript.sdk.sqlite @scale 1           samples=190
typescript.native.postgres @scale 1      SKIP (no data)
typescript.sdk.postgres @scale 1         SKIP (no data)
typescript.native.mysql @scale 1         SKIP (no data)
typescript.sdk.mysql @scale 1            SKIP (no data)
go.native.sqlite @scale 1                samples=190
go.sdk.sqlite @scale 1                   samples=190
go.native.postgres @scale 1              SKIP (no data)
go.sdk.postgres @scale 1                 SKIP (no data)
go.native.mysql @scale 1                 SKIP (no data)
go.sdk.mysql @scale 1                    SKIP (no data)
rust.native.sqlite @scale 1              samples=190
rust.sdk.sqlite @scale 1                 samples=190
rust.native.postgres @scale 1            SKIP (no data)
rust.sdk.postgres @scale 1               SKIP (no data)
rust.native.mysql @scale 1               SKIP (no data)
rust.sdk.mysql @scale 1                  SKIP (no data)
python.native.sqlite @scale 1            samples=190
python.sdk.sqlite @scale 1               samples=190
python.native.postgres @scale 1          SKIP (no data)
python.sdk.postgres @scale 1             SKIP (no data)
python.native.mysql @scale 1             SKIP (no data)
python.sdk.mysql @scale 1                SKIP (no data)
php.native.sqlite @scale 1               samples=190
php.sdk.sqlite @scale 1                  samples=190
php.native.postgres @scale 1             SKIP (no data)
php.sdk.postgres @scale 1                SKIP (no data)
php.native.mysql @scale 1                SKIP (no data)
php.sdk.mysql @scale 1                   SKIP (no data)
