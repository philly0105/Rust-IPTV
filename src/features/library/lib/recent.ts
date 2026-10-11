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

/** Keeps continue-watching entries for one source (or all when no source). */
export function continueForSource(positions: readonly PlaybackPosition[], sourceId?: string): PlaybackPosition[] {
  return sourceId ? positions.filter((p) => p.ref.sourceId === sourceId) : [...positions];
}
