import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { invalidate } from '@/api/query';
import type { DownloadStartArgs } from '@/api/rpc';
import { RpcError, rpc } from '@/api/transport';
import { sameRef, type Download, type ItemRef, type SourceKind } from '@/api/types';
import { playItem, usePlayerStore } from '@/features/player';

import { downloadFileName } from '../lib/format';
import { useToast } from '@/ui';
import { useDownloads } from './queries';

export interface PlayTarget {
  ref: ItemRef;
  sourceKind: SourceKind;
  title: string;
  posterUrl?: string;
  /** The title's group, so the parental gate can check group locks (C2). */
  categoryId?: string;
}

export interface PlayOptions {
  episodeId?: string;
  subtitle?: string;
  /** Forget the saved position first, so playback starts at 0. */
  fromStart?: boolean;
  /** Play a different copy (another source) instead of the page's target. */
  target?: PlayTarget;
}

/** Play, start over, stop, and download for one movie or series. */
export function usePlayback(target: PlayTarget | undefined) {
  const { t } = useTranslation('vod');
  const { toast } = useToast();
  const navigate = useNavigate();
  const [pendingDownload, setPendingDownload] = useState<string | null>(null);

  const play = useCallback(
    async (opts: PlayOptions = {}) => {
      const tgt = opts.target ?? target;
      if (!tgt) return;
      const { ref } = tgt;
      try {
        if (opts.fromStart) {
          await rpc('positions.remove', opts.episodeId ? { ref, episodeId: opts.episodeId } : { ref }).catch(() => undefined);
          void invalidate('positions.');
        }
        const args: Parameters<typeof playItem>[0] = {
          ref,
          title: tgt.title,
          isLive: false,
          sourceKind: tgt.sourceKind,
        };
        if (opts.episodeId) args.episodeId = opts.episodeId;
        if (opts.subtitle) args.subtitle = opts.subtitle;
        if (tgt.posterUrl) args.posterUrl = tgt.posterUrl;
        if (tgt.categoryId) args.categoryId = tgt.categoryId;
        await playItem(args);
      } catch (err) {
        toast({ title: t('playFailed'), description: RpcError.from(err).message, variant: 'error' });
      }
    },
    [target, t, toast],
  );

  const stop = useCallback(() => {
    void invalidate('positions.');
    usePlayerStore.getState().stop();
  }, []);

  const canDownload = target?.sourceKind === 'xtream' || target?.sourceKind === 'stalker';

  const download = useCallback(
    async (opts: { episodeId?: string; subtitle?: string; extension?: string } = {}) => {
      if (!target || !canDownload) return;
      const key = opts.episodeId ?? '';
      setPendingDownload(key);
      try {
        const { ref } = target;
        const linkArgs = opts.episodeId ? { ref, episodeId: opts.episodeId } : { ref };
        const src = target.sourceKind === 'xtream' ? await rpc('xtream.streamUrl', linkArgs) : await rpc('stalker.streamUrl', linkArgs);
        // Episodes: title = series name, subtitle = `S01E02 · Episode title` (the library groups and parses these).
        const args: DownloadStartArgs = {
          ref,
          title: target.title,
          url: src.url,
          fileNameHint: downloadFileName(target.title, opts.subtitle, opts.extension),
        };
        if (opts.episodeId) args.episodeId = opts.episodeId;
        if (opts.subtitle) args.subtitle = opts.subtitle;
        if (src.headers) args.headers = src.headers;
        if (target.posterUrl) args.posterUrl = target.posterUrl;
        await rpc('downloads.start', args);
        void invalidate('downloads.');
        toast({
          title: t('downloadQueued'),
          description: opts.subtitle ? `${target.title}  ${opts.subtitle}` : target.title,
          variant: 'success',
          action: { label: t('openDownloads'), onClick: () => void navigate('/downloads') },
        });
      } catch (err) {
        const e = RpcError.from(err);
        toast({ title: e.code === 'conflict' ? t('downloadExists') : t('downloadFailed'), description: e.message, variant: 'error' });
      } finally {
        setPendingDownload(null);
      }
    },
    [target, canDownload, t, toast, navigate],
  );

  return { play, stop, download, canDownload, pendingDownload };
}

/** Download rows for this item, keyed by episode id ('' for the movie itself). */
export function useItemDownloads(ref: ItemRef, enabled: boolean): Map<string, Download> {
  const q = useDownloads(enabled);
  return useMemo(() => {
    const map = new Map<string, Download>();
    for (const d of q.data ?? []) if (sameRef(d.ref, ref)) map.set(d.episodeId ?? '', d);
    return map;
  }, [q.data, ref]);
}
