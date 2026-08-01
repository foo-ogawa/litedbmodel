#!/usr/bin/env node
/**
 * The installed tree holds every package `package-lock.json` resolves for THIS platform (#245).
 *
 * `npm ci` is not deterministic. One image build's `npm ci` dropped `@esbuild/linux-arm64` — an
 * OPTIONAL dependency of esbuild — and exited 0 anyway; BuildKit then cached that incomplete layer,
 * so every later build reused it (`CACHED`) and `npm run build` failed with `The package
 * "@esbuild/linux-arm64" could not be found` until `--no-cache` rebuilt the SAME INPUTS into a
 * complete 286-package tree. Nothing between `npm ci` and the failure looked at whether the tree
 * matched the lockfile, because npm's own exit code said it did.
 *
 * That one was loud: the build needs esbuild, so it stopped. Had the dropped package been needed by
 * the TESTS and not the build, the image would have built, the suite would have run short, and the
 * result would have been the same false green as #237 — a cached layer holding an answer nobody
 * re-derived.
 *
 * So the tree is checked against the lockfile directly. The failure mode is finite (a set
 * difference), which is what makes it gateable at all.
 *
 * ── What "should be installed" means ──────────────────────────────────────────────────────────
 *
 * NOT "every entry in the lockfile": on this darwin-x64 host `npm ci` legitimately installs 8 of the
 * 61 `optional` entries and none of the 52 that carry `os`/`cpu`. A gate that required all of them
 * would be red on every machine, which is worth nothing.
 *
 * NOR "every entry whose own os/cpu/libc matches": `node_modules/@emnapi/core` declares NO platform
 * at all and is still, correctly, absent here — its only route from the root is through
 * `@rolldown/binding-wasm32-wasi` (`cpu: ["wasm32"]`), which this platform excludes. npm hoists it to
 * a top-level path, so nothing about its own key or fields says it was skipped. Requiring it would
 * false-red on every platform that is not wasm32.
 *
 * The requirement is therefore REACHABILITY, walked the way npm resolves: from the root manifest
 * through each entry's `dependencies` / `optionalDependencies` / `peerDependencies`, resolving a name
 * to the nearest enclosing `…/node_modules/<name>` (npm's hoisting rule), and NOT descending into a
 * node whose `os`/`cpu`/`libc` excludes this platform. Everything the walk reaches must be on disk;
 * everything on disk must have been reached. Both directions are checked — a package present but
 * unreachable is a tree the lockfile does not describe (a stale `node_modules` `npm ci` did not
 * clear), and that is the same class of lie in the other direction.
 *
 * A package "is on disk" iff its directory holds a `package.json`. A half-extracted directory is
 * missing, not present.
 *
 * ── Preconditions ────────────────────────────────────────────────────────────────────────────
 *
 * A FULL install (dev + optional). Every `npm ci` in this repository is one — `--ignore-scripts` and
 * `--legacy-peer-deps` are the only flags used, no `--omit` / `--production` anywhere in
 * `.github/workflows/`, `Dockerfile.test` or `package.json`. An omitted-dev install would be red
 * here, loudly and with the reason named, rather than quietly narrowing what the gate covers.
 *
 * AND an installer that prunes. npm 11.6.1 and 11.6.2 (arborist 9.1.5 / 9.1.6) drop a
 * platform-excluded optional package without dropping the subtree BELOW it: on every platform they
 * leave `@emnapi/wasi-threads` and `tslib` on disk, whose only route from the root is
 * `@rolldown/binding-wasm32-wasi` (`cpu: ["wasm32"]`). Those two releases disagree with themselves,
 * not with this gate — their own `npm ls` calls both packages `extraneous`, and their own
 * `npm install --package-lock-only` rewrites the lockfile to delete `@emnapi/core` while keeping
 * `@emnapi/core`'s now-parentless child. Every other npm sampled from 10.9.8 to 11.11.0 installs
 * exactly the 285 packages this lockfile resolves. So when UNEXPECTED names those packages, read the
 * npm version this gate reports before suspecting the lockfile: reinstalling under any other npm is
 * the fix, and no edit to the lockfile is (#253).
 *
 * That range is NOT declared as `devEngines.packageManager`. npm enforces `devEngines` on every
 * command that reads this manifest — `npm run`, `npx`, not just installs — and the npm bundled with
 * the Node this repository's benchmarks require (24.13) IS 11.6.2, so declaring it made every gate,
 * benchmark and conformance run in the tree refuse to start, including this one. Detecting the tree
 * that npm actually built is this gate's job and is finite; refusing the installer up front belongs
 * to no second mechanism (#253).
 *
 *   node scripts/check-installed-deps.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCK = join(ROOT, 'package-lock.json');
const MODULES = join(ROOT, 'node_modules');

if (!existsSync(LOCK)) {
  console.error('❌ installed-deps: package-lock.json is missing — there is nothing to check the tree against.');
  process.exit(1);
}
const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
const entries = lock.packages ?? {};
if (!existsSync(MODULES)) {
  console.error('❌ installed-deps: node_modules/ does not exist. Run `npm ci` first — this gate reads the INSTALLED tree.');
  process.exit(1);
}

/**
 * npm's `os` / `cpu` / `libc` matching, as `npm-install-checks` performs it: a list of allowed values,
 * each optionally negated with `!`. An all-negative list passes unless one of its entries names this
 * platform; a mixed list needs a positive hit AND no negative hit. An absent or empty list allows
 * everything.
 */
function allows(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  let negatives = 0;
  let hitNegative = false;
  let hitPositive = false;
  for (const item of list) {
    if (item.startsWith('!')) {
      negatives++;
      if (item.slice(1) === value) hitNegative = true;
    } else if (item === value || item === 'any') {
      hitPositive = true;
    }
  }
  if (hitNegative) return false;
  return negatives === list.length ? true : hitPositive;
}

/**
 * glibc vs musl, which the lockfile spells `libc` and which decides between sibling packages such as
 * `@rolldown/binding-linux-x64-gnu` and `…-musl` — the alpine image this repository's test container
 * is built from is musl, CI's ubuntu runner is glibc. Node reports the glibc it was linked against in
 * its process report; a musl build has no such field. Only linux has the distinction.
 */
const LIBC = process.platform !== 'linux' ? null : process.report?.getReport?.()?.header?.glibcVersionRuntime ? 'glibc' : 'musl';

/**
 * Which npm built the tree — the first thing to know when it does not match, and the thing whose
 * absence sent #253 chasing the platform instead. npm exports it in the user agent to every script it
 * runs, which is how both wired call sites reach this gate (`npm run deps:installed`).
 */
const NPM_VERSION = /\bnpm\/(\S+)/.exec(process.env.npm_config_user_agent ?? '')?.[1] ?? '(unknown — not run through npm)';

function installable(node) {
  return (
    allows(node.os, process.platform) &&
    allows(node.cpu, process.arch) &&
    (LIBC === null || allows(node.libc, LIBC))
  );
}

/**
 * `name`, resolved from the package at `fromKey` the way node's resolver reads the tree: every
 * directory from `fromKey` up to the root is tried in turn, and the nearest one with a
 * `node_modules/<name>` wins. This is what makes a HOISTED dependency reachable — most of this tree
 * sits at the top level while being required from three levels down.
 *
 * Walking PATH SEGMENTS rather than stripping `node_modules/<pkg>` pairs is what makes it total: a key
 * that is not under `node_modules` at all (a workspace directory, which is how a `link` entry's target
 * is spelled) still terminates at the root instead of never shrinking.
 */
function resolve(fromKey, name) {
  const segments = fromKey === '' ? [] : fromKey.split('/');
  for (let depth = segments.length; depth >= 0; depth--) {
    if (segments[depth - 1] === 'node_modules') continue; // no package lives directly in a node_modules/node_modules
    const key = [...segments.slice(0, depth), 'node_modules', name].join('/');
    if (entries[key]) return key;
  }
  return null;
}

// ── what the lockfile says this platform gets ──────────────────────────────────────────────
const required = new Set();
const queue = [''];
const seen = new Set(queue);
while (queue.length > 0) {
  const key = queue.shift();
  const node = entries[key];
  if (!node) continue;
  // A `link` entry is a symlink; its dependencies are declared at the target's own entry.
  const via = node.link && typeof node.resolved === 'string' && entries[node.resolved] ? [node.resolved] : [];
  const names = [
    ...Object.keys(node.dependencies ?? {}),
    ...Object.keys(node.optionalDependencies ?? {}),
    ...Object.keys(node.peerDependencies ?? {}),
    ...(key === '' ? Object.keys(node.devDependencies ?? {}) : []),
  ];
  for (const next of [...via, ...names.map((n) => resolve(key, n)).filter(Boolean)]) {
    if (seen.has(next)) continue;
    seen.add(next);
    if (!installable(entries[next])) continue; // excluded here, and so is everything only it reaches
    if (next.startsWith('node_modules/')) required.add(next);
    queue.push(next);
  }
}

// ── what is actually on disk ───────────────────────────────────────────────────────────────
const installed = new Set();
(function walk(prefix, dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue; // .bin, .package-lock.json, .cache — npm's own bookkeeping
    const members = name.startsWith('@') ? readdirSync(join(dir, name)).filter((s) => !s.startsWith('.')).map((s) => `${name}/${s}`) : [name];
    for (const member of members) {
      const abs = join(dir, member);
      if (!existsSync(join(abs, 'package.json'))) continue; // half-extracted is not installed
      installed.add(`${prefix}${member}`);
      walk(`${prefix}${member}/node_modules/`, join(abs, 'node_modules'));
    }
  }
})('node_modules/', MODULES);

// ── report ─────────────────────────────────────────────────────────────────────────────────
const missing = [...required].filter((k) => !installed.has(k)).sort();
const unexpected = [...installed].filter((k) => !required.has(k)).sort();

if (missing.length === 0 && unexpected.length === 0) {
  console.log(`✓ installed-deps: node_modules holds exactly the ${required.size} packages package-lock.json resolves for ${process.platform}-${process.arch}${LIBC ? `-${LIBC}` : ''}.`);
  process.exit(0);
}
console.error(`\n❌ installed-deps: node_modules does NOT match package-lock.json on ${process.platform}-${process.arch}${LIBC ? `-${LIBC}` : ''}.\n`);
const show = (label, keys, why) => {
  if (keys.length === 0) return;
  console.error(`  ${keys.length} ${label} — ${why}`);
  for (const k of keys.slice(0, 25)) console.error(`      ${k}`);
  if (keys.length > 25) console.error(`      … and ${keys.length - 25} more`);
  console.error('');
};
show('MISSING', missing, 'the lockfile resolves it for this platform and it is not installed');
show('UNEXPECTED', unexpected, 'installed but not reachable from the lockfile — a tree the lockfile does not describe');
console.error(
  'An `npm ci` that exits 0 with a tree like this is the defect: whatever runs next runs short, and a\n' +
    'cached image layer makes that permanent. Reinstall from scratch (`rm -rf node_modules && npm ci`,\n' +
    'or `docker compose … build --no-cache`) and check again before trusting any result from this tree.\n' +
    'If a from-scratch install lands here anyway, the installer is the suspect, not the lockfile: ask npm\n' +
    `(\`npm ls\`) whether it can explain the UNEXPECTED packages itself. This ran under npm ${NPM_VERSION}.`,
);
process.exit(1);
