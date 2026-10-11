import { rpc } from '@/api/transport';
import type { Download, PlayerSource } from '@/api/types';

import { playSource, usePlayerStore } from '../deps';
import { resumePoint } from './myvideos';
import { trackDownloadPosition } from './positionSync';

/**
 * Plays a completed download from disk, resuming at its saved position, and
 * keeps `downloads.setPosition` up to date while it plays.
 */
export async function playDownload(d: Download): Promise<void> {
  const src = await rpc('myvideos.playSource', { id: d.id });
  const source: PlayerSource = { ...src, title: src.title || d.title };
  if (!source.subtitle && d.subtitle) source.subtitle = d.subtitle;
  if (!source.posterUrl && d.posterUrl) source.posterUrl = d.posterUrl;
  const resume = resumePoint(d);
  if (resume !== undefined) source.resumeSeconds = resume;
  await playSource(source);
  trackDownloadPosition(usePlayerStore, d.id, source.url);
}
