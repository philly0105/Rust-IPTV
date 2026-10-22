import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import type { Settings } from '@/api/types';

import { Segmented, SettingsRow } from '../components';
import type { SettingsPatch } from '../lib/patch';

type Connections = 'one' | 'auto';

/**
 * downloads: "Connections per download" for each source. `settings.downloadSingleConnection`
 * lists the sources set to 1; every other source is Auto, which downloads one file over the
 * connections its account has spare and goes back to one while something plays from it.
 */
export function DownloadConnectionsRows({ settings, update }: { settings: Settings; update: (patch: SettingsPatch) => Promise<boolean> }) {
  const { t } = useTranslation('settings');
  const sources = useRpcQuery('sources.list', undefined, { staleTime: 60_000 });
  const single = settings.downloadSingleConnection ?? [];
  const options = [
    { value: 'one' as const, label: t('downloadConnectionsOne') },
    { value: 'auto' as const, label: t('downloadConnectionsAuto') },
  ];
  const choose = (sourceId: string, value: Connections) => {
    const rest = single.filter((id) => id !== sourceId);
    void update({ downloadSingleConnection: value === 'one' ? [...rest, sourceId] : rest });
  };
  return (
    <>
      {(sources.data ?? []).map((s, i) => (
        <SettingsRow key={s.id} label={t('downloadConnectionsFor', { name: s.name })} description={i === 0 ? t('downloadConnectionsHint') : undefined}>
          {({ id }) => (
            <Segmented<Connections>
              id={id}
              label={t('downloadConnectionsFor', { name: s.name })}
              value={single.includes(s.id) ? 'one' : 'auto'}
              options={options}
              onChange={(v) => choose(s.id, v)}
            />
          )}
        </SettingsRow>
      ))}
    </>
  );
}
