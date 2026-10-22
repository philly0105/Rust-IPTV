import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { invalidate, queryClient } from '@/api/query';
import type { DownloadStartArgs } from '@/api/rpc';
import { RpcError, rpc } from '@/api/transport';
import { sameRef, type Download, type ItemRef, type PlaybackPosition, type RequestHeaders } from '@/api/types';
import { playItem, usePlayerStore } from '@/features/player';

import { downloadFileName } from '../lib/format';
import { useToast, errorDescription } from '@/ui';
import { useDownloads } from './queries';
import { playItemArgs, type PlayOptions, type PlayTarget } from './usePlayTitle';

export type { PlayOptions, PlayTarget } from './usePlayTitle';

export interface DownloadOptions {
  episodeId?: string;
  subtitle?: string;
  extension?: string;
}

/** The stream a download fetches: the provider's link, or an M3U row's URL with the playlist's headers. */
async function streamSource(target: PlayTarget, episodeId: string | undefined): Promise<{ url: string; headers?: RequestHeaders }> {
  const { ref } = target;
  const linkArgs = episodeId ? { ref, episodeId } : { ref };
  if (target.sourceKind === 'xtream') return rpc('xtream.streamUrl', linkArgs);
  if (target.sourceKind === 'stalker') return rpc('stalker.streamUrl', linkArgs);
  // An m3u episode's URL is stored in its series row; the core merges the headers.
  if (episodeId) return rpc('m3u.streamUrl', { ref, episodeId });
  const [item, source] = await Promise.all([rpc('catalog.item', { ref }), rpc('sources.get', { id: ref.sourceId }).catch(() => null)]);
  const url = 'url' in item ? item.url : undefined;
  if (!url) throw new RpcError('not_found', 'This item has no stream URL');
  // Per-row headers (#EXTVLCOPT) override the playlist's, as in playback.
  const headers: RequestHeaders = { ...source?.m3u?.headers, ...('headers' in item ? item.headers : undefined) };
  return Object.values(headers).some(Boolean) ? { url, headers } : { url };
}

/** The extension of a URL's path, lower case ('' when none). */
const urlExtension = (url: string): string => /\.([a-z0-9]{2,5})$/i.exec(url.split(/[?#]/)[0] ?? '')?.[1]?.toLowerCase() ?? '';

/** An HLS playlist URL (`.m3u8`, `.m3u`): not one file. */
const isPlaylistUrl = (url: string): boolean => ['m3u8', 'm3u'].includes(urlExtension(url));

/** Video extensions an M3U row's URL can give its download (the playlist has no container field). */
const VIDEO_EXTENSIONS = new Set(['mp4', 'mkv', 'avi', 'mov', 'm4v', 'webm', 'ts', 'mpg', 'mpeg', 'wmv', 'flv']);

/** `downloads.start` args for the movie or one episode, with the stream URL the player would use. */
async function downloadArgs(target: PlayTarget, opts: DownloadOptions, notFileMessage: string): Promise<DownloadStartArgs> {
  const src = await streamSource(target, opts.episodeId);
  // The download would save the playlist text, not the film.
  if (target.sourceKind === 'm3u' && isPlaylistUrl(src.url)) throw new RpcError('unsupported', notFileMessage);
  const fromUrl = urlExtension(src.url);
  const extension = opts.extension ?? (VIDEO_EXTENSIONS.has(fromUrl) ? fromUrl : undefined);
  // Episodes: title = series name, subtitle = `S01E02 · Episode title` (the library groups and parses these).
  const args: DownloadStartArgs = {
    ref: target.ref,
    title: target.title,
    url: src.url,
    fileNameHint: downloadFileName(target.title, opts.subtitle, extension),
  };
  if (opts.episodeId) args.episodeId = opts.episodeId;
  if (opts.subtitle) args.subtitle = opts.subtitle;
  if (src.headers) args.headers = src.headers;
  if (target.posterUrl) args.posterUrl = target.posterUrl;
  return args;
}

/** Play, start over, stop, and download for one movie or series (the detail pages, which show the player). */
export function usePlayback(target: PlayTarget | undefined) {
  const { t } = useTranslation('vod');
  const { toast } = useToast();
  const navigate = useNavigate();
  const [pendingDownload, setPendingDownload] = useState<string | null>(null);

  const play = useCallback(
    async (opts: PlayOptions = {}) => {
      const tgt = opts.target ?? target;
      if (!tgt) return;
      try {
        await playItem(playItemArgs(tgt, opts));
      } catch (err) {
        toast({ title: t('playFailed'), description: errorDescription(err), variant: 'error' });
      }
    },
    [target, t, toast],
  );

  const stop = useCallback(() => {
    const final = finalPosition();
    usePlayerStore.getState().stop();
    if (!final) {
      void invalidate('positions.');
      return;
    }
    // The stop's own `positions.set` is still in flight: a refetch now raced it and brought back
    // the previous save (or none), so the page offered Play instead of Resume (L4-hf-vod-1).
    // Show the position being saved, and only mark the rest stale for their next mount.
    writeFinalPosition(final);
    void queryClient.invalidateQueries({ predicate: (q) => isPositionsKey(q.queryKey), refetchType: 'none' });
  }, []);

  // Every source kind: Xtream and Stalker rows re-resolve their URL in the core, M3U rows keep the playlist's.
  const canDownload = !!target;
  const [pendingSeason, setPendingSeason] = useState(false);

  const download = useCallback(
    async (opts: DownloadOptions = {}) => {
      if (!target || !canDownload) return;
      const key = opts.episodeId ?? '';
      setPendingDownload(key);
      try {
        await rpc('downloads.start', await downloadArgs(target, opts, t('downloadNotFile')));
        void invalidate('downloads.');
        toast({
          title: t('downloadQueued'),
          description: opts.subtitle ? `${target.title}  ${opts.subtitle}` : target.title,
          variant: 'success',
          action: { label: t('openDownloads'), onClick: () => void navigate('/downloads') },
        });
      } catch (err) {
        const e = RpcError.from(err);
        toast({ title: e.code === 'conflict' ? t('downloadExists') : t('downloadFailed'), description: errorDescription(e), variant: 'error' });
      } finally {
        setPendingDownload(null);
      }
    },
    [target, canDownload, t, toast, navigate],
  );

  /** Queues every episode in `episodes`, one after another; `name` is the season for the toast. */
  const downloadSeason = useCallback(
    async (episodes: DownloadOptions[], name: string) => {
      if (!target || !canDownload) return;
      if (episodes.length === 0) {
        toast({ title: t('seasonDownloadNothing'), description: `${target.title}  ${name}` });
        return;
      }
      setPendingSeason(true);
      let queued = 0;
      let failure: RpcError | undefined;
      try {
        for (const ep of episodes) {
          try {
            await rpc('downloads.start', await downloadArgs(target, ep, t('downloadNotFile')));
            queued += 1;
          } catch (err) {
            failure ??= RpcError.from(err);
          }
        }
      } finally {
        setPendingSeason(false);
      }
      void invalidate('downloads.');
      if (queued > 0) {
        toast({
          title: t('seasonDownloadQueued', { n: queued }),
          description: `${target.title}  ${name}`,
          variant: 'success',
          action: { label: t('openDownloads'), onClick: () => void navigate('/downloads') },
        });
      }
      if (failure) {
        toast({ title: t('seasonDownloadFailed', { n: episodes.length - queued }), description: errorDescription(failure), variant: 'error' });
      }
    },
    [target, canDownload, t, toast, navigate],
  );

  return { play, stop, download, downloadSeason, canDownload, pendingDownload, pendingSeason };
}

const isPositionsKey = (key: readonly unknown[]) => typeof key[0] === 'string' && key[0].startsWith('positions.');

/** The VOD position the player's stop is about to save, as the core will store it. */
function finalPosition(): PlaybackPosition | undefined {
  const { source, positionSeconds, durationSeconds } = usePlayerStore.getState();
  const ref = source?.ref;
  if (!ref || source?.isLive || (ref.contentType !== 'movie' && ref.contentType !== 'series')) return undefined;
  const pos = Math.floor(positionSeconds);
  if (!(pos > 0)) return undefined;
  const row: PlaybackPosition = { ref, positionSeconds: pos, updatedAt: new Date().toISOString(), watched: false };
  if (source.episodeId) row.episodeId = source.episodeId;
  if (durationSeconds && Number.isFinite(durationSeconds)) row.durationSeconds = Math.floor(durationSeconds);
  return row;
}

/** Writes `final` into the cached `positions.get` / `positions.forSeries` answers for its title. */
function writeFinalPosition(final: PlaybackPosition): void {
  const merge = (old: PlaybackPosition | null | undefined): PlaybackPosition => ({ ...final, watched: old?.watched ?? false });
  for (const q of queryClient.getQueryCache().findAll({ predicate: (q) => isPositionsKey(q.queryKey) })) {
    const [cmd, args] = q.queryKey as [string, { ref?: ItemRef; episodeId?: string } | null];
    if (!args?.ref || !sameRef(args.ref, final.ref)) continue;
    if (cmd === 'positions.get' && (args.episodeId ?? undefined) === final.episodeId) {
      queryClient.setQueryData<PlaybackPosition | null>(q.queryKey, (old) => merge(old));
    } else if (cmd === 'positions.forSeries' && final.episodeId) {
      queryClient.setQueryData<PlaybackPosition[]>(q.queryKey, (old) => {
        const list = old ?? [];
        const at = list.findIndex((p) => p.episodeId === final.episodeId);
        return at < 0 ? [...list, merge(undefined)] : list.map((p, i) => (i === at ? merge(p) : p));
      });
    }
  }
}

/**
 * Download rows for this item, keyed by episode id ('' for the movie itself). A new download of
 * this item or a status change arrives with `downloads.update`; the bytes of a running one come
 * from its live samples in the control that shows them (DL-7), not from refetching the list.
 */
export function useItemDownloads(ref: ItemRef, enabled: boolean): Map<string, Download> {
  const q = useDownloads(enabled);
  return useMemo(() => {
    const out = new Map<string, Download>();
    for (const d of q.data ?? []) if (sameRef(d.ref, ref)) out.set(d.episodeId ?? '', d);
    return out;
  }, [q.data, ref]);
}
