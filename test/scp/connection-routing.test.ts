import { describe, it, expect } from 'vitest';
import {
  resolvePool,
  WriterStickyClock,
  ConnectionRegistry,
  type AsyncConnectionPool,
  type RoutingConfig,
} from '../../src/scp';

// A fake pool IDENTITY: `resolvePool` returns the pool by reference and never acquires, so a bare
// object stands in for a real AsyncConnectionPool — this is a pure routing unit test (no live DB), the
// TS analogue of the go/python/php `_FakePool` routing tests.
function fakePool(label: string): AsyncConnectionPool {
  return {
    async acquire(): Promise<never> {
      throw new Error(`fake pool ${label} must not be acquired in a routing unit test`);
    },
    async release(): Promise<void> {},
  };
}

describe('WriterStickyClock — t=0 regression (#218)', () => {
  it('a mark() at clock t=0 arms stickiness → the read routes to the WRITER (read-your-writes)', () => {
    // The old code stored 0 as "never marked" (a value sentinel), so a commit when `Date.now()` / the
    // injectable clock returns 0 failed to stick and the read leaked to the reader replica. Revert
    // `lastWriteAt` to `= 0` + `=== 0` ⇒ both assertions below go RED. Every OTHER sticky test marks at
    // a non-zero clock (1_000_000), so this t=0 case was previously unproven.
    const reader = fakePool('reader');
    const writer = fakePool('writer');
    const sticky = new WriterStickyClock({ useWriterAfterTransaction: true, writerStickyDuration: 5000, now: () => 0 });
    const routing: RoutingConfig = { registry: ConnectionRegistry.fromDefault({ reader, writer }).build(), sticky };

    // Before any mark → reader (absence, not sticky), even at t=0.
    expect(resolvePool({ write: false }, routing)).toBe(reader);
    // A commit at clock t=0 arms the sticky clock.
    sticky.mark();
    expect(resolvePool({ write: false }, routing)).toBe(writer);
  });
});
