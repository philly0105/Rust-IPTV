import { CircleAlert, CircleCheck, Download, ExternalLink, RefreshCw, Server } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, ProgressBar, buttonClass } from '@/ui';
import { absoluteTime } from '../../sources/lib/format';
import { SettingsGroup } from '../components';
import { RELEASES_URL, openExternal } from '../lib/links';
import { checkForUpdate, type AvailableUpdate } from '../lib/updater';

type State =
  | { step: 'idle' }
  | { step: 'checking' }
  | { step: 'current' }
  | { step: 'available'; update: AvailableUpdate }
  | { step: 'installing'; update: AvailableUpdate; received: number; total?: number }
  | { step: 'installed'; version: string }
  | { step: 'failed'; message: string; during: 'check' | 'install'; update?: AvailableUpdate };

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * "Check for updates" in About. `available` = this build ships the updater
 * plugin with a signing key (`app.info.updaterAvailable`). Without it the panel says where new
 * versions come from (SR-6): the releases page for a desktop build, and for the browser, that
 * the server is updated where it runs. No build or README wording for end users.
 */
export function UpdatesPanel({ available, server = false }: { available: boolean; server?: boolean }) {
  const { t, i18n } = useTranslation('settings');
  const [state, setState] = useState<State>({ step: 'idle' });
  const received = useRef(0);

  if (!available) {
    return (
      <SettingsGroup title={t('updates')}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4" data-testid="updates-unavailable" data-mode={server ? 'server' : 'manual'}>
          <div className="flex min-w-0 flex-[1_1_18rem] items-start gap-3">
            {server ? <Server aria-hidden size={16} className="mt-1 shrink-0 text-fg-subtle" /> : null}
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-body font-medium text-fg">{server ? t('updatesServer') : t('updatesNotConfigured')}</p>
              <p className="text-body-sm text-fg-muted">{server ? t('updatesServerHint') : t('updatesNotConfiguredHint')}</p>
            </div>
          </div>
          <a href={RELEASES_URL} target="_blank" rel="noreferrer noopener" onClick={openExternal} className={buttonClass('secondary', 'sm', 'shrink-0')} data-testid="updates-releases">
            {t('updatesSeeReleases')}
            <ExternalLink aria-hidden size={14} />
          </a>
        </div>
      </SettingsGroup>
    );
  }

  const check = async () => {
    setState({ step: 'checking' });
    try {
      const update = await checkForUpdate();
      setState(update ? { step: 'available', update } : { step: 'current' });
    } catch (e) {
      setState({ step: 'failed', message: message(e), during: 'check' });
    }
  };

  const install = async (update: AvailableUpdate) => {
    received.current = 0;
    setState({ step: 'installing', update, received: 0 });
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === 'Started') {
          setState({ step: 'installing', update, received: 0, total: ev.data.contentLength });
        } else if (ev.event === 'Progress') {
          received.current += ev.data.chunkLength;
          const got = received.current;
          setState((s) => (s.step === 'installing' ? { ...s, received: got } : s));
        }
      });
      setState({ step: 'installed', version: update.version });
    } catch (e) {
      setState({ step: 'failed', message: message(e), during: 'install', update });
    }
  };

  const busy = state.step === 'checking' || state.step === 'installing';
  const lang = i18n.language;

  return (
    <SettingsGroup
      title={t('updates')}
      actions={
        state.step === 'installed' ? null : (
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw aria-hidden className="size-4" />}
            loading={state.step === 'checking'}
            disabled={busy}
            onClick={() => void check()}
            data-testid="updates-check"
          >
            {t('updatesCheck')}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3 px-4 py-4" aria-live="polite" data-testid="updates-panel">
        {state.step === 'idle' ? <p className="text-sm text-fg-muted">{t('updatesIdle')}</p> : null}
        {state.step === 'checking' ? <p className="text-sm text-fg-muted">{t('updatesChecking')}</p> : null}
        {state.step === 'current' ? (
          <p className="flex items-center gap-2 text-fg" data-testid="updates-current">
            <CircleCheck aria-hidden className="size-4 text-success" />
            {t('updatesCurrent')}
          </p>
        ) : null}
        {state.step === 'available' || state.step === 'installing' ? (
          <div className="flex flex-col gap-3" data-testid="updates-available">
            <div className="flex flex-col gap-0.5">
              <p className="font-display text-lg font-semibold text-fg">{t('updatesAvailable', { version: state.update.version })}</p>
              <p className="text-sm text-fg-muted">
                {state.update.date
                  ? t('updatesFromToDated', { current: state.update.currentVersion, when: absoluteTime(state.update.date, lang) })
                  : t('updatesFromTo', { current: state.update.currentVersion })}
              </p>
            </div>
            {state.update.body ? (
              <div
                className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-sm text-fg-muted"
                data-testid="updates-notes"
              >
                {state.update.body}
              </div>
            ) : null}
            {state.step === 'installing' ? (
              <div className="flex flex-col gap-1.5">
                <ProgressBar
                  value={state.total ? Math.min(100, Math.round((state.received / state.total) * 100)) : 0}
                  indeterminate={!state.total}
                  label={t('updatesDownloading')}
                />
                <p className="text-sm text-fg-muted">{t('updatesDownloading')}</p>
              </div>
            ) : (
              <div>
                <Button
                  variant="primary"
                  icon={<Download aria-hidden className="size-4" />}
                  onClick={() => void install(state.update)}
                  data-testid="updates-install"
                >
                  {t('updatesInstall', { version: state.update.version })}
                </Button>
              </div>
            )}
          </div>
        ) : null}
        {state.step === 'installed' ? (
          <div className="flex flex-col gap-1" data-testid="updates-installed">
            <p className="flex items-center gap-2 font-medium text-fg">
              <CircleCheck aria-hidden className="size-4 text-success" />
              {t('updatesInstalled', { version: state.version })}
            </p>
            <p className="text-sm text-fg-muted">{t('updatesRestart')}</p>
          </div>
        ) : null}
        {state.step === 'failed' ? (
          <div role="alert" className="flex flex-wrap items-start gap-3 text-sm" data-testid="updates-error">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="font-medium text-fg">{state.during === 'check' ? t('updatesCheckFailed') : t('updatesInstallFailed')}</p>
              <p className="break-words text-fg-muted">{state.message}</p>
            </div>
            {state.during === 'install' && state.update ? (
              <Button size="sm" variant="secondary" onClick={() => void install(state.update!)}>
                {t('retry')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsGroup>
  );
}
