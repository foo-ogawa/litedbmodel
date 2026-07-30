#!/usr/bin/env node
/**
 * Stale-claim detector for the tx-pin / named-DB precedence rule (#217).
 *
 * ## Why this is a gate and not a review checklist
 *
 * Since #217 gave a statement its own database (`ExecOptions.db` → `StatementIntent.db`), the tx pin no
 * longer serves EVERY statement of a transaction body: one naming a DIFFERENT database than the
 * transaction opened on is REJECTED (`assertTxDbAgrees` and its four ports) because a transaction is ONE
 * connection on ONE database. Dozens of comments across five languages asserted the old, unconditional
 * rule — "every statement resolves the pin", "the pin STILL wins over routing", "routing is inert inside
 * the tx".
 *
 * Those were corrected by hand FOUR times, and each round a fresh set surfaced: the twin in another
 * language, the twin 20 lines lower in the same file, the sibling nobody had listed. Hand-sweeping a
 * claim that appears in ~50 places across 5 languages does not converge, and a report of "all of them"
 * from a hand sweep is not evidence. So the invariant is enforced here instead: EVERY occurrence of the
 * claim vocabulary must carry one of the two CANONICAL qualifier spellings in its own comment block, or
 * be named in {@link ALLOWLIST} with a reason.
 *
 * ## The rule, in three clauses
 *
 *   A. Every SENTENCE that contains both a {@link VOCAB} spelling and a {@link PIN_TOPIC} word must also
 *      contain a {@link QUALIFIER}. The unit is the SENTENCE of the joined comment block, not a window of
 *      N characters: a claim and its exception belong to one sentence, so "qualified" cannot be satisfied
 *      by unrelated words that merely happen to be near. A ±N-character window is exactly what let four
 *      hand sweeps report zero while six named sites were still in the tree. Block-joining before the
 *      split is what catches a claim BROKEN ACROSS LINES ("so EVERY\n statement `body` issues resolves
 *      THAT connection"), which is how five of them survived those sweeps and this gate's first draft.
 *   B. An occurrence that is NOT about the tx pin is not a claim about it and passes clause A untouched.
 *      Where that cannot be decided from the block's own words (a test's assertion MESSAGE, an identifier),
 *      it must be listed in {@link ALLOWLIST} with a reason.
 *   C. Every {@link ALLOWLIST} entry must still MATCH something. A stale entry fails, the same
 *      bidirectional rule `scripts/check-go-test-skips.mjs` applies to its `LIVE_TESTS` list — otherwise
 *      an allowlist silently grows into a blanket ignore.
 *
 * Run: `npm run claims:check`
 */

import { readFileSync, statSync } from 'node:fs';
import { globSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the claim can live: the library source and the four language runtimes, plus their tests. NOT the
 * bc-GENERATED modules (`**\/gen/**`, `behaviors_*`) — those carry no prose, and they are rewritten by
 * `bc generate` on every run.
 */
const SCAN = [
  'src/**/*.ts',
  'test/**/*.ts',
  'conformance/*.ts',
  'benchmark/crosslang/*.ts',
  'go/litedbmodel_runtime/*.go',
  'go/conformance/*.go',
  'rust/litedbmodel_runtime/src/*.rs',
  'rust/litedbmodel_runtime/tests/*.rs',
  'rust/livedb_runner/src/*.rs',
  'python/litedbmodel_runtime/*.py',
  'python/tests/*.py',
  'php/src/*.php',
  'php/tests/*.php',
];
const SKIP = ['/gen/', 'behaviors_', '/target/', 'node_modules', '/.generated'];

/**
 * The claim vocabulary — the spellings that assert the OLD unconditional rule. Every one of these has been
 * found in the tree asserting it, which is why each is here rather than in a "maybe" list.
 */
const VOCAB = [
  /\bEVERY statement\b/i,
  /\ball of them\b/,
  /\bSTILL wins\b/,
  /\bpin(?:ned|s)?\b[^.]{0,50}\bwins\b/,
  /\bwins\b[^.]{0,50}\brouting\b/,
  /routing is inert/i,
  /\bINERT\b/,
  /any `?intent\.db`?/i,
  /Phase B is (?:NOT|not) broken/,
  /Phase B unbroken/,
  /ownership is (?:NOT|not) broken/,
  /never a fresh/i,
  /\balways the tx-owned\b/,
  /\balways returns THIS\b/,
];

/**
 * A sentence counts as a claim about the tx pin only if it SAYS so. This is the mechanical form of clause
 * B: the words are the sentence's own, not a guess about proximity. A module header that says "every
 * statement funnels through the ONE seam" in one sentence and mentions the pin in another is therefore not
 * a pin claim — the two facts are not being joined by the text.
 */
const PIN_TOPIC =
  /\bpin(?:ned|s|ning)?\b|tx-owned|tx OWNED|tx owned|tx-scoped|tx connection|owned connection|inside a (?:tx|transaction)|in a transaction|transaction body|tx body|transaction's whole duration|connection_for|connectionFor|ConnectionFor|withTransaction|with_transaction|WithTransaction|begin_tx|beginTx|TxConnection/;

/**
 * The TWO canonical qualifier spellings. A closed set of exactly two fixed strings, both of which name the
 * exception explicitly — so "qualified" is a property of the text, not of how near some other words are.
 *
 *   1. the "serves only these" form — the pin serves the statements OF THE TX'S OWN DATABASE;
 *   2. the "and the others are refused" form — a statement naming a DIFFERENT database is REJECTED.
 */
const QUALIFIER = [/of the tx's own database/, /naming a DIFFERENT database is (?:REJECTED|rejected)/];

/**
 * Occurrences that are NOT decidable from their own comment block: assertion MESSAGES and identifiers
 * (they have no block), and prose whose subject is provably not the pin but whose block mentions it in
 * passing. Each entry is `{ file, snippet, reason }`; `snippet` must still be found on a HIT line in
 * `file`, or the entry is stale and this gate fails (clause C).
 */
const ALLOWLIST = [
  {
    file: 'go/litedbmodel_runtime/write.go',
    snippet: 'a tx statement always targets the writer / tx connection',
    reason:
      'about StatementIntent.write (a tx statement is a WRITE intent), not about which database the pin ' +
      'serves. The sentence never mentions intent.db.',
  },
  {
    file: 'rust/litedbmodel_runtime/src/leaves.rs',
    snippet: 'the tx pin wins over its read intent',
    reason:
      "a test's expected-transcript comment about pin-vs-READER/WRITER precedence, which #217 did not " +
      'change: a read inside a tx still runs on the pinned writer connection.',
  },
  {
    file: 'rust/litedbmodel_runtime/src/driver.rs',
    snippet: 'it delegates every statement to the inner tx-owned connection',
    reason:
      'ConfiguredDriver\'s tx handle: it forwards to the ONE connection it wraps. A driver wrapper has no ' +
      'registry and no intent, so the named-DB rule does not apply to it.',
  },
];

// ── the scan ──────────────────────────────────────────────────────────────────────────────────────

/** A source line's comment marker, per language (the gate only judges PROSE). */
const COMMENT = /^\s*(?:\/\/\/?!?|\/\/|\*|#|--)\s?|^\s*\/\*+\s?/;

/** Is `line` a comment line (or inside a `/** … *\/` block, which the `*` prefix covers)? */
function isComment(line) {
  return COMMENT.test(line);
}

/**
 * The maximal run of consecutive comment lines containing line `i` (1-based), joined with the markers
 * stripped. A non-comment hit (a string literal, an identifier) yields just its own line.
 */
function blockStart(lines, i) {
  const idx = i - 1;
  if (!isComment(lines[idx])) return i;
  let a = idx;
  while (a > 0 && isComment(lines[a - 1])) a--;
  return a + 1;
}

function blockAround(lines, i) {
  const idx = i - 1;
  if (!isComment(lines[idx])) return lines[idx];
  let a = idx;
  let b = idx;
  while (a > 0 && isComment(lines[a - 1])) a--;
  while (b < lines.length - 1 && isComment(lines[b + 1])) b++;
  return lines
    .slice(a, b + 1)
    .map((l) => l.replace(COMMENT, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

function files() {
  const out = new Set();
  for (const pattern of SCAN) {
    for (const f of globSync(pattern, { cwd: ROOT })) {
      const p = f.split('\\').join('/');
      if (SKIP.some((k) => `/${p}`.includes(k))) continue;
      try {
        if (statSync(join(ROOT, p)).isFile()) out.add(p);
      } catch {
        /* a glob match that vanished — nothing to scan */
      }
    }
  }
  return [...out].sort();
}

const hits = [];
for (const f of files()) {
  const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
  const seen = new Set();
  for (let i = 1; i <= lines.length; i++) {
    // JOIN the comment block first (so a claim broken across lines is one string), then split it into
    // SENTENCES and judge each: a sentence is the unit that carries a claim together with its exception.
    const block = blockAround(lines, i);
    const start = blockStart(lines, i);
    for (const sentence of block.split(/(?<=[.;:])\s+/)) {
      const v = VOCAB.find((re) => re.test(sentence));
      if (v === undefined) continue;
      const key = `${start}:${String(v)}:${sentence.slice(0, 40)}`;
      if (seen.has(key)) continue; // one report per (block, vocabulary, sentence)
      seen.add(key);
      hits.push({
        file: f,
        line: start,
        vocab: String(v),
        text: sentence.trim(),
        block,
        aboutPin: PIN_TOPIC.test(sentence),
        qualified: QUALIFIER.some((re) => re.test(sentence)),
      });
    }
  }
}

// ── the three clauses ─────────────────────────────────────────────────────────────────────────────

const allowed = (h) =>
  ALLOWLIST.some((a) => a.file === h.file && (h.text.includes(a.snippet) || h.block.includes(a.snippet)));

const violations = hits.filter((h) => h.aboutPin && !h.qualified && !allowed(h));
const staleAllowlist = ALLOWLIST.filter(
  (a) => !hits.some((h) => h.file === a.file && (h.text.includes(a.snippet) || h.block.includes(a.snippet))),
);

const total = hits.length;
const pin = hits.filter((h) => h.aboutPin).length;
const usedAllow = hits.filter((h) => h.aboutPin && !h.qualified && allowed(h)).length;

if (violations.length > 0 || staleAllowlist.length > 0) {
  if (violations.length > 0) {
    console.error(
      `\n❌ ${violations.length} claim(s) assert the pre-#217 rule — the tx pin does NOT serve a statement\n` +
        `   that names a DIFFERENT database than the transaction opened on; it REJECTS it. Add one of the\n` +
        `   two canonical qualifiers to the comment block, or allowlist it with a reason:\n` +
        `     1. "of the tx's own database"\n` +
        `     2. "naming a DIFFERENT database … is REJECTED"\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    ${v.text.slice(0, 150)}`);
    }
  }
  if (staleAllowlist.length > 0) {
    console.error(
      `\n❌ ${staleAllowlist.length} ALLOWLIST entr(ies) match nothing — the text moved or was rewritten.\n` +
        `   Delete the entry (an allowlist that outlives its target is a blanket ignore):\n`,
    );
    for (const a of staleAllowlist) console.error(`  ${a.file}  «${a.snippet}»`);
  }
  console.error(
    `\nscanned ${total} occurrence(s) of the claim vocabulary; ${pin} are about the tx pin.\n`,
  );
  process.exit(1);
}

console.log(
  `✅ pin-precedence claims: ${total} occurrence(s) of the claim vocabulary across ${files().length} files; ` +
    `${pin} are about the tx pin and every one of them carries a canonical qualifier ` +
    `(${usedAllow} allowlisted with a reason, all ${ALLOWLIST.length} entries still matching).`,
);
