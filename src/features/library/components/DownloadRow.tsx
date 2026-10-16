/** One queue row on /downloads: artwork, title, status, dial progress, and actions. */

import { k } from '../lib/keys';
import { FolderOpen, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { memo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import type { Download, Source } from '@/api/types';
import { cn } from '@/ui/cn';

import { IconButton, Poster } from '../deps';
import { etaSeconds, formatBytes, formatDuration, formatSpeed, percentOf } from '../lib/format';
import type { EffectiveProgress } from '../lib/progress';
import type { QueueAction } from '../lib/queue';
import { SourceBadge, StatusBadge } from './bits';

export const DOWNLOAD_ROW_HEIGHT = 92;

const ICONS: Record<QueueAction, typeof Pause> = {
  pause: Pause,
  resume: Play,
  cancel: X,
  retry: RotateCcw,
  remove: Trash2,
  reveal: FolderOpen,
};

/** Letter shortcut for an action on the focused row (DownloadsPage), shown in the button's tooltip. */
const SHORTCUT_KEYS: Partial<Record<QueueAction, string>> = { pause: 'P', resume: 'P', retry: 'R', cancel: 'X', reveal: 'O' };

export interface DownloadRowProps {
  download: Download;
  progress: EffectiveProgress;
  source: Source | undefined;
  actions: readonly QueueAction[];
  busy: boolean;
  /**
   * The row is the list's keyboard tab stop: its action buttons join the Tab
   * order after it (Tab from the row reaches Pause, Show in folder, ...).
   * Other rows keep theirs out of it, so Tab leaves the list in one step.
   */
  tabbable?: boolean;
  onAction: (action: QueueAction, d: Download) => void;
}

/**
 * Progress track styled as a tuning dial: tick marks every 10 %, an amber
 * fill, and a needle at the current position. With no percent the track
 * stays empty, unless `indeterminate` (a transfer running with no known size)
 * sweeps a segment across it; with reduced motion that segment becomes a
 * faint full-width wash, so it never reads as a real 25 %.
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
  const fill = tone === 'accent' ? 'bg-accent' : tone === 'danger' ? 'bg-danger/70' : 'bg-fg-subtle/60';
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="relative h-2 w-full overflow-hidden rounded-full bg-surface-3"
    >
      <div
        aria-hidden
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            'repeating-linear-gradient(to right, transparent 0, transparent calc(10% - 1px), var(--color-border) calc(10% - 1px), var(--color-border) 10%)',
        }}
      />
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

function DownloadRowImpl({ download: d, progress, source, actions, busy, tabbable = false, onAction }: DownloadRowProps) {
  const { t, i18n } = useTranslation('library');
  const lang = i18n.language;
  const pct = percentOf(progress.bytesDownloaded, progress.totalBytes);
  const isActive = d.status === 'downloading';
  const eta = isActive ? etaSeconds(progress.bytesDownloaded, progress.totalBytes, progress.bytesPerSecond) : undefined;
  const sizeText = progress.totalBytes
    ? t('bytesOf', { done: formatBytes(progress.bytesDownloaded, lang), total: formatBytes(progress.totalBytes, lang) })
    : progress.bytesDownloaded > 0
      ? formatBytes(progress.bytesDownloaded, lang)
      : '';
  const tone = isActive ? 'accent' : d.status === 'failed' ? 'danger' : 'muted';

  let detail: string;
  if (d.status === 'downloading') {
    detail = progress.bytesPerSecond ? [formatSpeed(progress.bytesPerSecond, lang), eta !== undefined ? t('etaLeft', { time: formatDuration(eta, { locale: lang, t: (key, vars) => i18n.t(`vod:${key}`, vars) }) }) : ''].filter(Boolean).join('   ') : t('stalled');
  } else if (d.status === 'queued') detail = t('waitingForSlot');
  else if (d.status === 'paused') detail = t('pausedHint');
  else if (d.status === 'failed') detail = d.errorMessage ?? t('failedHint');
  else detail = t('canceledHint');

  return (
    <div
      className={cn(
        'group flex h-full items-center gap-4 rounded-md border border-transparent px-3 py-2',
        'hover:bg-surface-2 focus-within:bg-surface-2',
        isActive && 'bg-surface',
      )}
      data-testid="download-row"
      data-download-id={d.id}
      data-status={d.status}
    >
      <div className="w-12 shrink-0">
        <Poster src={d.posterUrl} sourceId={d.ref.sourceId} alt="" label={d.title} aspect="poster" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-fg" title={d.title}>
            {d.title}
          </span>
          {d.subtitle && <span className="hidden truncate text-[calc(13rem/15)] text-fg-muted md:inline">{d.subtitle}</span>}
          <StatusBadge status={d.status} className="ms-auto shrink-0" />
        </div>
        <DialProgress percent={pct} tone={tone} indeterminate={isActive && pct === undefined} label={t('progressFor', { title: d.title })} />
        <div className="flex min-w-0 items-center gap-3 text-xs text-fg-muted">
          <span className="font-display tabular-nums text-fg">{pct !== undefined ? `${pct}%` : ''}</span>
          {sizeText && <span className="font-display tabular-nums">{sizeText}</span>}
          <span
            className={cn('min-w-0 truncate whitespace-pre', d.status === 'failed' && 'text-danger')}
            title={detail}
            data-testid="download-detail"
          >
            {detail}
          </span>
          <SourceBadge source={source} className="ms-auto hidden shrink-0 lg:inline-flex" />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions.map((a) => {
          const Icon = ICONS[a];
          return (
            <IconButton
              key={a}
              size="sm"
              variant={a === actions[0] ? 'secondary' : 'ghost'}
              label={t(k('action', a) + 'Aria', { title: d.title })}
              title={SHORTCUT_KEYS[a] ? `${t(k('action', a))} (${SHORTCUT_KEYS[a]})` : t(k('action', a))}
              icon={<Icon size={16} aria-hidden />}
              disabled={busy}
              tabIndex={tabbable ? 0 : -1}
              data-action={a}
              onClick={() => onAction(a, d)}
            />
          );
        })}
      </div>
    </div>
  );
}

export const DownloadRow = memo(DownloadRowImpl);
