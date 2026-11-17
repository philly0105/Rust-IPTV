import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import type { Settings } from '@/api/types';
import { intlLocale, numberFormat } from '@/lib/intl';
import { Select } from '@/ui';

import { Segmented, SettingsRow, SwitchRow } from '../components';
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

/** `downloadMaxConnections`: 0 is Auto, else 1 to 8. */
const MAX_CONNECTIONS = 8;

/**
 * downloads: the most connections one file opens across all its sources. Auto lets each source's
 * spare connections decide; a number caps it, for a busy home network or a provider that objects.
 */
export function DownloadMaxConnectionsRow({ settings, update }: { settings: Settings; update: (patch: SettingsPatch) => Promise<boolean> }) {
  const { t, i18n } = useTranslation('settings');
  const raw = settings.downloadMaxConnections ?? 0;
  const value = Number.isInteger(raw) && raw >= 0 && raw <= MAX_CONNECTIONS ? raw : 0;
  const nf = numberFormat(intlLocale(i18n.language));
  const options = [
    { value: '0', label: t('downloadMaxConnectionsAuto') },
    ...Array.from({ length: MAX_CONNECTIONS }, (_, i) => ({ value: String(i + 1), label: nf.format(i + 1) })),
  ];
  return (
    <SettingsRow label={t('downloadMaxConnections')} description={t('downloadMaxConnectionsHint')}>
      {({ id, describedBy }) => (
        <Select
          id={id}
          aria-describedby={describedBy}
          className="w-auto"
          value={String(value)}
          options={options}
          onValueChange={(v) => void update({ downloadMaxConnections: Number(v) })}
          data-testid="select-downloadMaxConnections"
        />
      )}
    </SettingsRow>
  );
}

/**
 * downloads: other sources. Mirrors add bytes from identical copies of the same file (checked
 * first, so the file is the one picked). Equivalent copies let a queued download start on another
 * source with a close copy, which can be a different file, so it is off by default and says so.
 */
export function DownloadMirrorRows({ settings, update }: { settings: Settings; update: (patch: SettingsPatch) => Promise<boolean> }) {
  const { t } = useTranslation('settings');
  return (
    <>
      <SwitchRow
        label={t('downloadUseMirrors')}
        description={t('downloadUseMirrorsHint')}
        checked={settings.downloadUseMirrors !== false}
        onChange={(downloadUseMirrors) => void update({ downloadUseMirrors })}
        testId="toggle-downloadUseMirrors"
      />
      <SwitchRow
        label={t('downloadAllowEquivalent')}
        description={
          <>
            {t('downloadAllowEquivalentHint')}
            <span className="mt-1 flex items-start gap-1.5" data-testid="equivalent-warning">
              <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0 text-warning" />
              <span className="min-w-0">{t('downloadAllowEquivalentWarning')}</span>
            </span>
          </>
        }
        checked={settings.downloadAllowEquivalent === true}
        onChange={(downloadAllowEquivalent) => void update({ downloadAllowEquivalent })}
        testId="toggle-downloadAllowEquivalent"
      />
    </>
  );
}
