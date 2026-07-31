/**
 * The live-DB gate declarations, read in ONE place (#219).
 *
 * `livedb-gates.env` is the SSoT for "which variables open the live-DB legs, and to what". Two
 * checkers ask different halves of the same question about it — `check-reachable-test-gates.mjs`
 * asks whether every declaration gates a test and whether any workflow loads the file at all,
 * `check-go-test-skips.mjs` asks whether those declarations are actually IN its own environment
 * before it runs the go suite — so the FORMAT is parsed here and nowhere else. Two copies of this
 * parse are free to disagree about what counts as a declaration, and the one that is wrong is the
 * one nobody looks at.
 *
 * Which LINES count is character for character the filter CI applies when it opens the gates —
 * `^[A-Z][A-Z0-9_]*=` (`conformance.yml`, step "Open the live-DB test gates":
 * `grep -E '^[A-Z][A-Z0-9_]*=' livedb-gates.env >> "$GITHUB_ENV"`). A line this module accepts that
 * the grep does not is a gate CI never sets while a checker believes it did.
 *
 * The VALUE is where the two loaders of this file genuinely differ, so it cannot be read to match
 * both: `$GITHUB_ENV` takes everything after the `=` verbatim, while the local
 * `set -a && . ./livedb-gates.env` is a shell and strips one layer of quoting. They agree only on a
 * value that carries no quoting for a shell to strip, which is why every declaration below is a
 * bare `1`/`0` and the strip here never fires. It follows the local shell deliberately, because
 * that is the direction that fails where it counts: on `FOO="1"` this yields `1`, which equals a
 * locally sourced environment (green) and NOT the `"1"` CI would have (RED in CI). Reading the
 * value verbatim instead inverts that — green in CI, red only on the developer's machine.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATES_ENV = 'livedb-gates.env';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** How a gate is spelled wherever a test reads one. */
export const GATE_PATTERN = /LITEDBMODEL_[A-Z0-9_]+/g;

/**
 * `LITEDBMODEL_*` variables that are NOT skip gates, so naming one does not make a file a live-DB
 * leg and declaring one is not required. `LITEDBMODEL_LIVEDB_VECTORS` carries the corpus PATH into a
 * runner (set by `conformance/livedb-run.ts`, read by `rust/livedb_runner/src/main.rs` and its go
 * twin); nothing skips on it.
 */
export const NOT_A_GATE = new Set(['LITEDBMODEL_LIVEDB_VECTORS']);

/**
 * Whether `text` reads a live-DB gate — the ONE test for "this file holds live-DB legs", used by
 * every run gate to derive its live inventory from the tree and by `check-reachable-test-gates.mjs`
 * to decide which files a declaration must cover. Kept here with the pattern it applies, because a
 * second copy would be free to disagree about `LITEDBMODEL_LIVEDB_VECTORS` and the copy that is
 * wrong is the one nobody looks at.
 */
export function readsAGate(text) {
  return (text.match(GATE_PATTERN) ?? []).some((name) => !NOT_A_GATE.has(name));
}

/** Declared gate name → declared value, in file order. */
export function readGateDeclarations() {
  const declared = new Map();
  for (const line of readFileSync(join(ROOT, GATES_ENV), 'utf8').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    // One layer of quoting, as the local `.`-source would strip it — see above for why that side.
    if (m) declared.set(m[1], m[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return declared;
}
