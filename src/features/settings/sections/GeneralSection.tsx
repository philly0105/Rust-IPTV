import { useTranslation } from 'react-i18next';

import type { CoverSize, DashboardRails, StartupBehavior } from '@/api/types';
import { LANGUAGES, applyLanguage } from '@/i18n';

import { Select } from '../../sources/_shim';
import { Segmented, SettingsGroup, SettingsRow, SettingsSection, SwitchRow } from '../components';
import { railsPatch } from '../lib/patch';
import { DownloadsFolderRow } from './DownloadsFolderRow';
import type { SectionProps } from './types';

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

export function GeneralSection({ settings, update }: SectionProps) {
  const { t } = useTranslation('settings');

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
              onChange={setLanguage}
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
      </SettingsGroup>

      <SettingsGroup title={t('downloads')} description={t('downloadsHint')}>
        <DownloadsFolderRow custom={Boolean(settings.downloadsDir?.trim())} />
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
