import { Check, CircleAlert, CircleCheck, Download as DownloadIcon, Heart, LoaderCircle, Pause } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { invalidate, useRpcMutation } from '@/api/query';
import type { Download, ItemRef, ItemSnapshot } from '@/api/types';

import { captureWatched } from '@/features/library/lib/watchedUndo';
import { intlLocale } from '@/lib/intl';

import { useSetWatched } from '../../hooks/queries';
import { seriesWatchedTargets, watchedToastId, watchedUndoAll } from '../../lib/seriesWatched';
import { Button, IconButton, Tooltip, buttonClass, cn, useToast, errorDescription } from '@/ui';
import { HeroIcon } from './DetailHero';

/** Adds the title to favorites or takes it off, with the toast. */
function useFavoriteToggle(itemRef: ItemRef, snapshot: ItemSnapshot) {
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
  return { onClick, pending: toggle.isPending };
}

/**
 * Favorites on or off. `round` is the detail hero's round icon button (VL-hero-actions), between
 * My List and Watched, so the page says the title is a favourite: a toggle named "Favorite" whose
 * pressed state is the neutral selected fill with the heart filled in (a state, never amber), and
 * whose tooltip says what a press does.
 */
export function FavoriteButton({ itemRef, snapshot, isFavorite, round }: { itemRef: ItemRef; snapshot: ItemSnapshot; isFavorite: boolean; round?: boolean }) {
  const { t } = useTranslation('vod');
  const { onClick, pending } = useFavoriteToggle(itemRef, snapshot);
  if (round) {
    return (
      <IconButton
        size="lg"
        variant="secondary"
        label={t('captionFavorite')}
        tooltip={isFavorite ? t('removeFromFavorites') : t('addToFavorites')}
        pressed={isFavorite}
        icon={<Heart aria-hidden size={18} className={cn(isFavorite && 'fill-current')} />}
        className="rounded-full"
        onClick={onClick}
        disabled={pending}
        data-testid="vod-favorite-button"
      />
    );
  }
  const icon = <Heart aria-hidden size={18} className={cn(isFavorite && 'fill-current text-live')} />;
  return (
    <Button size="lg" variant="secondary" icon={icon} aria-pressed={isFavorite} loading={pending} onClick={onClick}>
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
  round,
  size = 'lg',
  labels,
  name,
}: {
  itemRef: ItemRef;
  /** Height of the labelled button: `lg` in a hero, `sm` beside a section heading. */
  size?: 'sm' | 'lg';
  episodeIds?: string[];
  /** With `episodeIds`: also set the series-level row to the new state. */
  series?: boolean;
  watched: boolean;
  compact?: boolean;
  /** The detail hero's round icon button, pressed while watched (VL-hero-actions). */
  round?: boolean;
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
  if (round) {
    return (
      <IconButton
        size="lg"
        variant="secondary"
        label={label}
        icon={icon}
        // Watched is a state, so it reads as pressed (neutral), with the green tick; the label says what a press does.
        className={cn('rounded-full', watched && 'bg-selected text-fg')}
        onClick={() => void onClick()}
        disabled={setWatched.isPending}
        data-testid="vod-watched-button"
      />
    );
  }
  if (compact) {
    return <IconButton label={label} icon={icon} onClick={() => void onClick()} disabled={setWatched.isPending} />;
  }
  return (
    <Button size={size} variant="ghost" icon={icon} loading={setWatched.isPending} onClick={() => void onClick()}>
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
  round,
  label,
  downloadedHref = '/my-videos',
}: {
  download: Download | undefined;
  pending: boolean;
  onStart: () => void;
  compact?: boolean;
  /** The detail hero's round icon button: the state in the icon and the tooltip (VL-hero-actions). */
  round?: boolean;
  /** Accessible context, e.g. the episode title. */
  label?: string;
  /** Where the finished download opens: its own My Videos page when the caller knows it (VL-offline-play). */
  downloadedHref?: string;
}) {
  const { t } = useTranslation('vod');
  const size = compact ? 'sm' : 'lg';
  const status = download?.status;
  const ctx = label ? ` ${label}` : '';
  if (round) return <RoundDownloadButton download={download} pending={pending} onStart={onStart} downloadedHref={downloadedHref} />;

  if (status === 'completed') {
    return compact ? (
      <Tooltip content={t('downloaded')} describe={false}>
        <Link to={downloadedHref} aria-label={`${t('downloaded')}${ctx}`} className={buttonClass('ghost', 'sm', 'w-8 px-0 text-success')}>
          <Check aria-hidden size={16} />
        </Link>
      </Tooltip>
    ) : (
      <Link to={downloadedHref} className={buttonClass('secondary', size)}>
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

/**
 * The progress ring of the round download button: a track and an arc for the share downloaded,
 * drawn inside the button's edge from 12 o'clock. The arc takes the accent while bytes move
 * (progress) and is neutral while paused or waiting in the queue. `pathLength` makes the dash
 * pattern a percentage.
 */
function DownloadRing({ percent, moving }: { percent: number; moving: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 36 36" className="pointer-events-none absolute inset-0 size-full -rotate-90" data-testid="vod-download-ring">
      <circle cx="18" cy="18" r="16" fill="none" strokeWidth="2.5" className="stroke-surface-3" />
      <circle
        cx="18"
        cy="18"
        r="16"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray={`${percent} 100`}
        className={cn(moving ? 'stroke-accent-mark' : 'stroke-fg-muted', 'motion-safe:transition-[stroke-dasharray] motion-safe:duration-(--duration-base)')}
        data-testid="vod-download-ring-fill"
      />
    </svg>
  );
}

/**
 * Round variant of {@link DownloadButton}: one 48 px circle whose icon and tooltip carry the state.
 * While the file comes in, a ring around the download glyph shows how much has (VL-hero-actions),
 * so the state reads without the tooltip, which touch never shows; only a download of unknown
 * size falls back to the spinner. It comes in its `HeroIcon`, whose phone caption is the state in
 * a word (Download, 45 %, Paused, Downloaded).
 */
function RoundDownloadButton({
  download,
  pending,
  onStart,
  downloadedHref,
}: {
  download: Download | undefined;
  pending: boolean;
  onStart: () => void;
  downloadedHref: string;
}) {
  const { t, i18n } = useTranslation('vod');
  const status = download?.status;
  const round = buttonClass('secondary', 'lg', 'relative w-12 rounded-full px-0');
  if (status === 'completed' || status === 'downloading' || status === 'queued' || status === 'paused') {
    const pct = download ? downloadPercent(download) : undefined;
    const text =
      status === 'completed'
        ? t('downloaded')
        : status === 'paused'
          ? t('downloadPaused')
          : pct !== undefined
            ? t('downloadingPercent', { percent: pct })
            : status === 'queued'
              ? t('downloadQueuedShort')
              : t('downloading');
    const caption =
      status === 'completed'
        ? t('downloaded')
        : status === 'paused'
          ? t('captionPaused')
          : pct !== undefined
            ? new Intl.NumberFormat(intlLocale(i18n.language), { style: 'percent' }).format(pct / 100)
            : status === 'queued'
              ? t('downloadQueuedShort')
              : t('downloading');
    let icon: ReactNode;
    if (status === 'completed') icon = <Check aria-hidden size={18} className="text-success" />;
    else if (pct !== undefined) {
      icon = (
        <>
          <DownloadRing percent={pct} moving={status === 'downloading'} />
          {status === 'paused' ? <Pause aria-hidden size={16} /> : <DownloadIcon aria-hidden size={16} />}
        </>
      );
    } else if (status === 'paused') icon = <Pause aria-hidden size={18} />;
    else icon = <LoaderCircle aria-hidden size={18} className="motion-safe:animate-spin" />;
    return (
      <HeroIcon caption={caption}>
        <Tooltip content={text} describe={false}>
          <Link to={status === 'completed' ? downloadedHref : '/downloads'} aria-label={text} className={round} data-testid="vod-download-button">
            {icon}
          </Link>
        </Tooltip>
      </HeroIcon>
    );
  }
  const failed = status === 'failed';
  return (
    <HeroIcon caption={failed ? t('captionRetry') : t('download')}>
      <IconButton
        size="lg"
        variant="secondary"
        label={failed ? t('downloadRetry') : t('download')}
        icon={pending ? <LoaderCircle aria-hidden size={18} className="motion-safe:animate-spin" /> : failed ? <CircleAlert aria-hidden size={18} className="text-danger" /> : <DownloadIcon aria-hidden size={18} />}
        aria-busy={pending || undefined}
        aria-disabled={pending || undefined}
        onClick={() => {
          if (!pending) onStart();
        }}
        className="rounded-full"
        data-testid="vod-download-button"
      />
    </HeroIcon>
  );
}
