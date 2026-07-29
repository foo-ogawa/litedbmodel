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
 * label. Comments are blanked first (their characters replaced, so indentation and line numbers
 * survive). Every one of those is a rule that can only LOSE a match, never invent one, so it errs
 * RED: a re-indented label, a table whose bounds this does not find, a commented-out label — all
 * fail rather than pass. The one thing that could invent a match is a `case "x":` line synthesised by
 * a macro or a generated include, and neither runner has one (both tables are hand-written, which is
 * the whole reason this gate exists).
 *
 * What it does NOT check, and it falls GREEN — the direction that matters, so it is named: a label
 * that is PRESENT but calls the wrong generated entry, passes the wrong arguments, or compares the
 * wrong thing. This proves the table has an arm for every vector, not that the arm is correct. It
 * also says nothing about rust's `impl_to_compare!` lowering, whose absence is a trait-bound COMPILE
 * error — that half is `cargo clippy -p livedb_runner --features livedb --all-targets`, which
 * conformance.yml's rust leg runs (the runner is not a default-member and its generated modules are
 * behind `--features livedb`, so a plain `cargo check`/`--workspace` clippy compiles neither).
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
 * and the form of one label. `label` must capture the entry name in group 1 and match the WHOLE line
 * so that nothing embedded in a longer line can satisfy it.
 */
const RUNNERS = [
  {
    lang: 'go',
    file: 'go/conformance/livedb/livedb_runner.go',
    opens: /^func callEntry\(/,
    closes: /^\s*default:\s*$/,
    label: /^\s*case "([A-Za-z0-9_]+)":\s*$/,
    how: 'case "<entry>":',
  },
  {
    lang: 'rust',
    file: 'rust/livedb_runner/src/main.rs',
    opens: /^\s*fn call_entry\(/,
    closes: /^\s*other =>/,
    label: /^\s*"([A-Za-z0-9_]+)" => \{\s*$/,
    how: '"<entry>" => {',
  },
];

/**
 * `src` with every comment blanked — a line comment to end of line, a block comment through its
 * terminator including across lines — replacing each comment character with a space so indentation,
 * line numbers and line lengths are unchanged. String literals are not tracked, so a `//` inside one blanks the rest of that line; that
 * can only remove a label match, which fails RED.
 */
function blankComments(src) {
  const out = [...src];
  let i = 0;
  while (i < out.length) {
    if (out[i] === '/' && out[i + 1] === '/') {
      while (i < out.length && out[i] !== '\n') out[i++] = ' ';
    } else if (out[i] === '/' && out[i + 1] === '*') {
      while (i < out.length && !(out[i] === '*' && out[i + 1] === '/')) {
        if (out[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < out.length) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
    } else {
      i++;
    }
  }
  return out.join('');
}

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * The entry labels one runner's dispatch table declares, or a `problem` explaining why the table
 * could not be read. Never both, and never an empty set treated as success — a table this cannot
 * find is a check that would pass vacuously.
 */
function labelsOf(runner) {
  const lines = blankComments(readFileSync(join(ROOT, runner.file), 'utf8')).split('\n');
  const open = lines.findIndex((l) => runner.opens.test(l));
  if (open === -1) {
    return { problem: `${runner.file}: no line opens the dispatch table (expected /${runner.opens.source}/). It was renamed or moved, and a scan that finds no table would pass every check below vacuously.` };
  }
  const close = lines.findIndex((l, n) => n > open && runner.closes.test(l));
  if (close === -1) {
    return { problem: `${runner.file}: the dispatch table opens at line ${open + 1} but no catch-all closes it (expected /${runner.closes.source}/). Without that bound this cannot tell a dispatch label from any other line of the file.` };
  }
  const body = lines.slice(open + 1, close);
  const matched = body.map((l, n) => ({ line: open + 2 + n, text: l, m: runner.label.exec(l) })).filter((r) => r.m);
  if (matched.length === 0) {
    return { problem: `${runner.file}: the dispatch table at lines ${open + 1}-${close + 1} declares NO label of the form \`${runner.how}\`. Either the form changed or the table is empty; both make this check vacuous.` };
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
    `\n   Read as a position in the dispatch table (signature → catch-all, at the first label's indentation,\n` +
    `   comments blanked), so a label this cannot place is not counted and the check fails RED.\n` +
    `   NOT checked, and it falls GREEN: whether a present arm calls the RIGHT generated entry with the\n` +
    `   right arguments. python/php are not checked at all — they dispatch \`ops[entry]\` by name.\n` +
    `   rust's \`impl_to_compare!\` lowering is a COMPILE error: cargo clippy -p livedb_runner --features livedb.`,
);
