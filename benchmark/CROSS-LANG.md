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

| op | rows/op | typescript | go |
|----|--------:|----|----|
| findAll | 100 | —/64 (—) | 158/— (—) |
| filterPaginateSort | 20 | —/812 (—) | 1244/— (—) |
| findFirst | 1 | —/13 (—) | 16/— (—) |
| findUnique | 1 | —/3 (—) | 11/— (—) |
| nestedFindAll | 1,100 | —/1180 (—) | 2862/— (—) |
| nestedFindFirst | 11 | —/193 (—) | 554/— (—) |
| nestedFindUnique | 11 | —/184 (—) | 546/— (—) |
| nestedRelations | 11,100 | —/9092 (—) | 31755/— (—) |
| compositeRelations | 11,100 | —/12930 (—) | SKIP |
| create | 0 | —/6 (—) | SKIP |
| update | 0 | —/2 (—) | SKIP |
| upsert | 0 | —/6 (—) | SKIP |
| createMany | 0 | —/23 (—) | SKIP |
| upsertMany | 0 | —/25 (—) | SKIP |
| updateMany | 0 | —/15 (—) | SKIP |
| nestedCreate | 0 | —/13 (—) | SKIP |
| nestedUpsert | 1 | —/13 (—) | SKIP |
| nestedUpdate | 0 | —/179 (—) | SKIP |
| delete | 0 | —/8 (—) | SKIP |

### sqlite — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | go |
|----|--------:|----|
| findAll | 100 | 1,580/— |
| filterPaginateSort | 20 | 62,175/— |
| findFirst | 1 | 16,000/— |
| findUnique | 1 | 11,000/— |
| nestedFindAll | 1,100 | 2,602/— |
| nestedFindFirst | 11 | 50,364/— |
| nestedFindUnique | 11 | 49,591/— |
| nestedRelations | 11,100 | 2,861/— |

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
typescript.sdk.sqlite @scale 1           samples=1140
typescript.native.postgres @scale 1      SKIP (no data)
typescript.sdk.postgres @scale 1         SKIP (no data)
typescript.native.mysql @scale 1         SKIP (no data)
typescript.sdk.mysql @scale 1            SKIP (no data)
go.native.sqlite @scale 1                samples=480
go.sdk.sqlite @scale 1                   SKIP (no data)
go.native.postgres @scale 1              SKIP (no data)
go.sdk.postgres @scale 1                 SKIP (no data)
go.native.mysql @scale 1                 SKIP (no data)
go.sdk.mysql @scale 1                    SKIP (no data)
rust.native.sqlite @scale 1              SKIP (no data)
rust.sdk.sqlite @scale 1                 SKIP (no data)
rust.native.postgres @scale 1            SKIP (no data)
rust.sdk.postgres @scale 1               SKIP (no data)
rust.native.mysql @scale 1               SKIP (no data)
rust.sdk.mysql @scale 1                  SKIP (no data)
python.native.sqlite @scale 1            SKIP (no data)
python.sdk.sqlite @scale 1               SKIP (no data)
python.native.postgres @scale 1          SKIP (no data)
python.sdk.postgres @scale 1             SKIP (no data)
python.native.mysql @scale 1             SKIP (no data)
python.sdk.mysql @scale 1                SKIP (no data)
php.native.sqlite @scale 1               SKIP (no data)
php.sdk.sqlite @scale 1                  SKIP (no data)
php.native.postgres @scale 1             SKIP (no data)
php.sdk.postgres @scale 1                SKIP (no data)
php.native.mysql @scale 1                SKIP (no data)
php.sdk.mysql @scale 1                   SKIP (no data)
