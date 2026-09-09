# Releasing litedbmodel (5-registry, owner-gated)

litedbmodel v2 ships from **one monorepo** to **five registries**, all pinned to a single version
(the `package.json` `version` field is the **SSoT**; `scripts/sync-versions.mjs` propagates it):

| Registry   | Package                                   | Source of truth                          |
|------------|-------------------------------------------|------------------------------------------|
| npm        | `litedbmodel`                             | `package.json` (the SSoT)                |
| PyPI       | `litedbmodel-runtime`                     | `python/pyproject.toml` + `__init__.py`  |
| crates.io  | `litedbmodel_runtime`                     | `rust/litedbmodel_runtime/Cargo.toml` + `src/lib.rs` |
| Go         | `github.com/foo-ogawa/litedbmodel/go/v2`  | VCS tag `go/vX.Y.Z` (no registry upload) |
| Packagist  | `litedbmodel/runtime`                     | git tag `vX.Y.Z` via repo webhook        |

> **⚠️ Publishing is irreversible.** npm / PyPI / crates.io do not allow re-publishing a version,
> and a pushed git tag is public. Everything below the "OWNER-GATED" line is the owner's call.

---

## How publish is triggered (the automation)

The chain is **merge-to-`main` → GitHub Release → publish workflows**, mirroring graphddb:

1. **`release.yml`** (`GitHub Release`) runs on push to `main` (or `workflow_dispatch`). It runs the
   release-discipline gates (`sync:versions:check`, `deps:check`), audit, build, tests, `npm pack
   --dry-run`, then — **only if the `vX.Y.Z` tag does not already exist** — creates the GitHub
   Release (`gh release create vX.Y.Z`) **and** pushes the Go submodule tag `go/vX.Y.Z` on the same
   commit. Idempotent: a re-run is a no-op if the tag already exists; the Go-tag step self-heals a
   transiently-missing tag.
2. The three registry publishers chain off `workflow_run: ["GitHub Release"] completed` (GitHub does
   **not** re-fire `release: published` for a token-created release, so they cannot rely on it):
   - **`publish.yml`** → npm (`litedbmodel`)
   - **`publish-pypi.yml`** → PyPI (`litedbmodel-runtime`)
   - **`publish-crates.yml`** → crates.io (`litedbmodel_runtime`)
   Each is **idempotent** (skips if that version already exists on the registry) and each runs its
   own dry-run/build/test before uploading.
3. **Packagist** (`litedbmodel/runtime`) needs no workflow — its repo webhook syncs the new
   `vX.Y.Z` tag automatically. (First release only: submit the repo once at packagist.org.)
4. **Go** needs no upload — `go get .../litedbmodel/go/v2@vX.Y.Z` resolves the `go/vX.Y.Z` tag that
   `release.yml` pushed. The `/v2` is not decoration: Go requires the module path to end in `/vN` from
   major 2 on, and without it the tag resolves for nobody — which is exactly what happened to v2.0.0
   through v2.2.4 (#265). `release.yml` now asks `proxy.golang.org` whether the version actually
   resolves and fails the release if it does not, because pushing the tag never proved anything.

### Where the owner signs off: the PULL REQUEST

**Approving the PR into `main` IS the release gate**, and it is the only one. `main` requires a pull
request review, and on this repository only the owner can give it — so nothing reaches a registry that
the owner did not approve, and the approval happens where the diff is readable rather than in a
deployment prompt with no context.

Once that PR merges, the chain above runs to completion on its own: the `release` GitHub Environment
the three publish jobs declare carries **no protection rules, deliberately**. A second gate there would
ask the owner to approve the same release twice, the second time with nothing new to look at.

So the sequence is: bump the version in the PR → CI green → **owner approves** → merge → published.
A merge with the version left unchanged publishes nothing (`release.yml` stops on the existing tag),
which is what makes an ordinary non-release PR safe.

### One-time prerequisites — MUST be configured before the release sequence

Status verified **2026-08-01** against `foo-ogawa/litedbmodel` and the registries themselves. All four
secrets are present and four of the five registries are live — npm `2.2.3`, PyPI present, crates.io
`2.2.3`, and the Go tag needs no registry. **Packagist is the one ❌ left**, and it blocks only the PHP
package: `litedbmodel/runtime` is still a 404 there, so a tag push syncs nothing until the repo is
submitted once at packagist.org. Everything else below is background for the next reader.

**A. Repo secrets** (`gh secret set <NAME> --repo foo-ogawa/litedbmodel`)

| Secret | Purpose | Status |
|---|---|---|
| `NPM_TOKEN` | npm publish (`litedbmodel`) | ✅ present — **verify it is an *automation* token** with publish rights (bypasses 2FA) |
| `PYPI_API_TOKEN` | PyPI publish (`litedbmodel-runtime`) | ✅ present |
| `CARGO_REGISTRY_TOKEN` | crates.io publish (`litedbmodel_runtime`) | ✅ present — the publishing account needs a verified email |
| `BEHAVIOR_CONTRACTS_PAT` | private `behavior-contracts` **Go** module fetch (CI + go build) | ✅ present — fine-grained PAT, **Contents: Read on `foo-ogawa/behavior-contracts`** (same name graphddb uses) |

**B. `release` GitHub Environment — exists, and carries NO protection rules ON PURPOSE.** The three
registry publish jobs declare `environment: release` so the uploads are grouped and auditable, not so
they pause. The sign-off is the PR approval into `main` (see "Where the owner signs off" above), which
only the owner can give; required reviewers here would ask for that same approval a second time, in a
prompt that shows none of the diff it is approving.

**C. Registry account setup**

| Registry | Name | Status / action |
|---|---|---|
| npm | `litedbmodel` | ✅ owned by foo-ogawa (v1.2.10) — v2.0.0 publishes over it |
| PyPI | `litedbmodel-runtime` | 🆓 unclaimed (404). First publish claims it. Project doesn't exist yet, so a project-scoped token can't be minted — use an **account-scoped** `PYPI_API_TOKEN` for the first release, **or (recommended) configure PyPI Trusted Publishing (OIDC)** and drop the token entirely |
| crates.io | `litedbmodel_runtime` | 🆓 likely free (novel name). Needs `CARGO_REGISTRY_TOKEN` + verified-email account |
| Packagist | `litedbmodel/runtime` | ❌ not submitted (404). **First release only: submit the repo once at packagist.org** and connect the GitHub→Packagist webhook (thereafter tag pushes auto-sync) |

**D. Downstream note (not a publish blocker):** the Go module fetches `behavior-contracts` from its
**private** repo, so anyone consuming `github.com/foo-ogawa/litedbmodel/go/v2` needs read access to
`foo-ogawa/behavior-contracts`. If the Go module is meant for public consumption, make bc's Go module
public (or otherwise redistribute it) before advertising the Go package.

---

## OWNER-GATED release sequence (do this once, per version)

Prereq (already done for 2.0.0 on branch `ws8b-release`): version bumped to the target in the SSoT,
`sync:versions` run, all dry-runs + conformance green, CHANGELOG updated. Verify with the
"Pre-release checklist" below.

1. **Merge the release PR to `main`** with `gh pr merge --merge` (NOT squash / rebase — history is
   preserved). ← *this is the irreversible trigger.*
2. `release.yml` runs on `main`, creates the `vX.Y.Z` GitHub Release, and pushes `go/vX.Y.Z`.
3. The three publish workflows queue and **wait on the `release` Environment**. **Approve each** in
   the Actions UI. They publish npm + PyPI + crates.io (idempotent).
4. Confirm Packagist picked up `vX.Y.Z` (packagist.org/packages/litedbmodel/runtime). If the webhook
   is not configured yet, click "Update" / submit the repo once.
5. Smoke-verify each published artifact resolves from a clean environment:
   - `npm view litedbmodel@X.Y.Z version`
   - `pip install litedbmodel-runtime==X.Y.Z` (fresh venv)
   - `cargo add litedbmodel_runtime@X.Y.Z` (throwaway crate)
   - `go get github.com/foo-ogawa/litedbmodel/go/v2@vX.Y.Z`
   - `composer require litedbmodel/runtime:^X`
6. **Archive `foo-ogawa/litedbmodel.rs`** — see below.

---

## litedbmodel.rs archive plan (owner action AT release)

Per spec §14, the Rust runtime has moved into this monorepo's `rust/` and the standalone
`foo-ogawa/litedbmodel.rs` repository is retired at GA. **Do this only after the crates.io publish
of `litedbmodel_runtime@X.Y.Z` from THIS monorepo has succeeded**, so there is no gap:

1. In the old repo's README, add a deprecation banner pointing to the monorepo + the crates.io
   package (`litedbmodel_runtime`).
2. Optionally keep it as a **crate-mirror only** (no further development) if any consumer still
   pins the old coordinates; otherwise proceed to archive.
3. GitHub → `foo-ogawa/litedbmodel.rs` → Settings → **Archive this repository** (read-only).

This is a manual owner action and is intentionally **not** automated.

---

## Pre-release checklist (all green before the merge in step 1)

Run from the repo root.

### Packaging and the static gates

- [ ] `npm run sync:versions:check`  — every language target in lockstep at the SSoT version, **both
      `Cargo.lock`s included** (a bump that rewrites only the manifests leaves the lock behind, and the
      next cargo command repairs it silently — that is how 2.2.1 shipped a 2.2.0 lock)
- [ ] `npm run deps:check`           — no `../`-escaping local deps in any manifest
- [ ] `npm run deps:installed`       — `node_modules` holds exactly what `package-lock.json` resolves for
      this platform (`npm ci` can drop an optional package and still exit 0, and nothing else looks)
- [ ] `npm run tracked:check`        — the index holds only files someone meant to commit (a tracked
      file shows up in neither `git status` nor `.gitignore`)
- [ ] `npm run build`                — TS build + SCP bundle
- [ ] `npm run lint`                 — eslint clean
- [ ] `npm run gates:check`          — every test gate is reachable from a PR/push workflow
- [ ] `npm run pkg:check`            — every published subpath loads (CJS + ESM) from a clean install
- [ ] `npm run conformance:dispatch:check` — the go + rust live-DB runners' endpoint TABLES cover every
      entry the corpus uses. Each runner asserts it from its own `dispatch`/`DISPATCH` before connecting,
      so it needs no database; a missed entry otherwise reaches the catch-all and fails only as a vector.
      Needs the go and rust toolchains (CI runs the two halves in the legs that have them)
- [ ] `npm publish --dry-run`        — tarball has `dist/`, no `src/`/`../` leaks
- [ ] `(cd python && python -m build && twine check dist/*)`
- [ ] fresh-venv wheel smoke — `pip install` the built wheel + run a real vector
- [ ] `(cd php && composer validate)`
- [ ] `(cd rust && cargo fmt --check && cargo check --locked && cargo clippy --all-targets -- -D warnings && cargo clippy -p livedb_runner --features livedb --all-targets -- -D warnings && cargo publish -p litedbmodel_runtime --dry-run)`
      — `--locked` makes cargo ACCEPT the committed lock instead of rewriting it under you.
      **`-p livedb_runner --features livedb` is not optional**: the runner is no default-member and its
      generated modules are behind that feature, so neither `cargo check` nor `clippy --workspace`
      compiles them, and a missing `impl_to_compare!` surfaces only in the live-DB leg
- [ ] `(cd go && go vet ./...) && npm run go:fmt:check` — module path `.../litedbmodel/go/v2`.
      `gofmt -l` alone is not a gate: it exits 0 whatever it prints, and the bc-generated modules are
      legitimately unformatted (gofmt-ing them is a `bc check` drift), so they would always be listed

### The five test suites — WITH THE LIVE-DB GATES OPEN (needs docker)

Every live-DB test in every language gates itself on a `LITEDBMODEL_*` variable declared in
`livedb-gates.env`. CI opens all of them from that one file before it runs any suite
(`conformance.yml`, step "Open the live-DB test gates"), so a local run that does not open them is
**not running what CI runs** — it runs less and reports green for the difference. Measured, running
the BARE runners with the gates closed, every one of them exiting 0: python 153 passed / **25
skipped**, php `OK, but some tests were skipped!` / **45 skipped** (its gate is inverted — an
inherited `LITEDBMODEL_SKIP_LIVE=1` is what closes it), go 106 passed / **16 skipped**, and rust does
not even COMPILE its 6 live tests — `71 passed` plus three binaries of `0 tests`. Reading that as a
pass is how the #215 regression reached a commit (#219).

So each suite now runs through its own RUN GATE (#219 go, #220 the rest). Each one **refuses to
start unless every gate `livedb-gates.env` declares is open in this shell**, then owns the runner's
argv and checks the runner's own machine-readable report against what the tree declares: every test
accounted for, **skip budget 0**, the live-DB legs still present. None of the five bare runners can
report any of that — each calls a suite that skipped, shrank or was never compiled a success.

Open the gates once, and run this whole section in that shell:

```bash
npm run docker:livedb:up && sleep 5
set -a && . ./livedb-gates.env && set +a && export TEST_DB_HOST=localhost
```

- [ ] `npm run ts:test`   — the whole vitest suite (unit + scp + parity + integration) through vitest's
      `--reporter=json`: **every one of the 51 `test/**/*.test.ts` files reported at least one test**, 0
      skipped, 0 todo. A path argument, a narrowed `include`, a `--testNamePattern` or a file that fails
      to LOAD each leaves a file reporting nothing while vitest still says `success: true` — and an
      inherited `SKIP_INTEGRATION_TESTS=1` silently drops all 19 live-DB files
- [ ] `npm run py:test`   — pytest's own `--junitxml`, checked against **every `def test*` Python's `ast`
      finds under `python/tests`** (every `.py`, every class — wider than pytest's own collection rules, so
      a file renamed off `test_*.py` or a `Test*` class renamed is red rather than absent). Then PHASE 2:
      the live legs are re-run against an UNREACHABLE database and one that PASSES anyway never dialled a
      server. 24 of the 29 must FAIL there; 4 are `test_conformance_corpus.py`'s offline corpus checks and
      must PASS instead; exactly 1 — `test_live_db_conformance_all_vectors_pass` — HANGS against a dead
      server (`#225` — the pool's acquire has no timeout), so it alone is probed under a 20s timeout and
      that allowance goes red the day it stops hanging
- [ ] `npm run php:test`  — phpunit's own `--log-junit`, checked against **every `test*` method
      `ReflectionClass` finds** in every class declared under `php/tests`. The precondition covers the
      INVERTED gate: `LITEDBMODEL_SKIP_LIVE=1` in the environment is red before phpunit starts. Needs
      `pcntl` (without it `TxBoundaryLiveTest::setUp` skips that whole class)
- [ ] `npm run go:test`   — `go test ./... -count=1` read from its whole `-json` stream: **every top-level
      `func Test*` under `go/` reported a verdict**, no unbuilt package, the live-DB legs still present,
      go's own exit code. Then PHASE 2: the 16 live legs are re-run against an UNREACHABLE database, and
      one that PASSES anyway never dialled a server
- [ ] `npm run rust:test` — the package AND target set from `cargo metadata`, each target run separately
      with `--features livedb` on every package that declares it: **no target may report `0 tests`**
      unless it is named as legitimately empty, 0 ignored, 0 filtered out. `cargo test -p
      litedbmodel_runtime` without the feature is what this catches — the live files are
      `#![cfg(feature = "livedb")]`, so they compile to nothing and cargo exits 0
- [ ] live-DB corpus: `npm run conformance:livedb:docker` — the corpus on real PG + MySQL; the run names how many of the four language legs ran (go/rust: #163). Run it LAST — it takes the stack down afterwards

A skip line in any of these is a coverage report, not a pass — and each gate now names the tests
instead of leaving you to read a count.

All five gates then re-run their live legs against an UNREACHABLE server, so a leg whose body is empty
— which passes an outcome check exactly as a real query does — is caught. `php:test` and `py:test`
except their offline corpus checks BY NAME and require those to pass instead; `ts:test` does the same
for the 38 offline tests inside its live files.

What is still **not** proven, and it falls GREEN everywhere: that a leg ASSERTED anything useful about
what it read. A body reduced to a bare connect dials, so it satisfies both phases. For TypeScript,
phase 2 also learns nothing about a file whose HOOKS fail without a server (`PkeyResult`, and every file
that skips itself): its tests never run, so none of them can pass either way.

---

## Repository name — RESOLVED (2026-07-10)

The GitHub repository has been renamed `litedbmodel.ts` → **`litedbmodel`** (owner decision; GitHub
301-redirects the old URL). All manifests now agree on `github.com/foo-ogawa/litedbmodel`:
`go/go.mod` (`.../litedbmodel/go/v2`), `rust/litedbmodel_runtime/Cargo.toml` (`repository`), and
`package.json` (`repository`/`homepage`). Go's VCS-tag resolution and the Packagist webhook resolve
against the live repo path. No further action required here.
