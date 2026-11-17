/**
 * Live transfer progress from `downloads.progress` events. One shared
 * subscription while any component listens; speeds are smoothed so the
 * readout does not flicker at 4 updates per second. Each row subscribes to
 * its own sample (`useLiveProgress`), so an event re-renders one row.
 *
 * The speed breakdown (`downloads.stats`, at most once a second per running
 * row) has a store of its own (`statsStore`, `useLiveStats`), read by the
 * row's note line and the details dialog.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import { onAppEvent } from '@/api/events';
import type { Download, DownloadProgressEvent, TransferStats } from '@/api/types';

export interface LiveProgress {
  bytesDownloaded: number;
  totalBytes?: number;
  /** Smoothed bytes per second. */
  bytesPerSecond: number;
  at: number;
  /**
   * Connections the transfer holds. The event sends it only when more than one, so once a
   * transfer has sent it, an event without it means one; before that it is unknown (an engine
   * that never sends it) and the row's own `connections` stands.
   */
  connections?: number;
  /** Sources the transfer draws on, on the same terms as `connections`. */
  sources?: number;
}

/** Weight of the newest sample in the moving average. */
const ALPHA = 0.35;
/** A sample older than this means the transfer has stalled. */
export const STALE_MS = 5_000;

type Listener = () => void;

/** A count from an event: its own when sent; one when omitted after an earlier event sent one. */
function countOf(sent: number | undefined, prev: number | undefined): number | undefined {
  if (typeof sent === 'number' && Number.isFinite(sent) && sent >= 1) return Math.floor(sent);
  return prev !== undefined ? 1 : undefined;
}

/**
 * One app event kept per download id, with one shared upstream subscription while anyone
 * listens. `getVersion` bumps on every change, for whole-store readers.
 */
abstract class EventStore<E, V> {
  protected readonly map = new Map<number, V>();
  private readonly listeners = new Set<Listener>();
  private version = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly subscribeUpstream: (handler: (e: E) => void) => () => void) {}

  /** Folds one event into the map. */
  abstract ingest(e: E, now?: number): void;

  get(id: number): V | undefined {
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

  protected bump(): void {
    this.version += 1;
    for (const l of this.listeners) l();
  }
}

export class ProgressStore extends EventStore<DownloadProgressEvent, LiveProgress> {
  override ingest(e: DownloadProgressEvent, now = Date.now()): void {
    if (!e || typeof e.id !== 'number' || !Number.isFinite(e.bytesDownloaded)) return;
    const prev = this.map.get(e.id);
    const raw = Number.isFinite(e.bytesPerSecond) && e.bytesPerSecond > 0 ? e.bytesPerSecond : 0;
    const fresh = prev !== undefined && now - prev.at < STALE_MS && prev.bytesPerSecond > 0;
    const bytesPerSecond = fresh ? prev.bytesPerSecond * (1 - ALPHA) + raw * ALPHA : raw;
    const next: LiveProgress = { bytesDownloaded: e.bytesDownloaded, bytesPerSecond, at: now };
    if (e.totalBytes != null) next.totalBytes = e.totalBytes;
    const connections = countOf(e.connections, prev?.connections);
    if (connections !== undefined) next.connections = connections;
    const sources = countOf(e.sources, prev?.sources);
    if (sources !== undefined) next.sources = sources;
    this.map.set(e.id, next);
    this.bump();
  }

  /** The summed live speed of every transfer whose sample is still fresh (the header sparkline). */
  totalSpeed(now = Date.now()): number {
    let total = 0;
    for (const p of this.map.values()) if (now - p.at < STALE_MS && p.bytesPerSecond > 0) total += p.bytesPerSecond;
    return total;
  }
}

export const progressStore = new ProgressStore((handler) => onAppEvent('downloads.progress', handler));

export interface EffectiveProgress {
  bytesDownloaded: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  /** Connections in use, only when more than one. */
  connections?: number;
  /** Sources drawn on, only when more than one. */
  sources?: number;
}

/**
 * Combines the persisted row with the latest live sample. A live sample only
 * counts while the row is downloading, and it only moves bytes forward.
 */
export function effectiveProgress(d: Download, live: LiveProgress | undefined, now = Date.now()): EffectiveProgress {
  const out: EffectiveProgress = { bytesDownloaded: d.bytesDownloaded };
  if (d.totalBytes != null) out.totalBytes = d.totalBytes;
  if (d.status !== 'downloading') return out;
  const fresh = live !== undefined && now - live.at < STALE_MS;
  // The live counts while the sample is fresh; else the row's, which the list refreshes.
  const connections = fresh && live.connections !== undefined ? live.connections : d.connections;
  const sources = fresh && live.sources !== undefined ? live.sources : d.sources;
  if (connections !== undefined && connections > 1) out.connections = connections;
  if (sources !== undefined && sources > 1) out.sources = sources;
  if (!live) return out;
  if (live.bytesDownloaded > out.bytesDownloaded) out.bytesDownloaded = live.bytesDownloaded;
  if (live.totalBytes != null) out.totalBytes = live.totalBytes;
  if (fresh && live.bytesPerSecond > 0) out.bytesPerSecond = live.bytesPerSecond;
  return out;
}

/**
 * `effectiveProgress` for one row, re-rendering it only when its own sample
 * changes (VD-4), and once more when that sample goes stale, so a transfer
 * that stops sending reads as stalled.
 */
export function useLiveProgress(d: Download): EffectiveProgress {
  const read = () => progressStore.get(d.id);
  const live = useSyncExternalStore(progressStore.subscribe, read, read);
  const [, setAged] = useState(0);
  const downloading = d.status === 'downloading';
  useEffect(() => {
    if (!downloading || !live) return;
    const left = live.at + STALE_MS - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setAged((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [downloading, live]);
  return effectiveProgress(d, live);
}

/** A breakdown older than this is stale: the transfer publishes one about every second. */
export const STATS_STALE_MS = 5_000;

export interface LiveStats {
  stats: TransferStats;
  at: number;
}

/** The latest `downloads.stats` breakdown per running row. */
export class StatsStore extends EventStore<TransferStats, LiveStats> {
  override ingest(e: TransferStats, now = Date.now()): void {
    if (!e || typeof e.id !== 'number') return;
    this.map.set(e.id, { stats: normalizeStats(e), at: now });
    this.bump();
  }
}

/** Arrays a payload may leave out (an older engine, a hand-built test row) read as empty. */
export function normalizeStats(s: TransferStats): TransferStats {
  return {
    ...s,
    bytesPerSecond: Number.isFinite(s.bytesPerSecond) ? s.bytesPerSecond : 0,
    connections: Array.isArray(s.connections) ? s.connections : [],
    sources: Array.isArray(s.sources) ? s.sources : [],
    notes: Array.isArray(s.notes) ? s.notes : [],
  };
}

export const statsStore = new StatsStore((handler) => onAppEvent('downloads.stats', handler));

/**
 * The breakdown to show for a row: a fresh `downloads.stats` event, else the row's own `stats`
 * (the list's copy). Only a downloading row has one.
 */
export function effectiveStats(d: Download, live: LiveStats | undefined, now = Date.now()): TransferStats | undefined {
  if (d.status !== 'downloading') return undefined;
  if (live && now - live.at < STATS_STALE_MS) return live.stats;
  return d.stats ? normalizeStats(d.stats) : undefined;
}

/** `effectiveStats` for one row, re-rendering it on its own events and once more when they go stale. */
export function useLiveStats(d: Download): TransferStats | undefined {
  const read = () => statsStore.get(d.id);
  const live = useSyncExternalStore(statsStore.subscribe, read, read);
  const [, setAged] = useState(0);
  const downloading = d.status === 'downloading';
  useEffect(() => {
    if (!downloading || !live) return;
    const left = live.at + STATS_STALE_MS - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setAged((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [downloading, live]);
  return effectiveStats(d, live);
}
