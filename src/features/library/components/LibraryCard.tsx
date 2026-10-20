/** Poster card for an offline movie or a series of downloaded episodes. */

import { FileWarning } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/ui/cn';

import { Badge, Poster } from '../deps';
import { formatBytes, formatClock } from '../lib/format';
import type { LibraryEntry } from '../lib/myvideos';

export const CARD_CAPTION_HEIGHT = 60;

function LibraryCardImpl({ entry }: { entry: LibraryEntry }) {
  const { t, i18n } = useTranslation('library');
  const missing = entry.kind === 'movie' ? entry.missing : entry.missingCount === entry.episodes.length;
  const partlyMissing = entry.kind === 'series' && entry.missingCount > 0 && !missing;

  let meta: string;
  if (entry.kind === 'movie') {
    const d = entry.download;
    const size = formatBytes(d.totalBytes ?? d.bytesDownloaded, i18n.language);
    meta = d.positionSeconds > 5 ? t('resumeAt', { time: formatClock(d.positionSeconds) }) : size || t('movie');
  } else {
    meta = t('episodeCount', { count: entry.episodes.length });
  }

  return (
    <div className="flex h-full flex-col gap-2" data-testid="library-card" data-kind={entry.kind} data-missing={missing || undefined}>
      <div
        className={cn(
          'relative overflow-hidden rounded-lg ring-1 ring-edge motion-safe:transition-transform motion-safe:duration-150',
          'group-hover:ring-border group-focus-visible:ring-2 group-focus-visible:ring-focus',
          missing && 'opacity-60 grayscale',
        )}
      >
        <Poster src={entry.posterUrl} sourceId={(entry.kind === 'movie' ? entry.download : entry.latest).ref?.sourceId} alt="" label={entry.title} aspect="poster" />
        {entry.kind === 'series' && (
          <span className="absolute end-2 top-2 rounded-sm border border-glass-border bg-glass-strong px-1.5 py-0.5 text-xs font-semibold tabular-nums text-on-glass">
            {entry.episodes.length}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col" style={{ height: CARD_CAPTION_HEIGHT - 8 }}>
        <span className="truncate text-sm font-medium text-fg" title={entry.title}>
          {entry.title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
          {missing ? (
            <Badge variant="danger" className="inline-flex items-center gap-1">
              <FileWarning size={12} aria-hidden />
              {t('fileMissing')}
            </Badge>
          ) : (
            <span className="truncate">{meta}</span>
          )}
          {partlyMissing && (
            <Badge variant="warning" className="shrink-0">
              {t('missingCount', { count: entry.missingCount })}
            </Badge>
          )}
        </span>
      </div>
    </div>
  );
}

export const LibraryCard = memo(LibraryCardImpl);
