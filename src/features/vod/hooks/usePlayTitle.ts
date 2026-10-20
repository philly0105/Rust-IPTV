import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { ItemRef, SourceKind } from '@/api/types';
import type { PlayItemArgs } from '@/features/player';

import { useToast, errorDescription } from '@/ui';

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
  /** Play from 0. The saved position (and the watched mark) stays until playback saves a new one. */
  fromStart?: boolean;
  /** Play a different copy (another source) instead of the page's target. */
  target?: PlayTarget;
}

/** The player's arguments for a movie or one episode of `tgt`. */
export function playItemArgs(tgt: PlayTarget, opts: PlayOptions = {}): PlayItemArgs {
  const args: PlayItemArgs = { ref: tgt.ref, title: tgt.title, isLive: false, sourceKind: tgt.sourceKind };
  if (opts.episodeId) args.episodeId = opts.episodeId;
  if (opts.subtitle) args.subtitle = opts.subtitle;
  if (tgt.posterUrl) args.posterUrl = tgt.posterUrl;
  if (tgt.categoryId) args.categoryId = tgt.categoryId;
  // Start over (VL-start-over-unwatches): no positions.remove first, which also dropped the
  // watched mark and, when the play then failed, the old resume point.
  if (opts.fromStart) args.fromStart = true;
  return args;
}

/**
 * Plays a title from a page that draws no player (a category grid's poster menu). The player
 * loads on the press, as on Home (performance audit SH-2), so the page's chunk does not make a
 * cold visit wait for the player's controls before its first render (`pnpm size:check` guards it).
 * Detail pages, which show the player, use `usePlayback`.
 */
export function usePlayTitle(): (target: PlayTarget, opts?: PlayOptions) => Promise<void> {
  const { t } = useTranslation('vod');
  const { toast } = useToast();
  return useCallback(
    async (target, opts = {}) => {
      try {
        const { playItem } = await import('@/features/player');
        await playItem(playItemArgs(target, opts));
      } catch (err) {
        toast({ title: t('playFailed'), description: errorDescription(err), variant: 'error' });
      }
    },
    [t, toast],
  );
}
