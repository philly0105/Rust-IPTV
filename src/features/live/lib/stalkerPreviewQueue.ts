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
  clock?: () => number;
}

interface Entry {
  programs: EpgProgram[];
  at: number;
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

  /** Replaces the wanted set with `refs` (in display order) and starts fetching what is missing. */
  sync(refs: readonly ItemRef[]): void {
    if (this.destroyed) return;
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
    const first = e.programs.find((p) => ms(p.end) > ms(p.start));
    return !!first && ms(first.end) > now;
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
        try {
          programs = await this.fetchPrograms(ref);
        } catch {
          programs = [];
        }
        if (this.destroyed || gen !== this.generation) return;
        this.inFlight.delete(key);
        this.cache.set(key, { programs, at: this.opts.clock() });
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
