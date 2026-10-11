/** Opening a favorite / recent entry: live and radio play, movies and series open their detail page. */

import type { ItemRef, ItemSnapshot, Source } from '@/api/types';

import { playItem } from '../deps';

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
 */
export async function openEntry(
  ref: ItemRef,
  snapshot: ItemSnapshot,
  source: Source | undefined,
  navigate: (path: string) => void,
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
}

/** "3 min ago", "yesterday", "2 weeks ago". */
export function relativeTime(iso: string, locale: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 7 * 86_400) return rtf.format(Math.round(diff / 86_400), 'day');
  if (abs < 30 * 86_400) return rtf.format(Math.round(diff / (7 * 86_400)), 'week');
  if (abs < 365 * 86_400) return rtf.format(Math.round(diff / (30 * 86_400)), 'month');
  return rtf.format(Math.round(diff / (365 * 86_400)), 'year');
}
