import { itemKey, type EpgProgram, type ItemKey, type ItemRef } from '@/api/types';

import { ms } from './epgTime';

/** Programmes per channel for a row preview: the airing one plus the next, with a margin. */
export const PREVIEW_FETCH_SIZE = 3;

export interface PreviewQueueOptions {
  /** How long an answer is reused while its first programme is still airing. */
  ttlMs?: number;
  /** How long a failed or empty answer suppresses a new request. */
  emptyTtlMs?: number;
  concurrency?: number;
  /** Pause between two requests of one worker. */
  delayMs?: number;
  /** At most this many channels are fetched per sync (top of the visible window first). */
  maxPerSync?: number;
  /** First pause after the portal's guide times out or the network fails; doubles per failure. */
  backoffMs?: number;
  /** Longest pause between two attempts at a silent portal. */
  maxBackoffMs?: number;
  clock?: () => number;
}

interface Entry {
  programs: EpgProgram[];
  at: number;
}

/**
 * A timeout or network failure: the portal did not answer at all (`stalker.epg` gives up after
 * 20 s, 40 s with `from`). Asking the other rows would only queue more 20 s waits, so the whole
 * source backs off instead. Anything else (a bad channel, a parse error) only affects its row.
 */
export function isTransientEpgError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { retryable?: unknown; code?: unknown };
  return e.retryable === true || e.code === 'timeout' || e.code === 'network';
}

/**
 * Per-channel `stalker.epg` previews for the visible rows of a channel list. A portal has no bulk
 * now/next call that works everywhere, so each visible channel is asked on its own: throttled,
 * cached and limited to what the user is looking at, so scrolling a 10k list cannot flood the
 * portal. Rows that scroll away before their turn are dropped from the queue.
 */
export class StalkerPreviewQueue {
  private readonly cache = new Map<ItemKey, Entry>();
  private readonly inFlight = new Set<ItemKey>();
  private queue: ItemRef[] = [];
  private workers = 0;
  private generation = 0;
  private destroyed = false;
  /** Last wanted set, replayed when a backoff ends or on `retry()`. */
  private wanted: readonly ItemRef[] = [];
  /** Consecutive transient failures; 0 while the portal answers. */
  private failures = 0;
  private pausedUntil = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly opts: Required<PreviewQueueOptions>;

  constructor(
    private readonly fetchPrograms: (ref: ItemRef) => Promise<EpgProgram[]>,
    private readonly onUpdate: () => void,
    options: PreviewQueueOptions = {},
  ) {
    this.opts = {
      ttlMs: 5 * 60_000,
      emptyTtlMs: 60_000,
      concurrency: 2,
      delayMs: 150,
      maxPerSync: 30,
      backoffMs: 30_000,
      maxBackoffMs: 5 * 60_000,
      clock: Date.now,
      ...options,
    };
  }

  /** Cached programmes, or undefined when unknown or expired. */
  get(ref: ItemRef): EpgProgram[] | undefined {
    const key = itemKey(ref);
    const e = this.cache.get(key);
    if (!e) return undefined;
    return this.usable(e) ? e.programs : undefined;
  }

  /**
   * True after the portal's guide timed out or the network failed, until an answer arrives.
   * Rows keep their cached programmes; the rest show the guide as unavailable.
   */
  get unavailable(): boolean {
    return this.failures > 0;
  }

  /** When the next automatic attempt runs (epoch ms), while backing off. */
  get retryAt(): number | undefined {
    return this.failures > 0 && this.pausedUntil > this.opts.clock() ? this.pausedUntil : undefined;
  }

  /** Ends the backoff now and asks the portal again for the wanted rows. */
  retry(): void {
    if (this.destroyed) return;
    this.clearTimer();
    this.pausedUntil = 0;
    this.sync(this.wanted);
  }

  /** Replaces the wanted set with `refs` (in display order) and starts fetching what is missing. */
  sync(refs: readonly ItemRef[]): void {
    if (this.destroyed) return;
    this.wanted = refs;
    // Backing off a silent portal: the timer replays the wanted set when the pause ends.
    if (this.pausedUntil > this.opts.clock()) {
      this.queue = [];
      return;
    }
    const missing: ItemRef[] = [];
    const seen = new Set<ItemKey>();
    for (const ref of refs) {
      const key = itemKey(ref);
      if (seen.has(key) || this.inFlight.has(key)) continue;
      seen.add(key);
      const e = this.cache.get(key);
      if (e && this.usable(e)) continue;
      missing.push(ref);
      if (missing.length >= this.opts.maxPerSync) break;
    }
    this.queue = missing;
    this.pump();
  }

  /** Forgets everything (source switch, EPG change); in-flight answers are dropped. */
  reset(): void {
    this.generation++;
    this.cache.clear();
    this.inFlight.clear();
    this.queue = [];
    this.failures = 0;
    this.pausedUntil = 0;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.resumeTimer !== undefined) clearTimeout(this.resumeTimer);
    this.resumeTimer = undefined;
  }

  /** One more transient failure: pause the whole source, doubling the pause each time. */
  private backOff(): void {
    const now = this.opts.clock();
    // Workers already in flight when the pause began fail the same way; count the outage once.
    if (this.pausedUntil > now) return;
    this.failures++;
    const pause = Math.min(this.opts.backoffMs * 2 ** (this.failures - 1), this.opts.maxBackoffMs);
    this.pausedUntil = now + pause;
    this.queue = [];
    this.clearTimer();
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined;
      if (!this.destroyed) this.sync(this.wanted);
    }, pause);
  }

  destroy(): void {
    this.reset();
    this.destroyed = true;
  }

  private usable(e: Entry): boolean {
    const now = this.opts.clock();
    if (e.programs.length === 0) return now - e.at < this.opts.emptyTtlMs;
    if (now - e.at >= this.opts.ttlMs) return false;
    // A programme boundary always triggers a fresh request instead of serving the one that ended.
    // The boundary is the end of the programme airing when the answer came; archived programmes
    // before it (an answer asked with `from`) are already over and never make the entry stale.
    const airing = e.programs.find((p) => ms(p.end) > ms(p.start) && ms(p.end) > e.at);
    return !airing || ms(airing.end) > now;
  }

  private pump(): void {
    while (!this.destroyed && this.workers < this.opts.concurrency && this.queue.length > 0) {
      this.workers++;
      void this.work();
    }
  }

  private async work(): Promise<void> {
    const gen = this.generation;
    try {
      for (let ref = this.queue.shift(); ref; ref = this.queue.shift()) {
        if (this.destroyed || gen !== this.generation) return;
        const key = itemKey(ref);
        this.inFlight.add(key);
        let programs: EpgProgram[];
        let transient = false;
        let answered = true;
        try {
          programs = await this.fetchPrograms(ref);
        } catch (err) {
          programs = [];
          answered = false;
          transient = isTransientEpgError(err);
        }
        if (this.destroyed || gen !== this.generation) return;
        this.inFlight.delete(key);
        if (transient) {
          // Nothing cached for the row: it is asked again once the source's pause ends.
          this.backOff();
        } else {
          // Only an answer proves the portal is back; a per-row error says nothing about it.
          if (answered) this.failures = 0;
          this.cache.set(key, { programs, at: this.opts.clock() });
        }
        this.onUpdate();
        if (this.queue.length > 0 && this.opts.delayMs > 0) await new Promise((r) => setTimeout(r, this.opts.delayMs));
      }
    } finally {
      this.workers--;
      // A worker that quit on a reset hands its slot to the queue of the new generation.
      if (gen !== this.generation) this.pump();
    }
  }
}
