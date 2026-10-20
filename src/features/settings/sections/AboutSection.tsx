import { Copy, FolderOpen, Gift, Route, ScrollText } from 'lucide-react';
import { version as reactVersion } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { isDesktop, rpc } from '@/api/transport';
// The openers only (no UI imports): the dialogs load on first open.
import { openTour, openWhatsNew } from '@/features/onboarding/store';

import { Button, ErrorState, Skeleton, useToast, errorDescription } from '@/ui';
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
      toast({ variant: 'error', title: t('aboutActionFailed'), description: errorDescription(e) });
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
            <p className="text-headline text-fg">Tsrust IPTV</p>
            <p className="text-lg tabular-nums text-fg-muted" data-testid="about-version">
              {t('aboutVersion', { version: info.data.version })}
            </p>
          </div>
          <SettingsGroup>
            <dl className="flex flex-col divide-y divide-divider">
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
          {/* Run 3 C7: What's new lists every release so far; the tour replays from step one. */}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<Gift aria-hidden className="size-4" />} onClick={openWhatsNew} data-testid="about-whats-new">
              {t('aboutWhatsNew')}
            </Button>
            <Button variant="ghost" icon={<Route aria-hidden className="size-4" />} onClick={openTour} data-testid="about-tour">
              {t('aboutTakeTour')}
            </Button>
          </div>
          {!isDesktop ? <p className="text-sm text-fg-muted">{t('aboutServerNote')}</p> : null}
          <p className="max-w-2xl text-sm text-fg-subtle">{t('aboutCredits')}</p>
        </>
      )}
    </SettingsSection>
  );
}
