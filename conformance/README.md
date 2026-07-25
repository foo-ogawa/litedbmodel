# litedbmodel SCP conformance harness

The conformance corpus for the litedbmodel v2 SCP surface: the machine-verified half of the §10
promise — **同一宣言 + 入力 → 同一 SQL + 同一結果** — across dialects and languages.

## The pipeline every vector goes through

```
decorated models + DECLARED endpoints (harness.ts fixtures — no SQL anywhere)
  → emitBehaviorModule                    the library's lowering (src/scp/emit)
  → tsc --strict over the emitted source  bc's authoring requirement
  → bc generate --lang typescript-native  the real CLI; no litedbmodel code in the path
  → bindTyped(leafHandlers(ctx))          the ONLY hand-wiring: calling the generated method
  → SQLite (in-memory) / live PostgreSQL / live MySQL
```

The corpus is therefore a contract on the ARTIFACT the language runtimes run, not on a TS-only
build. There is one generator and one runner; both drive that pipeline.

## Layout

```
conformance/
  harness.ts            SSoT: the fixtures, the pipeline, the vector types, the asserter
  gen-vectors.ts        writeCorpus()/checkCorpus() — capture the corpus from the pipeline
  gen-vectors.test.ts   vitest wrapper that (re)writes conformance/vectors/*.json
  vitest.config.ts      config for the generator (kept out of the main test/** include)
  vectors/*.json        the FROZEN corpus (one file per suite) — pure JSON
  .generated/           the emitted + bc-generated modules (gitignored, rebuilt on demand)
```

The **assertion baseline** lives in the main test suite: `test/scp/conformance-vectors.test.ts`
loads the frozen corpus, asserts it is byte-true to what the current pipeline produces (drift
gate), replays every vector, re-asserts dialect invariance from the frozen data, and checks the
relation CONTENT contracts. It is part of `vitest run`.

## The suites

| suite     | what one vector pins                                                                      |
|-----------|-------------------------------------------------------------------------------------------|
| `exec`    | one endpoint call on one dialect: the ordered `{sql, params}` the transport handed the driver, the FULL materialized result (nested relation children included), and — for a write — the resulting DB state |
| `guard`   | a read whose baked `findHardLimit` cap is exceeded: the `LIMIT cap + 1` bounded fetch, and the `LimitExceededError` the read boundary throws |
| `tx`      | a write-time-relations bundle run as ONE gate-first transaction: result + post-tx DB state |
| `dialect` | the `orderByNulls` dialect primitive                                                      |

The SQL golden and the result golden come from the SAME execution, so a rendered statement in the
corpus is always one a real database answered — never a rendering that could not occur.

## Dialect invariance is enforced at capture

Every exec case is generated for all three dialects from the SAME declaration and input.
`generateCorpus()` FAILS LOUDLY if a read's result differs between dialects, or if a write's
`changes` count or resulting DB state differs. The frozen corpus is re-checked for the same
property by the assertion test, so the invariant is readable from the data.

## Content, never counts

A relation-bearing vector carries a `relationFields` contract — `relation path → the exact field
names every child at that path must carry` — and `checkRelationContent` asserts:

1. the path materialized at least one child object;
2. every child's field set is EXACTLY the declared one;
3. every declared field is non-null in at least one child.

A row-count assertion satisfies none of these. This is the direct answer to the defect where
typed-native relation ops returned children as empty structs and every count-only test passed it;
the assertion test carries negative controls that rebuild that symptom out of the frozen value and
prove the checker rejects it.

## Running

```bash
# assertion baseline (part of the normal suite; needs the docker PG + MySQL stack)
npx vitest run test/scp/conformance-vectors.test.ts

# regenerate the corpus after a reviewed change to the declarations / emitter / makesql
npx vitest run --config conformance/vitest.config.ts
```

The live databases come from `docker-compose.test.yml` (`npm run docker:up`); host ports are read
from `TEST_DB_*` / `TEST_MYSQL_*`, defaulting to PostgreSQL 5433 and MySQL 3307.

## Cross-language legs

`vectors-runner.ts`, `vectors-run.ts`, `gen-livedb.ts`, `livedb-run.ts`, `vectors-livedb/` and the
per-language runners under `python/ php/ go/ rust/` are the BUNDLE-REPLAY model: they replay a
serialized `SqlBundle` corpus through each language's `execute_bundle` / `read_bundle`. That model
was retired on the library side by the CLI-only codegen cutover — a leaf-executed module cannot be
replayed from serialized IR — so those legs do not run today. Migrating them (the runners and the
corpus together, per language) is issue #144; they are deliberately untouched until then, because
moving the corpus without the runners only breaks them differently.
