/**
 * Bell and record markers on a guide programme that has a reminder or a recording.
 * A recording a series rule made (Run 2 C5) shows a repeat mark instead of the dot.
 */

import { Bell, Repeat } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { EpgProgram, ItemRef, Recording, Reminder } from '@/api/types';

import { useScheduleIndex } from '../hooks';
import { markFor, type ScheduleIndex } from '../lib/schedule';

export function ScheduleMark({ channelRef, program }: { channelRef: ItemRef | undefined; program: Pick<EpgProgram, 'start'> }) {
  return <ScheduleMarkView index={useScheduleIndex()} channelRef={channelRef} program={program} />;
}

/**
 * The markers for an index the caller holds (L2-perf-ui-1): a guide cell subscribes to nothing,
 * and only a programme that has a mark pays for the labels.
 */
export const ScheduleMarkView = memo(function ScheduleMarkView({
  index,
  channelRef,
  program,
}: {
  index: ScheduleIndex;
  channelRef: ItemRef | undefined;
  program: Pick<EpgProgram, 'start'>;
}) {
  const { reminder, recording } = markFor(index, channelRef, program);
  if (!reminder && !recording) return null;
  return <Marks reminder={reminder} recording={recording} />;
});

function Marks({ reminder, recording }: { reminder: Reminder | undefined; recording: Recording | undefined }) {
  const { t } = useTranslation('live');
  const { t: tg } = useTranslation('guide');
  return (
    <>
      {reminder ? (
        <span className="inline-flex shrink-0" title={t('reminderOn')} data-testid="mark-reminder">
          <Bell className="size-3 text-accent" aria-hidden />
          <span className="sr-only">{t('reminderOn')}</span>
        </span>
      ) : null}
      {recording ? (
        <span
          className="inline-flex shrink-0 items-center"
          title={recording.ruleId ? tg('seriesMark') : recording.status === 'recording' ? t('recordingNow') : t('recordingSet')}
          data-testid="mark-recording"
          data-series={recording.ruleId ? '' : undefined}
        >
          {recording.ruleId ? (
            <Repeat aria-hidden className={`size-3 text-live ${recording.status === 'recording' ? 'motion-safe:animate-pulse' : ''}`} strokeWidth={2.5} />
          ) : (
            <span aria-hidden className={`block size-2 rounded-full bg-live ${recording.status === 'recording' ? 'motion-safe:animate-pulse' : ''}`} />
          )}
          <span className="sr-only">
            {recording.status === 'recording' ? t('recordingNow') : t('recordingSet')}
            {recording.ruleId ? `, ${tg('seriesMark')}` : ''}
          </span>
        </span>
      ) : null}
    </>
  );
}
