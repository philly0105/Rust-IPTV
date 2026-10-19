/** Opening a favorite / recent entry: live and radio play, movies and series open their detail page. */

import { sameRef, type ItemRef, type ItemSnapshot, type PlaybackPosition, type Source } from '@/api/types';
import { queueSeriesFrom } from '@/features/vod/lib/episodeQueue';
import { intlLocale } from '@/lib/intl';

import { playItem, usePlayerStore } from '../deps';

export function detailPath(ref: ItemRef): string | undefined {
  const sid = encodeURIComponent(ref.sourceId);
  const iid = encodeURIComponent(ref.itemId);
  if (ref.contentType === 'movie') return `/s/${sid}/movie/${iid}`;
  if (ref.contentType === 'series') return `/s/${sid}/series/${iid}`;
  return undefined;
}

export class SourceGoneError extends Error {
  constructor() {
    super('source removed');
    this.name = 'SourceGoneError';
  }
}

/**
 * Plays a live or radio entry, or navigates to the detail page of a movie or
 * series. Throws `SourceGoneError` when the owning source no longer exists.
 * `favorites`: the entry was opened from a favorites page (one source's, or every
 * source's without `sourceId`), so channel up/down walks the favorites in their order.
 */
export async function openEntry(
  ref: ItemRef,
  snapshot: ItemSnapshot,
  source: Source | undefined,
  navigate: (path: string) => void,
  favorites?: { sourceId?: string },
): Promise<void> {
  const path = detailPath(ref);
  if (path) {
    navigate(path);
    return;
  }
  if (!source) throw new SourceGoneError();
  const args: Parameters<typeof playItem>[0] = {
    ref,
    title: snapshot.title,
    isLive: true,
    isRadio: ref.contentType === 'radio',
    sourceKind: source.kind,
  };
  if (snapshot.subtitle) args.subtitle = snapshot.subtitle;
  if (snapshot.posterUrl) args.posterUrl = snapshot.posterUrl;
  await playItem(args);
  // Only once it plays: a refused PIN leaves what played, and its zapping, alone.
  if (favorites && sameRef(usePlayerStore.getState().source?.ref, ref)) {
    usePlayerStore.setState({ zapContext: { sourceId: ref.sourceId, favorites } });
  }
}

/**
 * Continue watching: resumes the saved title in the player (the player picks
 * up the saved position). A series episode also gets the series queue, so the
 * next episode follows on its own, as it does when started from the detail page.
 * Throws `SourceGoneError` when the owning source no longer exists.
 */
export async function resumePosition(p: PlaybackPosition, source: Source | undefined): Promise<void> {
  if (!source) throw new SourceGoneError();
  const title = p.snapshot?.title ?? p.ref.itemId;
  const args: Parameters<typeof playItem>[0] = { ref: p.ref, title, isLive: false, isRadio: false, sourceKind: source.kind };
  if (p.episodeId) args.episodeId = p.episodeId;
  if (p.snapshot?.subtitle) args.subtitle = p.snapshot.subtitle;
  if (p.snapshot?.posterUrl) args.posterUrl = p.snapshot.posterUrl;
  await playItem(args);
  if (p.ref.contentType === 'series' && p.episodeId) {
    const queue: Parameters<typeof queueSeriesFrom>[0] = { ref: p.ref, sourceKind: source.kind, title, episodeId: p.episodeId };
    if (p.snapshot?.posterUrl) queue.posterUrl = p.snapshot.posterUrl;
    await queueSeriesFrom(queue);
  }
}

/** "3 min ago", "yesterday", "2 weeks ago". */
export function relativeTime(iso: string, locale: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 7 * 86_400) return rtf.format(Math.round(diff / 86_400), 'day');
  if (abs < 30 * 86_400) return rtf.format(Math.round(diff / (7 * 86_400)), 'week');
  if (abs < 365 * 86_400) return rtf.format(Math.round(diff / (30 * 86_400)), 'month');
  return rtf.format(Math.round(diff / (365 * 86_400)), 'year');
}
