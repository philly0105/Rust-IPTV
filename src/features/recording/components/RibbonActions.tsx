/**
 * Reminder and recording controls in the now/next ribbon header: a bell for
 * the shown programme, and a record menu (this programme, every airing of it
 * as a series rule, or the channel for a fixed time).
 */

import { Bell, BellRing, Circle, Repeat, Square } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { itemKey, type Channel, type EpgProgram } from '@/api/types';
import { IconButton, Menu, type MenuItem } from '@/ui';

import { useRecordingCapabilities, useRuleIndex, useScheduleActions, useScheduleIndex } from '../hooks';
import { canHaveRule, ruleFor } from '../lib/rules';
import { CHANNEL_DURATIONS, markFor, programOptions } from '../lib/schedule';
import { RecordSeriesDialog, RemoveRuleDialog, type SeriesTarget } from './SeriesDialogs';

export interface RibbonActionsProps {
  channel: Channel;
  channelName: string;
  /** The programme the ribbon shows (display time); none without a guide. */
  program?: EpgProgram;
  now: number;
}

export function RibbonActions({ channel, channelName, program, now }: RibbonActionsProps) {
  const { t, i18n } = useTranslation('live');
  const { t: tg } = useTranslation('guide');
  const index = useScheduleIndex();
  const ruleIndex = useRuleIndex();
  const rule = program ? ruleFor(ruleIndex, channel.ref, program.title) : undefined;
  const [seriesTarget, setSeriesTarget] = useState<SeriesTarget | null>(null);
  const [removing, setRemoving] = useState(false);
  const caps = useRecordingCapabilities();
  const actions = useScheduleActions();
  const mark = program ? markFor(index, channel.ref, program) : {};
  const options = program ? programOptions(program, now) : { remind: false, record: false };
  const running = index.recordingChannels.get(itemKey(channel.ref));
  const canRecord = caps.data?.supported === true;
  const target = program ? { ref: channel.ref, channelName, program } : undefined;

  const minutes = (m: number) =>
    m < 60
      ? new Intl.NumberFormat(i18n.language, { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(m)
      : new Intl.NumberFormat(i18n.language, { style: 'unit', unit: 'hour', unitDisplay: 'short' }).format(m / 60);

  const items: MenuItem[] = [];
  const stoppable = mark.recording ?? running;
  if (stoppable) {
    items.push({
      id: 'stop',
      label: stoppable.status === 'recording' ? t('stopRecording') : t('cancelRecording'),
      icon: <Square className="size-4" />,
      onSelect: () => void actions.cancelRecording(stoppable),
    });
  } else if (target && options.record) {
    items.push({
      id: 'programme',
      label: t('recordProgramme', { title: target.program.title }),
      icon: <Circle className="size-4 fill-live text-live" />,
      onSelect: () => void actions.record(target),
    });
  }
  if (rule) {
    items.push({ id: 'series', label: tg('removeRuleFor', { title: rule.title }), icon: <Repeat className="size-4 text-live" />, onSelect: () => setRemoving(true) });
  } else if (target && canRecord && canHaveRule(channel.ref, target.program.title)) {
    const title = target.program.title;
    items.push({ id: 'series', label: tg('recordSeriesOf', { title }), icon: <Repeat className="size-4" />, onSelect: () => setSeriesTarget({ ref: channel.ref, channelName, title }) });
  }
  if (!running) {
    if (items.length > 0) items.push({ id: 'sep', type: 'separator' });
    for (const m of CHANNEL_DURATIONS) {
      items.push({
        id: `for-${m}`,
        label: t('recordChannelFor', { duration: minutes(m) }),
        onSelect: () => void actions.record({ ref: channel.ref, channelName, durationMinutes: m }),
      });
    }
  }

  return (
    <>
      {target && (options.remind || mark.reminder) ? (
        <IconButton
          size="sm"
          label={mark.reminder ? t('reminderOn') : t('remindMe')}
          pressed={!!mark.reminder}
          className={mark.reminder ? 'text-accent' : ''}
          icon={mark.reminder ? <BellRing className="size-4" /> : <Bell className="size-4" />}
          onClick={() => void actions.toggleReminder(target, mark.reminder)}
          data-testid="ribbon-remind"
        />
      ) : null}
      {canRecord || stoppable ? (
        <Menu
          label={t('recordMenu')}
          align="end"
          items={items}
          triggerClassName="inline-flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg active:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent"
          trigger={<Circle className={`size-4 ${running ? 'fill-live text-live motion-safe:animate-pulse' : ''}`} aria-hidden />}
        />
      ) : null}
      <RecordSeriesDialog target={seriesTarget} onClose={() => setSeriesTarget(null)} />
      <RemoveRuleDialog rule={removing ? (rule ?? null) : null} onClose={() => setRemoving(false)} />
    </>
  );
}
