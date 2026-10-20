import { useTranslation } from 'react-i18next';

import type { Settings } from '@/api/types';

import { Select } from '@/ui';
import { formatUnit } from '../../sources/lib/format';
import { SettingsGroup, SettingsRow } from '../components';
import type { SettingsPatch } from '../lib/patch';

/** account: the choices offered; another stored value (a restored backup) is listed too. */
export const REFRESH_INTERVAL_CHOICES: readonly number[] = [0, 6, 12, 24, 48];
export const EXPIRY_WARN_CHOICES: readonly number[] = [0, 3, 7, 14, 30];

// The source dialogs' auto-refresh hint formats the interval the same way.
export { formatUnit };

/** The fixed choices plus `current` when it is not one of them, in order. */
export function choicesWith(choices: readonly number[], current: number): number[] {
  return choices.includes(current) ? [...choices] : [...choices, current].sort((a, b) => a - b);
}

/**
 * account: how often sources refresh in the background (`sourceRefreshIntervalHours`) and how
 * early a subscription expiry is flagged (`accountExpiryWarnDays`).
 */
export function SourceRefreshGroup({ settings, update }: { settings: Settings; update: (patch: SettingsPatch) => Promise<boolean> }) {
  const { t, i18n } = useTranslation('settings');
  const lang = i18n.language;
  const interval = settings.sourceRefreshIntervalHours;
  const warn = settings.accountExpiryWarnDays;

  const intervalOptions = choicesWith(REFRESH_INTERVAL_CHOICES, interval).map((h) => ({
    value: String(h),
    label: h === 0 ? t('refreshIntervalStartup') : t('refreshIntervalEvery', { interval: formatUnit(h, 'hour', lang) }),
  }));
  const warnOptions = choicesWith(EXPIRY_WARN_CHOICES, warn).map((d) => ({
    value: String(d),
    label: d === 0 ? t('expiryWarnOff') : t('expiryWarnBefore', { days: formatUnit(d, 'day', lang) }),
  }));

  return (
    <SettingsGroup id="sources" title={t('sourceRefreshGroup')} description={t('sourceRefreshGroupHint')}>
      <SettingsRow label={t('refreshInterval')} description={t('refreshIntervalHint')}>
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={String(interval)}
            options={intervalOptions}
            onValueChange={(v) => void update({ sourceRefreshIntervalHours: Number(v) })}
            data-testid="select-sourceRefreshIntervalHours"
          />
        )}
      </SettingsRow>
      <SettingsRow label={t('expiryWarn')} description={t('expiryWarnHint')}>
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={String(warn)}
            options={warnOptions}
            onValueChange={(v) => void update({ accountExpiryWarnDays: Number(v) })}
            data-testid="select-accountExpiryWarnDays"
          />
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}
