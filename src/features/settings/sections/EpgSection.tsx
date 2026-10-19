import { clsx } from 'clsx';
import { Eraser, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { onAppEvent } from '@/api/events';
import { invalidate, queryClient, rpcKey, useRpcQuery } from '@/api/query';
import { rpc, rpcRaw } from '@/api/transport';
import type { EpgProgressEvent, EpgSourceStatus, EpgViewMode, Settings } from '@/api/types';

import { Badge, Button, Dialog, ErrorState, IconButton, Input, SkeletonList, useToast, errorDescription } from '@/ui';
import { absoluteTime, formatCount, relativeTime } from '../../sources/lib/format';
import { redactText, redactUrl } from '../../sources/lib/redact';
import { CommitInput, Segmented, SettingsGroup, SettingsRow, SettingsSection, SwitchRow } from '../components';
import { epgErrorText } from '../lib/epgError';
import { addEpgUrl, validateEpgOffset } from '../lib/patch';
import { parity, type SectionProps } from './types';

const STATUS_CLASS: Record<EpgSourceStatus['status'], string> = {
  idle: 'text-fg-muted',
  fetching: 'text-accent',
  ok: 'text-success',
  error: 'text-danger',
};

export function EpgSection({ settings, update }: SectionProps) {
  const { t, i18n } = useTranslation('settings');
  const { toast } = useToast();
  const addId = useId();
  const [draft, setDraft] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, EpgProgressEvent>>({});
  const [offsetError, setOffsetError] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const statuses = useRpcQuery('epg.sources', undefined, { staleTime: 5_000 });
  const sources = useRpcQuery('sources.list', undefined);
  const sourceNames = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s.name])), [sources.data]);

  useEffect(() => {
    const offProgress = onAppEvent('epg.progress', (e) => {
      setLive((prev) => ({ ...prev, [e.url]: e }));
      if (e.phase === 'done' || e.phase === 'error') void invalidate('epg.sources');
    });
    const offChanged = onAppEvent('epg.changed', () => {
      setLive({});
      void invalidate('epg.');
    });
    return () => {
      offProgress();
      offChanged();
    };
  }, []);

  const addUrl = async () => {
    const r = addEpgUrl(settings.epgUrls, draft);
    if (!r.ok) {
      setAddError(r.error);
      return;
    }
    setAddError(null);
    setDraft('');
    if (await update({ epgUrls: r.list })) {
      await invalidate('epg.sources');
      // Fetch the new guide right away.
      const url = r.list[r.list.length - 1];
      if (url) void rpc('epg.refresh', { url }).catch(() => undefined);
    }
  };

  const removeUrl = async (url: string, from: HTMLElement) => {
    const index = settings.epgUrls.indexOf(url);
    // The row and its button go away; keep focus in the list (the next row's
    // remove button, else the add field) instead of dropping it to the page.
    const buttons = [...document.querySelectorAll<HTMLElement>('[data-epg-remove]')];
    const at = buttons.indexOf(from);
    const nextFocus = buttons[at + 1] ?? buttons[at - 1] ?? document.getElementById(addId);
    if (!(await update({ epgUrls: settings.epgUrls.filter((u) => u !== url) }))) return;
    void invalidate('epg.sources');
    nextFocus?.focus();
    toast({
      variant: 'info',
      title: t('epgUrlRemoved', { url: redactUrl(url) }),
      action: {
        label: t('undo'),
        onClick: () => {
          // Back into its old place in whatever the list is now.
          const now = queryClient.getQueryData<Settings>(rpcKey('settings.get'))?.epgUrls ?? [];
          if (now.includes(url)) return;
          const list = [...now];
          list.splice(Math.min(Math.max(index, 0), list.length), 0, url);
          void update({ epgUrls: list }).then((ok) => {
            if (ok) void invalidate('epg.sources');
          });
        },
      },
    });
  };

  const refresh = async (url?: string) => {
    try {
      await rpc('epg.refresh', url ? { url } : {});
      void invalidate('epg.sources');
    } catch (e) {
      toast({ variant: 'error', title: t('epgRefreshFailed'), description: errorDescription(e, redactText) });
    }
  };

  const setEnabled = async (url: string, enabled: boolean) => {
    try {
      await rpc('epg.setEnabled', { url, enabled });
      await Promise.all([invalidate('epg.'), invalidate('sources.')]);
    } catch (e) {
      toast({ variant: 'error', title: t('saveFailed'), description: errorDescription(e) });
    }
  };

  const clearAll = async () => {
    setClearing(true);
    try {
      await rpcRaw('epg.clearAll');
      setLive({});
      setClearOpen(false);
      toast({ variant: 'success', title: t('epgClearDone') });
      await Promise.all([invalidate('epg.'), invalidate('sources.')]);
    } catch (e) {
      toast({ variant: 'error', title: t('epgClearFailed'), description: errorDescription(e) });
    } finally {
      setClearing(false);
    }
  };

  const lang = i18n.language;
  const offset = parity(settings).epgOffsetMinutes;

  return (
    <SettingsSection title={t('sectionEpg')} description={t('sectionEpgLead')} testId="settings-epg">
      <SettingsGroup title={t('epgGlobalUrls')} description={t('epgGlobalUrlsHint')}>
        {settings.epgUrls.length === 0 ? (
          <p className="px-4 py-4 text-sm text-fg-muted">{t('epgGlobalEmpty')}</p>
        ) : (
          settings.epgUrls.map((url) => (
            <div key={url} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg" title={redactUrl(url)} data-testid="epg-global-url">
                {redactUrl(url)}
              </span>
              <IconButton
                label={t('epgRemoveUrl', { url: redactUrl(url) })}
                icon={<Trash2 aria-hidden className="size-4" />}
                onClick={(e) => void removeUrl(url, e.currentTarget)}
                data-epg-remove=""
              />
            </div>
          ))
        )}
        <div className="flex flex-col gap-1.5 px-4 py-4">
          <label htmlFor={addId} className="text-sm font-medium text-fg">
            {t('epgAddUrl')}
          </label>
          <div className="flex gap-2">
            <Input
              id={addId}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://epg.example/guide.xml.gz"
              value={draft}
              aria-invalid={addError ? true : undefined}
              aria-describedby={addError ? `${addId}-err` : undefined}
              onChange={(e) => {
                setDraft(e.target.value);
                if (addError) setAddError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void addUrl();
                }
              }}
              data-testid="epg-add-input"
            />
            <Button icon={<Plus aria-hidden className="size-4" />} disabled={!draft.trim()} onClick={() => void addUrl()} data-testid="epg-add">
              {t('add')}
            </Button>
          </div>
          {addError ? (
            <p id={`${addId}-err`} role="alert" className="text-sm text-danger">
              {t(addError)}
            </p>
          ) : null}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t('epgStatus')}
        description={t('epgStatusHint')}
        actions={
          <Button size="sm" variant="secondary" icon={<RefreshCw aria-hidden className="size-4" />} onClick={() => void refresh()} data-testid="epg-refresh-all">
            {t('epgRefreshAll')}
          </Button>
        }
      >
        {statuses.isPending ? (
          <div className="p-4">
            <SkeletonList rows={3} />
          </div>
        ) : statuses.isError ? (
          <ErrorState error={statuses.error} onRetry={() => void statuses.refetch()} />
        ) : statuses.data.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-fg-muted">{t('epgStatusEmpty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-divider" aria-label={t('epgStatus')}>
            {statuses.data.map((s) => {
              const ev = live[s.url];
              const fetching = s.status === 'fetching' || (ev && ev.phase !== 'done' && ev.phase !== 'error');
              const status = fetching ? 'fetching' : s.status;
              const origin = s.origin === 'settings' ? t('epgFromSettings') : (sourceNames.get(s.sourceId ?? '') ?? t('epgFromSource'));
              // Xtream sources contribute `xmltv.php?username=..&password=..`; never render the password.
              const shown = redactUrl(s.url);
              return (
                <li key={s.url} className="flex flex-col gap-2 py-1" data-testid="epg-status-row">
                  <SwitchRow
                    label={
                      <span className="block truncate font-mono text-sm" title={shown} data-testid="epg-status-url">
                        {shown}
                      </span>
                    }
                    description={
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <Badge>{origin}</Badge>
                        <span className={clsx('font-medium', STATUS_CLASS[status])}>{t(`epgState_${status}`)}</span>
                        {ev && fetching ? (
                          <span className="tabular-nums">{t('epgProgramsSoFar', { count: ev.programs, value: formatCount(ev.programs, lang) })}</span>
                        ) : (
                          <span className="tabular-nums">
                            {t('epgCounts', { programs: formatCount(s.programCount, lang), channels: formatCount(s.channelCount, lang) })}
                          </span>
                        )}
                        {s.lastFetchAt ? <span title={absoluteTime(s.lastFetchAt, lang)}>{relativeTime(s.lastFetchAt, lang)}</span> : null}
                      </span>
                    }
                    checked={s.enabled}
                    onChange={(v) => void setEnabled(s.url, v)}
                  />
                  {s.error && !fetching ? (
                    <p role="alert" className="-mt-2 px-4 text-sm text-danger">
                      {epgErrorText(s.error, t, lang)}
                    </p>
                  ) : null}
                  <div className="-mt-2 flex justify-end px-4 pb-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<RefreshCw aria-hidden className={clsx('size-4', fetching && 'motion-safe:animate-spin')} />}
                      disabled={!s.enabled || Boolean(fetching)}
                      onClick={() => void refresh(s.url)}
                      aria-label={t('epgRefreshOne', { url: shown })}
                    >
                      {t('epgRefresh')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t('epgViewMode')} description={t('epgViewModeHint')}>
          {({ id }) => (
            <Segmented<EpgViewMode>
              id={id}
              label={t('epgViewMode')}
              value={settings.epgViewMode}
              options={[
                { value: 'timeline', label: t('epgViewTimeline') },
                { value: 'list', label: t('epgViewList') },
              ]}
              onChange={(epgViewMode) => void update({ epgViewMode })}
            />
          )}
        </SettingsRow>
        <SettingsRow label={t('epgOffset')} description={t('epgOffsetHint')} error={offsetError ? t(offsetError) : null}>
          {({ id, describedBy, invalid }) => (
            <div className="flex items-center gap-2">
              <CommitInput
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                type="text"
                // Not "numeric": phone keypads for it have no minus sign, and the shift can be negative.
                inputMode="text"
                value={String(offset)}
                className="w-24 text-end tabular-nums"
                onError={setOffsetError}
                validate={(v) => {
                  const r = validateEpgOffset(v);
                  return r.ok ? null : r.error;
                }}
                onCommit={(v) => {
                  const r = validateEpgOffset(v);
                  if (r.ok) void update({ epgOffsetMinutes: r.minutes });
                }}
                testId="input-epgOffsetMinutes"
              />
              <span className="text-sm text-fg-muted">{t('epgOffsetUnit')}</span>
            </div>
          )}
        </SettingsRow>
        {/* guide: Xtream short-EPG fallback. */}
        <SwitchRow
          label={t('epgShortFallback')}
          description={t('epgShortFallbackHint')}
          checked={settings.epgShortFallback !== false}
          onChange={(epgShortFallback) => void update({ epgShortFallback })}
          testId="toggle-epgShortFallback"
        />
      </SettingsGroup>

      <SettingsGroup title={t('epgClearTitle')}>
        <div className="flex flex-col gap-3 px-4 py-4 @2xl:flex-row @2xl:items-center @2xl:justify-between">
          <p className="max-w-xl text-sm text-fg-muted">{t('epgClearHint')}</p>
          <Button variant="danger" icon={<Eraser aria-hidden className="size-4" />} onClick={() => setClearOpen(true)} data-testid="epg-clear-all">
            {t('epgClearButton')}
          </Button>
        </div>
      </SettingsGroup>

      <Dialog
        open={clearOpen}
        onClose={() => (clearing ? undefined : setClearOpen(false))}
        title={t('epgClearConfirmTitle')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setClearOpen(false)} disabled={clearing}>
              {t('cancel')}
            </Button>
            <Button variant="danger" loading={clearing} onClick={() => void clearAll()} data-testid="epg-clear-confirm">
              {t('epgClearConfirm')}
            </Button>
          </>
        }
      >
        <p className="text-fg-muted">{t('epgClearConfirmBody')}</p>
      </Dialog>
    </SettingsSection>
  );
}
