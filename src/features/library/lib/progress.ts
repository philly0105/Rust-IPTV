/**
 * Live transfer progress from `downloads.progress` events. One shared
 * subscription while any component listens; speeds are smoothed so the
 * readout does not flicker at 4 updates per second.
 */

import { useSyncExternalStore } from 'react';

import { onAppEvent } from '@/api/events';
import type { Download, DownloadProgressEvent } from '@/api/types';

export interface LiveProgress {
  bytesDownloaded: number;
  totalBytes?: number;
  /** Smoothed bytes per second. */
  bytesPerSecond: number;
  at: number;
}

/** Weight of the newest sample in the moving average. */
const ALPHA = 0.35;
/** A sample older than this means the transfer has stalled. */
export const STALE_MS = 5_000;

type Listener = () => void;

export class ProgressStore {
  private readonly map = new Map<number, LiveProgress>();
  private readonly listeners = new Set<Listener>();
  private version = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly subscribeUpstream: (handler: (e: DownloadProgressEvent) => void) => () => void) {}

  ingest(e: DownloadProgressEvent, now = Date.now()): void {
    if (!e || typeof e.id !== 'number' || !Number.isFinite(e.bytesDownloaded)) return;
    const prev = this.map.get(e.id);
    const raw = Number.isFinite(e.bytesPerSecond) && e.bytesPerSecond > 0 ? e.bytesPerSecond : 0;
    const fresh = prev !== undefined && now - prev.at < STALE_MS && prev.bytesPerSecond > 0;
    const bytesPerSecond = fresh ? prev.bytesPerSecond * (1 - ALPHA) + raw * ALPHA : raw;
    const next: LiveProgress = { bytesDownloaded: e.bytesDownloaded, bytesPerSecond, at: now };
    if (e.totalBytes != null) next.totalBytes = e.totalBytes;
    this.map.set(e.id, next);
    this.bump();
  }

  get(id: number): LiveProgress | undefined {
    return this.map.get(id);
  }

  /** Drops samples for rows that are gone or no longer transferring. */
  prune(keepIds: Iterable<number>): void {
    const keep = new Set(keepIds);
    let changed = false;
    for (const id of [...this.map.keys()]) {
      if (!keep.has(id)) {
        this.map.delete(id);
        changed = true;
      }
    }
    if (changed) this.bump();
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    if (!this.unsubscribe) this.unsubscribe = this.subscribeUpstream((e) => this.ingest(e));
    return () => {
      this.listeners.delete(l);
      if (this.listeners.size === 0 && this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
    };
  };

  getVersion = (): number => this.version;

  private bump(): void {
    this.version += 1;
    for (const l of this.listeners) l();
  }
}

export const progressStore = new ProgressStore((handler) => onAppEvent('downloads.progress', handler));

/** Re-renders the caller on every progress event; read values with `progressStore.get(id)`. */
export function useProgressVersion(): number {
  return useSyncExternalStore(progressStore.subscribe, progressStore.getVersion, progressStore.getVersion);
}

export interface EffectiveProgress {
  bytesDownloaded: number;
  totalBytes?: number;
  bytesPerSecond?: number;
}

/**
 * Combines the persisted row with the latest live sample. A live sample only
 * counts while the row is downloading, and it only moves bytes forward.
 */
export function effectiveProgress(d: Download, live: LiveProgress | undefined, now = Date.now()): EffectiveProgress {
  const out: EffectiveProgress = { bytesDownloaded: d.bytesDownloaded };
  if (d.totalBytes != null) out.totalBytes = d.totalBytes;
  if (d.status !== 'downloading' || !live) return out;
  if (live.bytesDownloaded > out.bytesDownloaded) out.bytesDownloaded = live.bytesDownloaded;
  if (live.totalBytes != null) out.totalBytes = live.totalBytes;
  if (now - live.at < STALE_MS && live.bytesPerSecond > 0) out.bytesPerSecond = live.bytesPerSecond;
  return out;
}
