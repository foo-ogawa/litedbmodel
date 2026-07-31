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
 * Five clauses:
 *
 *   A. Every tracked file at the repository ROOT is one of {@link ROOT_FILES}. The root is where a
 *      mistyped shell command lands, and it is small enough to enumerate. BIDIRECTIONAL: a name in
 *      that list that is no longer tracked is red too, so the list cannot rot into a rubber stamp.
 *   B. No tracked file is BUILD OUTPUT, in three shapes:
 *        - a PATH the repository itself declares is output: inside a `target/` whose parent holds a
 *          `Cargo.toml` (the manifest is what makes it cargo's output directory — the directory NAME
 *          alone proves nothing, and `go/lm_bench/lm_orm_native/target_mysql.go` is a source file whose
 *          name starts with the same word), or a path the committed `.gitignore` set matches, which
 *          takes a `git add -f` and nothing else. Neither subsumes the other: the cargo cache above got
 *          in BECAUSE that crate's `.gitignore` was missing, and `.gitignore` in turn covers `dist/`,
 *          `php/vendor/`, `python/**\/__pycache__/`, `coverage/`, `*.log` — none of which cargo's rule
 *          knows about.
 *        - a blob whose CONTENT is not source text: it begins with an executable or archive magic
 *          number ({@link MAGIC}), or it holds a NUL byte anywhere.
 *        - a blob git records EXECUTABLE (100755) that is neither a `#!` script nor a binary the rule
 *          above named. `execve` runs exactly two things, a `#!` script and a native executable format,
 *          so a third thing carrying the bit cannot be run at all — either the bit is wrong or this
 *          gate does not know the format, and unmodelled is RED.
 *   C. No tracked file is EMPTY, outside {@link EMPTY_FILES}. Zero bytes is the signature of a shell
 *      redirect that created a file nobody wanted, which is clause A's junk file exactly — and this
 *      one catches it in a subdirectory too, where no inventory exists.
 *   D. Every index entry is a REGULAR FILE, mode 100644 or 100755. A 120000 is a SYMLINK, whose blob is
 *      a target path git stores and never validates: it may leave the repository, point into a build
 *      directory or dangle, and being neither empty nor binary it satisfies every other clause here. A
 *      160000 is a SUBMODULE, whose sha is a commit rather than a blob, so no content check can see it
 *      at all. This tree has zero of either; one would be a deliberate change to this gate.
 *   E. Every module under `src/` is REACHED by something — a published `exports` entry, a tracked file
 *      outside `src`, or one of those transitively. This is the shape of junk clause A structurally
 *      cannot see: a plausible name, in a subdirectory, holding ordinary text. Measured, a six-line
 *      valid-TypeScript `src/scp/notes.ts` that nothing imports left `tsc --noEmit`, `eslint src`,
 *      `npm run build` and every other `scripts/check-*.mjs` at exit 0.
 *
 * Clause B judges CONTENT because the three things it judged before were all properties anyone can set
 * without changing what the file IS. It was "mode 100755, and the blob does not begin with `#!`", and
 * all of these passed it (#222 D/E/F):
 *
 *     a `.o`, a wheel, a `.node` addon         no executable bit, and no cargo `target/` above them
 *     that 20 MB Mach-O, `git add --chmod=-x`  the bit is not a property of the contents — and a
 *                                              checkout with core.fileMode=false records 100644 for
 *                                              everything, so it is not even a property of the machine
 *     the same binary with `#!/bin/sh\n` on it  measured: blob 20040410 bytes, exit 0
 *
 * A NUL byte ANYWHERE is what makes the last one unwalkable-around: a magic number is read at offset 0,
 * so prepending ten bytes moves it out of view, while the payload's NULs do not move. {@link MAGIC}
 * therefore does not carry the detection — it NAMES the format in the message, and it is a second
 * trigger for a format that somehow holds no NUL. `MZ` is why it needs care in the other direction: two
 * printable letters a text file may legitimately begin with, so PE must also carry its own `PE\0\0`
 * signature at the offset its DOS header points to.
 *
 * EVERY clause reads the INDEX — mode, sha, and the blob behind the sha. Clause B did not: it took the
 * mode from the index and then opened the WORKING TREE for the shebang, and mixing the two made the gate
 * lie. Measured — a 20 MB Mach-O staged 100755, then the worktree file alone replaced with `#!/bin/sh`:
 *
 *     index says            100755 67ac6231… go/lm_bench/lm_orm_v2   (blob size 20040400)
 *     before the swap       exit 1   ← correctly red
 *     after the swap        exit 0   ← green, with the 20 MB binary still in the index
 *
 * CI would not be fooled (it checks out fresh), but RELEASING.md asks for this locally, where the tree
 * is dirty by definition — and a smudge filter would do the same thing to a clean one.
 *
 * The one rule that CANNOT read only the index is the `.gitignore` one, because git's exclude machinery
 * has no index-only mode: `--exclude-per-directory=.gitignore` reads the files on disk. It is fenced so
 * that it cannot go green against a set this repository does not declare — every tracked `.gitignore`
 * must equal its blob, and an UNTRACKED `.gitignore` is red, since a `!pattern` in one re-includes a
 * path and would mask the very force-add being looked for. `--exclude-per-directory` and not
 * `--exclude-standard` for the same reason: the standard set adds `$GIT_DIR/info/exclude` and the user's
 * global file, neither of which is in the repository, so its answer would differ per machine.
 *
 * {@link ROOT_FILES}, {@link EMPTY_FILES} and the tree itself are compared BIDIRECTIONALLY, so an
 * exemption cannot outlive the file it was written for. Clause B's content rule has no allowlist and
 * needs none: no tracked blob holds a NUL byte or a magic number, which is what the green line below
 * measures every time it prints. A legitimately binary tracked file — an image, a fixture database —
 * is RED, and would have to be declared here deliberately.
 *
 * What it does NOT check, and these fall GREEN — the direction that matters:
 *
 *   - a build artifact that is TEXT, is not ignored, and sits outside a cargo `target/`: a `.d` dep
 *     file, a generated `.json`, an emitted `.ts`. Nothing in its bytes distinguishes it from source.
 *   - junk in a subdirectory OUTSIDE `src/` with a plausible name and text content: a stray `.go`,
 *     `.py`, `.php` or `.md`. Clause E answers this for the TypeScript source tree by asking what
 *     reaches a module, and there is no equivalent for the others: an unreferenced `.go` file in an
 *     existing package still compiles under `go build ./...`, and a new package with no importer is
 *     built all the same, so the toolchain says nothing. The root inventory is the only thing covering
 *     the one directory it covers.
 *   - anything UNTRACKED. That is `git status`'s job, and it does it — which is precisely why the
 *     tracked ones needed this.
 *
 * Where it errs otherwise, it errs RED, which is why these are not holes: a locally modified or added
 * `.gitignore` (the fence above), an index entry whose mode or blob this cannot parse, and a repository
 * whose blobs together exceed the 512 MB read buffer.
 *
 *   node scripts/check-tracked-files.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

/**
 * Clause E's published entry points: the `src` module behind each `exports` subpath, and the ONLY roots
 * that are not derived from the index.
 *
 * `exports` names built artifacts (`./dist/scp/index.cjs`), so the source they are built from is a
 * convention rather than something the manifest states. Rather than trust the convention, this map is
 * checked BOTH ways against `package.json`: an `exports` subpath with no line here is red, and a line
 * whose file is not tracked is red. `./eslint-plugin` maps to `null` deliberately — it resolves to
 * `./eslint-plugin/index.js`, a hand-written directory outside `src` that nothing builds, so it has no
 * `src` module and contributes no root.
 */
const ENTRY_POINTS = {
  '.': 'src/index.ts',
  './drivers': 'src/drivers/index.ts',
  './scp': 'src/scp/index.ts',
  './eslint-plugin': null,
};

/** The extensions clause E follows imports through, and the ones that may be a root outside `src`. */
const JS_LIKE = /\.(?:m|c)?(?:ts|js)$/;

/** The modes an index entry may have. Anything else is clause D — a symlink, or a submodule. */
const REGULAR = new Set(['100644', '100755']);

/** Whether `blob` begins with exactly these bytes. Out of range compares as a miss. */
const begins = (blob, ...bytes) => bytes.every((b, i) => blob[i] === b);

/**
 * PE's own signature, at the offset its DOS header points to. Required because the two bytes a PE
 * file starts with, `MZ`, are printable ASCII a text file may legitimately begin with — this is the
 * one entry in {@link MAGIC} whose first bytes are not by themselves evidence of anything.
 */
const isPE = (blob) => blob.length >= 0x40 && begins(blob.subarray(blob.readUInt32LE(0x3c)), 0x50, 0x45, 0x00, 0x00);

/**
 * Compiled and archived formats, by the bytes a file of that format BEGINS with, and what to call it.
 *
 * Every one of these is something a build produced: a compiler, a linker, `go build`, `cargo build`,
 * `pip wheel`, `javac`. The list NAMES what was found — the detection that does not depend on
 * enumerating formats is the NUL-byte test beside it, because a magic number is at offset 0 and
 * anything prepended hides it.
 *
 * Byte orders: Mach-O's magic is written in the host's order, so a file produced on a big-endian host
 * and read here has it reversed (`MH_CIGAM`) — both are the same format and both are output. The
 * universal-binary header `0xCAFEBABE` is also the Java class-file magic, which needs no separate
 * entry: a `.class` is build output too.
 */
const MAGIC = [
  ['ELF — a Linux executable, a `.so`, or a `.o`', (b) => begins(b, 0x7f, 0x45, 0x4c, 0x46)],
  [
    'Mach-O — a macOS executable, a `.dylib`, a `.o`, or a `.node` addon',
    (b) =>
      begins(b, 0xfe, 0xed, 0xfa, 0xce) || // MH_MAGIC     32-bit
      begins(b, 0xce, 0xfa, 0xed, 0xfe) || // MH_CIGAM     32-bit, byte-swapped
      begins(b, 0xfe, 0xed, 0xfa, 0xcf) || // MH_MAGIC_64
      begins(b, 0xcf, 0xfa, 0xed, 0xfe), //  MH_CIGAM_64
  ],
  [
    'a Mach-O universal binary, or a Java `.class`',
    (b) =>
      begins(b, 0xca, 0xfe, 0xba, 0xbe) || // FAT_MAGIC / Java
      begins(b, 0xbe, 0xba, 0xfe, 0xca) || // FAT_CIGAM
      begins(b, 0xca, 0xfe, 0xba, 0xbf) || // FAT_MAGIC_64
      begins(b, 0xbf, 0xba, 0xfe, 0xca), //  FAT_CIGAM_64
  ],
  ['PE/COFF — a Windows `.exe`, `.dll`, or `.obj`', (b) => begins(b, 0x4d, 0x5a) && isPE(b)],
  ['an `ar` archive — a `.a` static library, or a rust `.rlib`', (b) => begins(b, 0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a)],
  ['a zip archive — a `.whl` wheel, a `.jar`, a `.zip`', (b) => begins(b, 0x50, 0x4b, 0x03, 0x04)],
];

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

/**
 * The BLOB behind every sha, as `sha → Buffer`.
 *
 * The blobs, not the working-tree files at those paths. Those are different bytes whenever the tree is
 * dirty, and reading the tree while taking the mode from the index is what let a 20 MB Mach-O staged
 * 100755 pass by overwriting only the worktree copy with `#!/bin/sh` (exit 1 → exit 0, blob untouched
 * at 20040400 bytes). The index is what would be committed; it is the only thing this may consult.
 *
 * ONE `git cat-file --batch` for the whole index. Per-blob `git cat-file blob <sha>` is the same bytes
 * and reads far better, but it is a process per file: 40 s for this repository's 519, against 0.2 s
 * here — and a gate slow enough to be skipped is a gate nobody runs. Its output frames each blob as
 * `<sha> blob <size>\n<contents>\n`, so `missing`, a `commit` (a submodule sha) and a short stream all
 * fail the frame and are RED rather than silently absent.
 */
function blobsOf(entries) {
  const shas = [...new Set(entries.map((e) => e.sha))];
  let out;
  try {
    out = execFileSync('git', ['cat-file', '--batch'], { cwd: ROOT, input: `${shas.join('\n')}\n`, maxBuffer: 512 * 1024 * 1024 });
  } catch (err) {
    console.error(`❌ could not read the index's blobs (\`git cat-file --batch\`), so their contents could not be judged at all: ${err.message}`);
    process.exit(1);
  }
  const blobs = new Map();
  let at = 0;
  for (const sha of shas) {
    const eol = out.indexOf(0x0a, at);
    const header = eol === -1 ? out.subarray(at).toString('latin1') : out.subarray(at, eol).toString('latin1');
    const m = /^([0-9a-f]{40}) blob (\d+)$/.exec(header);
    if (!m || m[1] !== sha) {
      console.error(
        `❌ \`git cat-file --batch\` answered ${JSON.stringify(header)} where the blob ${sha} was expected, so this file's contents were never judged:\n` +
          `      ${entries.filter((e) => e.sha === sha).map((e) => e.path).join('\n      ')}`,
      );
      process.exit(1);
    }
    blobs.set(sha, out.subarray(eol + 1, eol + 1 + Number(m[2])));
    at = eol + 1 + Number(m[2]) + 1; // the LF git writes after the contents
  }
  if (at !== out.length) {
    console.error(`❌ \`git cat-file --batch\` left ${out.length - at} byte(s) unaccounted for after the ${shas.length} blobs asked for, so this script's reading of its output is wrong.`);
    process.exit(1);
  }
  return blobs;
}

/**
 * Tracked paths the committed `.gitignore` set matches — a `git add -f`, and nothing else can produce
 * one. `--exclude-per-directory` rather than `--exclude-standard`: see the header. The two fences that
 * make this an INDEX answer are checked at the call site.
 */
function ignoredButTracked() {
  try {
    return execFileSync('git', ['ls-files', '-z', '-i', '-c', '--exclude-per-directory=.gitignore'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);
  } catch (err) {
    console.error(`❌ could not ask git which tracked paths .gitignore matches: ${err.message}`);
    process.exit(1);
  }
}

/** Files in the tree that git does not track and `.gitignore` does not cover. */
function untracked() {
  try {
    return execFileSync('git', ['ls-files', '-z', '-o', '--exclude-per-directory=.gitignore'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);
  } catch (err) {
    console.error(`❌ could not ask git for the untracked files: ${err.message}`);
    process.exit(1);
  }
}

const IGNORE_FILE = (p) => p === '.gitignore' || p.endsWith('/.gitignore');

const entries = indexEntries();
const tracked = new Set(entries.map((e) => e.path));
// Clause D's split, made here because everything below reads a BLOB, and a symlink's or submodule's
// entry has none to read: 120000 stores a path, 160000 stores a commit sha.
const irregular = entries.filter((e) => !REGULAR.has(e.mode));
const regular = entries.filter((e) => REGULAR.has(e.mode));
const blobs = blobsOf(regular);
const problems = [];

/** A path is reported under the FIRST clause that explains it — one file, one reason, one fix. */
const claimed = new Set();
const take = (paths) => {
  const mine = [...new Set(paths)].filter((p) => !claimed.has(p)).sort();
  for (const p of mine) claimed.add(p);
  return mine;
};

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
// B1, by path: a `target/` whose parent holds a Cargo.toml — cargo's output dir, by its manifest.
const cargoOut = take(
  entries
    .map((e) => e.path)
    .filter((p) => {
      const parts = p.split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] !== 'target') continue;
        const crate = parts.slice(0, i).join('/');
        if (tracked.has(crate === '' ? 'Cargo.toml' : `${crate}/Cargo.toml`)) return true;
      }
      return false;
    }),
);
if (cargoOut.length > 0) {
  const dirs = [...new Set(cargoOut.map((p) => p.slice(0, p.indexOf('/target/') + 8)))];
  problems.push(
    `${cargoOut.length} tracked file(s) are cargo BUILD OUTPUT — inside a \`target/\` whose parent holds a Cargo.toml:\n` +
      dirs.map((d) => `      ${d}**   (${cargoOut.filter((p) => p.startsWith(d)).length} files)`).join('\n') +
      `\n\n      \`git rm -r\` the directory and give the crate a \`.gitignore\` holding \`target/\`,\n` +
      `      the way its siblings have one.`,
  );
}
// B1, by path: what the repository's own `.gitignore` set declares is not source. Both fences first —
// the answer must be the one the COMMITTED .gitignore files give, or this rule is not an index rule.
const driftedIgnores = regular
  .filter((e) => IGNORE_FILE(e.path))
  .filter((e) => {
    let onDisk;
    try {
      onDisk = readFileSync(join(ROOT, e.path));
    } catch {
      return true; // tracked and gone from the tree: git reads no patterns from it at all
    }
    return !onDisk.equals(blobs.get(e.sha));
  })
  .map((e) => e.path)
  .sort();
const addedIgnores = untracked().filter(IGNORE_FILE).sort();
if (driftedIgnores.length > 0 || addedIgnores.length > 0) {
  problems.push(
    `${driftedIgnores.length + addedIgnores.length} \`.gitignore\` file(s) in this tree are not the ones the index holds, so the rule below would be judged against an ignore set this repository does not declare:\n` +
      driftedIgnores.map((p) => `      ${p}   (${tracked.has(p) ? 'tracked, and the file on disk differs from its blob' : 'gone'})`).join('\n') +
      (driftedIgnores.length > 0 && addedIgnores.length > 0 ? '\n' : '') +
      addedIgnores.map((p) => `      ${p}   (untracked — nothing in the index says these patterns exist)`).join('\n') +
      `\n\n      git's exclude machinery has no index-only mode, so this one rule reads the tree. Commit\n` +
      `      or remove the change: a \`!pattern\` in a local .gitignore RE-INCLUDES a path and would\n` +
      `      hide exactly the \`git add -f\` this is looking for, so it is red rather than trusted.`,
  );
}
const forceAdded = take(ignoredButTracked());
if (forceAdded.length > 0) {
  problems.push(
    `${forceAdded.length} tracked file(s) are matched by this repository's own \`.gitignore\` — they can only have been added with \`git add -f\`:\n` +
      forceAdded.map((p) => `      ${JSON.stringify(p)}`).join('\n') +
      `\n\n      .gitignore is where this repository says what is not source: a build directory\n` +
      `      (\`dist/\`, \`php/vendor/\`, \`__pycache__/\`), a log, a coverage report. \`git rm --cached\`\n` +
      `      it — while it is tracked, the ignore rule that names it does nothing.`,
  );
}
// B2, by content: what the blob IS. Not what its mode says, and not what its name says.
const notSource = new Map();
for (const e of regular) {
  const blob = blobs.get(e.sha);
  const format = MAGIC.find(([, is]) => is(blob));
  const nul = blob.indexOf(0);
  if (format) notSource.set(e.path, `begins with the magic number of ${format[0]}`);
  else if (nul !== -1) notSource.set(e.path, `binary — a NUL byte at offset ${nul} of ${blob.length}`);
}
const artifacts = take([...notSource.keys()]);
if (artifacts.length > 0) {
  problems.push(
    `${artifacts.length} tracked file(s) are BUILD OUTPUT by their contents — the blob is not source text:\n` +
      artifacts.map((p) => `      ${JSON.stringify(p)}   (${notSource.get(p)})`).join('\n') +
      `\n\n      A build product does not belong in the index — it is per-platform, it is megabytes,\n` +
      `      and nothing reads it (the bench cells run \`go run ./<pkg>/\`). \`git rm\` it and ignore\n` +
      `      the path. This is a test on the CONTENT, so neither dropping the executable bit\n` +
      `      (\`git add --chmod=-x\`) nor prepending \`#!/bin/sh\` changes the answer.`,
  );
}
// B3: staged executable, and its blob is neither a script nor a binary the rule above could name.
const unclassifiable = take(
  regular.filter((e) => e.mode === '100755' && !notSource.has(e.path) && blobs.get(e.sha).subarray(0, 2).toString('latin1') !== '#!').map((e) => e.path),
);
if (unclassifiable.length > 0) {
  problems.push(
    `${unclassifiable.length} tracked file(s) are staged EXECUTABLE (100755) but their blobs are neither \`#!\` scripts nor any binary format this script knows:\n` +
      unclassifiable
        .map((p) => {
          const blob = blobs.get(entries.find((e) => e.path === p).sha);
          return `      ${JSON.stringify(p)}   (${blob.length} bytes, begins ${JSON.stringify(blob.subarray(0, 8).toString('latin1'))})`;
        })
        .join('\n') +
      `\n\n      \`execve\` runs exactly two things: a \`#!\` script, and a native executable format.\n` +
      `      A file carrying the bit that is neither cannot be run at all, so either the bit is\n` +
      `      wrong (\`git update-index --chmod=-x <path>\`) or this gate does not know the format —\n` +
      `      and an executable it cannot classify is red, not green.`,
  );
}

// ── C. empty files, both directions ─────────────────────────────────────────
const emptyNow = new Set(entries.filter((e) => e.sha === EMPTY_BLOB).map((e) => e.path));
const empties = take([...emptyNow].filter((p) => !EMPTY_FILES.includes(p)));
// The reverse: an exemption that has outlived its file. ROOT_FILES and check-go-fmt's GENERATED are
// both checked this way; EMPTY_FILES was not, so a path-specific licence to be empty would have stayed
// in force after the file stopped being empty — or stopped existing.
const stillExempt = EMPTY_FILES.filter((p) => !emptyNow.has(p)).sort();
if (empties.length > 0) {
  problems.push(
    `${empties.length} tracked file(s) are EMPTY and not in EMPTY_FILES:\n` +
      empties.map((p) => `      ${JSON.stringify(p)}`).join('\n') +
      `\n\n      Zero bytes is what a shell redirect leaves behind when a command was meant to run\n` +
      `      instead. If the file is deliberate (a package marker), list it in EMPTY_FILES.`,
  );
}
if (stillExempt.length > 0) {
  problems.push(
    `${stillExempt.length} name(s) in EMPTY_FILES are not empty tracked files any more — the exemption has outlived what it was written for, and a standing exemption nobody rechecks is how the next empty file at that path goes unnoticed:\n` +
      stillExempt.map((p) => `      ${p}   (${tracked.has(p) ? 'tracked, but no longer empty' : 'not tracked at all'})`).join('\n'),
  );
}

// ── D. every entry is a regular file ────────────────────────────────────────
if (irregular.length > 0) {
  problems.push(
    `${irregular.length} index entr${irregular.length === 1 ? 'y is' : 'ies are'} not a REGULAR FILE:\n` +
      irregular
        .map((e) => {
          const what = e.mode === '120000' ? 'a SYMLINK — its blob is a target path git stores and never validates' : e.mode === '160000' ? 'a SUBMODULE — its sha is a commit, not a blob' : 'a mode this script does not model';
          return `      ${JSON.stringify(e.path)}   (mode ${e.mode}: ${what})`;
        })
        .join('\n') +
      `\n\n      Every content check here reads a blob, and these have none to read: a symlink may\n` +
      `      leave the repository, point into a build directory or dangle, and it is neither empty\n` +
      `      nor binary, so it satisfies every other clause. This tree had none of either when the\n` +
      `      clause was written; if one is now deliberate, that is a change to make HERE.`,
  );
}

// ── E. every src module is REACHED by something ──────────────────────────────
//
// The one shape of junk clause A cannot see: a file in a SUBDIRECTORY, with a plausible name and
// ordinary text content. Measured, with a six-line valid-TypeScript `src/scp/notes.ts` that nothing
// imports staged: `tsc --noEmit`, `eslint src`, `npm run build` and every other `scripts/check-*.mjs`
// all exit 0. Nothing in this repository caught it, so being told it was "not checked" was the whole
// protection.
//
// It is caught by asking what REACHES it. A module under `src` is either published — reachable from an
// `exports` subpath's entry — or exercised by something outside `src` (a test, a conformance harness, a
// bench cell, a script), or reached from one of those transitively. A file none of that reaches is in
// the index for no reason anyone can point at.
//
// Roots come from the INDEX, not from a list here: every tracked JS-like file outside `src`. The only
// declared roots are the `exports` entries, which cannot be derived because `exports` names built
// artifacts — and that map is checked both ways against package.json.
//
// The import walk reads BLOBS, like every other clause, and it is deliberately crude: a regex over
// specifiers, static and relative only. Crude in the RED direction — an import form it fails to see
// makes a file look unreached, which is a false alarm someone must answer, never a silent pass. A
// dynamic `import(variable)` is the one shape that would need a real parser, and it too errs red.
const srcTs = regular.map((e) => e.path).filter((p) => p.startsWith('src/') && p.endsWith('.ts'));
if (srcTs.length > 0) {
  const pkg = JSON.parse(blobs.get(entries.find((e) => e.path === 'package.json').sha).toString('utf8'));
  const named = Object.keys(ENTRY_POINTS);
  const exported = Object.keys(pkg.exports ?? {});
  const unmapped = exported.filter((s) => !named.includes(s)).sort();
  const stale = named.filter((s) => !exported.includes(s)).sort();
  const gone = named.filter((s) => ENTRY_POINTS[s] !== null && !tracked.has(ENTRY_POINTS[s])).sort();
  if (unmapped.length > 0 || stale.length > 0 || gone.length > 0) {
    problems.push(
      `ENTRY_POINTS no longer describes package.json's \`exports\`, so clause E would walk from the wrong roots and a module reachable only from a published entry would read as unreferenced:\n` +
        [
          ...unmapped.map((s) => `      ${s}   (exported, but this script names no src module for it)`),
          ...stale.map((s) => `      ${s}   (named here, but package.json exports no such subpath)`),
          ...gone.map((s) => `      ${s} → ${ENTRY_POINTS[s]}   (named here, but that file is not tracked)`),
        ].join('\n'),
    );
  } else {
    /** `from '…'`, `import('…')`, `require('…')` — the specifier only. */
    const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
    const resolveSpec = (fromPath, spec) => {
      if (!spec.startsWith('.')) return null; // a bare specifier is a package, never a file under src/
      const base = join(dirname(fromPath), spec).replace(/\.(?:m|c)?js$/, '');
      for (const c of [`${base}.ts`, `${base}.mts`, `${base}.cts`, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.ts`]) {
        if (tracked.has(c)) return c;
      }
      return null;
    };
    const reached = new Set();
    const queue = [];
    for (const r of [...Object.values(ENTRY_POINTS).filter(Boolean), ...regular.map((e) => e.path).filter((p) => !p.startsWith('src/') && JS_LIKE.test(p))]) {
      if (!reached.has(r)) {
        reached.add(r);
        queue.push(r);
      }
    }
    const shaOf = new Map(regular.map((e) => [e.path, e.sha]));
    while (queue.length > 0) {
      const from = queue.shift();
      const blob = blobs.get(shaOf.get(from));
      if (!blob) continue;
      for (const [, spec] of blob.toString('utf8').matchAll(SPEC)) {
        const to = resolveSpec(from, spec);
        if (to && !reached.has(to)) {
          reached.add(to);
          queue.push(to);
        }
      }
    }
    const unreferenced = take(srcTs.filter((p) => !reached.has(p)));
    if (unreferenced.length > 0) {
      problems.push(
        `${unreferenced.length} module(s) under src/ are reached by NOTHING — not from a published \`exports\` entry, not from any tracked file outside src/, and not transitively from either:\n` +
          unreferenced.map((p) => `      ${p}`).join('\n') +
          `\n\n      A file in a subdirectory with a plausible name and ordinary text content is the one\n` +
          `      shape the root inventory cannot see, and nothing else here sees it: measured, a\n` +
          `      six-line valid-TypeScript src/scp/notes.ts that nothing imports leaves tsc, eslint,\n` +
          `      the build and every other check-*.mjs green. Delete it, or import it from whatever\n` +
          `      was supposed to use it. If it IS imported by a form this crude walk cannot see (a\n` +
          `      dynamic \`import(variable)\`), that is worth knowing too — this errs red.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('❌ the git index holds files nobody meant to commit:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(`${problems.length} problem(s). A tracked file is invisible to \`git status\` AND to .gitignore.`);
  process.exit(1);
}
console.log(
  `✅ ${entries.length} tracked files, judged from the index — mode, sha, and the blob behind the sha. Every\n` +
    `   entry is a REGULAR FILE (100644/100755): no symlink, no submodule. NO blob holds a NUL byte or begins\n` +
    `   with an executable/archive magic number (ELF, Mach-O incl. universal, PE/COFF with its PE signature,\n` +
    `   \`ar\`, zip), so a compiled artifact is red under any name, in any directory, with or without the\n` +
    `   executable bit, and with a \`#!\` line prepended; nothing is staged 100755 but a \`#!\` script. None is\n` +
    `   cargo build output (inside a \`target/\` whose parent holds a Cargo.toml) or a path this repository's\n` +
    `   own \`.gitignore\` matches (a \`git add -f\`) — and every tracked \`.gitignore\` equals its blob with no\n` +
    `   untracked one beside it, which is what makes that last answer the INDEX's and not this machine's.\n` +
    `   The root holds EXACTLY the ${ROOT_FILES.length} files ROOT_FILES lists; the only empty files are the ${EMPTY_FILES.length} EMPTY_FILES\n` +
    `   declares. Both lists are checked BOTH WAYS, so neither an inventory nor an exemption can outlive the\n` +
    `   file it was written for.\n` +
    `   Every module under src/ is REACHED by something — a published \`exports\` entry, a tracked file\n` +
    `   outside src/, or one of those transitively — so a plausibly-named text file nothing imports is red\n` +
    `   even though tsc, eslint and the build accept it.\n` +
    `   NOT checked, and these fall GREEN: a build artifact that is TEXT, is not ignored, and sits outside a\n` +
    `   cargo \`target/\` (a \`.d\` dep file, a generated \`.json\`, an emitted \`.ts\`) — nothing in its bytes\n` +
    `   distinguishes it from source; junk in a subdirectory OUTSIDE src/ with a plausible name and text\n` +
    `   content (a stray .go/.py/.php — an unreferenced .go file still compiles under \`go build ./...\`, so\n` +
    `   the toolchain says nothing, and only the root is inventoried); and anything UNTRACKED — that is\n` +
    `   \`git status\`, which works, which is why only the tracked ones needed a gate. Where it errs otherwise it errs RED: a locally modified or added \`.gitignore\`, an\n` +
    `   entry whose mode or blob it cannot parse, blobs together past its 512 MB read buffer.`,
);
