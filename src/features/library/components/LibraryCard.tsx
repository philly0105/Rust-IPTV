/** Poster card for an offline movie or a series of downloaded episodes. */

import { FileWarning, Play } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { CARD_ART } from '@/ui/card';
import { cn } from '@/ui/cn';

import { Badge, Poster } from '../deps';
import { formatBytes, formatClock } from '../lib/format';
import type { LibraryEntry } from '../lib/myvideos';

export const CARD_CAPTION_HEIGHT = 60;

function LibraryCardImpl({ entry }: { entry: LibraryEntry }) {
  const { t, i18n } = useTranslation('library');
  const missing = entry.kind === 'movie' ? entry.missing : entry.missingCount === entry.episodes.length;
  const partlyMissing = entry.kind === 'series' && entry.missingCount > 0 && !missing;

  // One order for every card's facts (VL-library-cards): what it is, then its size. Where a movie
  // stopped is drawn on the artwork, not in the caption.
  let meta: string;
  let resumeAt: number | undefined;
  if (entry.kind === 'movie') {
    const d = entry.download;
    const size = formatBytes(d.totalBytes ?? d.bytesDownloaded, i18n.language);
    meta = size ? `${t('movie')} · ${size}` : t('movie');
    resumeAt = d.positionSeconds > 5 ? d.positionSeconds : undefined;
  } else {
    meta = t('episodeCount', { count: entry.episodes.length });
  }

  return (
    <div className="flex h-full flex-col gap-2" data-testid="library-card" data-kind={entry.kind} data-missing={missing || undefined}>
      {/* The shared card states (src/ui/card.ts): the grid's listitem is the card root. */}
      <div className={cn(CARD_ART, missing && 'opacity-60 grayscale')}>
        {/* The frame's ring is the edge; the poster's own hairline would double it. */}
        <Poster src={entry.posterUrl} sourceId={(entry.kind === 'movie' ? entry.download : entry.latest).ref?.sourceId} alt="" label={entry.title} aspect="poster" className="after:hidden" />
        {entry.kind === 'series' && (
          <span className="absolute end-1.5 top-1.5 rounded-sm bg-glass-strong px-1.5 py-0.5 text-xs font-semibold tabular-nums text-on-glass">
            {entry.episodes.length}
          </span>
        )}
        {resumeAt !== undefined && !missing && (
          <span
            className="absolute start-1.5 bottom-1.5 inline-flex items-center gap-1 rounded-sm bg-glass-strong px-1.5 py-0.5 text-xs font-medium tabular-nums text-on-glass"
            data-testid="library-card-resume"
          >
            <Play size={10} aria-hidden className="fill-current" />
            <span className="sr-only">{t('resumeAt', { time: formatClock(resumeAt) })}</span>
            <span aria-hidden>{formatClock(resumeAt)}</span>
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
