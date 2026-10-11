import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CoverSize, DashboardRails, StartupBehavior } from '@/api/types';
import { LANGUAGES, applyLanguage } from '@/i18n';

import { Select } from '@/ui';
import { Segmented, SettingsGroup, SettingsRow, SettingsSection, SwitchRow } from '../components';
import { clampRating, railsPatch, type SettingsPatch } from '../lib/patch';
import { DownloadsFolderRow } from './DownloadsFolderRow';
import { RecordingsFolderRow } from './RecordingsFolderRow';
import { parity, type SectionProps } from './types';

const RAILS: (keyof DashboardRails)[] = [
  'hero',
  'continueWatching',
  'liveFavorites',
  'recentlyWatchedLive',
  'favoriteMoviesAndSeries',
  'recentSources',
  'recentlyAdded',
  'tmdbTrending',
];

const RAIL_KEY: Record<keyof DashboardRails, string> = {
  hero: 'railHero',
  continueWatching: 'railContinueWatching',
  liveFavorites: 'railLiveFavorites',
  recentlyWatchedLive: 'railRecentlyWatchedLive',
  favoriteMoviesAndSeries: 'railFavoriteMoviesAndSeries',
  recentSources: 'railRecentSources',
  recentlyAdded: 'railRecentlyAdded',
  tmdbTrending: 'railTmdbTrending',
};

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
  const label = draft > 0 ? t('vodMinRatingValue', { value: draft.toLocaleString(i18n.language, { minimumFractionDigits: 1 }) }) : t('vodMinRatingOff');
  return (
    <SettingsRow label={t('vodMinRating')} description={t('vodMinRatingHint')}>
      {({ id, describedBy }) => (
        <div className="flex items-center gap-3">
          <input
            id={id}
            type="range"
            min={0}
            max={10}
            step={0.5}
            value={draft}
            aria-describedby={describedBy}
            aria-valuetext={label}
            onChange={(e) => setDraft(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            className="w-44 accent-[var(--color-accent)]"
            data-testid="input-vodMinRating"
          />
          <output htmlFor={id} className="w-14 text-right text-sm tabular-nums text-fg" data-testid="vodMinRating-value">
            {draft > 0 ? draft.toLocaleString(i18n.language, { minimumFractionDigits: 1 }) : t('vodMinRatingAny')}
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

  return (
    <SettingsSection title={t('sectionGeneral')} description={t('sectionGeneralLead')} testId="settings-general">
      <SettingsGroup>
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
        <SettingsRow label={t('coverSize')} description={t('coverSizeHint')}>
          {({ id }) => (
            <Segmented<CoverSize>
              id={id}
              label={t('coverSize')}
              value={settings.coverSize}
              options={[
                { value: 'small', label: t('coverSmall') },
                { value: 'medium', label: t('coverMedium') },
                { value: 'large', label: t('coverLarge') },
              ]}
              onChange={(coverSize) => void update({ coverSize })}
            />
          )}
        </SettingsRow>
        <SwitchRow
          label={t('stripCountryPrefix')}
          description={t('stripCountryPrefixHint')}
          checked={extra.stripCountryPrefix}
          onChange={(stripCountryPrefix) => void update({ stripCountryPrefix })}
          testId="toggle-stripCountryPrefix"
        />
      </SettingsGroup>

      <SettingsGroup title={t('vodGroup')} description={t('vodGroupHint')}>
        <MinRatingRow value={extra.vodMinRating} update={update} />
      </SettingsGroup>

      <SettingsGroup title={t('downloads')} description={t('downloadsHint')}>
        <DownloadsFolderRow custom={Boolean(settings.downloadsDir?.trim())} />
        <RecordingsFolderRow value={extra.recordingsDir} update={update} />
      </SettingsGroup>

      <SettingsGroup title={t('dashboard')} description={t('dashboardHint')}>
        <SwitchRow
          label={t('showDashboard')}
          description={t('showDashboardHint')}
          checked={settings.showDashboard}
          onChange={(showDashboard) => void update({ showDashboard })}
          testId="toggle-showDashboard"
        />
        {RAILS.map((rail) => (
          <SwitchRow
            key={rail}
            label={t(RAIL_KEY[rail])}
            checked={settings.dashboardRails[rail]}
            disabled={!settings.showDashboard}
            onChange={(v) => void update(railsPatch(settings, rail, v))}
            testId={`toggle-rail-${rail}`}
          />
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}
