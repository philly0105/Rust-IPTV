import { CircleAlert, CircleCheck, PlugZap, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate } from '@/api/query';
import { rpc } from '@/api/transport';

import { Button, Select, useToast, errorDescription } from '@/ui';
import { SecretInput } from '../../sources/components/SecretInput';
import { SettingsGroup, SettingsNote, SettingsRow, SettingsSection, SwitchRow } from '../components';
import { TMDB_LANGUAGES } from '../lib/languages';
import { tmdbPatch } from '../lib/patch';
import type { SectionProps } from './types';

type TestState = { status: 'idle' } | { status: 'running' } | { status: 'done'; ok: boolean; message?: string; error?: unknown };

export function MetadataSection({ settings, update }: SectionProps) {
  const { t } = useTranslation('settings');
  const { toast } = useToast();
  const saved = settings.tmdb.apiKey ?? '';
  const [key, setKey] = useState(saved);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [clearing, setClearing] = useState(false);
  useEffect(() => setKey(saved), [saved]);

  const commitKey = async () => {
    const v = key.trim();
    if (v === saved) return;
    if (v && !/^[A-Za-z0-9._-]{16,}$/.test(v)) {
      setKeyError('errorTmdbKey');
      return;
    }
    setKeyError(null);
    if (await update(tmdbPatch(settings, { apiKey: v }))) void invalidate('tmdb.');
  };

  // SS-18: the result leads with a translated sentence; TMDB's or the core's own words (English)
  // follow in small type, for anyone who needs them.
  const runTest = async () => {
    setTest({ status: 'running' });
    try {
      const r = await rpc('tmdb.testKey', { apiKey: key.trim() });
      setTest({ status: 'done', ok: r.ok, message: r.ok ? undefined : r.message });
    } catch (e) {
      setTest({ status: 'done', ok: false, error: e });
    }
  };

  const clearCache = async () => {
    setClearing(true);
    try {
      await rpc('tmdb.clearCache');
      await invalidate('tmdb.');
      toast({ variant: 'success', title: t('tmdbCacheCleared') });
    } catch (e) {
      toast({ variant: 'error', title: t('tmdbCacheClearFailed'), description: errorDescription(e) });
    } finally {
      setClearing(false);
    }
  };

  const enabled = settings.tmdb.enabled;
  const languageOptions = TMDB_LANGUAGES.map((l) => (l.value === '' ? { value: '', label: t('tmdbLanguageAuto') } : l));

  return (
    <SettingsSection title={t('sectionMetadata')} description={t('sectionMetadataLead')} testId="settings-metadata">
      <SettingsGroup>
        <SwitchRow
          label={t('tmdbEnabled')}
          description={t('tmdbEnabledHint')}
          checked={enabled}
          onChange={(v) => void update(tmdbPatch(settings, { enabled: v })).then((ok) => (ok ? invalidate('tmdb.') : undefined))}
          testId="toggle-tmdb"
        />
        {/* SS-9: while TMDB is off, say what turning it on opens, and dim the rows it governs. */}
        {enabled ? null : <SettingsNote testId="tmdb-off-note">{t('tmdbOffNote')}</SettingsNote>}
        <SettingsRow label={t('tmdbApiKey')} description={t('tmdbApiKeyHint')} error={keyError ? t(keyError) : null} stack dimmed={!enabled}>
          {({ id, describedBy }) => (
            <div className="flex w-full flex-col gap-3">
              <div className="flex items-center gap-2">
                {/* The kit's secret field, as the source dialogs use for passwords (SS-9). */}
                <SecretInput
                  id={id}
                  value={key}
                  disabled={!enabled}
                  aria-describedby={describedBy}
                  aria-invalid={keyError ? true : undefined}
                  placeholder={t('tmdbApiKeyPlaceholder')}
                  showLabel={t('showKey')}
                  hideLabel={t('hideKey')}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setTest({ status: 'idle' });
                    if (keyError) setKeyError(null);
                  }}
                  onBlur={() => void commitKey()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitKey();
                    }
                  }}
                  className="font-mono placeholder:font-sans"
                  wrapperClassName="min-w-0 flex-1"
                  data-testid="input-tmdb-key"
                />
                <Button
                  size="md"
                  variant="secondary"
                  icon={<PlugZap aria-hidden className="size-4" />}
                  loading={test.status === 'running'}
                  disabled={!enabled}
                  onClick={() => void runTest()}
                  data-testid="tmdb-test"
                >
                  {t('tmdbTest')}
                </Button>
              </div>
              {test.status === 'done' ? (
                <div aria-live="polite" className="flex items-start gap-1.5 text-body-sm" data-testid="tmdb-test-result">
                  {test.ok ? <CircleCheck aria-hidden size={16} className="mt-0.5 shrink-0 text-success" /> : <CircleAlert aria-hidden size={16} className="mt-0.5 shrink-0 text-danger" />}
                  <div className="min-w-0">
                    {test.ok ? (
                      <p className="text-success">{t('tmdbTestOk')}</p>
                    ) : test.error !== undefined ? (
                      // A failed request (offline, TMDB down): the hint for its code, then its own text.
                      <p className="text-danger">{errorDescription(test.error)}</p>
                    ) : (
                      <>
                        <p className="text-danger">{t('tmdbTestFailed')}</p>
                        {test.message ? (
                          <p className="text-caption break-words text-fg-subtle" dir="auto" data-error-message="">
                            {test.message}
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </SettingsRow>
        <SettingsRow label={t('tmdbLanguage')} description={t('tmdbLanguageHint')} dimmed={!enabled}>
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              disabled={!enabled}
              value={settings.tmdb.language ?? ''}
              options={languageOptions}
              onValueChange={(language) => void update(tmdbPatch(settings, { language })).then((ok) => (ok ? invalidate('tmdb.') : undefined))}
            />
          )}
        </SettingsRow>
        <SettingsRow label={t('tmdbCache')} description={t('tmdbCacheHint')}>
          {() => (
            <Button size="sm" variant="secondary" icon={<Trash2 aria-hidden className="size-4" />} loading={clearing} onClick={() => void clearCache()}>
              {t('tmdbClearCache')}
            </Button>
          )}
        </SettingsRow>
        {/* TMDB's terms ask for the notice wherever its data is configured: the group's footer, not a loose line. */}
        <p className="rounded-b-lg bg-surface-2/50 px-4 py-2.5 text-caption text-fg-subtle" data-testid="tmdb-attribution">
          {t('tmdbAttribution')}
        </p>
      </SettingsGroup>
    </SettingsSection>
  );
}
