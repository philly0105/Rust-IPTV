import { Check, CircleAlert, CircleCheck, Download as DownloadIcon, Heart, LoaderCircle, Pause } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { invalidate, useRpcMutation } from '@/api/query';
import type { Download, ItemRef, ItemSnapshot } from '@/api/types';

import { captureWatched } from '@/features/library/lib/watchedUndo';

import { useSetWatched } from '../../hooks/queries';
import { seriesWatchedTargets, watchedToastId, watchedUndoAll } from '../../lib/seriesWatched';
import { Button, IconButton, Tooltip, buttonClass, cn, useToast, errorDescription } from '@/ui';

export function FavoriteButton({ itemRef, snapshot, isFavorite, compact }: { itemRef: ItemRef; snapshot: ItemSnapshot; isFavorite: boolean; compact?: boolean }) {
  const { t } = useTranslation('vod');
  const { toast } = useToast();
  const toggle = useRpcMutation('favorites.toggle');
  const onClick = () =>
    toggle.mutate(
      { ref: itemRef, snapshot },
      {
        onSuccess: (res) => {
          void invalidate('favorites.');
          toast({ title: res.isFavorite ? t('addedToFavorites') : t('removedFromFavorites'), variant: 'success' });
        },
        onError: (err) => toast({ title: t('favoriteFailed'), description: errorDescription(err), variant: 'error' }),
      },
    );
  const icon = <Heart aria-hidden size={18} className={cn(isFavorite && 'fill-current text-live')} />;
  if (compact) {
    return <IconButton label={isFavorite ? t('removeFromFavorites') : t('addToFavorites')} pressed={isFavorite} icon={icon} onClick={onClick} disabled={toggle.isPending} />;
  }
  return (
    <Button size="lg" variant="secondary" icon={icon} aria-pressed={isFavorite} loading={toggle.isPending} onClick={onClick}>
      {isFavorite ? t('inFavorites') : t('addToFavorites')}
    </Button>
  );
}

/**
 * Toggles watched for a movie (no `episodeIds`) or a set of episodes, and with `series` the
 * series-level row too (`lib/seriesWatched` works out which episodes; they may be none).
 */
export function WatchedButton({
  itemRef,
  episodeIds,
  series,
  watched,
  compact,
  labels,
  name,
}: {
  itemRef: ItemRef;
  episodeIds?: string[];
  /** With `episodeIds`: also set the series-level row to the new state. */
  series?: boolean;
  watched: boolean;
  compact?: boolean;
  /** Overrides for the two button labels (season-level wording). */
  labels?: { mark: string; unmark: string };
  /** What the toast says was marked ("Season 2", the series title). */
  name?: string;
}) {
  const { t } = useTranslation('vod');
  const { toast } = useToast();
  const setWatched = useSetWatched();
  const label = watched ? (labels?.unmark ?? t('markUnwatched')) : (labels?.mark ?? t('markWatched'));
  const onClick = async () => {
    const next = !watched;
    const targets = episodeIds ? seriesWatchedTargets(itemRef, { episodeIds, series: !!series }) : [{ ref: itemRef }];
    // The rows about to change, so Undo can put them back; without them the toast has no Undo.
    const before = await Promise.all(targets.map((x) => captureWatched(x))).catch(() => undefined);
    setWatched.mutate(
      { ref: itemRef, ...(episodeIds ? { episodeIds, series: !!series } : {}), watched: next },
      {
        onSuccess: () =>
          toast({
            // One toast per title: marking season after season replaces it (L1-vod-14).
            id: watchedToastId(itemRef),
            title: name ? t(next ? 'namedMarkedWatched' : 'namedMarkedUnwatched', { name }) : next ? t('markedWatched') : t('markedUnwatched'),
            variant: 'success',
            ...(before
              ? {
                  action: watchedUndoAll(targets, before, {
                    label: t('undo', { ns: 'library' }),
                    onFailed: () => toast({ title: t('undoFailed', { ns: 'library' }), variant: 'error' }),
                  }),
                }
              : {}),
          }),
        onError: (err) => toast({ title: t('watchedFailed'), description: errorDescription(err), variant: 'error' }),
      },
    );
  };
  const icon = <CircleCheck aria-hidden size={18} className={cn(watched && 'text-success')} />;
  if (compact) {
    return <IconButton label={label} icon={icon} onClick={() => void onClick()} disabled={setWatched.isPending} />;
  }
  return (
    <Button size="lg" variant="ghost" icon={icon} loading={setWatched.isPending} onClick={() => void onClick()}>
      {label}
    </Button>
  );
}

export function downloadPercent(d: Download): number | undefined {
  if (!d.totalBytes || d.totalBytes <= 0) return undefined;
  return Math.min(100, Math.round((d.bytesDownloaded / d.totalBytes) * 100));
}

/** Download control reflecting the queue row for this item or episode. */
export function DownloadButton({
  download,
  pending,
  onStart,
  compact,
  label,
}: {
  download: Download | undefined;
  pending: boolean;
  onStart: () => void;
  compact?: boolean;
  /** Accessible context, e.g. the episode title. */
  label?: string;
}) {
  const { t } = useTranslation('vod');
  const size = compact ? 'sm' : 'lg';
  const status = download?.status;
  const ctx = label ? ` ${label}` : '';

  if (status === 'completed') {
    return compact ? (
      <Tooltip content={t('downloaded')} describe={false}>
        <Link to="/my-videos" aria-label={`${t('downloaded')}${ctx}`} className={buttonClass('ghost', 'sm', 'w-8 px-0 text-success')}>
          <Check aria-hidden size={16} />
        </Link>
      </Tooltip>
    ) : (
      <Link to="/my-videos" className={buttonClass('secondary', size)}>
        <Check aria-hidden size={18} className="text-success" />
        {t('downloaded')}
      </Link>
    );
  }
  if (status === 'downloading' || status === 'queued') {
    const pct = download ? downloadPercent(download) : undefined;
    const text = pct !== undefined ? t('downloadingPercent', { percent: pct }) : status === 'queued' ? t('downloadQueuedShort') : t('downloading');
    return (
      <Tooltip content={compact ? text : null} describe={false}>
        <Link to="/downloads" aria-label={`${text}${ctx}`} className={buttonClass(compact ? 'ghost' : 'secondary', size, compact ? 'w-auto px-2 text-xs' : undefined)}>
          <LoaderCircle aria-hidden size={compact ? 14 : 18} className="motion-safe:animate-spin" />
          {compact ? (pct !== undefined ? `${pct}%` : null) : text}
        </Link>
      </Tooltip>
    );
  }
  if (status === 'paused') {
    return (
      <Tooltip content={compact ? t('downloadPaused') : null} describe={false}>
        <Link to="/downloads" aria-label={`${t('downloadPaused')}${ctx}`} className={buttonClass(compact ? 'ghost' : 'secondary', size, compact ? 'w-8 px-0' : undefined)}>
          <Pause aria-hidden size={compact ? 14 : 18} />
          {!compact && t('downloadPaused')}
        </Link>
      </Tooltip>
    );
  }
  const failed = status === 'failed';
  const text = failed ? t('downloadRetry') : t('download');
  if (compact) {
    return (
      <IconButton
        size="sm"
        label={`${text}${ctx}`}
        icon={failed ? <CircleAlert aria-hidden size={16} className="text-danger" /> : <DownloadIcon aria-hidden size={16} />}
        disabled={pending}
        onClick={onStart}
      />
    );
  }
  return (
    <Button size={size} variant="secondary" icon={<DownloadIcon aria-hidden size={18} />} loading={pending} onClick={onStart}>
      {text}
    </Button>
  );
}
