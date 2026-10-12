import { Check, CircleAlert, CircleCheck, Download as DownloadIcon, Heart, LoaderCircle, Pause } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { invalidate, useRpcMutation } from '@/api/query';
import type { Download, ItemRef, ItemSnapshot } from '@/api/types';

import { captureWatched, watchedUndoAction } from '@/features/library/lib/watchedUndo';

import { useSetWatched } from '../../hooks/queries';
import { Button, IconButton, buttonClass, cn, useToast } from '@/ui';

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
        onError: (err) => toast({ title: t('favoriteFailed'), description: err.message, variant: 'error' }),
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

/** Toggles watched for a movie (no `episodeIds`) or a set of episodes. */
export function WatchedButton({
  itemRef,
  episodeIds,
  watched,
  compact,
  labels,
}: {
  itemRef: ItemRef;
  episodeIds?: string[];
  watched: boolean;
  compact?: boolean;
  /** Overrides for the two button labels (season-level wording). */
  labels?: { mark: string; unmark: string };
}) {
  const { t } = useTranslation('vod');
  const { toast } = useToast();
  const setWatched = useSetWatched();
  const label = watched ? (labels?.unmark ?? t('markUnwatched')) : (labels?.mark ?? t('markWatched'));
  const onClick = async () => {
    const next = !watched;
    const target = { ref: itemRef, ...(episodeIds ? { episodeIds } : {}) };
    // The rows about to change, so Undo can put them back; without them the toast has no Undo.
    const before = await captureWatched(target).catch(() => undefined);
    setWatched.mutate(
      { ...target, watched: next },
      {
        onSuccess: () =>
          toast({
            title: next ? t('markedWatched') : t('markedUnwatched'),
            variant: 'success',
            ...(before
              ? {
                  action: watchedUndoAction(target, before, {
                    label: t('undo', { ns: 'library' }),
                    onFailed: () => toast({ title: t('undoFailed', { ns: 'library' }), variant: 'error' }),
                  }),
                }
              : {}),
          }),
        onError: (err) => toast({ title: t('watchedFailed'), description: err.message, variant: 'error' }),
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
      <Link to="/my-videos" aria-label={`${t('downloaded')}${ctx}`} title={t('downloaded')} className={buttonClass('ghost', 'sm', 'w-8 px-0 text-success')}>
        <Check aria-hidden size={16} />
      </Link>
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
      <Link to="/downloads" aria-label={`${text}${ctx}`} title={text} className={buttonClass(compact ? 'ghost' : 'secondary', size, compact ? 'w-auto px-2 text-xs' : undefined)}>
        <LoaderCircle aria-hidden size={compact ? 14 : 18} className="motion-safe:animate-spin" />
        {compact ? (pct !== undefined ? `${pct}%` : null) : text}
      </Link>
    );
  }
  if (status === 'paused') {
    return (
      <Link to="/downloads" aria-label={`${t('downloadPaused')}${ctx}`} title={t('downloadPaused')} className={buttonClass(compact ? 'ghost' : 'secondary', size, compact ? 'w-8 px-0' : undefined)}>
        <Pause aria-hidden size={compact ? 14 : 18} />
        {!compact && t('downloadPaused')}
      </Link>
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
