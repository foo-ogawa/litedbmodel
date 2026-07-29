#!/usr/bin/env node
/**
 * The index holds only files someone MEANT to commit (#203).
 *
 * A TRACKED file is invisible to the two things everyone relies on: `git status` is clean while it is
 * there, and `.gitignore` does not apply to it. So three separate pieces of junk sat in this tree with
 * nothing to notice them, and each was found by looking rather than by a gate:
 *
 *   - a 0-byte file at the repository root named `host=localhost port=5433 user=testuser
 *     password=testpass dbname=testdb` — a `psql` connection string with the quotes left off, so the
 *     shell made the redirect target a filename (`84f85a1`). Its NAME contains `password=testpass`,
 *     which is a secret-scanner false positive forever.
 *   - 153 files / 27 MB of cargo build cache under `rust/orm_bench_common/target/` (`ab1f88e`). Its two
 *     sibling standalone crates each carry a `.gitignore` holding `target/`; this one did not.
 *   - two 20 MB Mach-O x86_64 executables, `go/lm_orm` and `go/lm_orm_native` (`d491c14`) — a `go build`
 *     run from `go/` instead of the package directory. Nothing invokes them: the bench cells run
 *     `go run ./lm_bench/lm_orm_native/` (benchmark/crosslang/run-cells.sh:144-145).
 *
 * Three clauses, one per way a file gets in:
 *
 *   A. Every tracked file at the repository ROOT is one of {@link ROOT_FILES}. The root is where a
 *      mistyped shell command lands, and it is small enough to enumerate. BIDIRECTIONAL: a name in
 *      that list that is no longer tracked is red too, so the list cannot rot into a rubber stamp.
 *   B. No tracked file is BUILD OUTPUT, in either of the two shapes seen:
 *        - inside a `target/` directory whose parent holds a `Cargo.toml`. The manifest is what makes
 *          it cargo's output directory — the directory NAME alone proves nothing, and `go/lm_bench/
 *          lm_orm_native/target_mysql.go` is a source file whose name starts with the same word.
 *        - a file git records EXECUTABLE (mode 100755) that does not begin with `#!`. A compiled
 *          binary always carries the executable bit and never a shebang; a script always has one.
 *          This is the clause that needs no new line per binary.
 *   C. No tracked file is EMPTY, outside {@link EMPTY_FILES}. Zero bytes is the signature of a shell
 *      redirect that created a file nobody wanted, which is clause A's junk file exactly — and this
 *      one catches it in a subdirectory too, where no inventory exists. Decided from the BLOB (git's
 *      empty-blob hash), so it reads the index and not the working tree.
 *
 * What it does NOT check, and all of these fall GREEN — the direction that matters:
 *
 *   - a build artifact that is neither executable nor under a cargo `target/`: a `.o`, a wheel, a
 *     `.node` addon, a `dist/` file force-added. Clause B knows the two shapes that have actually
 *     happened here, not the category.
 *   - junk in a SUBDIRECTORY with a plausible name and non-zero content. Only the root is inventoried;
 *     enumerating every directory would be a list nobody could keep true, and a list nobody keeps true
 *     is the thing clause A's bidirectional check exists to prevent.
 *   - anything UNTRACKED. That is `git status`'s job, and it does it — which is precisely why the
 *     tracked ones needed this.
 *
 *   node scripts/check-tracked-files.mjs
 */
import { execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Every file the repository root is supposed to hold. Adding one here is the deliberate act of saying
 * "the root is the right place for this"; the check is bidirectional, so deleting a file means
 * removing its line too.
 */
const ROOT_FILES = [
  '.dockerignore',
  '.gitignore',
  '.npmignore',
  '.npmrc',
  'CHANGELOG.md',
  'CLAUDE.md',
  'Dockerfile.test',
  'LICENSE',
  'NATIVE_RELATION_PLAN.md',
  'README.md',
  'RELEASING.md',
  'SECURITY.md',
  'docker-compose.livedb.yml',
  'docker-compose.test.yml',
  'embedoc.config.yaml',
  'eslint.config.mjs',
  'livedb-gates.env',
  'package-lock.json',
  'package.json',
  'tsconfig.json',
  'typedoc.json',
  'vitest.config.ts',
];

/** Tracked files that are legitimately empty. A python package marker carries no content by design. */
const EMPTY_FILES = ['python/orm_bench_sdk/__init__.py'];

/** git's hash of the empty blob — every zero-byte file in the index has exactly this one. */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

/** The index, as `{ mode, sha, path }` — NUL-separated, because a junk filename can contain spaces. */
function indexEntries() {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '-sz'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    console.error(`❌ could not read the git index (\`git ls-files -sz\`): ${err.message}`);
    process.exit(1);
  }
  const entries = [];
  for (const record of out.split('\0')) {
    if (record === '') continue;
    const m = /^(\d{6}) ([0-9a-f]{40}) \d+\t([\s\S]*)$/.exec(record);
    if (!m) {
      console.error(`❌ \`git ls-files -sz\` produced a record this script cannot parse, so the index was only partly read: ${JSON.stringify(record)}`);
      process.exit(1);
    }
    entries.push({ mode: m[1], sha: m[2], path: m[3] });
  }
  if (entries.length === 0) {
    console.error('❌ the git index holds no files at all, so every check below would pass vacuously.');
    process.exit(1);
  }
  return entries;
}

/** Whether `path` begins with `#!` — read from the working tree, the only place the bytes are. */
function hasShebang(path) {
  const buf = Buffer.alloc(2);
  let fd;
  try {
    fd = openSync(join(ROOT, path), 'r');
  } catch (err) {
    console.error(`❌ ${path} is tracked as executable but could not be opened to tell a script from a binary: ${err.message}`);
    process.exit(1);
  }
  try {
    return readSync(fd, buf, 0, 2, 0) === 2 && buf.toString('latin1') === '#!';
  } finally {
    closeSync(fd);
  }
}

const entries = indexEntries();
const tracked = new Set(entries.map((e) => e.path));
const problems = [];

// ── A. the root inventory, both directions ──────────────────────────────────
const rootNow = entries.map((e) => e.path).filter((p) => !p.includes('/'));
const unexpected = rootNow.filter((p) => !ROOT_FILES.includes(p)).sort();
const vanished = ROOT_FILES.filter((p) => !tracked.has(p)).sort();
if (unexpected.length > 0) {
  problems.push(
    `${unexpected.length} tracked file(s) at the repository root are not in this script's ROOT_FILES:\n` +
      unexpected.map((p) => `      ${JSON.stringify(p)}`).join('\n') +
      `\n\n      If one belongs at the root, add it to ROOT_FILES. If it does not — a mistyped shell\n` +
      `      command, a stray artifact — \`git rm\` it: once tracked, \`git status\` is clean and\n` +
      `      .gitignore does not apply, so nothing else will ever mention it.`,
  );
}
if (vanished.length > 0) {
  problems.push(
    `${vanished.length} name(s) in ROOT_FILES are no longer tracked, so the inventory has stopped describing this tree — and an inventory nobody keeps true accepts anything:\n` +
      vanished.map((p) => `      ${p}`).join('\n'),
  );
}

// ── B. build output ─────────────────────────────────────────────────────────
/** Paths inside a `target/` whose parent holds a Cargo.toml — cargo's output dir, by its manifest. */
const cargoOut = entries
  .map((e) => e.path)
  .filter((p) => {
    const parts = p.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] !== 'target') continue;
      const crate = parts.slice(0, i).join('/');
      if (tracked.has(crate === '' ? 'Cargo.toml' : `${crate}/Cargo.toml`)) return true;
    }
    return false;
  })
  .sort();
if (cargoOut.length > 0) {
  const dirs = [...new Set(cargoOut.map((p) => p.slice(0, p.indexOf('/target/') + 8)))];
  problems.push(
    `${cargoOut.length} tracked file(s) are cargo BUILD OUTPUT — inside a \`target/\` whose parent holds a Cargo.toml:\n` +
      dirs.map((d) => `      ${d}**   (${cargoOut.filter((p) => p.startsWith(d)).length} files)`).join('\n') +
      `\n\n      \`git rm -r\` the directory and give the crate a \`.gitignore\` holding \`target/\`,\n` +
      `      the way its siblings have one.`,
  );
}
/** Executable, no shebang — a compiled binary. A script has a shebang; a binary never does. */
const binaries = entries.filter((e) => e.mode === '100755' && !cargoOut.includes(e.path) && !hasShebang(e.path)).map((e) => e.path).sort();
if (binaries.length > 0) {
  problems.push(
    `${binaries.length} tracked file(s) are EXECUTABLE but are not scripts (no \`#!\`), i.e. compiled binaries:\n` +
      binaries.map((p) => `      ${p}`).join('\n') +
      `\n\n      A build product does not belong in the index — it is per-platform, it is megabytes,\n` +
      `      and nothing reads it (the bench cells run \`go run ./<pkg>/\`). \`git rm\` it and ignore\n` +
      `      the path.`,
  );
}

// ── C. empty files ──────────────────────────────────────────────────────────
const empties = entries.filter((e) => e.sha === EMPTY_BLOB && !EMPTY_FILES.includes(e.path) && !cargoOut.includes(e.path)).map((e) => e.path).sort();
if (empties.length > 0) {
  problems.push(
    `${empties.length} tracked file(s) are EMPTY and not in EMPTY_FILES:\n` +
      empties.map((p) => `      ${JSON.stringify(p)}`).join('\n') +
      `\n\n      Zero bytes is what a shell redirect leaves behind when a command was meant to run\n` +
      `      instead. If the file is deliberate (a package marker), list it in EMPTY_FILES.`,
  );
}

if (problems.length > 0) {
  console.error('❌ the git index holds files nobody meant to commit:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(`${problems.length} problem(s). A tracked file is invisible to \`git status\` AND to .gitignore.`);
  process.exit(1);
}
console.log(
  `✅ ${entries.length} tracked files: the repository root holds EXACTLY the ${ROOT_FILES.length} files ROOT_FILES lists\n` +
    `   (checked both ways, so the list cannot go stale); none is cargo build output (inside a \`target/\`\n` +
    `   whose parent holds a Cargo.toml) or a compiled binary (mode 100755 without a \`#!\`); and the only\n` +
    `   empty ones are the ${EMPTY_FILES.length} EMPTY_FILES declares.\n` +
    `   NOT checked, and all fall GREEN: a build artifact that is neither executable nor under a cargo\n` +
    `   \`target/\` (a .o, a wheel, a force-added dist file); junk in a SUBDIRECTORY with a plausible name\n` +
    `   and non-zero content (only the root is inventoried); and anything UNTRACKED — that is \`git\n` +
    `   status\`, which works, which is why only the tracked ones needed a gate.`,
);
