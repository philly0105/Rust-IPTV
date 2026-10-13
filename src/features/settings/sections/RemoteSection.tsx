import { clsx } from 'clsx';
import { Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate, useRpcQuery } from '@/api/query';
import { RpcError, isDesktop, rpc } from '@/api/transport';

import { Button, IconButton, Skeleton, useToast } from '@/ui';
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
      toast({ variant: 'error', title: t('remoteFailed'), description: RpcError.from(e).message });
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
        <SettingsRow label={t('remotePort')} description={t('remotePortHint')} error={portError ? t(portError) : null}>
          {({ id, describedBy }) => (
            <CommitInput
              id={id}
              describedBy={describedBy}
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

      <SettingsGroup title={t('remoteStatus')}>
        <div className="flex flex-col gap-3 px-4 py-4" aria-live="polite" data-testid="remote-status">
          {status.isPending ? (
            <Skeleton className="h-6 w-64" />
          ) : status.isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm" data-testid="remote-status-error">
              <span className="min-w-0 flex-1 text-danger">{t('remoteStatusFailed', { message: status.error.message })}</span>
              <Button size="sm" variant="secondary" onClick={() => void status.refetch()}>
                {t('retry')}
              </Button>
            </div>
          ) : (
            <>
              <p className="flex items-center gap-2">
                <span aria-hidden className={clsx('size-2.5 rounded-full', running ? 'bg-success' : 'bg-fg-subtle')} />
                <span className="font-medium text-fg">{running ? t('remoteRunning') : t('remoteStopped')}</span>
              </p>
              {running && url ? (
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 truncate rounded-sm bg-surface-2 px-2 py-1 font-mono text-sm text-fg" data-testid="remote-url">
                    {url}
                  </code>
                  <IconButton label={t('remoteCopy')} icon={<Copy aria-hidden className="size-4" />} onClick={() => void copy()} />
                  <Button size="sm" variant="ghost" icon={<ExternalLink aria-hidden className="size-4" />} onClick={() => void open()}>
                    {t('remoteOpen')}
                  </Button>
                </div>
              ) : enabled && !running ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-warning">{t('remoteEnabledNotRunning')}</p>
                  <Button size="sm" variant="secondary" loading={busy} onClick={() => void run(() => rpc('remote.start'))}>
                    {t('remoteStart')}
                  </Button>
                </div>
              ) : null}
              <p className="text-sm text-fg-muted">{t(isDesktop ? 'remoteLoopbackNote' : 'remoteLoopbackNoteServer')}</p>
            </>
          )}
        </div>
      </SettingsGroup>

      {/* remote: LAN mode and pairing */}
      <RemoteLanPanel settings={settings} update={update} status={status.data} />
    </SettingsSection>
  );
}
