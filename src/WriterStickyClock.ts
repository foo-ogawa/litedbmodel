/**
 * litedbmodel - Writer-sticky clock (read-your-writes for the request that committed)
 */
import { AsyncLocalStorage } from 'async_hooks';

/**
 * One async chain's record of its commits on a {@link WriterStickyClock}. A transaction enters a fresh
 * cell into its CALLER's chain when it starts and stamps it on commit, so the stamp is visible to the
 * caller's later reads and to nothing else: another request is another chain, and a chain that
 * inherited a cell (a request descending from startup code that committed) never stamps that cell —
 * it enters its own. `prev` links to the cells still open when this one began, so concurrent
 * transactions of ONE chain (`Promise.all([tx1, tx2])`) all count once they are done.
 */
export interface StickyCell {
  /**
   * `null` until stamped — absence, NOT a value sentinel. The injectable clocks legitimately return 0
   * (a monotonic clock right after process start), so encoding "never marked" as 0 would mis-classify a
   * commit at clock t=0 and leak the read-your-writes read to the reader replica.
   */
  at: number | null;
  open: boolean;
  readonly prev: StickyCell | null;
}

/** The latest stamp on `cell` or the open cells it was linked to. */
function latestStamp(cell: StickyCell | undefined): number | null {
  let latest: number | null = null;
  for (let c: StickyCell | null | undefined = cell; c; c = c.prev) {
    if (c.at !== null && (latest === null || c.at > latest)) latest = c.at;
  }
  return latest;
}

/**
 * A writer-sticky CLOCK (read-your-writes). After a transaction COMMITs, the reads of the async
 * chain that committed (the request that wrote) route to the WRITER for `stickyDurationMs`, so the
 * just-committed row is visible despite reader-replica lag. Other chains — concurrent requests — keep
 * reading from the reader: they did not write, so they have no lag to hide. The clock is per
 * DB base; the time it holds is per async chain.
 *
 * The transaction calls {@link begin} as its first synchronous step (so the cell lands in the caller's
 * chain), {@link mark} on commit, and {@link end} when the transaction is over; the read path reads
 * {@link isSticky}. `useWriterAfterTransaction=false` disables it entirely (`isSticky()` always false).
 * Without a separate writer the reads go to the one database either way.
 */
export class WriterStickyClock {
  private readonly chain = new AsyncLocalStorage<StickyCell>();
  private readonly enabled: boolean;
  private readonly stickyDurationMs: number;
  /** Injectable clock (tests advance it); defaults to `Date.now`. */
  private readonly now: () => number;

  constructor(opts: { useWriterAfterTransaction?: boolean; writerStickyDuration?: number; now?: () => number } = {}) {
    this.enabled = opts.useWriterAfterTransaction ?? true;
    this.stickyDurationMs = opts.writerStickyDuration ?? 5000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Start tracking a transaction in the current chain: enters a fresh cell that carries the chain's
   * latest stamp. Must run synchronously at the start of the transaction, before its first `await`.
   */
  begin(): StickyCell {
    const current = this.chain.getStore();
    let open: StickyCell | null = current ?? null;
    while (open !== null && !open.open) open = open.prev;
    const cell: StickyCell = { at: latestStamp(current), open: true, prev: open };
    this.chain.enterWith(cell);
    return cell;
  }

  /** The transaction that began `cell` is over (committed or not). */
  end(cell: StickyCell): void {
    cell.open = false;
  }

  /** Record that the current chain just committed. */
  mark(): void {
    if (!this.enabled) return;
    let cell = this.chain.getStore();
    if (cell === undefined) {
      cell = { at: null, open: false, prev: null };
      this.chain.enterWith(cell);
    }
    cell.at = this.now();
  }

  /** Is a read in the current chain sticky-to-writer (within `writerStickyDuration` of its last commit)? */
  isSticky(): boolean {
    if (!this.enabled) return false;
    const at = latestStamp(this.chain.getStore());
    return at !== null && this.now() - at < this.stickyDurationMs;
  }
}
