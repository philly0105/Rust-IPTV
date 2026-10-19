/**
 * A recording file as a My Videos card, so the All grid shows everything on
 * disk. Recordings have no artwork: the channel's tinted initials tile stands
 * in, marked as a recording in the corner. The caption mirrors LibraryCard.
 */

import { Disc3, FileWarning } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { dateTimeFormat } from '@/lib/intl';
import { cn } from '@/ui/cn';

import { Badge, Poster } from '../deps';
import { CARD_CAPTION_HEIGHT } from './LibraryCard';
import type { RecordingEntry } from '../lib/myvideos';

function RecordingCardImpl({ entry }: { entry: RecordingEntry }) {
  const { t, i18n } = useTranslation('library');
  const f = entry.file;
  const writing = f.status === 'recording';
  const at = Date.parse(f.date);
  const date = Number.isFinite(at) ? dateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(at) : '';

  return (
    <div className="flex h-full flex-col gap-2" data-testid="library-card" data-kind="recording" data-missing={entry.missing || undefined}>
      <div
        className={cn(
          'relative overflow-hidden rounded-lg ring-1 ring-border',
          'group-hover:ring-accent/60 group-focus-visible:ring-2 group-focus-visible:ring-accent',
          entry.missing && 'opacity-60 grayscale',
        )}
      >
        <Poster src={undefined} alt="" label={f.channelName ?? entry.title} kind="live" aspect="poster" />
        <span className="absolute start-2 top-2 inline-flex items-center gap-1 rounded-sm bg-bg/85 px-1.5 py-0.5 text-xs font-medium text-fg">
          <Disc3 size={12} aria-hidden className={writing ? 'text-live' : 'text-fg-muted'} />
          {writing ? t('recStatusRecording') : t('recordingKind')}
        </span>
      </div>
      <div className="flex min-w-0 flex-col" style={{ height: CARD_CAPTION_HEIGHT - 8 }}>
        <span dir="auto" className="truncate text-match-parent text-sm font-medium text-fg" title={f.fileName}>
          {entry.title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
          {entry.missing ? (
            <Badge variant="danger" className="inline-flex items-center gap-1">
              <FileWarning size={12} aria-hidden />
              {t('fileMissing')}
            </Badge>
          ) : (
            <span className="truncate tabular-nums">{date}</span>
          )}
        </span>
      </div>
    </div>
  );
}

export const RecordingCard = memo(RecordingCardImpl);
