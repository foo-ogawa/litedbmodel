/**
 * Live-DB leg (re)generation entry, run under vitest's ESM resolver (#36 WS7g; #144).
 *
 *   npm run conformance:gen:livedb                          # write the language modules + corpus
 *   LIVEDB_GEN_MODE=check npm run conformance:gen:livedb    # drift-gate them (no write)
 *
 * Like gen-vectors.test.ts this is the SSoT generator wrapped so vitest resolves the ESM-only
 * behavior-contracts from source. It lowers the harness declaration for `postgres` + `mysql`, runs
 * `bc generate` for the python / php / go legs, and projects the frozen exec suite onto the live
 * dialects — no fixture is re-declared and no query is re-executed here.
 */
import { describe, it, expect } from 'vitest';
import { writeLivedbCorpus } from './gen-livedb';

const MODE = process.env.LIVEDB_GEN_MODE === 'check' ? 'check' : 'generate';

describe('live-DB cross-language leg', () => {
  it(`${MODE}s the language modules + the live-DB corpus`, () => {
    const file = writeLivedbCorpus(MODE);
    expect(file).toContain('livedb.json');
    // eslint-disable-next-line no-console
    console.log(`${MODE}: live-DB corpus ${file}`);
  }, 300_000);
});
