import { itemKey, type EpgProgram, type ItemKey, type ItemRef } from '@/api/types';

import { ms } from './epgTime';

/** Programmes per channel for a row preview: the airing one plus the next, with a margin. */
export const PREVIEW_FETCH_SIZE = 3;

export interface PreviewQueueOptions {
  /** How long an answer is reused while its first programme is still airing. */
  ttlMs?: number;
  /** Refresh at the next airing programme boundary (previews do; complete guide tables do not). */
  expireAtProgramBoundary?: boolean;
  /** Keep the last answer on screen while an expired entry is refreshed. */
  staleWhileRevalidate?: boolean;
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
  /**
   * Share the backoff and the answers with every other queue of this source (the live list, both
   * grid queues, the next grid window). Without it the queue keeps both to itself.
   */
  sourceId?: string;
  /** What this queue asks for beyond the channel (e.g. `limit|from`); part of its cache keys. */
  scope?: string;
}

interface Entry {
  programs: EpgProgram[];
  at: number;
}

/** Answers kept per source; the oldest go first beyond this. */
const MAX_CACHED = 2000;

/** One source's portal guide: whether it is answering, and what it said. */
interface SourceState {
  /** Consecutive transient failures; 0 while the portal answers. */
  failures: number;
  pausedUntil: number;
  resumeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Keyed by scope + item key, so a window moved back finds its earlier answers. */
  cache: Map<string, Entry>;
  /** Queues that synced and were not reset since; a pause, its end and a retry reach all of them. */
  queues: Set<StalkerPreviewQueue>;
}

const newSourceState = (): SourceState => ({ failures: 0, pausedUntil: 0, resumeTimer: undefined, cache: new Map(), queues: new Set() });

const sources = new Map<string, SourceState>();

function sourceState(sourceId: string): SourceState {
  let st = sources.get(sourceId);
  if (!st) {
    st = newSourceState();
    sources.set(sourceId, st);
  }
  return st;
}

/** Forgets every source's backoff and answers (a fresh render tree in tests). */
export function resetStalkerPreviewSources(): void {
  for (const st of sources.values()) if (st.resumeTimer !== undefined) clearTimeout(st.resumeTimer);
  sources.clear();
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
 *
 * With `sourceId`, the backoff and the answers belong to the source, not to the queue: a new queue
 * for a moved grid window (or the other page) keeps waiting out a silent portal's pause, and reuses
 * the answers already cached for its `scope`.
 */
export class StalkerPreviewQueue {
  private readonly shared: SourceState;
  /** True when `shared` is this queue's own (no `sourceId`): `reset` then forgets it too. */
  private readonly ownsState: boolean;
  private readonly scope: string;
  private readonly inFlight = new Set<ItemKey>();
  private queue: ItemRef[] = [];
  private workers = 0;
  private generation = 0;
  private destroyed = false;
  /** Last wanted set, replayed when a backoff ends or on `retry()`. */
  private wanted: readonly ItemRef[] = [];
  private readonly opts: Required<Omit<PreviewQueueOptions, 'sourceId' | 'scope'>>;

  constructor(
    private readonly fetchPrograms: (ref: ItemRef) => Promise<EpgProgram[]>,
    private readonly onUpdate: () => void,
    { sourceId, scope = '', ...options }: PreviewQueueOptions = {},
  ) {
    this.ownsState = sourceId === undefined;
    this.shared = sourceId === undefined ? newSourceState() : sourceState(sourceId);
    this.scope = scope;
    this.opts = {
      ttlMs: 5 * 60_000,
      expireAtProgramBoundary: true,
      staleWhileRevalidate: false,
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
    const e = this.shared.cache.get(this.cacheKey(itemKey(ref)));
    if (!e) return undefined;
    return this.opts.staleWhileRevalidate || this.usable(e) ? e.programs : undefined;
  }

  /**
   * True after the portal's guide timed out or the network failed, until an answer arrives.
   * Rows keep their cached programmes; the rest show the guide as unavailable.
   */
  get unavailable(): boolean {
    return this.shared.failures > 0;
  }

  /** When the next automatic attempt runs (epoch ms), while backing off. */
  get retryAt(): number | undefined {
    const st = this.shared;
    return st.failures > 0 && st.pausedUntil > this.opts.clock() ? st.pausedUntil : undefined;
  }

  /** Ends the source's backoff now and asks the portal again for every queue's wanted rows. */
  retry(): void {
    if (this.destroyed) return;
    this.clearTimer();
    this.shared.pausedUntil = 0;
    this.shared.queues.add(this);
    for (const q of [...this.shared.queues]) q.sync(q.wanted);
  }

  /** Replaces the wanted set with `refs` (in display order) and starts fetching what is missing. */
  sync(refs: readonly ItemRef[]): void {
    if (this.destroyed) return;
    this.shared.queues.add(this);
    this.wanted = refs;
    // Backing off a silent portal: the timer replays the wanted set when the pause ends.
    if (this.shared.pausedUntil > this.opts.clock()) {
      this.queue = [];
      return;
    }
    const missing: ItemRef[] = [];
    const seen = new Set<ItemKey>();
    for (const ref of refs) {
      const key = itemKey(ref);
      if (seen.has(key) || this.inFlight.has(key)) continue;
      seen.add(key);
      const e = this.shared.cache.get(this.cacheKey(key));
      if (e && this.usable(e)) continue;
      missing.push(ref);
      if (missing.length >= this.opts.maxPerSync) break;
    }
    this.queue = missing;
    this.pump();
  }

  /**
   * Stops this queue's work; in-flight answers are dropped. A shared source keeps its backoff and
   * answers for the other queues; a queue without `sourceId` forgets both.
   */
  reset(): void {
    this.generation++;
    this.inFlight.clear();
    this.queue = [];
    this.shared.queues.delete(this);
    if (this.ownsState) {
      this.shared.cache.clear();
      this.shared.failures = 0;
      this.shared.pausedUntil = 0;
      this.clearTimer();
    }
  }

  private cacheKey(key: ItemKey): string {
    return `${this.scope}\n${key}`;
  }

  private clearTimer(): void {
    const st = this.shared;
    if (st.resumeTimer !== undefined) clearTimeout(st.resumeTimer);
    st.resumeTimer = undefined;
  }

  /** One more transient failure: pause the whole source, doubling the pause each time. */
  private backOff(): void {
    const st = this.shared;
    const now = this.opts.clock();
    // Workers already in flight when the pause began fail the same way; count the outage once.
    if (st.pausedUntil > now) return;
    st.failures++;
    const pause = Math.min(this.opts.backoffMs * 2 ** (st.failures - 1), this.opts.maxBackoffMs);
    st.pausedUntil = now + pause;
    this.clearTimer();
    this.queue = [];
    for (const q of st.queues) {
      q.queue = [];
      // The other queues of the source show the outage too.
      if (q !== this) q.onUpdate();
    }
    st.resumeTimer = setTimeout(() => {
      st.resumeTimer = undefined;
      for (const q of [...st.queues]) q.sync(q.wanted);
    }, pause);
  }

  destroy(): void {
    this.reset();
    this.destroyed = true;
  }

  private store(key: ItemKey, programs: EpgProgram[]): void {
    const cache = this.shared.cache;
    const k = this.cacheKey(key);
    cache.delete(k);
    cache.set(k, { programs, at: this.opts.clock() });
    // A Map iterates in insertion order: the first keys are the oldest answers.
    for (const old of cache.keys()) {
      if (cache.size <= MAX_CACHED) break;
      cache.delete(old);
    }
  }

  private usable(e: Entry): boolean {
    const now = this.opts.clock();
    if (e.programs.length === 0) return now - e.at < this.opts.emptyTtlMs;
    if (now - e.at >= this.opts.ttlMs) return false;
    if (!this.opts.expireAtProgramBoundary) return true;
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
          if (answered && this.shared.failures > 0) {
            this.shared.failures = 0;
            for (const q of this.shared.queues) if (q !== this) q.onUpdate();
          }
          this.store(key, programs);
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
