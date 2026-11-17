/**
 * A recording file as a My Videos card. Recordings are TV, so the card is 16:9 (a poster shape
 * made them look like broken artwork beside the real posters). The picture is the channel's logo,
 * fitted small on black like a frame of the stream, looked up through the recording that wrote the
 * file; a file with no known channel falls back to the tinted initials tile. A glass chip says
 * "REC" with a red dot while the file is still being written and "Recorded" once it is done (a
 * finished file read as a capture in progress), with the length in the other corner. The caption
 * reads programme, then channel and date.
 */

import { Disc3, FileWarning } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import type { ItemRef, RecordingFile } from '@/api/types';
// Straight from live, as EntryRow takes it: a recording's channel reads as it does in the other library rows.
import { ChannelName } from '@/features/live/components/ChannelLogo';
import { useDisplayPrefs } from '@/features/live/hooks/useDisplayPrefs';
import { dateTimeFormat, intlLocale } from '@/lib/intl';
import { CARD_ART } from '@/ui/card';
import { cn } from '@/ui/cn';

import { Badge, Poster, useRecordings } from '../deps';
import { formatClock } from '../lib/format';
import type { RecordingEntry } from '../lib/myvideos';

const NO_REF: ItemRef = { sourceId: '', contentType: 'live', itemId: '' };

/**
 * The logo of the channel a recording file came from: the file names its recording, the recording
 * its channel, and the catalog that channel's logo (cached, so a grid of cards asks once each).
 */
function useChannelLogo(f: RecordingFile): string | undefined {
  const recordings = useRecordings().data;
  const ref = f.recordingId ? recordings?.find((r) => r.id === f.recordingId)?.ref : undefined;
  const item = useRpcQuery('catalog.item', { ref: ref ?? NO_REF }, { enabled: !!ref, staleTime: 10 * 60_000 });
  const data = ref ? item.data : undefined;
  return data && 'logoUrl' in data ? data.logoUrl || undefined : undefined;
}

/** Caption under the wide artwork: title and one line of facts. */
export const RECORDING_CAPTION_HEIGHT = 48;

/** "Nov 16, 4:12 PM": the year only when it is not this one, so a narrow card keeps the time. */
function recordedFormat(at: number): Intl.DateTimeFormatOptions {
  const sameYear = new Date(at).getFullYear() === new Date().getFullYear();
  return sameYear ? DATE_THIS_YEAR : DATE_OTHER_YEAR;
}
const DATE_THIS_YEAR: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
const DATE_OTHER_YEAR: Intl.DateTimeFormatOptions = { ...DATE_THIS_YEAR, year: 'numeric' };

function RecordingCardImpl({ entry }: { entry: RecordingEntry }) {
  const { t, i18n } = useTranslation('library');
  const f = entry.file;
  const writing = f.status === 'recording';
  const at = Date.parse(f.date);
  const date = Number.isFinite(at) ? dateTimeFormat(intlLocale(i18n.language), recordedFormat(at)).format(at) : '';
  const { stripCountryPrefix } = useDisplayPrefs();
  const channel = f.title && f.channelName ? f.channelName : undefined;
  const logo = useChannelLogo(f);

  return (
    <div className="flex h-full flex-col gap-2" data-testid="library-card" data-kind="recording" data-missing={entry.missing || undefined}>
      <div className={cn(CARD_ART, entry.missing && 'opacity-60 grayscale')}>
        {/* A logo is drawn about 40 % of the frame's height (padding in % of the width: 17 % of a
            16:9 frame's width is 30 % of its height), on black in every theme, like the player. */}
        <Poster
          src={logo}
          alt=""
          label={f.channelName ?? entry.title}
          kind="live"
          aspect="wide"
          fit="contain"
          className={cn('after:hidden', logo && 'bg-black [&_img]:px-[25%] [&_img]:py-[17%]')}
        />
        {/* Glass like every chip on artwork (VL-library-cards); bg-bg turned near-white in the light theme. */}
        <span className="absolute start-1.5 top-1.5 inline-flex items-center gap-1 rounded-sm bg-glass-strong px-1.5 py-0.5 text-xs font-medium text-on-glass">
          {writing ? (
            <span aria-hidden className="size-2 rounded-full bg-live" data-testid="recording-live-dot" />
          ) : (
            <Disc3 size={12} aria-hidden className="text-on-glass-muted" />
          )}
          {writing ? t('recordingChip') : t('recordedChip')}
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
            // Warning, as the Recordings tab and Missing files say it: the file is gone, nothing failed.
            <Badge variant="warning" className="inline-flex items-center gap-1">
              <FileWarning size={12} aria-hidden />
              {t('fileMissing')}
            </Badge>
          ) : (
            <>
              {/* The channel gives way to the date and time, which tell two recordings of a channel apart. */}
              {channel && (
                <>
                  <ChannelName name={channel} strip={stripCountryPrefix} title={channel} className="min-w-0 truncate" />
                  <span aria-hidden className="shrink-0 text-fg-subtle">
                    ·
                  </span>
                </>
              )}
              <span className={cn('tabular-nums', channel ? 'shrink-0' : 'truncate')}>{date}</span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

export const RecordingCard = memo(RecordingCardImpl);
