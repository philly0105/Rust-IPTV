/**
 * "Remind me", "Record" and "Record series" for one guide programme (K6, Run 2 C5).
 * Rendered inside the programme dialog's action row and each guide search hit;
 * each button toggles off the same way.
 */

import type { TFunction } from 'i18next';
import { Bell, BellOff, Circle, Repeat, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { EpgProgram, ItemRef, RecordingRule } from '@/api/types';
import { Button, IconButton } from '@/ui';

import { useCancelPending, useRecordingCapabilities, useRemindersEnabled, useRuleIndex, useScheduleActions, useScheduleIndex } from '../hooks';
import { canHaveRule, ruleFor, type RuleKey } from '../lib/rules';
import { markFor, programOptions, type ScheduleIndex } from '../lib/schedule';
import { RecordSeriesDialog, RemoveRuleDialog, type SeriesTarget } from './SeriesDialogs';
import { StopRecordingDialog } from './StopRecordingDialog';

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

/**
 * What every action row reads: the schedule and rule indexes, recording support, the reminders
 * setting, the actions and the labels. A list of programmes (guide search hits) reads it once
 * and hands it to each {@link ProgramActionsView} (L2-perf-ui-2).
 */
export interface ProgramActionsShared {
  index: ScheduleIndex;
  rules: ReadonlyMap<RuleKey, RecordingRule>;
  /** Recording support: undefined until the capabilities answer. */
  canRecord: boolean | undefined;
  remindersOn: boolean;
  actions: ReturnType<typeof useScheduleActions>;
  t: TFunction<'live'>;
  tg: TFunction<'guide'>;
}

export function useProgramActionsShared(): ProgramActionsShared {
  const { t } = useTranslation('live');
  const { t: tg } = useTranslation('guide');
  const index = useScheduleIndex();
  const rules = useRuleIndex();
  const caps = useRecordingCapabilities();
  const remindersOn = useRemindersEnabled();
  const actions = useScheduleActions();
  const canRecord = caps.data?.supported;
  return useMemo(() => ({ index, rules, canRecord, remindersOn, actions, t, tg }), [index, rules, canRecord, remindersOn, actions, t, tg]);
}

export function ProgramActions(props: ProgramActionsProps) {
  return <ProgramActionsView {...props} shared={useProgramActionsShared()} />;
}

export function ProgramActionsView({ channelRef, channelName, program, now, variant = 'buttons', shared }: ProgramActionsProps & { shared: ProgramActionsShared }) {
  const { index, rules, actions, remindersOn, t, tg } = shared;
  const rule = ruleFor(rules, channelRef, program.title);
  const [seriesTarget, setSeriesTarget] = useState<SeriesTarget | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState<'remind' | 'record' | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  // The dialogs mount on first use and stay for their closing animation: a row that never opens
  // one (most guide search hits) mounts none (L2-perf-ui-2).
  const [dialogsUsed, setDialogsUsed] = useState(false);
  const { reminder, recording } = markFor(index, channelRef, program);
  const stopping = useCancelPending(recording?.id);
  const recordBusy = busy === 'record' || stopping;
  const options = programOptions(program, now);
  const target = { ref: channelRef, channelName, program };
  const canRecord = shared.canRecord === true;

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
  // Stopping a recording that is writing now cannot be undone: it asks first.
  const toggleRecord = () => {
    if (recording?.status !== 'recording') return void run('record', () => (recording ? actions.cancelRecording(recording) : actions.record(target)));
    setDialogsUsed(true);
    setConfirmStop(true);
  };
  const toggleSeries = () => {
    setDialogsUsed(true);
    if (rule) setRemoving(true);
    else setSeriesTarget({ ref: channelRef, channelName, title: program.title });
  };
  const dialogs = dialogsUsed ? (
    <>
      <RecordSeriesDialog target={seriesTarget} onClose={() => setSeriesTarget(null)} />
      <RemoveRuleDialog rule={removing ? (rule ?? null) : null} onClose={() => setRemoving(false)} />
      <StopRecordingDialog recording={confirmStop && recording?.status === 'recording' ? recording : null} onClose={() => setConfirmStop(false)} />
    </>
  ) : null;

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
            disabled={recordBusy}
            aria-busy={recordBusy || undefined}
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
          loading={recordBusy}
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
      {options.record && shared.canRecord === false && !recording ? (
        <p className="w-full text-xs text-fg-subtle" data-testid="record-unavailable">
          {t('recordUnavailable')}
        </p>
      ) : null}
    </>
  );
}
