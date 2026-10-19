/** Settings > Recording: recording padding and guide reminders. */

import { useTranslation } from 'react-i18next';

import type { ReminderAction } from '@/api/types';
import { Select, type SelectOption } from '@/ui';
import { intlLocale } from '@/lib/intl';

import { Segmented, SettingsGroup, SettingsRow, SettingsSection, SwitchRow } from '../components';
import type { SectionProps } from './types';

export const PADDING_BEFORE_CHOICES = [0, 1, 2, 3, 5, 10, 15] as const;
export const PADDING_AFTER_CHOICES = [0, 1, 2, 5, 10, 15, 20, 30] as const;
export const LEAD_CHOICES = [0, 1, 2, 5, 10, 15, 30] as const;

/** The choices, plus the saved value when it is not one of them (set by a backup or an older build). */
export function minuteChoices(choices: readonly number[], current: number): number[] {
  return choices.includes(current) ? [...choices] : [...choices, current].sort((a, b) => a - b);
}

export function RecordingSection({ settings, update }: SectionProps) {
  const { t, i18n } = useTranslation('settings');
  const minutes = (n: number) => new Intl.NumberFormat(intlLocale(i18n.language), { style: 'unit', unit: 'minute', unitDisplay: 'long' }).format(n);
  const options = (choices: readonly number[], current: number): SelectOption[] =>
    minuteChoices(choices, current).map((n) => ({ value: String(n), label: minutes(n) }));
  const before = settings.recordingPaddingBeforeMinutes;
  const after = settings.recordingPaddingAfterMinutes;
  const lead = settings.reminderLeadMinutes;
  const enabled = settings.remindersEnabled;
  const action: ReminderAction = settings.reminderAction;

  return (
    <SettingsSection title={t('sectionRecording')} description={t('recordingSectionHint')} testId="settings-recording">
      <SettingsGroup title={t('recordingPaddingGroup')} description={t('recordingPaddingHint')}>
        <SettingsRow label={t('recordingPaddingBefore')}>
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={String(before)}
              options={options(PADDING_BEFORE_CHOICES, before)}
              onValueChange={(v) => void update({ recordingPaddingBeforeMinutes: Number(v) })}
              data-testid="recording-padding-before"
            />
          )}
        </SettingsRow>
        <SettingsRow label={t('recordingPaddingAfter')}>
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={String(after)}
              options={options(PADDING_AFTER_CHOICES, after)}
              onValueChange={(v) => void update({ recordingPaddingAfterMinutes: Number(v) })}
              data-testid="recording-padding-after"
            />
          )}
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t('remindersGroup')}>
        <SwitchRow
          label={t('remindersEnabled')}
          description={t('remindersEnabledHint')}
          checked={enabled}
          onChange={(v) => void update({ remindersEnabled: v })}
          testId="reminders-enabled"
        />
        <SettingsRow label={t('reminderLead')} description={t('reminderLeadHint')}>
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              disabled={!enabled}
              value={String(lead)}
              options={options(LEAD_CHOICES, lead)}
              onValueChange={(v) => void update({ reminderLeadMinutes: Number(v) })}
              data-testid="reminder-lead"
            />
          )}
        </SettingsRow>
        <SettingsRow label={t('reminderAction')} description={action === 'switch' ? t('reminderActionSwitchHint') : t('reminderActionNotifyHint')}>
          {({ id }) => (
            <Segmented<ReminderAction>
              id={id}
              label={t('reminderAction')}
              value={action}
              options={[
                { value: 'notify', label: t('reminderActionNotify') },
                { value: 'switch', label: t('reminderActionSwitch') },
              ]}
              onChange={(v) => void update({ reminderAction: v })}
            />
          )}
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
