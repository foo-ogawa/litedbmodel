#!/usr/bin/env node
/**
 * The live-DB conformance runners DISPATCH every corpus entry (#201).
 *
 * Adding a conformance endpoint means hand-following the two runners that cannot look a method up by
 * name — go `go/conformance/livedb/livedb_runner.go` and rust `rust/livedb_runner/src/main.rs`. Their
 * `switch entry` / `match entry` is the sanctioned signature-direct call table (CLAUDE.md §3.1); what
 * is NOT sanctioned is how late a missed one shows up. BOTH runners end their table in a catch-all
 * (`default: return nil, fmt.Errorf("unknown entry %q", entry)` and `other => Err(BehaviorError::new(
 * "UNKNOWN_ENTRY", …))`), so a missing arm COMPILES in both languages — `go build ./...`,
 * `cargo clippy`, nothing sees it — and surfaces as one failing vector after docker is up and the
 * other three language legs have run.
 *
 * python and php are not checked because they have nothing to follow: both dispatch
 * `ops[vector['entry']]`, a name lookup on the generated module's facade
 * (python/conformance/livedb_runner.py, php/conformance/livedb_runner.php).
 *
 * The invariant, in one clause per runner: the entry labels its dispatch table declares are EXACTLY
 * the entries `conformance/vectors-livedb/livedb.json` uses. That corpus is the SSoT — it is what the
 * runners iterate, it is committed, and `conformance:check:livedb` drift-gates it against the harness
 * declaration — so this needs no build, no toolchain and no database, and it is red BEFORE docker.
 * Both directions are red: a corpus entry with no label falls into the catch-all at run time, and a
 * label no vector reaches is dead code.
 *
 * A label is read as a POSITION IN THE DISPATCH TABLE, not as text occurring in the file. The table
 * runs from the dispatch function's signature to the first catch-all line after it; a label is a line
 * inside that region, matching the language's label form, at the indentation of the region's FIRST
 * label, AND BEGINNING IN CODE — see {@link codeMask}.
 *
 * That last condition is the one this script was first written WITHOUT, and it made the check
 * worthless in the exact scenario it exists for. Blanking comments alone left string literals intact,
 * so a label spelled inside a raw string counted as an arm. Measured, with go's real `case
 * "pagedFeed":` arm DELETED and this put at the table's own indentation inside a raw string:
 *
 *     case "posts":
 *             _ = `
 *     case "pagedFeed":
 *     `
 *
 * `grep -c pg.PagedFeed` → 0, `go build`/`go vet` → exit 0, and this script → exit 0 with the full
 * green line, while `pagedFeed`'s eight vectors fell into the catch-all. The rust twin (`r#"…"#`) was
 * green too. A line's first non-whitespace character is now required to be CODE, which rejects both.
 *
 * What it does NOT check, and every one of these falls GREEN — the direction that matters, so each is
 * named:
 *
 *   - a comment or literal construct {@link codeMask} does not model. What it RECOGNISES: line and
 *     block comments, the latter nesting or not per the language; `"…"` with backslash escapes; go's
 *     backtick raw strings; rust's `r"…"`, `r#"…"#`, `b"…"`, `br#"…"#` with any number of hashes; and
 *     `'x'` / `'\n'` char literals. That is the list it handles and NOT a claim to completeness — the
 *     previous version of this comment called the same list exhaustive for go and rust while rust's
 *     comment NESTING was missing from it, and a label hidden inside a nested comment counted as an arm
 *     (see {@link codeMask}). Anything outside the list is scanned as code, so a label inside it counts;
 *     being scanned as a literal when it is code is the opposite direction and fails RED, which is why
 *     `'` is only taken as a char literal in the exact `'x'` shape — a rust lifetime (`&'static str`)
 *     and a loop label (`'outer:`) are left as code.
 *   - a label that is PRESENT but calls the wrong generated entry, passes the wrong arguments, or
 *     compares the wrong thing. This proves the table has an arm for every vector, not that the arm is
 *     correct.
 *   - the close bound is the FIRST catch-all after the signature, so DELETING the table's own catch-all
 *     silently extends the region to the next one in the file (go has four more `default:` lines; the
 *     one after `callEntry` is inside `argToAny`). A larger region can only ADD labels, and a label no
 *     vector reaches is reported as a dead arm — so it errs red — but it WOULD hide a missing arm if
 *     some other switch in the same file spelled `case "<that entry>":`. Measured today: every
 *     label-shaped line in each file lies strictly inside its own table (go, 22 of them at lines
 *     295-408 in a table spanning 292-417; rust, 22 within 399-630), and there are none anywhere else.
 *   - rust's `impl_to_compare!` lowering, whose absence is a trait-bound COMPILE error — that half is
 *     `cargo clippy -p livedb_runner --features livedb --all-targets`, which conformance.yml's rust leg
 *     runs (the runner is not a default-member and its generated modules are behind `--features
 *     livedb`, so a plain `cargo check`/`--workspace` clippy compiles neither).
 *
 * Measured to err RED: a re-indented label, a table whose open or close bound is not found, a label
 * commented out with `//` or with a block comment (nested or not), a label inside a string literal, and
 * a runner entry that fails to declare whether its language's block comments nest. Those are the cases
 * that have been broken and observed failing — not a closing claim that nothing else can pass, which is
 * what the two previous versions of this comment asserted and what the audits then disproved twice.
 *
 *   node scripts/check-livedb-runner-dispatch.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CORPUS = join(ROOT, 'conformance', 'vectors-livedb', 'livedb.json');

/**
 * The two runners that dispatch by hand, each as: the file, the line that OPENS its dispatch table,
 * the line that CLOSES it (the catch-all — the arm that turns an unknown entry into a runtime error),
 * the form of one label, and whether the language's block comments NEST. `label` must capture the
 * entry name in group 1 and match the WHOLE line so that nothing embedded in a longer line can satisfy
 * it.
 *
 * `nestedBlockComments` is a property of the LANGUAGE, which is why it is declared here beside the
 * other per-language syntax rather than assumed inside the scanner. Go: "Comments do not nest"
 * (spec, Comments). Rust: block comments nest (reference, Comments). Reading rust's as flat let a
 * commented-out label go uncounted while the arm it was hiding did not exist — see {@link codeMask}.
 */
const RUNNERS = [
  {
    lang: 'go',
    file: 'go/conformance/livedb/livedb_runner.go',
    opens: /^func callEntry\(/,
    closes: /^\s*default:\s*$/,
    label: /^\s*case "([A-Za-z0-9_]+)":\s*$/,
    how: 'case "<entry>":',
    nestedBlockComments: false,
  },
  {
    lang: 'rust',
    file: 'rust/livedb_runner/src/main.rs',
    opens: /^\s*fn call_entry\(/,
    closes: /^\s*other =>/,
    label: /^\s*"([A-Za-z0-9_]+)" => \{\s*$/,
    how: '"<entry>" => {',
    nestedBlockComments: true,
  },
];

// `nestedBlockComments` must be DECLARED, not defaulted. Omitting it on the rust entry is a mistake
// already made once here, and because `undefined` is falsy it silently selected the flat scan — the
// exact hole this property exists to close, reintroduced by a missing line. An absent or non-boolean
// declaration is therefore red before anything is scanned.
for (const r of RUNNERS) {
  if (typeof r.nestedBlockComments !== 'boolean') {
    console.error(
      `❌ the ${r.lang} runner entry does not declare \`nestedBlockComments\` (got ${JSON.stringify(r.nestedBlockComments)}). ` +
        `Whether block comments nest is a property of the language and decides how ${r.file} is scanned; left undefined it would default to NOT nesting, which is how a commented-out label came to be counted as an arm.`,
    );
    process.exit(1);
  }
}

/**
 * A byte-for-byte mask over `src`: 1 where the character is CODE, 0 where it is the body of a comment
 * or of a string / char literal.
 *
 * Blanking is NOT an option here, which is the trap the first version of this script fell into: a
 * dispatch label IS a string literal (`case "pagedFeed":`, `"pagedFeed" => {`), so blanking string
 * contents erases every real label and the whole check collapses. What distinguishes a real label from
 * one spelled inside another string is not the label text — it is identical — but whether the line
 * BEGINS in code. So the OPENING delimiter of a literal stays code (it is code punctuation, and it is
 * the first non-whitespace character of every rust label line) while the body and the closing
 * delimiter do not. A label nested in a raw string therefore starts inside that string's body, at 0.
 *
 * One pass, and it is the only normalisation the label matcher consumes. What it recognises: `//` to
 * end of line; `/*` through its terminator, NESTING where `nestedBlockComments` says the language
 * nests; `"…"` with backslash escapes; go's backtick raw strings; rust's `r"…"` / `r#"…"#` / `b"…"` /
 * `br##"…"##` with any number of hashes; and char literals in the exact `'x'` / `'\n'` shape ONLY, so a
 * rust lifetime (`&'static str`) and a loop label (`'outer:`) stay code rather than opening a literal
 * that swallows the rest of the line.
 *
 * Nesting is not a detail. Rust's block comments nest and go's do not, and reading rust's as flat made
 * the scanner leave a nested comment at the INNER terminator and call the rest of those lines code.
 * Measured, with rust's real `"usersWithPosts" => {` arm DELETED and, at the arm indentation, an outer
 * block comment holding a complete inner one, then the label, then the outer terminator:
 *
 *     `grep -c pg::usersWithPosts`                                    0
 *     cargo fmt --all -- --check                                      exit 0
 *     cargo clippy -p livedb_runner --features livedb --all-targets    exit 0
 *     this script                                                     exit 0
 *
 * The label inside the comment was counted as the arm that was gone, and its eight vectors would have
 * hit the catch-all on a live database.
 *
 * Where it is wrong it is wrong in a direction: marking code as a comment or literal loses label
 * matches and fails RED, while treating a comment or literal as code can invent one and falls GREEN.
 * The recognised list above is therefore not offered as exhaustive — the nesting hole was exactly a
 * missing item on a list that claimed to be — and "a construct this does not model" stays a named
 * green-falling limitation rather than a solved problem.
 */
function codeMask(src, nestedBlockComments) {
  const mask = new Uint8Array(src.length).fill(1);
  /** Mark [from, to) as non-code. Newlines are marked too — nothing reads the mask at one. */
  const body = (from, to) => {
    for (let k = Math.max(from, 0); k < Math.min(to, src.length); k++) mask[k] = 0;
  };
  const WORD = /[A-Za-z0-9_]/;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      body(i, j);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      // Depth-counted, which is the flat scan when the language does not nest: `depth` starts at 1 and
      // only `*/` decrements it, so go behaves exactly as before while rust's inner terminator closes
      // the inner comment instead of the outer one. An UNTERMINATED comment runs to end of file, marking
      // everything after it non-code — the table bounds are then not found, which is red.
      let j = i + 2;
      let depth = 1;
      while (j < src.length && depth > 0) {
        if (nestedBlockComments && src[j] === '/' && src[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (src[j] === '*' && src[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      body(i, j);
      i = j;
      continue;
    }
    // rust raw / byte strings. The `r` must not be continuing an identifier, or `for"…` would open one.
    const raw = /^b?r(#*)"/.exec(src.slice(i, i + 64));
    if (raw && !WORD.test(src[i - 1] ?? '')) {
      const open = i + raw[0].length;
      const term = `"${raw[1]}`;
      const end = src.indexOf(term, open);
      const stop = end === -1 ? src.length : end + term.length;
      body(open, stop);
      i = stop;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      const stop = end === -1 ? src.length : end + 1;
      body(i + 1, stop);
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"' && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, src.length);
      body(i + 1, stop);
      i = stop;
      continue;
    }
    const ch = /^'(\\.|[^'\\\n])'/.exec(src.slice(i, i + 8));
    if (ch) {
      body(i + 1, i + ch[0].length);
      i += ch[0].length;
      continue;
    }
    i++;
  }
  return mask;
}

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * The entry labels one runner's dispatch table declares, or a `problem` explaining why the table
 * could not be read. Never both, and never an empty set treated as success — a table this cannot
 * find is a check that would pass vacuously.
 */
function labelsOf(runner) {
  const src = readFileSync(join(ROOT, runner.file), 'utf8');
  const mask = codeMask(src, runner.nestedBlockComments);
  // Every line, with the mask value at its FIRST non-whitespace character — the one question asked of
  // the mask. A blank line begins in nothing and is never a bound or a label.
  let at = 0;
  const lines = src.split('\n').map((text) => {
    const start = at + indentOf(text);
    at += text.length + 1;
    return { text, code: text.trim() !== '' && mask[start] === 1 };
  });
  const open = lines.findIndex((l) => l.code && runner.opens.test(l.text));
  if (open === -1) {
    return { problem: `${runner.file}: no line of CODE opens the dispatch table (expected /${runner.opens.source}/). It was renamed or moved, and a scan that finds no table would pass every check below vacuously.` };
  }
  const close = lines.findIndex((l, n) => n > open && l.code && runner.closes.test(l.text));
  if (close === -1) {
    return { problem: `${runner.file}: the dispatch table opens at line ${open + 1} but no catch-all closes it (expected /${runner.closes.source}/). Without that bound this cannot tell a dispatch label from any other line of the file.` };
  }
  // A label must BEGIN IN CODE: the same spelling inside a comment or a string literal is not an arm,
  // and reading it as one is how a deleted arm went green.
  const matched = lines
    .slice(open + 1, close)
    .map((l, n) => ({ line: open + 2 + n, text: l.text, m: l.code ? runner.label.exec(l.text) : null }))
    .filter((r) => r.m);
  if (matched.length === 0) {
    return { problem: `${runner.file}: the dispatch table at lines ${open + 1}-${close + 1} declares NO label of the form \`${runner.how}\` that begins in code. Either the form changed or the table is empty; both make this check vacuous.` };
  }
  // Nested `switch`/`match` arms indent deeper than the table's own labels, so the table's labels are
  // the ones at the FIRST label's indentation. Errs red: a re-indented label is not counted.
  const depth = indentOf(matched[0].text);
  const labels = new Map();
  for (const r of matched) {
    if (indentOf(r.text) !== depth) continue;
    if (!labels.has(r.m[1])) labels.set(r.m[1], r.line);
  }
  return { labels };
}

const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
if (!Array.isArray(corpus.vectors) || corpus.vectors.length === 0) {
  console.error(`❌ ${CORPUS} holds no vectors, so there is nothing to require of either runner. An empty corpus makes this check vacuous.`);
  process.exit(1);
}
/** entry → the vectors that reach it, so a missing arm names what will fail. */
const required = new Map();
for (const v of corpus.vectors) {
  if (typeof v.entry !== 'string' || v.entry === '') {
    console.error(`❌ ${CORPUS} has a vector with no \`entry\` (${JSON.stringify(v.name ?? v)}), so what the runners must dispatch cannot be derived from it.`);
    process.exit(1);
  }
  if (!required.has(v.entry)) required.set(v.entry, []);
  required.get(v.entry).push(v.name ?? '(unnamed)');
}

const problems = [];
for (const runner of RUNNERS) {
  const { labels, problem } = labelsOf(runner);
  if (problem) {
    problems.push(problem);
    continue;
  }
  const missing = [...required.keys()].filter((e) => !labels.has(e)).sort();
  const dead = [...labels.keys()].filter((e) => !required.has(e)).sort();
  if (missing.length > 0) {
    problems.push(
      `${runner.file} does not dispatch ${missing.length} entr${missing.length === 1 ? 'y' : 'ies'} the live-DB corpus uses. Each falls into the runner's catch-all and fails as a VECTOR — with docker up and the other language legs already run:\n` +
        missing.map((e) => `      ${e}   (${required.get(e).length} vector(s), e.g. ${required.get(e)[0]})`).join('\n') +
        `\n\n      Add \`${runner.how}\` to the table${runner.lang === 'rust' ? ', and an `impl_to_compare!` for the entry\'s outType in BOTH dialect modules — that half is a compile error `cargo clippy -p livedb_runner --features livedb` reports' : ''}.`,
    );
  }
  if (dead.length > 0) {
    problems.push(
      `${runner.file} dispatches ${dead.length} entr${dead.length === 1 ? 'y' : 'ies'} no corpus vector reaches — dead arms, which nothing else notices because an arm that never runs never fails:\n` +
        dead.map((e) => `      ${e}   (line ${labels.get(e)})`).join('\n'),
    );
  }
}

if (problems.length > 0) {
  console.error('❌ the live-DB conformance runners are out of step with the corpus:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(`${problems.length} problem(s).`);
  process.exit(1);
}
console.log(
  `✅ both hand-written live-DB runners dispatch EXACTLY the ${required.size} entries the ${corpus.vectors.length}-vector corpus uses, with no dead arm —\n` +
    RUNNERS.map((r) => `   ${r.file}   (\`${r.how}\`)`).join('\n') +
    `\n   Each label is a position in the dispatch table: inside the signature → catch-all region, at the\n` +
    `   first label's indentation, and BEGINNING IN CODE — not in a comment and not in a string literal,\n` +
    `   with rust's block comments read as NESTING and go's as flat, per language.\n` +
    `   NOT checked, and every one of these falls GREEN:\n` +
    `     - a comment or literal construct the scanner does not model. It recognises line + block\n` +
    `       comments, "…" with escapes, go backtick raw strings, rust r"…"/r#"…"#/b"…"/br##"…"##, and\n` +
    `       '\\n'-shape char literals — offered as the list it HANDLES, not as a complete one: rust's\n` +
    `       comment nesting was a missing item on this list, and a label hidden by it counted as an arm.\n` +
    `       Anything outside the list is read as code, so a label inside it counts; the reverse mistake\n` +
    `       loses matches and fails red.\n` +
    `     - whether a PRESENT arm calls the right generated entry with the right arguments.\n` +
    `     - a DELETED catch-all: the close bound is the first one after the signature, so removing the\n` +
    `       table's own extends the region to the next in the file. That can only ADD labels, and an\n` +
    `       unreached label is reported as a dead arm — so it errs red — but it would hide a missing arm\n` +
    `       if another switch in the same file spelled that entry. Measured: no label-shaped line exists\n` +
    `       outside either table.\n` +
    `     - python/php, which are not checked at all and need no arm — they dispatch \`ops[entry]\` by name.\n` +
    `   rust's \`impl_to_compare!\` lowering is a COMPILE error: cargo clippy -p livedb_runner --features livedb.`,
);
