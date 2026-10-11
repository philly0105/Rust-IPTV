import type { ContentType, Download, FavoriteEntry, PlaybackPosition, RecentEntry } from '@/api/types';

let nextId = 1;

export function makeDownload(over: Partial<Download> = {}): Download {
  const id = over.id ?? nextId++;
  return {
    id,
    ref: { sourceId: 'src1', contentType: 'movie', itemId: `m${id}` },
    title: `Movie ${id}`,
    url: `http://example.test/${id}.mp4`,
    status: 'queued',
    bytesDownloaded: 0,
    createdAt: `2026-10-01T10:00:${String(id % 60).padStart(2, '0')}Z`,
    updatedAt: `2026-10-01T10:00:${String(id % 60).padStart(2, '0')}Z`,
    positionSeconds: 0,
    ...over,
  };
}

export function makeEpisode(seriesId: string, title: string, subtitle: string, over: Partial<Download> = {}): Download {
  return makeDownload({
    ref: { sourceId: 'src1', contentType: 'series', itemId: seriesId },
    episodeId: subtitle,
    title,
    subtitle,
    status: 'completed',
    totalBytes: 1000,
    bytesDownloaded: 1000,
    fileAvailable: true,
    ...over,
  });
}

export function makeFavorite(contentType: ContentType, itemId: string, position: number, sourceId = 'src1'): FavoriteEntry {
  return {
    ref: { sourceId, contentType, itemId },
    addedAt: `2026-09-0${(position % 9) + 1}T12:00:00Z`,
    position,
    snapshot: { title: `${contentType} ${itemId}`, contentType },
  };
}

export function makeRecent(itemId: string, viewedAt: string, contentType: ContentType = 'movie', sourceId = 'src1'): RecentEntry {
  return { ref: { sourceId, contentType, itemId }, viewedAt, snapshot: { title: `Watched ${itemId}`, contentType } };
}

export function makePosition(itemId: string, positionSeconds: number, durationSeconds?: number, sourceId = 'src1'): PlaybackPosition {
  const p: PlaybackPosition = {
    ref: { sourceId, contentType: 'movie', itemId },
    positionSeconds,
    watched: false,
    updatedAt: '2026-10-10T20:00:00Z',
    snapshot: { title: `Continue ${itemId}`, contentType: 'movie' },
  };
  if (durationSeconds !== undefined) p.durationSeconds = durationSeconds;
  return p;
}
