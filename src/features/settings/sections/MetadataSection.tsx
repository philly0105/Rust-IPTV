import { CircleAlert, CircleCheck, Eye, EyeOff, PlugZap, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate } from '@/api/query';
import { RpcError, rpc } from '@/api/transport';

import { Button, IconButton, Select, fieldClass, useToast, errorDescription } from '@/ui';
import { SettingsGroup, SettingsRow, SettingsSection, SwitchRow } from '../components';
import { TMDB_LANGUAGES } from '../lib/languages';
import { tmdbPatch } from '../lib/patch';
import type { SectionProps } from './types';

type TestState = { status: 'idle' } | { status: 'running' } | { status: 'done'; ok: boolean; message?: string };

export function MetadataSection({ settings, update }: SectionProps) {
  const { t } = useTranslation('settings');
  const { toast } = useToast();
  const saved = settings.tmdb.apiKey ?? '';
  const [key, setKey] = useState(saved);
  const [shown, setShown] = useState(false);
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

  const runTest = async () => {
    setTest({ status: 'running' });
    try {
      const r = await rpc('tmdb.testKey', { apiKey: key.trim() });
      setTest({ status: 'done', ok: r.ok, message: r.message });
    } catch (e) {
      setTest({ status: 'done', ok: false, message: RpcError.from(e).message });
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
        <SettingsRow label={t('tmdbApiKey')} description={t('tmdbApiKeyHint')} error={keyError ? t(keyError) : null} stack>
          {({ id, describedBy }) => (
            <div className="flex w-full flex-col gap-3">
              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <input
                    id={id}
                    type={shown ? 'text' : 'password'}
                    value={key}
                    disabled={!enabled}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby={describedBy}
                    aria-invalid={keyError ? true : undefined}
                    placeholder={t('tmdbApiKeyPlaceholder')}
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
                    className={fieldClass('md', 'pe-11 font-mono placeholder:font-sans')}
                    data-testid="input-tmdb-key"
                  />
                  <div className="absolute inset-y-0 end-0.5 flex items-center">
                    <IconButton
                      label={shown ? t('hideKey') : t('showKey')}
                      aria-pressed={shown}
                      disabled={!enabled}
                      icon={shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
                      onClick={() => setShown((s) => !s)}
                    />
                  </div>
                </div>
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
                <p aria-live="polite" className="flex items-center gap-1.5 text-sm" data-testid="tmdb-test-result">
                  {test.ok ? <CircleCheck aria-hidden className="size-4 text-success" /> : <CircleAlert aria-hidden className="size-4 text-danger" />}
                  <span className={test.ok ? 'text-success' : 'text-danger'}>
                    {test.ok ? (test.message ?? t('tmdbTestOk')) : (test.message ?? t('tmdbTestFailed'))}
                  </span>
                </p>
              ) : null}
            </div>
          )}
        </SettingsRow>
        <SettingsRow label={t('tmdbLanguage')} description={t('tmdbLanguageHint')}>
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
      </SettingsGroup>
      <p className="max-w-2xl text-sm text-fg-subtle" data-testid="tmdb-attribution">
        {t('tmdbAttribution')}
      </p>
    </SettingsSection>
  );
}
