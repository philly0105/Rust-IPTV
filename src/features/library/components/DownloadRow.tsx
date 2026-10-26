/** One queue row on /downloads: artwork, title, status, progress, and actions. */

import { k } from '../lib/keys';
import { ArrowUpToLine, FolderOpen, Gauge, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { memo, type CSSProperties } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import type { Download, Source } from '@/api/types';
import { cn } from '@/ui/cn';
import { dateTimeFormat, intlLocale } from '@/lib/intl';

import { IconButton, Poster, PosterCellWidthContext, useMediaQuery, usePosterWidthBox, useScaledPx } from '../deps';
import { etaSeconds, formatBytes, formatDuration, formatSpeed, percentOf } from '../lib/format';
import { useLiveProgress } from '../lib/progress';
import type { QueueAction } from '../lib/queue';
import { SourceBadge, StatusBadge } from './bits';
import { REVEAL_ON_FINE } from './EntryRow';

export const DOWNLOAD_ROW_HEIGHT = 84;

const ICONS: Record<QueueAction, typeof Pause> = {
  pause: Pause,
  resume: Play,
  cancel: X,
  retry: RotateCcw,
  remove: Trash2,
  reveal: FolderOpen,
  next: ArrowUpToLine,
};

/** Letter shortcut for an action on the focused row (DownloadsPage), shown in the button's tooltip. */
const SHORTCUT_KEYS: Partial<Record<QueueAction, string>> = { pause: 'P', resume: 'P', retry: 'R', cancel: 'X', reveal: 'O' };

export interface DownloadRowProps {
  /** The persisted row; the live transfer sample comes from the progress store. */
  download: Download;
  source: Source | undefined;
  /** The page mixes sources: each row names its own. When every row shares one, none does. */
  showSource?: boolean;
  actions: readonly QueueAction[];
  busy: boolean;
  /**
   * The row is the list's keyboard tab stop: its action buttons join the Tab
   * order after it (Tab from the row reaches Pause, Show in folder, ...).
   * Other rows keep theirs out of it, so Tab leaves the list in one step.
   */
  tabbable?: boolean;
  onAction: (action: QueueAction, d: Download) => void;
  onPlayCatchup?: (d: Download) => void;
  onSpeedLimit?: (d: Download) => void;
  globalRateLimitBps?: number;
}

/**
 * Progress track: a plain track with the fill, and on the active row a needle at the current
 * position (the tuner-dial nod). The fill is amber only while bytes move; a paused or queued row
 * is a neutral grey and a failed one a muted red, so one glance finds the transfer that is running.
 * With no percent the track stays empty, unless `indeterminate` (a transfer running with no known
 * size) sweeps a segment across it; with reduced motion that segment becomes a faint full-width
 * wash, so it never reads as a real 25 %.
 */
export function DialProgress({
  percent,
  tone,
  label,
  indeterminate = false,
}: {
  percent: number | undefined;
  tone: 'accent' | 'muted' | 'danger';
  label: string;
  indeterminate?: boolean;
}) {
  const fill = tone === 'accent' ? 'bg-accent-mark' : tone === 'danger' ? 'bg-danger/70' : 'bg-fg-subtle/50';
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
    >
      {percent === undefined ? (
        indeterminate ? (
          <div
            aria-hidden
            data-testid="dial-indeterminate"
            className={cn(
              'absolute inset-y-0 start-0 w-1/3 rounded-full motion-safe:animate-indeterminate rtl:-scale-x-100',
              'motion-reduce:inset-x-0 motion-reduce:w-auto motion-reduce:opacity-30',
              fill,
            )}
          />
        ) : null
      ) : (
        // One full-width layer slid in from the start edge: the fill and its needle move
        // together with `translate`, which the compositor animates. Width and inset
        // transitions re-ran layout on every row 4 times a second (L2-guide-library-10).
        <div
          aria-hidden
          data-testid="dial-fill"
          className={cn(
            'absolute inset-0 rounded-full',
            'translate-x-[calc(var(--dial)*1%_-_100%)] rtl:translate-x-[calc(100%_-_var(--dial)*1%)]',
            'motion-safe:transition-[translate] motion-safe:duration-300',
            fill,
          )}
          style={{ '--dial': percent } as CSSProperties}
        >
          {tone === 'accent' && percent > 0 && percent < 100 && (
            <div aria-hidden data-testid="dial-needle" className="absolute -end-px inset-y-0 w-0.5 rounded-full bg-fg shadow-[0_0_6px_var(--color-glow)]" />
          )}
        </div>
      )}
    </div>
  );
}

/** What a queued row waits for: its turn, playback or a free connection on its source, or the provider. */
function waitingDetail(d: Download, t: TFunction<'library'>, lang: string): string {
  const w = d.waiting;
  const at = w?.until ? Date.parse(w.until) : NaN;
  const time = Number.isNaN(at) ? undefined : dateTimeFormat(intlLocale(lang), { hour: 'numeric', minute: '2-digit' }).format(at);
  switch (w?.reason) {
    case 'playback':
      return t('waitingForPlayback');
    case 'connection':
      return time ? t('waitingForConnectionAt', { time }) : t('waitingForConnection');
    case 'provider':
      return time ? t('waitingForProvider', { time }) : t('waitingForSlot');
    default:
      return t('waitingForSlot');
  }
}

/** The artwork's box, `w-10 sm:w-12`: spacing steps of 3.75 px at 100 % scale. */
const ART_PX = 37.5;
const ART_SM_PX = 45;
/** Tailwind's `sm` breakpoint. */
const SM_QUERY = '(min-width: 40rem)';

function DownloadRowImpl({ download: d, source, showSource = true, actions, busy, tabbable = false, onAction, onPlayCatchup, onSpeedLimit, globalRateLimitBps = 1024 * 1024 }: DownloadRowProps) {
  const { t, i18n } = useTranslation('library');
  const progress = useLiveProgress(d);
  const lang = i18n.language;
  const pct = percentOf(progress.bytesDownloaded, progress.totalBytes);
  const isActive = d.status === 'downloading';
  const canPlayCatchup = d.ref.contentType === 'live' && d.episodeId?.startsWith('catchup:') &&
    (d.status === 'queued' || d.status === 'downloading' || d.status === 'paused');
  const eta = isActive ? etaSeconds(progress.bytesDownloaded, progress.totalBytes, progress.bytesPerSecond) : undefined;
  const sizeText = progress.totalBytes
    ? t('bytesOf', { done: formatBytes(progress.bytesDownloaded, lang), total: formatBytes(progress.totalBytes, lang) })
    : progress.bytesDownloaded > 0
      ? formatBytes(progress.bytesDownloaded, lang)
      : '';
  const limit = d.rateLimitBps ?? globalRateLimitBps;
  const speed = limit === 0 ? t('speedUnlimited') : t('speedValue', { value: (limit / (1024 * 1024)).toLocaleString(lang, { maximumFractionDigits: 6 }) });
  const speedLabel = d.rateLimitBps === undefined ? t('speedInherited', { speed }) : speed;
  const tone = isActive ? 'accent' : d.status === 'failed' ? 'danger' : 'muted';
  // P2-POSTERS-2: the artwork's width is known, so it does not read its frame as it mounts.
  const artWidth = usePosterWidthBox(useScaledPx(useMediaQuery(SM_QUERY) ? ART_SM_PX : ART_PX, true));

  let detail: string;
  if (d.status === 'downloading') {
    detail = progress.bytesPerSecond
      ? [
          formatSpeed(progress.bytesPerSecond, lang),
          eta !== undefined ? t('etaLeft', { time: formatDuration(eta, { locale: lang, t: (key, vars) => i18n.t(`vod:${key}`, vars) }) }) : '',
          d.connections ? t('connectionsInUse', { n: d.connections }) : '',
        ]
          .filter(Boolean)
          .join('   ')
      : t('stalled');
  } else if (d.status === 'queued') detail = waitingDetail(d, t, lang);
  else if (d.status === 'paused') detail = t('pausedHint');
  else if (d.status === 'failed') detail = d.errorMessage ?? t('failedHint');
  else detail = t('canceledHint');

  return (
    <div
      className={cn(
        'group flex h-full items-center gap-3 rounded-md px-2 sm:gap-4',
        'hover:bg-hover in-focus-visible:bg-hover focus-within:bg-hover motion-safe:transition-colors',
      )}
      data-testid="download-row"
      data-download-id={d.id}
      data-status={d.status}
    >
      <div className="w-10 shrink-0 overflow-hidden rounded-sm ring-1 ring-edge sm:w-12">
        <PosterCellWidthContext.Provider value={artWidth}>
          <Poster src={d.posterUrl} sourceId={d.ref.sourceId} alt="" label={d.title} aspect="poster" />
        </PosterCellWidthContext.Provider>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span dir="auto" className="min-w-0 truncate text-body-sm font-medium text-fg" title={d.title}>
            {d.title}
          </span>
          {d.subtitle && (
            <span dir="auto" className="hidden min-w-0 truncate text-caption text-fg-muted md:inline">
              {d.subtitle}
            </span>
          )}
          {/* Below sm the detail line under the bar says the state; the badge would only squeeze the title. */}
          <StatusBadge status={d.status} className="ms-auto shrink-0 max-sm:hidden" />
        </div>
        <DialProgress percent={pct} tone={tone} indeterminate={isActive && pct === undefined} label={t('progressFor', { title: d.title })} />
        {/* One line at any width: the numbers never wrap, the detail gives way first. */}
        <div className="flex min-w-0 items-center gap-3 whitespace-nowrap text-caption text-fg-muted">
          {pct !== undefined && <span className="shrink-0 font-medium tabular-nums text-fg">{`${pct}%`}</span>}
          {sizeText && <span className="hidden shrink-0 tabular-nums sm:inline">{sizeText}</span>}
          <span
            className={cn('min-w-0 truncate whitespace-pre', d.status === 'failed' && 'text-danger')}
            title={detail}
            data-testid="download-detail"
          >
            {detail}
          </span>
          {onSpeedLimit && (
            <button
              type="button"
              className="ms-auto inline-flex shrink-0 items-center gap-1 rounded-sm text-caption text-fg-muted hover:text-fg focus-visible:text-fg"
              aria-label={t('speedEditAria', { title: d.subtitle || d.title, speed: speedLabel })}
              title={t('speedEditAria', { title: d.subtitle || d.title, speed: speedLabel })}
              tabIndex={tabbable ? 0 : -1}
              onClick={() => onSpeedLimit(d)}
            >
              <Gauge size={12} aria-hidden />
              <span>{speedLabel}</span>
            </button>
          )}
          {showSource && <SourceBadge source={source} className="ms-auto hidden shrink-0 lg:inline-flex" />}
        </div>
      </div>
      {/* Ghost icon buttons. A row that is waiting or paused shows them on hover or focus (fine
          pointers); a failed row always shows Retry and Remove, since it is there to be dealt with.
          The column is as wide as the most a row has (four), shown or not, so every bar, badge
          and button ends on the same line. */}
      <div
        className={cn(
          'flex shrink-0 items-center justify-end gap-0.5 pointer-fine:w-[calc(4*2rem+3*0.125rem)]',
          !isActive && d.status !== 'failed' && REVEAL_ON_FINE,
        )}
        data-testid="download-actions"
      >
        {canPlayCatchup && onPlayCatchup && (
          <IconButton
            size="sm"
            label={t('actionWatchCatchupAria', { title: d.subtitle?.split(' · ')[0] || d.title })}
            tooltip={t('actionWatchCatchup')}
            icon={<Play size={16} aria-hidden />}
            disabled={busy}
            tabIndex={tabbable ? 0 : -1}
            data-action="watch"
            onClick={() => onPlayCatchup(d)}
          />
        )}
        {actions.map((a) => {
          const Icon = ICONS[a];
          return (
            <IconButton
              key={a}
              size="sm"
              label={t(k('action', a) + 'Aria', { title: d.title })}
              tooltip={t(k('action', a))}
              shortcut={SHORTCUT_KEYS[a]?.toLowerCase()}
              icon={<Icon size={16} aria-hidden />}
              disabled={busy}
              tabIndex={tabbable ? 0 : -1}
              data-action={a}
              className={a === 'remove' || a === 'cancel' ? 'hover:text-danger' : undefined}
              onClick={() => onAction(a, d)}
            />
          );
        })}
      </div>
    </div>
  );
}

export const DownloadRow = memo(DownloadRowImpl);
