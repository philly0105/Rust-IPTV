/** Pure model for /recent: day buckets and continue-watching math. */

import type { PlaybackPosition, RecentEntry } from '@/api/types';

export type RecentBucket = 'today' | 'yesterday' | 'thisWeek' | 'earlier';

const DAY_MS = 86_400_000;

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function bucketOf(viewedAt: string, now = Date.now()): RecentBucket {
  const t = Date.parse(viewedAt);
  if (!Number.isFinite(t)) return 'earlier';
  const today = startOfDay(now);
  if (t >= today) return 'today';
  if (t >= today - DAY_MS) return 'yesterday';
  if (t >= today - 6 * DAY_MS) return 'thisWeek';
  return 'earlier';
}

export type RecentRow =
  | { kind: 'header'; bucket: RecentBucket; count: number; key: string }
  | { kind: 'item'; entry: RecentEntry; key: string };

/** Newest first, split into day buckets with header rows. */
export function buildRecentRows(entries: readonly RecentEntry[], search = '', now = Date.now()): RecentRow[] {
  const q = search.trim().toLocaleLowerCase();
  const sorted = [...entries]
    .filter((e) => !q || e.snapshot.title.toLocaleLowerCase().includes(q) || (e.snapshot.subtitle?.toLocaleLowerCase().includes(q) ?? false))
    .sort((a, b) => b.viewedAt.localeCompare(a.viewedAt));
  const rows: RecentRow[] = [];
  let current: { kind: 'header'; bucket: RecentBucket; count: number; key: string } | undefined;
  for (const entry of sorted) {
    const bucket = bucketOf(entry.viewedAt, now);
    if (!current || current.bucket !== bucket) {
      current = { kind: 'header', bucket, count: 0, key: `h-${bucket}` };
      rows.push(current);
    }
    current.count += 1;
    rows.push({ kind: 'item', entry, key: `r-${entry.ref.sourceId}|${entry.ref.contentType}|${entry.ref.itemId}` });
  }
  return rows;
}

/** Watched fraction 0..1, or undefined without a duration. */
export function watchedFraction(p: PlaybackPosition): number | undefined {
  if (!p.durationSeconds || p.durationSeconds <= 0) return undefined;
  return Math.max(0, Math.min(1, p.positionSeconds / p.durationSeconds));
}

/** Most `recent.list` returns in one call (the core's cap). */
export const RECENT_LIST_MAX = 1000;
/** History rows the core keeps per source. */
export const RECENT_PER_SOURCE = 200;

export type RecentAddArgs = { ref: RecentEntry['ref']; snapshot: RecentEntry['snapshot']; viewedAt: string };
type ListHistory = (args: { sourceId?: string; limit: number }) => Promise<RecentEntry[]>;

/** `recent.add` arguments that put an entry back exactly as it was, original date included (C7). */
export function restoreArgs(e: RecentEntry): RecentAddArgs {
  return { ref: e.ref, snapshot: e.snapshot, viewedAt: e.viewedAt };
}

function entryKey(e: RecentEntry): string {
  return `${e.ref.sourceId}|${e.ref.contentType}|${e.ref.itemId}`;
}

/**
 * Every history entry in scope, for undoing a clear. One call covers a source
 * (the core keeps 200 per source); across sources a full first page means
 * there may be more, so each source is read on its own as well.
 */
export async function collectHistory(list: ListHistory, sourceId: string | undefined, sourceIds: Iterable<string>): Promise<RecentEntry[]> {
  if (sourceId) return list({ sourceId, limit: RECENT_LIST_MAX });
  const first = await list({ limit: RECENT_LIST_MAX });
  if (first.length < RECENT_LIST_MAX) return first;
  const seen = new Map(first.map((e) => [entryKey(e), e]));
  for (const id of sourceIds) {
    for (const e of await list({ sourceId: id, limit: RECENT_PER_SOURCE })) seen.set(entryKey(e), e);
  }
  return [...seen.values()];
}

/** Re-adds entries with their original dates. Returns how many made it back. */
export async function restoreHistory(entries: readonly RecentEntry[], add: (args: RecentAddArgs) => Promise<void>): Promise<number> {
  let restored = 0;
  for (const e of entries) {
    try {
      await add(restoreArgs(e));
      restored += 1;
    } catch {
      // Counted as missing; the caller reports the shortfall.
    }
  }
  return restored;
}

type PositionRef = PlaybackPosition['ref'];
export type PositionCalls = {
  forSeries: (args: { ref: PositionRef }) => Promise<PlaybackPosition[]>;
  remove: (args: { ref: PositionRef; episodeId?: string; allEpisodes?: boolean }) => Promise<void>;
  set: (args: {
    ref: PositionRef;
    episodeId?: string;
    positionSeconds: number;
    durationSeconds?: number;
    snapshot?: NonNullable<PlaybackPosition['snapshot']>;
    updatedAt?: string;
    watched?: boolean;
  }) => Promise<void>;
};

/**
 * Removes a continue-watching card. A series card stands for every unfinished
 * episode row, so all of them go (C13 `allEpisodes`); otherwise the card
 * would come back showing an older half-watched episode. Returns the rows
 * removed, for Undo.
 */
export async function removeContinueCard(p: PlaybackPosition, calls: PositionCalls): Promise<PlaybackPosition[]> {
  if (p.ref.contentType !== 'series') {
    await calls.remove(p.episodeId ? { ref: p.ref, episodeId: p.episodeId } : { ref: p.ref });
    return [p];
  }
  const rows = (await calls.forSeries({ ref: p.ref })).filter((r) => !r.watched);
  await calls.remove({ ref: p.ref, allEpisodes: true });
  return rows.some((r) => (r.episodeId ?? '') === (p.episodeId ?? '')) ? rows : [...rows, p];
}

/**
 * Puts removed rows back with their original times (C14), so the card
 * returns to its old place in the rail and the episode that stood for the
 * series is again its newest row; a watched row stays watched. Oldest first,
 * in case a time is refused.
 * Returns how many made it back.
 */
export async function restorePositions(rows: readonly PlaybackPosition[], set: PositionCalls['set']): Promise<number> {
  const oldestFirst = [...rows].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  let restored = 0;
  for (const r of oldestFirst) {
    try {
      await set({
        ref: r.ref,
        positionSeconds: r.positionSeconds,
        ...(r.episodeId ? { episodeId: r.episodeId } : {}),
        ...(r.durationSeconds != null ? { durationSeconds: r.durationSeconds } : {}),
        ...(r.snapshot ? { snapshot: r.snapshot } : {}),
        updatedAt: r.updatedAt,
        ...(r.watched ? { watched: true } : {}),
      });
      restored += 1;
    } catch {
      // Counted as missing; the caller reports the shortfall.
    }
  }
  return restored;
}

/** Keeps continue-watching entries for one source (or all when no source). */
export function continueForSource(positions: readonly PlaybackPosition[], sourceId?: string): PlaybackPosition[] {
  return sourceId ? positions.filter((p) => p.ref.sourceId === sourceId) : [...positions];
}
