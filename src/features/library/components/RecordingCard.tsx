/**
 * A recording file as a My Videos card. Recordings are TV, so the card is 16:9 (a poster shape
 * made them look like broken artwork beside the real posters): the channel's tinted initials
 * tile stands in for a picture, with a glass chip that says it is a recording (red while it is
 * still writing) and the length in the other corner. The caption reads programme, then
 * channel and date.
 */

import { Disc3, FileWarning } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { dateTimeFormat, intlLocale } from '@/lib/intl';
import { CARD_ART } from '@/ui/card';
import { cn } from '@/ui/cn';

import { Badge, Poster } from '../deps';
import { formatClock } from '../lib/format';
import type { RecordingEntry } from '../lib/myvideos';

/** Caption under the wide artwork: title and one line of facts. */
export const RECORDING_CAPTION_HEIGHT = 48;

function RecordingCardImpl({ entry }: { entry: RecordingEntry }) {
  const { t, i18n } = useTranslation('library');
  const f = entry.file;
  const writing = f.status === 'recording';
  const at = Date.parse(f.date);
  const date = Number.isFinite(at) ? dateTimeFormat(intlLocale(i18n.language), { dateStyle: 'medium', timeStyle: 'short' }).format(at) : '';
  const channel = f.title && f.channelName ? f.channelName : undefined;

  return (
    <div className="flex h-full flex-col gap-2" data-testid="library-card" data-kind="recording" data-missing={entry.missing || undefined}>
      <div className={cn(CARD_ART, entry.missing && 'opacity-60 grayscale')}>
        <Poster src={undefined} alt="" label={f.channelName ?? entry.title} kind="live" aspect="wide" className="after:hidden" />
        {/* Glass like every chip on artwork (VL-library-cards); bg-bg turned near-white in the light theme. */}
        <span className="absolute start-1.5 top-1.5 inline-flex items-center gap-1 rounded-sm bg-glass-strong px-1.5 py-0.5 text-xs font-medium text-on-glass">
          <Disc3 size={12} aria-hidden className={writing ? 'text-live' : 'text-on-glass-muted'} />
          {writing ? t('recStatusRecording') : t('recordingKind')}
        </span>
        {f.durationSeconds && !entry.missing ? (
          <span className="absolute end-1.5 bottom-1.5 rounded-sm bg-glass-strong px-1.5 py-0.5 font-numeric text-xs tabular-nums text-on-glass" aria-hidden>
            {formatClock(f.durationSeconds)}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col" style={{ height: RECORDING_CAPTION_HEIGHT - 8 }}>
        <span dir="auto" className="truncate text-match-parent text-body-sm font-medium text-fg" title={f.fileName}>
          {entry.title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-caption text-fg-muted">
          {entry.missing ? (
            <Badge variant="danger" className="inline-flex items-center gap-1">
              <FileWarning size={12} aria-hidden />
              {t('fileMissing')}
            </Badge>
          ) : (
            <span dir="auto" className="truncate tabular-nums">
              {channel ? `${channel} · ${date}` : date}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

export const RecordingCard = memo(RecordingCardImpl);
