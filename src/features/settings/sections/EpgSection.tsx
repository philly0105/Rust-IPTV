import { clsx } from 'clsx';
import { CircleAlert, CircleCheck, CircleDashed, Eraser, LoaderCircle, Plus, RefreshCw, Trash2, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { onAppEvent } from '@/api/events';
import { invalidate, queryClient, rpcKey, useRpcQuery } from '@/api/query';
import { rpc, rpcRaw } from '@/api/transport';
import type { EpgProgressEvent, EpgSourceStatus, EpgViewMode, Settings } from '@/api/types';

import { Badge, Button, Dialog, ErrorState, IconButton, Input, MetaLine, SkeletonList, Switch, useToast, errorDescription, type BadgeVariant } from '@/ui';
import { absoluteTime, formatCount, relativeTime } from '../../sources/lib/format';
import { redactText, redactUrl } from '../../sources/lib/redact';
import { CommitInput, Segmented, SettingsGroup, SettingsRow, SettingsSection, SwitchRow } from '../components';
import { epgErrorText } from '../lib/epgError';
import { addEpgUrl, validateEpgOffset } from '../lib/patch';
import { parity, type SectionProps } from './types';

/** Each guide's state as a badge: colour plus an icon, so the state never rests on colour alone. */
const STATUS_BADGE: Record<EpgSourceStatus['status'], { variant: BadgeVariant; icon: LucideIcon }> = {
  idle: { variant: 'neutral', icon: CircleDashed },
  fetching: { variant: 'neutral', icon: LoaderCircle },
  ok: { variant: 'success', icon: CircleCheck },
  error: { variant: 'danger', icon: CircleAlert },
};

/**
 * One guide in the status list (SS-20): what it belongs to (the source, or "Added in Settings")
 * as the title, its state and counts under it, and the redacted address last, small, for anyone
 * who needs it. Refresh and the on/off switch sit together at the end of the first line.
 */
function GuideStatusRow({
  url,
  origin,
  status,
  counts,
  fetchedAt,
  error,
  enabled,
  onEnabled,
  onRefresh,
}: {
  url: string;
  origin: string;
  status: EpgSourceStatus['status'];
  counts: string;
  fetchedAt?: string | null;
  error: string | null;
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  onRefresh: () => void;
}) {
  const { t, i18n } = useTranslation('settings');
  const id = useId();
  const lang = i18n.language;
  // Xtream sources contribute `xmltv.php?username=..&password=..`; never render the password.
  const shown = redactUrl(url);
  const fetching = status === 'fetching';
  const { variant, icon: Icon } = STATUS_BADGE[status];
  return (
    <li className="flex items-start gap-3 px-4 py-3" data-testid="epg-status-row" data-status={status}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor={`${id}-switch`} className="truncate text-body font-medium text-fg text-match-parent" dir="auto" data-testid="epg-status-origin">
          {origin}
        </label>
        <MetaLine
          id={`${id}-state`}
          // A phone-width column stacks state, counts and age, so no separator hangs at a line end.
          className="text-body-sm @max-md:flex-col @max-md:items-start @max-md:[&>[aria-hidden]]:hidden"
          items={[
            <Badge key="state" variant={variant} data-testid="epg-status-state">
              <Icon aria-hidden size={12} className={clsx('shrink-0', fetching && 'motion-safe:animate-spin')} />
              {t(`epgState_${status}`)}
            </Badge>,
            <span key="counts" className="tabular-nums">
              {counts}
            </span>,
            fetchedAt ? (
              <span key="age" title={absoluteTime(fetchedAt, lang)}>
                {relativeTime(fetchedAt, lang)}
              </span>
            ) : null,
          ]}
        />
        <span id={`${id}-url`} className="block truncate font-mono text-caption text-fg-subtle" dir="ltr" title={shown} data-testid="epg-status-url">
          {shown}
        </span>
        {error ? (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          label={t('epgRefreshOne', { url: shown })}
          tooltip={t('epgRefresh')}
          icon={<RefreshCw aria-hidden size={16} className={clsx(fetching && 'motion-safe:animate-spin')} />}
          disabled={!enabled || fetching}
          onClick={onRefresh}
          data-testid="epg-status-refresh"
        />
        <Switch
          id={`${id}-switch`}
          checked={enabled}
          onCheckedChange={onEnabled}
          aria-describedby={`${id}-state ${id}-url`}
          data-testid="epg-status-switch"
        />
      </div>
    </li>
  );
}

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
    const offChanged = onAppEvent('epg.changed', (e) => {
      setLive({});
      // A status-only change (a refresh starting, a 304) leaves the guide data as it was.
      void invalidate(e.reason === 'status' ? 'epg.sources' : 'epg.');
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
              const fetching = s.status === 'fetching' || Boolean(ev && ev.phase !== 'done' && ev.phase !== 'error');
              const status = fetching ? 'fetching' : s.status;
              const origin = s.origin === 'settings' ? t('epgFromSettings') : (sourceNames.get(s.sourceId ?? '') ?? t('epgFromSource'));
              return (
                <GuideStatusRow
                  key={s.url}
                  url={s.url}
                  origin={origin}
                  status={status}
                  counts={
                    ev && fetching
                      ? t('epgProgramsSoFar', { count: ev.programs, value: formatCount(ev.programs, lang) })
                      : t('epgCounts', { programs: formatCount(s.programCount, lang), channels: formatCount(s.channelCount, lang) })
                  }
                  fetchedAt={s.lastFetchAt}
                  error={s.error && !fetching ? epgErrorText(s.error, t, lang) : null}
                  enabled={s.enabled}
                  onEnabled={(v) => void setEnabled(s.url, v)}
                  onRefresh={() => void refresh(s.url)}
                />
              );
            })}
          </ul>
        )}
      </SettingsGroup>

      <SettingsGroup title={t('epgDisplayGroup')}>
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

      <SettingsGroup title={t('epgClearTitle')} tone="danger">
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
