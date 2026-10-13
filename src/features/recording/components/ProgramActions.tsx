/**
 * "Remind me" and "Record" for one guide programme (K6). Rendered inside the
 * programme dialog's action row; each button toggles off the same way.
 */

import { Bell, BellOff, Circle, Square } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { EpgProgram, ItemRef } from '@/api/types';
import { Button } from '@/ui';

import { useRecordingCapabilities, useRemindersEnabled, useScheduleActions, useScheduleIndex } from '../hooks';
import { markFor, programOptions } from '../lib/schedule';

export interface ProgramActionsProps {
  channelRef: ItemRef;
  /** The name the guide shows for the channel. */
  channelName: string;
  /** Display-time programme. */
  program: EpgProgram;
  now: number;
}

export function ProgramActions({ channelRef, channelName, program, now }: ProgramActionsProps) {
  const { t } = useTranslation('live');
  const index = useScheduleIndex();
  const caps = useRecordingCapabilities();
  const remindersOn = useRemindersEnabled();
  const actions = useScheduleActions();
  const [busy, setBusy] = useState<'remind' | 'record' | null>(null);
  const { reminder, recording } = markFor(index, channelRef, program);
  const options = programOptions(program, now);
  const target = { ref: channelRef, channelName, program };
  const canRecord = caps.data?.supported === true;

  const run = async (which: 'remind' | 'record', work: () => Promise<unknown>) => {
    setBusy(which);
    try {
      await work();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {options.remind || reminder ? (
        <Button
          size="sm"
          variant={reminder ? 'secondary' : 'ghost'}
          aria-pressed={!!reminder}
          loading={busy === 'remind'}
          icon={reminder ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
          onClick={() => void run('remind', () => actions.toggleReminder(target, reminder))}
          data-testid="program-remind"
        >
          {reminder ? t('reminderOn') : t('remindMe')}
        </Button>
      ) : null}
      {(options.record && canRecord) || recording ? (
        <Button
          size="sm"
          variant={recording ? 'secondary' : 'ghost'}
          aria-pressed={!!recording}
          loading={busy === 'record'}
          icon={recording ? <Square className="size-3.5" /> : <Circle className="size-3.5 fill-live text-live" />}
          onClick={() => void run('record', () => (recording ? actions.cancelRecording(recording) : actions.record(target)))}
          data-testid="program-record"
        >
          {recording ? (recording.status === 'recording' ? t('stopRecording') : t('cancelRecording')) : t('record')}
        </Button>
      ) : null}
      {reminder && !remindersOn ? <p className="w-full text-xs text-fg-subtle">{t('remindersOffHint')}</p> : null}
      {options.record && caps.data && !caps.data.supported && !recording ? (
        <p className="w-full text-xs text-fg-subtle" data-testid="record-unavailable">
          {t('recordUnavailable')}
        </p>
      ) : null}
    </>
  );
}
