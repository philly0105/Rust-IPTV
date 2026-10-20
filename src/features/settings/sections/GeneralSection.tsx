import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isDesktop } from '@/api/transport';
import type { StartupBehavior, WindowStart } from '@/api/types';
import { LANGUAGES, applyLanguage } from '@/i18n';

import { Select, Slider } from '@/ui';
import { intlLocale } from '@/lib/intl';
import { Segmented, SettingsGroup, SettingsRow, SettingsSection, SwitchRow } from '../components';
import { clampRating, type SettingsPatch } from '../lib/patch';
import { DownloadsFolderRow } from './DownloadsFolderRow';
// account:
import { SourceRefreshGroup } from './SourceRefreshGroup';
import { parity, type SectionProps } from './types';

const LANGUAGE_OPTIONS = LANGUAGES.map((l) => ({ value: l.code, label: l.name }));

/**
 * 0..10 slider for the minimum VOD rating. Dragging only moves the local value;
 * it saves when the pointer or key is released, or on blur.
 */
function MinRatingRow({ value, update }: { value: number; update: (patch: SettingsPatch) => Promise<boolean> }) {
  const { t, i18n } = useTranslation('settings');
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = clampRating(draft);
    if (next !== value) void update({ vodMinRating: next });
  };
  const label = draft > 0 ? t('vodMinRatingValue', { value: draft.toLocaleString(intlLocale(i18n.language), { minimumFractionDigits: 1 }) }) : t('vodMinRatingOff');
  return (
    <SettingsRow label={t('vodMinRating')} description={t('vodMinRatingHint')}>
      {({ id, describedBy }) => (
        <div className="flex items-center gap-3">
          <Slider
            id={id}
            min={0}
            max={10}
            step={0.5}
            value={draft}
            aria-describedby={describedBy}
            aria-valuetext={label}
            onValueChange={setDraft}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            className="w-44"
            data-testid="input-vodMinRating"
          />
          <output htmlFor={id} className="w-14 text-end text-body-sm font-medium tabular-nums text-fg" data-testid="vodMinRating-value">
            {draft > 0 ? draft.toLocaleString(intlLocale(i18n.language), { minimumFractionDigits: 1 }) : t('vodMinRatingAny')}
          </output>
        </div>
      )}
    </SettingsRow>
  );
}

export function GeneralSection({ settings, update }: SectionProps) {
  const { t } = useTranslation('settings');
  const extra = parity(settings);

  const setLanguage = (language: string) => {
    void applyLanguage(language);
    void update({ language });
  };

  // SS-8: General keeps the app-wide choices. Poster size and the home screen are in Appearance,
  // the recordings folder in Recording, the image cache and Reset in Backup and storage.
  return (
    <SettingsSection title={t('sectionGeneral')} description={t('sectionGeneralLead')} testId="settings-general">
      <SettingsGroup title={t('startupGroup')}>
        <SettingsRow label={t('language')} description={t('languageHint')}>
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={LANGUAGES.some((l) => l.code === settings.language) ? settings.language : 'en'}
              options={LANGUAGE_OPTIONS}
              onValueChange={setLanguage}
            />
          )}
        </SettingsRow>
        <SettingsRow label={t('startupBehavior')} description={t('startupBehaviorHint')}>
          {({ id }) => (
            <Segmented<StartupBehavior>
              id={id}
              label={t('startupBehavior')}
              value={settings.startupBehavior}
              options={[
                { value: 'first-view', label: t('startupFirstView') },
                { value: 'restore-last-view', label: t('startupRestore') },
              ]}
              onChange={(startupBehavior) => void update({ startupBehavior })}
            />
          )}
        </SettingsRow>
        {/* The desktop window only: a browser tab has no window to size. */}
        {isDesktop && (
          <SettingsRow label={t('windowStart')} description={t('windowStartHint')}>
            {({ id }) => (
              <Segmented<WindowStart>
                id={id}
                label={t('windowStart')}
                value={settings.windowStart ?? 'normal'}
                options={[
                  { value: 'normal', label: t('windowStartNormal') },
                  { value: 'maximized', label: t('windowStartMaximized') },
                  { value: 'fullscreen', label: t('windowStartFullscreen') },
                ]}
                onChange={(windowStart) => void update({ windowStart })}
              />
            )}
          </SettingsRow>
        )}
      </SettingsGroup>

      {/* account: background refresh and subscription warnings. The source cards link here. */}
      <SourceRefreshGroup settings={settings} update={update} />

      <SettingsGroup title={t('catalogGroup')} description={t('catalogGroupHint')}>
        <SwitchRow
          label={t('stripCountryPrefix')}
          description={t('stripCountryPrefixHint')}
          checked={extra.stripCountryPrefix}
          onChange={(stripCountryPrefix) => void update({ stripCountryPrefix })}
          testId="toggle-stripCountryPrefix"
        />
        <SwitchRow
          label={t('englishOnly')}
          description={t('englishOnlyHint')}
          checked={settings.englishOnly === true}
          onChange={(englishOnly) => void update({ englishOnly })}
          testId="toggle-englishOnly"
        />
        <MinRatingRow value={extra.vodMinRating} update={update} />
      </SettingsGroup>

      <SettingsGroup title={t('downloads')} description={t('downloadsHint')}>
        <DownloadsFolderRow custom={Boolean(settings.downloadsDir?.trim())} />
      </SettingsGroup>
    </SettingsSection>
  );
}
