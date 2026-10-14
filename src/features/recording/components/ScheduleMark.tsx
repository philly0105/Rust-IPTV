/**
 * Bell and record markers on a guide programme that has a reminder or a recording.
 * A recording a series rule made (Run 2 C5) shows a repeat mark instead of the dot.
 */

import { Bell, Repeat } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { EpgProgram, ItemRef } from '@/api/types';

import { useScheduleIndex } from '../hooks';
import { markFor } from '../lib/schedule';

export function ScheduleMark({ channelRef, program }: { channelRef: ItemRef | undefined; program: Pick<EpgProgram, 'start'> }) {
  const { t } = useTranslation('live');
  const { t: tg } = useTranslation('guide');
  const { reminder, recording } = markFor(useScheduleIndex(), channelRef, program);
  if (!reminder && !recording) return null;
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
