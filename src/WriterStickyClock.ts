/**
 * litedbmodel - Writer-sticky clock (read-your-writes for the request that committed)
 */
import { currentRequestScope } from './RequestScope';

/**
 * A writer-sticky CLOCK (read-your-writes). After a request COMMITs, that request's reads route to the
 * WRITER for `stickyDurationMs`, so the just-committed row is visible despite reader-replica lag. Other
 * requests keep reading from the reader: they did not write, so they have no lag to hide. A request is
 * the scope opened by `Middleware.run` at the request entry, and the commit time is kept in that scope
 * (per clock, i.e. per DB base), so every read of the request sees it at any `await` depth. Outside a
 * request scope no commit time is kept and reads go to the reader.
 *
 * The transaction calls {@link mark} on commit; the read path reads {@link isSticky}.
 * `useWriterAfterTransaction=false` disables it entirely (`isSticky()` always false). Without a
 * separate writer the reads go to the one database either way.
 */
export class WriterStickyClock {
  private readonly enabled: boolean;
  private readonly stickyDurationMs: number;
  /** Injectable clock (tests advance it); defaults to `Date.now`. */
  private readonly now: () => number;

  constructor(opts: { useWriterAfterTransaction?: boolean; writerStickyDuration?: number; now?: () => number } = {}) {
    this.enabled = opts.useWriterAfterTransaction ?? true;
    this.stickyDurationMs = opts.writerStickyDuration ?? 5000;
    this.now = opts.now ?? Date.now;
  }

  /** Record that the current request just committed. */
  mark(): void {
    if (this.enabled) currentRequestScope()?.commits.set(this, this.now());
  }

  /** Is a read in the current request sticky-to-writer (within `writerStickyDuration` of its last commit)? */
  isSticky(): boolean {
    if (!this.enabled) return false;
    const at = currentRequestScope()?.commits.get(this);
    return at !== undefined && this.now() - at < this.stickyDurationMs;
  }
}
