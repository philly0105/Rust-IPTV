import { Check, CircleAlert, CircleCheck, CirclePause, Clock, Download as DownloadIcon, HardDriveDownload, Heart, LoaderCircle, Pause } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { Download, ItemRef, ItemSnapshot } from '@/api/types';

import { toggleFavoriteWithUndo } from '@/features/library/lib/favoriteToggle';
import { useLiveProgress, type EffectiveProgress } from '@/features/library/lib/progress';
import { captureWatched } from '@/features/library/lib/watchedUndo';
import { intlLocale } from '@/lib/intl';

import { useSetWatched } from '../../hooks/queries';
import { seriesWatchedTargets, watchedToastId, watchedUndoAll } from '../../lib/seriesWatched';
import { Button, IconButton, Tooltip, buttonClass, cn, useToast, errorDescription } from '@/ui';
import { GHOST_ICON } from '@/ui/Button';
import { HeroIcon } from './DetailHero';

/**
 * Adds the title to favorites or takes it off: the shared toggle's toast names the title, and a
 * removal carries Undo. The state flips at once and the answer settles it, so the heart does not
 * look dead while the call and the refetch run.
 */
function useFavoriteToggle(itemRef: ItemRef, snapshot: ItemSnapshot, isFavorite: boolean) {
  const [optimistic, setOptimistic] = useState<boolean | undefined>(undefined);
  const onClick = () => {
    if (optimistic !== undefined) return;
    setOptimistic(!isFavorite);
    void toggleFavoriteWithUndo(itemRef, snapshot, snapshot.title, isFavorite).finally(() => setOptimistic(undefined));
  };
  return { onClick, pending: optimistic !== undefined, favorite: optimistic ?? isFavorite };
}

/**
 * Favorites on or off. `round` is the detail hero's icon button (VL-hero-actions), between
 * My List and Watched, so the page says the title is a favourite: a toggle named "Favorite" whose
 * pressed state is the neutral selected fill with the heart filled in (a state, never amber), and
 * whose tooltip says what a press does.
 */
export function FavoriteButton({ itemRef, snapshot, isFavorite: shown, round }: { itemRef: ItemRef; snapshot: ItemSnapshot; isFavorite: boolean; round?: boolean }) {
  const { t } = useTranslation('vod');
  const { onClick, pending, favorite: isFavorite } = useFavoriteToggle(itemRef, snapshot, shown);
  if (round) {
    return (
      <IconButton
        size="lg"
        variant="secondary"
        label={t('captionFavorite')}
        tooltip={isFavorite ? t('removeFromFavorites') : t('addToFavorites')}
        pressed={isFavorite}
        // The heart shows the new state at once, so no spinner; a press during the call is ignored,
        // and focus stays on the button (native disabled would drop it to the page).
        icon={<Heart aria-hidden size={18} className={cn(isFavorite && 'fill-current')} />}
        aria-busy={pending || undefined}
        onClick={onClick}
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

interface WatchedTarget {
  itemRef: ItemRef;
  episodeIds?: string[];
  /** With `episodeIds`: also set the series-level row to the new state. */
  series?: boolean;
  watched: boolean;
  /** Overrides for the two button labels (season-level wording). */
  labels?: { mark: string; unmark: string };
  /** What the toast says was marked ("Season 2", the series title). */
  name?: string;
}

/**
 * The watched toggle behind {@link WatchedButton}, for a control of another shape (the phone's
 * season menu): what a press does, in words, and the press itself with its toast and Undo.
 */
export function useWatchedToggle({ itemRef, episodeIds, series, watched, labels, name }: WatchedTarget) {
  const { t } = useTranslation('vod');
  const { toast } = useToast();
  const setWatched = useSetWatched();
  const label = watched ? (labels?.unmark ?? t('markUnwatched')) : (labels?.mark ?? t('markWatched'));
  const toggle = async () => {
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
  return { label, toggle: () => void toggle(), pending: setWatched.isPending };
}

/**
 * Toggles watched for a movie (no `episodeIds`) or a set of episodes, and with `series` the
 * series-level row too (`lib/seriesWatched` works out which episodes; they may be none).
 */
export function WatchedButton({
  compact,
  round,
  size = 'lg',
  disabled,
  ...target
}: WatchedTarget & {
  /** Height of the labelled button: `lg` in a hero, `sm` beside a section heading. */
  size?: 'sm' | 'lg';
  compact?: boolean;
  /** The detail hero's icon button, pressed while watched (VL-hero-actions). */
  round?: boolean;
  /** Not pressable yet: what a press marks is still loading (a series' episodes). */
  disabled?: boolean;
}) {
  const { watched } = target;
  const { label, toggle, pending } = useWatchedToggle(target);
  const icon = <CircleCheck aria-hidden size={18} className={cn(watched && 'text-success')} />;
  if (round) {
    return (
      <IconButton
        size="lg"
        variant="secondary"
        label={label}
        icon={icon}
        // Watched is a state, so it reads as pressed (neutral), with the green tick; the label says what a press does.
        className={cn(watched && 'bg-selected text-fg')}
        onClick={toggle}
        disabled={disabled}
        loading={pending}
        data-testid="vod-watched-button"
      />
    );
  }
  if (compact) {
    return <IconButton label={label} icon={icon} onClick={toggle} disabled={disabled} loading={pending} />;
  }
  return (
    <Button size={size} variant="ghost" icon={icon} loading={pending} disabled={disabled} onClick={toggle}>
      {label}
    </Button>
  );
}

export function downloadPercent(d: Pick<EffectiveProgress, 'bytesDownloaded' | 'totalBytes'>): number | undefined {
  if (!d.totalBytes || d.totalBytes <= 0) return undefined;
  return Math.min(100, Math.round((d.bytesDownloaded / d.totalBytes) * 100));
}

/**
 * How much of `d` is in, from its live `downloads.progress` sample while it transfers (DL-7). The
 * page no longer refetches `downloads.list` for progress, so this is what moves the ring and the
 * percent, and an event re-renders only the control that calls it.
 */
function useDownloadPercent(d: Download): number | undefined {
  return downloadPercent(useLiveProgress(d));
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
  /** The detail hero's icon button: the state in the icon and the tooltip (VL-hero-actions). */
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
    // The file-on-disk glyph the row's facts use, in the quiet icon tone: a green tick here sat
    // beside the green watched tick and read as a second one (vod-detail-02).
    return compact ? (
      <Tooltip content={t('downloaded')} describe={false}>
        <Link to={downloadedHref} aria-label={`${t('downloaded')}${ctx}`} className={buttonClass('ghost', 'sm', cn(COMPACT_SLOT, GHOST_ICON))}>
          <HardDriveDownload aria-hidden size={16} />
        </Link>
      </Tooltip>
    ) : (
      <Link to={downloadedHref} className={buttonClass('secondary', size)}>
        <Check aria-hidden size={18} className="text-success" />
        {t('downloaded')}
      </Link>
    );
  }
  if (download && (download.status === 'downloading' || download.status === 'queued')) return <DownloadingLink download={download} compact={compact} ctx={ctx} />;
  if (status === 'paused') {
    return (
      <Tooltip content={compact ? t('downloadPaused') : null} describe={false}>
        <Link to="/downloads" aria-label={`${t('downloadPaused')}${ctx}`} className={buttonClass(compact ? 'ghost' : 'secondary', size, compact ? cn(COMPACT_SLOT, GHOST_ICON) : undefined)}>
          {/* A paused state, not a Pause button: the glyph in a circle, in the quiet tone. */}
          {compact ? <CirclePause aria-hidden size={16} /> : <Pause aria-hidden size={18} />}
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
        className={COMPACT_SLOT}
        label={`${text}${ctx}`}
        icon={failed ? <CircleAlert aria-hidden size={16} className="text-danger" /> : <DownloadIcon aria-hidden size={16} />}
        loading={pending}
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
 * The compact control's box, the same in every state, so the watched toggle beside it keeps its
 * place down the episode list while a download spins, waits or pauses (vod-detail-03).
 */
const COMPACT_SLOT = 'w-14 px-0 justify-center';

/**
 * {@link DownloadButton} while its row is queued or coming in: the percent from the live sample.
 * Only a download under way spins and shows the percent; a queued one waits under a clock, so it
 * does not look like a transfer stuck at 0 %.
 */
function DownloadingLink({ download, compact, ctx }: { download: Download; compact: boolean | undefined; ctx: string }) {
  const { t } = useTranslation('vod');
  const pct = useDownloadPercent(download);
  const queued = download.status === 'queued';
  const text = queued ? t('downloadQueuedShort') : pct !== undefined ? t('downloadingPercent', { percent: pct }) : t('downloading');
  return (
    <Tooltip content={compact ? text : null} describe={false}>
      <Link to="/downloads" aria-label={`${text}${ctx}`} className={buttonClass(compact ? 'ghost' : 'secondary', compact ? 'sm' : 'lg', compact ? cn(COMPACT_SLOT, 'gap-1 text-xs', queued && GHOST_ICON) : undefined)}>
        {queued ? (
          <Clock aria-hidden size={compact ? 14 : 18} />
        ) : (
          <LoaderCircle aria-hidden size={compact ? 14 : 18} className="motion-safe:animate-spin" />
        )}
        {compact ? (!queued && pct !== undefined ? `${pct}%` : null) : text}
      </Link>
    </Tooltip>
  );
}

/**
 * The progress ring of the hero's download button: a track and an arc for the share downloaded,
 * drawn just inside the button's edge, a rounded square like the button, from the middle of its
 * top side clockwise. The arc takes the accent while bytes move (progress) and is neutral while
 * paused or waiting in the queue. `pathLength` makes the dash pattern a percentage.
 */
const RING_PATH = 'M18 2.5H30a3.5 3.5 0 0 1 3.5 3.5V30a3.5 3.5 0 0 1-3.5 3.5H6A3.5 3.5 0 0 1 2.5 30V6A3.5 3.5 0 0 1 6 2.5Z';
function DownloadRing({ percent, moving }: { percent: number; moving: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 36 36" className="pointer-events-none absolute inset-0 size-full" data-testid="vod-download-ring">
      <path d={RING_PATH} fill="none" strokeWidth="2.5" className="stroke-surface-3" />
      <path
        d={RING_PATH}
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
 * Hero variant of {@link DownloadButton}: one 48 px icon button whose icon and tooltip carry the state.
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
  const { t } = useTranslation('vod');
  const status = download?.status;
  if (download && (status === 'completed' || status === 'downloading' || status === 'queued' || status === 'paused')) {
    return <RoundDownloadState download={download} downloadedHref={downloadedHref} />;
  }
  const failed = status === 'failed';
  return (
    <HeroIcon caption={failed ? t('captionRetry') : t('download')}>
      <IconButton
        size="lg"
        variant="secondary"
        label={failed ? t('downloadRetry') : t('download')}
        icon={failed ? <CircleAlert aria-hidden size={18} className="text-danger" /> : <DownloadIcon aria-hidden size={18} />}
        loading={pending}
        onClick={onStart}
        data-testid="vod-download-button"
      />
    </HeroIcon>
  );
}

/** {@link RoundDownloadButton} once its row is under way or done: the ring moves with the live sample. */
function RoundDownloadState({ download, downloadedHref }: { download: Download; downloadedHref: string }) {
  const { t, i18n } = useTranslation('vod');
  const status = download.status;
  const round = buttonClass('secondary', 'lg', 'relative w-12 px-0');
  const pct = useDownloadPercent(download);
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
  // The file on disk, as the episode rows draw it; the green tick is the watched mark's (vod-detail-02).
  if (status === 'completed') icon = <HardDriveDownload aria-hidden size={18} />;
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
