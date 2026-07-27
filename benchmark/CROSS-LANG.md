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
| findAll | 100 | —/87 (—) | 170/108 (1.58×) | 69/43 (1.60×) | 322/87 (3.70×) | 267/56 (4.80×) |
| filterPaginateSort | 20 | —/898 (—) | 1240/1353 (0.92×) | 820/826 (0.99×) | 1354/1273 (1.06×) | 1120/794 (1.41×) |
| findFirst | 1 | —/21 (—) | 21/15 (1.40×) | 8/11 (0.73×) | 41/9 (4.82×) | 25/5 (4.90×) |
| findUnique | 1 | —/3 (—) | 11/9 (1.22×) | 6/1 (5.50×) | 35/4 (8.63×) | 20/2 (10.00×) |
| nestedFindAll | 1,100 | —/1266 (—) | 2660/1535 (1.73×) | 2136/793 (2.69×) | 6875/2202 (3.12×) | 3910/923 (4.24×) |
| nestedFindFirst | 11 | —/337 (—) | 530/646 (0.82×) | 389/374 (1.04×) | 1031/959 (1.08×) | 471/348 (1.36×) |
| nestedFindUnique | 11 | —/304 (—) | 499/528 (0.94×) | 394/353 (1.12×) | 1048/913 (1.15×) | 446/333 (1.34×) |
| nestedRelations | 11,100 | —/10305 (—) | 30400/12958 (2.35×) | 25914/5845 (4.43×) | 66627/15524 (4.29×) | 42731/7396 (5.78×) |
| compositeRelations | 11,100 | —/19573 (—) | 60565/39821 (1.52×) | 42219/20349 (2.07×) | 99657/36362 (2.74×) | 70598/19616 (3.60×) |
| create | 0 | —/6 (—) | 16/9 (1.78×) | 8/4 (1.88×) | 38/6 (6.33×) | 24/5 (4.70×) |
| update | 0 | —/3 (—) | 11/5 (2.20×) | 3/1 (3.00×) | 34/2 (16.75×) | 18/2 (12.00×) |
| upsert | 1 | —/10 (—) | 29/20 (1.46×) | 15/7 (2.14×) | 47/16 (2.94×) | 33/9 (3.67×) |
| createMany | 0 | —/36 (—) | 64/48 (1.35×) | 42/40 (1.04×) | 75/48 (1.55×) | 52/31 (1.66×) |
| upsertMany | 0 | —/32 (—) | 73/55 (1.33×) | 45/42 (1.08×) | 73/45 (1.63×) | 49/39 (1.26×) |
| updateMany | 0 | —/54 (—) | 151/116 (1.30×) | 75/56 (1.34×) | 119/85 (1.40×) | 79/82 (0.96×) |
| nestedCreate | 1 | —/17 (—) | 51/33 (1.53×) | 20/9 (2.22×) | 113/40 (2.86×) | 58/14 (4.14×) |
| nestedUpsert | 1 | —/16 (—) | 53/39 (1.36×) | 28/9 (3.11×) | 108/34 (3.16×) | 57/16 (3.65×) |
| nestedUpdate | 1 | —/207 (—) | 327/283 (1.16×) | 161/176 (0.91×) | 483/395 (1.22×) | 353/189 (1.87×) |
| delete | 1 | —/15 (—) | 41/33 (1.26×) | 18/8 (2.19×) | 109/38 (2.87×) | 52/12 (4.33×) |

### sqlite — per-row cost, native / sdk (ns per row)

> Only ops that move rows. A write that returns nothing has no per-row cost and reads `—`;
> its cost is entirely the fixed per-call overhead in ①.

| op | rows/op | go | rust | python | php |
|----|--------:|----|----|----|----|
| findAll | 100 | 1,700/1,075 | 690/430 | 3,220/870 | 2,665/555 |
| filterPaginateSort | 20 | 62,000/67,650 | 40,975/41,300 | 67,700/63,625 | 56,000/39,700 |
| findFirst | 1 | 21,000/15,000 | 8,000/11,000 | 41,000/8,500 | 24,500/5,000 |
| findUnique | 1 | 11,000/9,000 | 5,500/1,000 | 34,500/4,000 | 20,000/2,000 |
| nestedFindAll | 1,100 | 2,418/1,395 | 1,941/720 | 6,250/2,002 | 3,554/839 |
| nestedFindFirst | 11 | 48,182/58,727 | 35,364/34,000 | 93,727/87,136 | 42,818/31,591 |
| nestedFindUnique | 11 | 45,318/48,000 | 35,818/32,091 | 95,273/82,955 | 40,545/30,227 |
| nestedRelations | 11,100 | 2,739/1,167 | 2,335/527 | 6,002/1,399 | 3,850/666 |
| compositeRelations | 11,100 | 5,456/3,587 | 3,803/1,833 | 8,978/3,276 | 6,360/1,767 |
| upsert | 1 | 28,500/19,500 | 15,000/7,000 | 47,000/16,000 | 33,000/9,000 |
| nestedCreate | 1 | 50,500/33,000 | 20,000/9,000 | 113,000/39,500 | 58,000/14,000 |
| nestedUpsert | 1 | 52,500/38,500 | 28,000/9,000 | 107,500/34,000 | 56,500/15,500 |
| nestedUpdate | 1 | 327,000/283,000 | 160,500/176,000 | 483,000/394,500 | 352,500/188,500 |
| delete | 1 | 41,000/32,500 | 17,500/8,000 | 109,000/38,000 | 52,000/12,000 |

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
