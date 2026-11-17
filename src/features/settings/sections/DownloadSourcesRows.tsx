import { RotateCcw } from 'lucide-react';
import { useEffect } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { invalidate, useRpcMutation, useRpcQuery } from '@/api/query';
import type { Settings, SourceConnectionLimit } from '@/api/types';
import { dateTimeFormat, intlLocale } from '@/lib/intl';
import { Button, Switch } from '@/ui';

import { SettingsGroup, SettingsNote, SettingsRow } from '../components';
import type { SettingsPatch } from '../lib/patch';

/** Only these sources' accounts report a connection limit, so only they are ever tested. */
const PROBED_KINDS = new Set(['xtream', 'stalker']);

/** While a test runs, the list is read again this often, so its result shows without a reload. */
export const PROBING_REFRESH_MS = 5_000;

interface StatusInput {
  limit: SourceConnectionLimit | undefined;
  off: boolean;
  single: boolean;
  lang: string;
}

/**
 * What the app knows about a source's limit, in one line: the account's figure, then what a test
 * found and when, or why there is no test.
 */
export function probeStatus(t: TFunction<'settings'>, { limit, off, single, lang }: StatusInput): string {
  if (single) return t('downloadProbeSingle');
  const parts: string[] = [];
  if (limit?.reported !== undefined) parts.push(t('downloadProbeReported', { count: limit.reported }));
  if (off) {
    parts.push(t('downloadProbeOff'));
  } else if (limit?.probing) {
    parts.push(t('downloadProbeRunning'));
  } else if (limit?.mode === 'accept' && limit.learned !== undefined) {
    parts.push(t('downloadProbeLearnedAccept', { count: limit.learned }));
  } else if (limit?.mode === 'refuse') {
    parts.push(t('downloadProbeLearnedRefuse'));
  } else if (limit?.mode === 'kickOldest') {
    parts.push(t('downloadProbeLearnedKick'));
  } else {
    parts.push(t('downloadProbeNever'));
  }
  const at = limit?.probedAt ? Date.parse(limit.probedAt) : NaN;
  if (!off && !limit?.probing && limit?.mode && !Number.isNaN(at)) {
    parts.push(t('downloadProbeTestedAt', { date: dateTimeFormat(intlLocale(lang), { month: 'short', day: 'numeric' }).format(at) }));
  }
  return parts.join(' · ');
}

/**
 * downloads: per Xtream or Stalker source, whether a large download may test for more connections
 * than the account reports, what the last test found, and Test again (which forgets it, so the
 * next eligible download tests anew). A source with speed-up Off never splits, so it never tests.
 */
export function DownloadSourcesRows({ settings, update }: { settings: Settings; update: (patch: SettingsPatch) => Promise<boolean> }) {
  const { t, i18n } = useTranslation('settings');
  const sources = useRpcQuery('sources.list', undefined, { staleTime: 60_000 });
  const probed = (sources.data ?? []).filter((s) => PROBED_KINDS.has(s.kind));
  const limits = useRpcQuery('downloads.connectionLimits', undefined, { enabled: probed.length > 0 });
  const reset = useRpcMutation('downloads.resetConnectionLimit', { invalidate: ['downloads.connectionLimits'] });
  const probing = limits.data?.some((l) => l.probing) ?? false;

  useEffect(() => {
    if (!probing) return;
    const timer = setInterval(() => void invalidate('downloads.connectionLimits'), PROBING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [probing]);

  if (probed.length === 0) return null;
  const disabled = settings.downloadProbeDisabled ?? [];
  const single = settings.downloadSingleConnection ?? [];
  const byId = new Map((limits.data ?? []).map((l) => [l.sourceId, l]));
  const toggle = (sourceId: string, on: boolean) => {
    const rest = disabled.filter((id) => id !== sourceId);
    void update({ downloadProbeDisabled: on ? rest : [...rest, sourceId] });
  };

  return (
    <SettingsGroup title={t('downloadProbeGroup')} description={t('downloadProbeHint')}>
      {probed.map((s) => {
        const off = disabled.includes(s.id);
        const one = single.includes(s.id);
        const limit = byId.get(s.id);
        const tested = limit?.mode !== undefined || limit?.learned !== undefined || limit?.probedAt !== undefined;
        const resetting = reset.isPending && reset.variables?.sourceId === s.id;
        return (
          <SettingsRow key={s.id} label={t('downloadProbeFor', { name: s.name })} description={probeStatus(t, { limit, off, single: one, lang: i18n.language })} dimmed={one}>
            {({ id, describedBy }) => (
              <div className="flex items-center gap-3" data-testid={`probe-row-${s.id}`}>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RotateCcw size={14} aria-hidden />}
                  aria-label={t('downloadProbeTestAgainAria', { name: s.name })}
                  disabled={one || off || !tested || limit?.probing === true || reset.isPending}
                  loading={resetting}
                  onClick={() => reset.mutate({ sourceId: s.id })}
                  data-testid={`probe-reset-${s.id}`}
                >
                  {t('downloadProbeTestAgain')}
                </Button>
                <Switch
                  id={id}
                  checked={!off}
                  onCheckedChange={(on) => toggle(s.id, on)}
                  aria-describedby={describedBy}
                  disabled={one}
                  data-testid={`toggle-probe-${s.id}`}
                />
              </div>
            )}
          </SettingsRow>
        );
      })}
      {limits.isError && <SettingsNote testId="probe-load-error">{t('downloadProbeLoadError')}</SettingsNote>}
    </SettingsGroup>
  );
}
