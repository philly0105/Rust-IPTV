import { BookOpen, Bug, ChevronRight, Copy, ExternalLink, FolderOpen, Gift, Route } from 'lucide-react';
import { version as reactVersion, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { isDesktop, rpc } from '@/api/transport';
// The openers only (no UI imports): the dialogs load on first open.
import { openTour, openWhatsNew } from '@/features/onboarding/store';
import { BrandMark } from '@/ui/BrandMark';

import { Badge, Button, ErrorState, IconButton, Skeleton, useToast, errorDescription } from '@/ui';
import { SettingsGroup, SettingsSection } from '../components';
import { ISSUES_URL, PROJECT_URL, openExternal, platformName } from '../lib/links';
import { updaterAvailable } from '../lib/updater';
import type { SectionProps } from './types';
import { UpdatesPanel } from './UpdatesPanel';

/** One outbound link row: icon, title, a line on what is there, and the arrow out. */
function LinkRow({ href, icon, title, hint, testId }: { href: string; icon: ReactNode; title: string; hint: string; testId: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={openExternal}
      className="flex items-center gap-3 px-4 py-3 hover:bg-hover active:bg-active motion-safe:transition-colors"
      data-testid={testId}
    >
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md border border-edge bg-surface-2 text-fg-muted">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body font-medium text-fg">{title}</span>
        <span className="text-body-sm text-fg-muted">{hint}</span>
      </span>
      <ExternalLink aria-hidden size={16} className="shrink-0 text-fg-subtle" />
    </a>
  );
}

/**
 * A path in the data group: the label, the path in mono (it wraps anywhere), and on the desktop an
 * Open button. Each row is its own term and value list, with the button beside it, outside the
 * list: a dl holds only dt and dd (or a div of them).
 */
function PathRow({ label, path, onOpen, openLabel, testId }: { label: string; path: string; onOpen?: () => void; openLabel: string; testId?: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <dl className="flex min-w-0 flex-1 flex-col gap-0.5">
        <dt className="text-body-sm text-fg-muted">{label}</dt>
        <dd className="min-w-0 break-all font-mono text-body-sm text-fg" dir="ltr">
          {path}
        </dd>
      </dl>
      {onOpen ? <IconButton label={openLabel} icon={<FolderOpen aria-hidden size={16} />} onClick={onOpen} data-testid={testId} /> : null}
    </div>
  );
}

/**
 * About, as a product page (SS-12): the app's mark, name and version with what's new and the
 * tour, where the project lives and where to report a problem, updates (SR-6), where the data
 * is kept, and the diagnostics a bug report needs, folded away from people who do not.
 */
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

  // Plain English for a bug report, whatever the UI language.
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
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
        </div>
      ) : info.isError ? (
        <ErrorState error={info.error} onRetry={() => void info.refetch()} />
      ) : (
        <>
          <div className="flex flex-col gap-5 rounded-lg border border-edge bg-surface p-5 @md:flex-row @md:items-start" data-testid="about-product">
            <BrandMark size={64} className="shrink-0 rounded-xl shadow-1" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className="text-title text-fg">Tsrust IPTV</p>
                <Badge className="tabular-nums" data-testid="about-version">
                  {t('aboutVersion', { version: info.data.version })}
                </Badge>
              </div>
              <p className="text-body-sm text-fg-muted">{t('aboutTagline')}</p>
              <p className="text-caption text-fg-subtle" data-testid="about-platform">
                {t('aboutPlatformValue', {
                  platform: platformName(info.data.platform),
                  kind: info.data.isDesktop ? t('aboutDesktop') : t('aboutServer'),
                })}
              </p>
              {/* One row of equal buttons under the text, so the card keeps a straight edge. */}
              <div className="mt-2 flex flex-wrap gap-2" data-testid="about-product-actions">
                <Button variant="secondary" size="sm" icon={<Gift aria-hidden size={16} />} onClick={openWhatsNew} data-testid="about-whats-new">
                  {t('aboutWhatsNew')}
                </Button>
                <Button variant="secondary" size="sm" icon={<Route aria-hidden size={16} />} onClick={openTour} data-testid="about-tour">
                  {t('aboutTakeTour')}
                </Button>
              </div>
            </div>
          </div>

          <SettingsGroup title={t('aboutLinks')}>
            <LinkRow href={PROJECT_URL} icon={<BookOpen size={16} />} title={t('aboutHomepage')} hint={t('aboutHomepageHint')} testId="about-homepage" />
            <LinkRow href={ISSUES_URL} icon={<Bug size={16} />} title={t('aboutIssues')} hint={t('aboutIssuesHint')} testId="about-issues" />
          </SettingsGroup>

          <UpdatesPanel available={isDesktop && updaterAvailable(info.data)} server={!isDesktop} />

          <SettingsGroup title={t('aboutDataGroup')} description={isDesktop ? undefined : t('aboutServerNote')}>
            <PathRow
              label={t('aboutDataDir')}
              path={info.data.dataDir}
              openLabel={t('aboutOpenDataDir')}
              onOpen={isDesktop ? () => void act(() => rpc('app.openPath', { path: info.data.dataDir })) : undefined}
            />
            <PathRow
              label={t('aboutLogFile')}
              path={info.data.logFile}
              openLabel={t('aboutOpenLogs')}
              onOpen={isDesktop ? () => void act(() => rpc('app.openLogDir')) : undefined}
              testId="about-open-logs"
            />
          </SettingsGroup>

          {/* For a bug report: technical details stay folded, with the copy button beside them. */}
          <details className="group rounded-lg border border-edge bg-surface" data-testid="about-diagnostics">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-4 py-3 text-body font-medium text-fg hover:bg-hover [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden size={16} className="text-fg-subtle group-open:rotate-90 motion-safe:transition-transform rtl:rotate-180 rtl:group-open:rotate-90" />
              {t('aboutDiagnostics')}
            </summary>
            <div className="flex flex-col gap-3 border-t border-divider px-4 py-3">
              <p className="text-body-sm text-fg-muted">{t('aboutDiagnosticsHint')}</p>
              <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-body-sm">
                <dt className="text-fg-muted">{t('aboutPlatform')}</dt>
                <dd className="font-mono text-fg">{`${info.data.platform}, ${info.data.isDesktop ? 'desktop' : 'server'}`}</dd>
                <dt className="text-fg-muted">{t('aboutReact')}</dt>
                <dd className="font-mono text-fg">{reactVersion}</dd>
              </dl>
              <div>
                <Button variant="secondary" size="sm" icon={<Copy aria-hidden size={16} />} onClick={() => void copyDiagnostics()} data-testid="about-copy-diagnostics">
                  {t('aboutCopyDiagnostics')}
                </Button>
              </div>
            </div>
          </details>

          <p className="max-w-2xl text-caption text-fg-subtle">{t('aboutCredits')}</p>
        </>
      )}
    </SettingsSection>
  );
}
