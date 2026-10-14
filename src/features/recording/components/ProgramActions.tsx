/**
 * "Remind me", "Record" and "Record series" for one guide programme (K6, Run 2 C5).
 * Rendered inside the programme dialog's action row and each guide search hit;
 * each button toggles off the same way.
 */

import { Bell, BellOff, Circle, Repeat, Square } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { EpgProgram, ItemRef } from '@/api/types';
import { Button, IconButton } from '@/ui';

import { useRecordingCapabilities, useRemindersEnabled, useRuleIndex, useScheduleActions, useScheduleIndex } from '../hooks';
import { canHaveRule, ruleFor } from '../lib/rules';
import { markFor, programOptions } from '../lib/schedule';
import { RecordSeriesDialog, RemoveRuleDialog, type SeriesTarget } from './SeriesDialogs';

export interface ProgramActionsProps {
  channelRef: ItemRef;
  /** The name the guide shows for the channel. */
  channelName: string;
  /** Display-time programme. */
  program: EpgProgram;
  now: number;
  /** `icons`: compact icon buttons without the hint lines (guide search hits). */
  variant?: 'buttons' | 'icons';
}

export function ProgramActions({ channelRef, channelName, program, now, variant = 'buttons' }: ProgramActionsProps) {
  const { t } = useTranslation('live');
  const { t: tg } = useTranslation('guide');
  const index = useScheduleIndex();
  const rules = useRuleIndex();
  const rule = ruleFor(rules, channelRef, program.title);
  const [seriesTarget, setSeriesTarget] = useState<SeriesTarget | null>(null);
  const [removing, setRemoving] = useState(false);
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

  const remindLabel = reminder ? t('reminderOn') : t('remindMe');
  const recordLabel = recording ? (recording.status === 'recording' ? t('stopRecording') : t('cancelRecording')) : t('record');
  const seriesLabel = rule ? (rule.enabled ? tg('seriesOn') : tg('seriesPaused')) : tg('recordSeries');
  const showRemind = options.remind || !!reminder;
  const showRecord = (options.record && canRecord) || !!recording;
  const showSeries = (canRecord && canHaveRule(channelRef, program.title)) || !!rule;
  const toggleRemind = () => void run('remind', () => actions.toggleReminder(target, reminder));
  const toggleRecord = () => void run('record', () => (recording ? actions.cancelRecording(recording) : actions.record(target)));
  const toggleSeries = () => (rule ? setRemoving(true) : setSeriesTarget({ ref: channelRef, channelName, title: program.title }));
  const dialogs = (
    <>
      <RecordSeriesDialog target={seriesTarget} onClose={() => setSeriesTarget(null)} />
      <RemoveRuleDialog rule={removing ? (rule ?? null) : null} onClose={() => setRemoving(false)} />
    </>
  );

  if (variant === 'icons') {
    return (
      <>
        {showRemind ? (
          <IconButton
            size="sm"
            label={remindLabel}
            pressed={!!reminder}
            disabled={busy === 'remind'}
            className={reminder ? 'text-accent' : ''}
            icon={reminder ? <BellOff className="size-4" /> : <Bell className="size-4" />}
            onClick={toggleRemind}
            data-testid="program-remind"
          />
        ) : null}
        {showRecord ? (
          <IconButton
            size="sm"
            label={recordLabel}
            pressed={!!recording}
            disabled={busy === 'record'}
            icon={recording ? <Square className="size-4" /> : <Circle className="size-4 fill-live text-live" />}
            onClick={toggleRecord}
            data-testid="program-record"
          />
        ) : null}
        {showSeries ? (
          <IconButton
            size="sm"
            label={seriesLabel}
            pressed={!!rule}
            icon={<Repeat className={`size-4 ${rule ? 'text-live' : ''}`} />}
            onClick={toggleSeries}
            data-testid="program-record-series"
          />
        ) : null}
        {dialogs}
      </>
    );
  }

  return (
    <>
      {showRemind ? (
        <Button
          size="sm"
          variant={reminder ? 'secondary' : 'ghost'}
          aria-pressed={!!reminder}
          loading={busy === 'remind'}
          icon={reminder ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
          onClick={toggleRemind}
          data-testid="program-remind"
        >
          {remindLabel}
        </Button>
      ) : null}
      {showRecord ? (
        <Button
          size="sm"
          variant={recording ? 'secondary' : 'ghost'}
          aria-pressed={!!recording}
          loading={busy === 'record'}
          icon={recording ? <Square className="size-3.5" /> : <Circle className="size-3.5 fill-live text-live" />}
          onClick={toggleRecord}
          data-testid="program-record"
        >
          {recordLabel}
        </Button>
      ) : null}
      {showSeries ? (
        <Button
          size="sm"
          variant={rule ? 'secondary' : 'ghost'}
          aria-pressed={!!rule}
          icon={<Repeat className={`size-3.5 ${rule ? 'text-live' : ''}`} />}
          onClick={toggleSeries}
          data-testid="program-record-series"
        >
          {seriesLabel}
        </Button>
      ) : null}
      {dialogs}
      {reminder && !remindersOn ? <p className="w-full text-xs text-fg-subtle">{t('remindersOffHint')}</p> : null}
      {options.record && caps.data && !caps.data.supported && !recording ? (
        <p className="w-full text-xs text-fg-subtle" data-testid="record-unavailable">
          {t('recordUnavailable')}
        </p>
      ) : null}
    </>
  );
}
