# litedbmodel/go

The Go leg of the litedbmodel v2 SCP multi-language runtime. It is the shared runtime a
`bc generate`d native module binds to — semantics-identical to the TS reference (`src/scp`).

**Status: implemented.** There is no litedbmodel-owned bundle/read-graph/tx-plan execution (the
self-built `SqlBundle`/`ReadGraph` surface was removed in #227): a BC-generated native module drives
the closed-set orchestration and calls the leaf handlers directly. The leg passes the full frozen
conformance corpus (SQL byte-for-byte across all three dialects) against real in-proc SQLite + the
live PG/MySQL cross-language pass.

## What it does

- **`litedbmodel_runtime/`** — the shared runtime the generated native module binds to:
  - `leaf_transport.go` — the op-agnostic leaf transport (`executeSQL` / `pluck` / `group`), the
    SOLE leaf catalog, plus the render-layer placeholder resolution (`finalizeSQL` — `?`→`$N`
    quote-aware + the deferred PG array-cast) that a statement's final SQL passes through.
  - `exec_context.go` / `middleware.go` — the `ExecutionContext` + the central `Execute`/`Run`/
    `RunGuarded` seam every SQL funnels through, and the middleware chain.
  - `connection_routing.go` / `pool_factory.go` / `livedb.go` — connection routing / reader-writer
    pool / writer-sticky / per-execution tx ownership, and the live PG/MySQL drivers.
  - `dialect.go` — the closed dialect strategy (SSoT): `orderByNulls` (native NULLS for PG/SQLite,
    `IS NULL` emulation for MySQL), the placeholder finalize form — ported from `src/scp/dialect.ts`.
  - `grouping.go` / `wire/` — the shared grouping SSoT + the de-box wire layer.
  - `errors.go` / `sqldb.go` / `value.go` — SQLite→SqlFailure mapping, the `database/sql` seam +
    value marshalling, and the bigint-safe conformance value codec.
  - `runtime.go` — the package doc + the `Version` constant (the in-source version mirror).

## bc runtime-core is CONSUMED, not reimplemented

The generic Expression-IR evaluation AND the plan/map/wire/output orchestration live in the
bc-GENERATED native module (compiled from the declared endpoints), which calls the leaf handlers by
straight-line native code. The runtime delegates to the shared common core
`github.com/foo-ogawa/behavior-contracts/go`, **consumed via the published VCS tag `go/v0.2.0`**
(mirroring graphddb). No local `replace` onto a sibling checkout — the `check-no-local-deps` gate
forbids `../`-escaping deps.

behavior-contracts is a **private** repo: `go build` needs `GOPRIVATE=github.com/foo-ogawa/*` plus
authenticated git access (wired in `.github/workflows/conformance.yml`, mirroring graphddb's go
leg). The in-proc SQLite is the pure-Go `modernc.org/sqlite` driver (no cgo).

## Versioning

Go publishes by VCS tag, not a manifest version field. `scripts/sync-versions.mjs` mirrors
`package.json`'s version into the `Version` constant in `runtime.go`; the release tag is
`go/v<version>`.
