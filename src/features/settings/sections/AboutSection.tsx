import { Copy, FolderOpen, ScrollText } from 'lucide-react';
import { version as reactVersion } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { RpcError, isDesktop, rpc } from '@/api/transport';

import { Button, ErrorState, Skeleton, useToast } from '@/ui';
import { SettingsGroup, SettingsSection } from '../components';
import { updaterAvailable } from '../lib/updater';
import type { SectionProps } from './types';
import { UpdatesPanel } from './UpdatesPanel';

export function AboutSection(_props: SectionProps) {
  const { t } = useTranslation('settings');
  const { toast } = useToast();
  const info = useRpcQuery('app.info', undefined, { staleTime: Infinity });

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast({ variant: 'error', title: t('aboutActionFailed'), description: RpcError.from(e).message });
    }
  };

  const copyDiagnostics = async () => {
    if (!info.data) return;
    const text = [
      `Tsrust IPTV ${info.data.version}`,
      `Platform: ${info.data.platform} (${info.data.isDesktop ? 'desktop' : 'server'})`,
      `React: ${reactVersion}`,
      `User agent: ${navigator.userAgent}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast({ variant: 'success', title: t('aboutCopied') });
    } catch {
      toast({ variant: 'error', title: t('aboutCopyFailed') });
    }
  };

  return (
    <SettingsSection title={t('sectionAbout')} testId="settings-about">
      {info.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16 w-72" />
          <Skeleton className="h-40" />
        </div>
      ) : info.isError ? (
        <ErrorState error={info.error} onRetry={() => void info.refetch()} />
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <p className="font-display text-4xl font-semibold text-fg">Tsrust IPTV</p>
            <p className="font-display text-lg tabular-nums text-accent" data-testid="about-version">
              {t('aboutVersion', { version: info.data.version })}
            </p>
          </div>
          <SettingsGroup>
            <dl className="flex flex-col divide-y divide-border">
              {[
                { k: t('aboutPlatform'), v: `${info.data.platform}, ${info.data.isDesktop ? t('aboutDesktop') : t('aboutServer')}` },
                { k: t('aboutReact'), v: reactVersion },
                { k: t('aboutDataDir'), v: info.data.dataDir, mono: true },
                { k: t('aboutLogFile'), v: info.data.logFile, mono: true },
              ].map((row) => (
                <div key={row.k} className="flex flex-col gap-1 px-4 py-3 @2xl:flex-row @2xl:items-baseline @2xl:gap-6">
                  <dt className="w-40 shrink-0 text-sm text-fg-muted">{row.k}</dt>
                  <dd className={row.mono ? 'min-w-0 break-all font-mono text-sm text-fg' : 'text-fg'}>{row.v}</dd>
                </div>
              ))}
            </dl>
          </SettingsGroup>
          <UpdatesPanel available={isDesktop && updaterAvailable(info.data)} />
          <div className="flex flex-wrap gap-2">
            {isDesktop ? (
              <>
                <Button icon={<ScrollText aria-hidden className="size-4" />} onClick={() => void act(() => rpc('app.openLogDir'))} data-testid="about-open-logs">
                  {t('aboutOpenLogs')}
                </Button>
                <Button icon={<FolderOpen aria-hidden className="size-4" />} onClick={() => void act(() => rpc('app.openPath', { path: info.data.dataDir }))}>
                  {t('aboutOpenDataDir')}
                </Button>
              </>
            ) : null}
            <Button variant="ghost" icon={<Copy aria-hidden className="size-4" />} onClick={() => void copyDiagnostics()}>
              {t('aboutCopyDiagnostics')}
            </Button>
          </div>
          {!isDesktop ? <p className="text-sm text-fg-muted">{t('aboutServerNote')}</p> : null}
          <p className="max-w-2xl text-sm text-fg-subtle">{t('aboutCredits')}</p>
        </>
      )}
    </SettingsSection>
  );
}
