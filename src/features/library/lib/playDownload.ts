import { rpc } from '@/api/transport';
import type { Download, PlayerSource } from '@/api/types';

import { playSource, usePlayerStore } from '../deps';
import { resumePoint } from './myvideos';
import { trackDownloadPosition } from './positionSync';

export interface DownloadStart {
  /** Start at the beginning (Start over). */
  fromStart?: boolean;
  /**
   * Where the page that offers the play says it resumes, in seconds (0: from the beginning). A
   * catalogue detail page passes the title's own saved position, the one its Resume label and
   * progress bar show: streaming saves that position but not the download's, so the file's own
   * spot can lag far behind it.
   */
  resumeSeconds?: number;
}

/**
 * Where an offline video starts, in seconds: `resumeSeconds` when the caller
 * names it, else its own saved position when that is a resume point, else 0.
 * Never undefined: `myvideos.playSource` fills any stored position (even a few
 * seconds in), and the player looks up the stream's saved position when none
 * is given, so "Play" and "Start over" must name 0 to start at the beginning.
 * The player treats 0 as "no resume".
 */
export function downloadStartSeconds(d: Download, opts?: DownloadStart): number {
  if (opts?.fromStart) return 0;
  if (opts?.resumeSeconds !== undefined) return Math.max(0, opts.resumeSeconds);
  return resumePoint(d) ?? 0;
}

/**
 * Plays a completed download from disk, resuming at its saved position (or
 * where `resumeSeconds` says, or from the beginning with `fromStart`), and
 * keeps `downloads.setPosition` up to date while it plays.
 */
export async function playDownload(d: Download, opts?: DownloadStart): Promise<void> {
  const src = await rpc('myvideos.playSource', { id: d.id });
  const source: PlayerSource = { ...src, title: src.title || d.title };
  if (!source.subtitle && d.subtitle) source.subtitle = d.subtitle;
  if (!source.posterUrl && d.posterUrl) source.posterUrl = d.posterUrl;
  source.resumeSeconds = downloadStartSeconds(d, opts);
  await playSource(source);
  trackDownloadPosition(usePlayerStore, d.id, source.url);
}
