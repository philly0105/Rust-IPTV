/** Settings > Recording: where recordings go, recording padding and guide reminders. */

import { useTranslation } from 'react-i18next';

import type { ReminderAction } from '@/api/types';
import { Select, type SelectOption } from '@/ui';
import { intlLocale } from '@/lib/intl';

import { Segmented, SettingsGroup, SettingsRow, SettingsSection, SwitchRow } from '../components';
import { RecordingsFolderRow } from './RecordingsFolderRow';
import { parity, type SectionProps } from './types';

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
    <SettingsSection title={t('sectionRecording')} testId="settings-recording">
      {/* SS-8: the folder sits with the rest of recording, where people look for it. The padding is
          one row with its two minutes side by side, not two label-only rows. */}
      <SettingsGroup title={t('recordingsGroup')}>
        <RecordingsFolderRow value={parity(settings).recordingsDir} update={update} />
        <SettingsRow label={t('recordingPaddingGroup')} description={t('recordingPaddingHint')}>
          {({ id, describedBy }) => (
            // Each select is named by the row and its own short label: "Recording padding, Before".
            // Phone width: a two-column grid, so both selects line up under their labels.
            <div className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 @md:flex @md:w-auto @md:flex-wrap @md:gap-x-4">
              <span id={`${id}-label`} className="sr-only">
                {t('recordingPaddingGroup')}
              </span>
              <span className="contents @md:flex @md:items-center @md:gap-2">
                <label id={`${id}-before`} htmlFor={id} className="text-body-sm text-fg-muted">
                  {t('recordingPaddingBeforeShort')}
                </label>
                <Select
                  id={id}
                  aria-labelledby={`${id}-label ${id}-before`}
                  aria-describedby={describedBy}
                  value={String(before)}
                  options={options(PADDING_BEFORE_CHOICES, before)}
                  onValueChange={(v) => void update({ recordingPaddingBeforeMinutes: Number(v) })}
                  data-testid="recording-padding-before"
                />
              </span>
              <span className="contents @md:flex @md:items-center @md:gap-2">
                <label id={`${id}-after`} htmlFor={`${id}-a`} className="text-body-sm text-fg-muted">
                  {t('recordingPaddingAfterShort')}
                </label>
                <Select
                  id={`${id}-a`}
                  aria-labelledby={`${id}-label ${id}-after`}
                  aria-describedby={describedBy}
                  value={String(after)}
                  options={options(PADDING_AFTER_CHOICES, after)}
                  onValueChange={(v) => void update({ recordingPaddingAfterMinutes: Number(v) })}
                  data-testid="recording-padding-after"
                />
              </span>
            </div>
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
