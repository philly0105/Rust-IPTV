/** One downloaded episode on the offline series detail. */

import { k } from '../lib/keys';
import { FileWarning, FolderOpen, Play, RotateCcw, Trash2 } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { isDesktop } from '@/api/transport';
import type { Download } from '@/api/types';
import { cn } from '@/ui/cn';

import { Badge, IconButton } from '../deps';
import { formatBytes, formatClock } from '../lib/format';
import type { EpisodeEntry } from '../lib/myvideos';

export const EPISODE_ROW_HEIGHT = 64;

export type EpisodeAction = 'play' | 'redownload' | 'reveal' | 'remove';

export function episodeCode(ep: EpisodeEntry): string {
  if (ep.season === undefined || ep.episode === undefined) return '';
  return `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
}

export function episodeActions(ep: EpisodeEntry): EpisodeAction[] {
  if (ep.missing) return ['redownload', 'remove'];
  return isDesktop ? ['play', 'reveal', 'remove'] : ['play', 'remove'];
}

const ICONS: Record<EpisodeAction, typeof Play> = { play: Play, redownload: RotateCcw, reveal: FolderOpen, remove: Trash2 };

function EpisodeRowImpl({
  episode: ep,
  playing,
  busy,
  tabbable = false,
  onAction,
}: {
  episode: EpisodeEntry;
  playing: boolean;
  busy: boolean;
  /** The row is the list's tab stop: its buttons join the Tab order after it. */
  tabbable?: boolean;
  onAction: (a: EpisodeAction, d: Download) => void;
}) {
  const { t, i18n } = useTranslation('library');
  const d = ep.download;
  const code = episodeCode(ep);
  const actions = episodeActions(ep);
  return (
    <div
      className={cn(
        'flex h-full items-center gap-4 rounded-md px-3 hover:bg-surface-2',
        playing && 'bg-surface-2 shadow-[inset_3px_0_0_var(--color-accent)] rtl:shadow-[inset_-3px_0_0_var(--color-accent)]',
      )}
      data-testid="episode-row"
      data-missing={ep.missing || undefined}
    >
      <span className={cn('w-16 shrink-0 font-display text-sm tabular-nums', playing ? 'text-accent' : 'text-fg-muted')}>{code || '—'}</span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate text-sm', ep.missing ? 'text-fg-muted' : 'text-fg')}>{ep.name || d.subtitle || d.title}</span>
        <span className="flex items-center gap-3 text-xs text-fg-subtle">
          {ep.missing ? (
            <Badge variant="danger" className="inline-flex items-center gap-1">
              <FileWarning size={12} aria-hidden />
              {t('fileMissing')}
            </Badge>
          ) : (
            <>
              <span className="font-display tabular-nums">{formatBytes(d.totalBytes ?? d.bytesDownloaded, i18n.language)}</span>
              {d.positionSeconds > 5 && <span>{t('resumeAt', { time: formatClock(d.positionSeconds) })}</span>}
              {playing && <span className="text-accent">{t('nowPlaying')}</span>}
            </>
          )}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions.map((a) => {
          const Icon = ICONS[a];
          return (
            <IconButton
              key={a}
              size="sm"
              variant={a === actions[0] ? 'secondary' : 'ghost'}
              label={t(k('episode', a) + 'Aria', { title: ep.name || code || d.title })}
              title={t(k('episode', a))}
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

export const EpisodeRow = memo(EpisodeRowImpl);
