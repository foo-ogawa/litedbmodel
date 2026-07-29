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
 * The accepted line is `^[A-Z][A-Z0-9_]*=`, character for character the filter CI applies when it
 * opens the gates (`conformance.yml`, step "Open the live-DB test gates":
 * `grep -E '^[A-Z][A-Z0-9_]*=' livedb-gates.env >> "$GITHUB_ENV"`). A line this module accepts that
 * the grep does not is a gate CI never sets while a checker believes it did.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATES_ENV = 'livedb-gates.env';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Declared gate name → declared value, in file order. */
export function readGateDeclarations() {
  const declared = new Map();
  for (const line of readFileSync(join(ROOT, GATES_ENV), 'utf8').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    // A shell `.`-source strips one layer of quoting; keep the value comparable to `process.env`.
    if (m) declared.set(m[1], m[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return declared;
}
