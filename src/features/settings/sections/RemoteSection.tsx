import { clsx } from 'clsx';
import { Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate, useRpcQuery } from '@/api/query';
import { isDesktop, rpc } from '@/api/transport';

import { Badge, Button, IconButton, Skeleton, useToast, errorDescription } from '@/ui';
import { CommitInput, SettingsGroup, SettingsRow, SettingsSection, SwitchRow } from '../components';
import { remotePatch, validatePort } from '../lib/patch';
import { RemoteLanPanel } from './RemoteLanPanel';
import type { SectionProps } from './types';

export function RemoteSection({ settings, update }: SectionProps) {
  const { t } = useTranslation('settings');
  const { toast } = useToast();
  const [portError, setPortError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const status = useRpcQuery('remote.status', undefined, { staleTime: 2_000 });
  const enabled = settings.remoteControl.enabled;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast({ variant: 'error', title: t('remoteFailed'), description: errorDescription(e) });
    } finally {
      setBusy(false);
      void invalidate('remote.');
    }
  };

  const setEnabled = (v: boolean) =>
    run(async () => {
      if (!(await update(remotePatch(settings, { enabled: v })))) return;
      if (v) await rpc('remote.start');
      else await rpc('remote.stop');
    });

  const setPort = (raw: string) =>
    run(async () => {
      const r = validatePort(raw);
      if (!r.ok) return;
      if (!(await update(remotePatch(settings, { port: r.port })))) return;
      if (status.data?.running) {
        await rpc('remote.stop');
        await rpc('remote.start');
      }
    });

  const url = status.data?.url;
  const running = status.data?.running ?? false;

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast({ variant: 'success', title: t('remoteCopied') });
    } catch {
      toast({ variant: 'error', title: t('remoteCopyFailed') });
    }
  };

  const open = async () => {
    if (!url) return;
    if (isDesktop) {
      try {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(url);
        return;
      } catch {
        // fall through to window.open
      }
    }
    window.open(url, '_blank', 'noopener');
  };

  return (
    <SettingsSection title={t('sectionRemote')} description={t('sectionRemoteLead')} testId="settings-remote">
      <SettingsGroup>
        <SwitchRow label={t('remoteEnabled')} description={t('remoteEnabledHint')} checked={enabled} disabled={busy} onChange={(v) => void setEnabled(v)} testId="toggle-remote" />
        {/* The state sits under the switch it follows, not in a group of its own. With remote
            control off and stopped the switch says it all, so the row stays empty (and out of
            sight) but mounted: it is the live region that announces the change. */}
        <div
          className={status.isPending || status.isError || running || enabled ? 'flex flex-col gap-2 px-4 py-3' : 'sr-only'}
          aria-live="polite"
          data-testid="remote-status"
        >
          {status.isPending ? (
            <Skeleton className="h-6 w-64" />
          ) : status.isError ? (
            <div role="alert" className="flex flex-wrap items-start gap-3 text-body-sm" data-testid="remote-status-error">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-danger">{t('remoteStatusFailed')}</p>
                <p className="text-fg-muted">{errorDescription(status.error)}</p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => void status.refetch()}>
                {t('retry')}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                <Badge variant={running ? 'success' : enabled ? 'warning' : 'neutral'} data-testid="remote-state">
                  <span aria-hidden className={clsx('size-1.5 shrink-0 rounded-full', running ? 'bg-success' : enabled ? 'bg-warning' : 'bg-fg-subtle')} />
                  {running ? t('remoteRunning') : t('remoteStopped')}
                </Badge>
                {running && url ? (
                  <span className="flex min-w-0 flex-1 items-center gap-1">
                    <code className="min-w-0 truncate rounded-sm bg-surface-2 px-2 py-1 font-mono text-body-sm text-fg" dir="ltr" data-testid="remote-url">
                      {url}
                    </code>
                    <IconButton label={t('remoteCopy')} icon={<Copy aria-hidden size={16} />} onClick={() => void copy()} />
                    <IconButton label={t('remoteOpen')} icon={<ExternalLink aria-hidden size={16} />} onClick={() => void open()} data-testid="remote-open" />
                  </span>
                ) : enabled && !running ? (
                  <span className="flex flex-wrap items-center gap-3">
                    <span className="text-body-sm text-warning">{t('remoteEnabledNotRunning')}</span>
                    <Button size="sm" variant="secondary" loading={busy} onClick={() => void run(() => rpc('remote.start'))}>
                      {t('remoteStart')}
                    </Button>
                  </span>
                ) : null}
              </div>
              {running ? <p className="text-caption text-fg-subtle">{t(isDesktop ? 'remoteLoopbackNote' : 'remoteLoopbackNoteServer')}</p> : null}
            </>
          )}
        </div>
        <SettingsRow label={t('remotePort')} description={t('remotePortHint')} error={portError ? t(portError) : null}>
          {({ id, describedBy, invalid }) => (
            <CommitInput
              id={id}
              describedBy={describedBy}
              invalid={invalid}
              inputMode="numeric"
              className="w-28 text-end tabular-nums"
              value={String(settings.remoteControl.port)}
              validate={(v) => {
                const r = validatePort(v);
                return r.ok ? null : r.error;
              }}
              onError={setPortError}
              onCommit={(v) => void setPort(v)}
              disabled={busy}
              testId="input-remote-port"
            />
          )}
        </SettingsRow>
      </SettingsGroup>

      {/* remote: LAN mode and pairing */}
      <RemoteLanPanel settings={settings} update={update} status={status.data} />
    </SettingsSection>
  );
}
