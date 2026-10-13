/** Bell and record markers on a guide programme that has a reminder or a recording. */

import { Bell } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { EpgProgram, ItemRef } from '@/api/types';

import { useScheduleIndex } from '../hooks';
import { markFor } from '../lib/schedule';

export function ScheduleMark({ channelRef, program }: { channelRef: ItemRef | undefined; program: Pick<EpgProgram, 'start'> }) {
  const { t } = useTranslation('live');
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
        <span className="inline-flex shrink-0" title={recording.status === 'recording' ? t('recordingNow') : t('recordingSet')} data-testid="mark-recording">
          <span aria-hidden className={`block size-2 rounded-full bg-live ${recording.status === 'recording' ? 'motion-safe:animate-pulse' : ''}`} />
          <span className="sr-only">{recording.status === 'recording' ? t('recordingNow') : t('recordingSet')}</span>
        </span>
      ) : null}
    </>
  );
}
