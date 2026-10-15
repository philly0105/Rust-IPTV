import { rpc } from '@/api/transport';
import type { Download, PlayerSource } from '@/api/types';

import { playSource, usePlayerStore } from '../deps';
import { resumePoint } from './myvideos';
import { trackDownloadPosition } from './positionSync';

/**
 * Where an offline video starts, in seconds: its own saved position when that
 * is a resume point, else 0. Never undefined: `myvideos.playSource` fills any
 * stored position (even a few seconds in), and the player looks up the
 * stream's saved position when none is given, so "Play" and "Start over"
 * must name 0 to start at the beginning. The player treats 0 as "no resume".
 */
export function downloadStartSeconds(d: Download, opts?: { fromStart?: boolean }): number {
  if (opts?.fromStart) return 0;
  return resumePoint(d) ?? 0;
}

/**
 * Plays a completed download from disk, resuming at its saved position (or
 * from the beginning with `fromStart`), and keeps `downloads.setPosition` up
 * to date while it plays.
 */
export async function playDownload(d: Download, opts?: { fromStart?: boolean }): Promise<void> {
  const src = await rpc('myvideos.playSource', { id: d.id });
  const source: PlayerSource = { ...src, title: src.title || d.title };
  if (!source.subtitle && d.subtitle) source.subtitle = d.subtitle;
  if (!source.posterUrl && d.posterUrl) source.posterUrl = d.posterUrl;
  source.resumeSeconds = downloadStartSeconds(d, opts);
  await playSource(source);
  trackDownloadPosition(usePlayerStore, d.id, source.url);
}
