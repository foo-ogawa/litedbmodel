#!/usr/bin/env node
/**
 * Single source of truth for the release version is package.json (WS7a, #30). Every language
 * runtime that ships on its own registry must track that version so the generated §8 bundle and
 * the runtime that interprets it stay in lockstep across all 5 registries:
 *
 *   - python/pyproject.toml                        -> PyPI       (litedbmodel-runtime)
 *   - python/litedbmodel_runtime/__init__.py       -> (in-source __version__ shipped in the wheel)
 *   - rust/litedbmodel_runtime/Cargo.toml          -> crates.io  (litedbmodel_runtime)
 *   - rust/litedbmodel_runtime/src/lib.rs          -> (in-source VERSION const shipped in the crate)
 *   - rust/Cargo.lock                              -> cargo's resolution of that manifest
 *   - rust/orm_bench/Cargo.lock                    -> ditto, for the standalone bench workspace
 *   - go/litedbmodel_runtime/runtime.go `Version`  -> Go module VCS tag `go/v<version>`
 *   - php/src/Runtime.php `VERSION`                -> Packagist  (litedbmodel/runtime)
 *
 * (npm itself is package.json, the SSoT — nothing to sync.)
 *
 * This script copies package.json's `version` into each target. It runs in the publish workflows
 * before building and can be run by hand after bumping package.json:
 *
 *   npm run sync:versions
 *
 * With `--check` it exits non-zero if ANY target is out of sync instead of rewriting (CI drift
 * gate). NO ad-hoc default: the version is read from the SSoT (package.json) and every target
 * MUST already carry a recognizable version marker, else the script fails loudly.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const check = process.argv.includes('--check');

/**
 * One Cargo.lock, as a row of the table below.
 *
 * A lock records the RESOLVED version of every package in the graph, path members included — so a
 * bump that rewrites `rust/litedbmodel_runtime/Cargo.toml` and not the lock leaves the lock behind,
 * and then the first cargo command anyone runs rewrites it and dirties a clean tree. That is exactly
 * what 2.2.1 shipped (`53e5320` bumped the manifest only; `4b55ae9` caught `rust/Cargo.lock` up by
 * hand a release later), and `rust/orm_bench/Cargo.lock` was still at 2.2.0 at 2.2.2 because nothing
 * had ever looked at it.
 *
 * Rewritten TEXTUALLY, as one more row of that table, rather than by shelling out to `cargo update`:
 * publish-pypi.yml runs this script in a job set up with Node + Python and no rust toolchain, so a
 * cargo call there would fail the publish outright. A lock holds one `[[package]]` entry per package,
 * so `name = "…"` immediately followed by `version = "…"` matches exactly one place — and the NAME is
 * part of the match, which is what keeps it off the other 263 `version =` lines in the file.
 *
 * This settles the version FIELD, which is all the SSoT owns. That cargo still ACCEPTS the lock — no
 * dependency added to a manifest without being resolved into it — is `cargo check --locked`, which
 * conformance.yml's rust leg now runs; a bare `cargo check` repairs a stale lock in place and exits 0.
 */
function cargoLock(label) {
  return {
    label,
    path: resolve(root, label),
    re: /^name = "litedbmodel_runtime"\nversion = "([^"]*)"$/m,
    render: (v) => `name = "litedbmodel_runtime"\nversion = "${v}"`,
  };
}

/**
 * Each target: a file + the regex whose FIRST capture group is the version to replace, and a
 * `render(v)` producing the full replacement line. The regex must match exactly one place (the
 * package/manifest version marker), never a dependency spec.
 */
const targets = [
  {
    label: 'python/pyproject.toml',
    path: resolve(root, 'python/pyproject.toml'),
    // `[project]` version is a bare `version = "..."` at line start (dependency versions are
    // inside `dependencies = [...]`, never at line start).
    re: /^version = "([^"]*)"$/m,
    render: (v) => `version = "${v}"`,
  },
  {
    label: 'rust/litedbmodel_runtime/Cargo.toml',
    path: resolve(root, 'rust/litedbmodel_runtime/Cargo.toml'),
    // `[package]` version at line start (dependency versions are inline `{ version = "..." }`).
    re: /^version = "([^"]*)"$/m,
    render: (v) => `version = "${v}"`,
  },
  {
    // The published crate's runtime version constant (crates.io ships this file). Must track the
    // SSoT or `litedbmodel_runtime::VERSION` reports a stale version in the published artifact.
    label: 'rust/litedbmodel_runtime/src/lib.rs',
    path: resolve(root, 'rust/litedbmodel_runtime/src/lib.rs'),
    re: /pub const VERSION: &str = "([^"]*)";/,
    render: (v) => `pub const VERSION: &str = "${v}";`,
  },
  // Every Cargo.lock that RESOLVES the runtime — `rust/Cargo.lock` for the workspace and
  // `rust/orm_bench/Cargo.lock` for the standalone bench workspace (`rust/orm_bench/Cargo.toml`
  // declares its own `[workspace]` and depends on the runtime by path).
  cargoLock('rust/Cargo.lock'),
  cargoLock('rust/orm_bench/Cargo.lock'),
  {
    // The published wheel's runtime version dunder (PyPI ships this file). Must track the SSoT or
    // `litedbmodel_runtime.__version__` reports a stale version in the published artifact.
    label: 'python/litedbmodel_runtime/__init__.py',
    path: resolve(root, 'python/litedbmodel_runtime/__init__.py'),
    re: /^__version__ = "([^"]*)"$/m,
    render: (v) => `__version__ = "${v}"`,
  },
  {
    label: 'go/litedbmodel_runtime/runtime.go',
    path: resolve(root, 'go/litedbmodel_runtime/runtime.go'),
    // `const Version = "..."` — Go publishes by tag, so the constant is the in-source mirror.
    re: /const Version = "([^"]*)"/,
    render: (v) => `const Version = "${v}"`,
  },
  {
    label: 'php/src/Runtime.php',
    path: resolve(root, 'php/src/Runtime.php'),
    // `public const VERSION = '...'` (Packagist reads the git tag; this is the in-source mirror).
    re: /public const VERSION = '([^']*)'/,
    render: (v) => `public const VERSION = '${v}'`,
  },
];

let drift = false;

for (const { label, path, re, render } of targets) {
  const contents = readFileSync(path, 'utf8');
  const m = re.exec(contents);
  if (!m) {
    console.error(`Could not find a version marker in ${label} (pattern ${re})`);
    process.exit(1);
  }
  const current = m[1];
  if (current === version) {
    console.log(`${label} already at ${version}`);
    continue;
  }
  if (check) {
    console.error(`Version drift: package.json=${version}, ${label} has ${current}`);
    drift = true;
    continue;
  }
  writeFileSync(path, contents.replace(re, render(version)), 'utf8');
  console.log(`Synced ${label} to ${version}`);
}

if (drift) {
  console.error('Run `npm run sync:versions` and commit the result.');
  process.exit(1);
}
