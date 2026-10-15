/**
 * What's new (contract C7): the release notes since the version the user
 * last saw, each item with its icon. Closing it (Got it, Escape, the close
 * button or the backdrop) stores the running version in
 * `settings.lastSeenVersion`, so it shows once per update.
 *
 * Opened by the startup decision with `since` (rule B: '' for the current
 * version only; rule C: the last seen version), or by hand (`since: null`)
 * from the About section, which lists every release so far. A startup open
 * with nothing to list stores the version and shows nothing.
 */

import { Compass } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefCallback } from 'react';

import { useRpcQuery } from '@/api/query';
import { Button, cn, Dialog, Skeleton } from '@/ui';

import { releasesToShow } from './decide';
import { RELEASE_NOTES, type ReleaseNotes } from './notes';
import { saveOnboarding } from './persist';
import { openTour } from './store';
import { useOnboardingStrings } from './strings';

export interface WhatsNewDialogProps {
  since: string | null;
  auto: boolean;
  onClose: () => void;
}

/** Makes the list a Tab stop only while it scrolls, so keyboard users can scroll it and nobody tabs through a dead stop. */
function useScrollable<T extends HTMLElement>(): [RefCallback<T>, boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    if (!el) return;
    const check = () => setScrollable(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    ro?.observe(el);
    for (const child of Array.from(el.children)) ro?.observe(child);
    return () => ro?.disconnect();
  }, [el]);
  return [setEl, scrollable];
}

function NotesSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" className="grid gap-x-6 gap-y-5 sm:grid-cols-2" data-testid="whats-new-loading">
      <span className="sr-only">{label}</span>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-start gap-3.5">
          <Skeleton className="h-9 w-9 shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Release({ release, showVersion }: { release: ReleaseNotes; showVersion: boolean }) {
  const { t } = useOnboardingStrings();
  return (
    <section aria-label={showVersion ? t('whatsNewVersion', { version: release.version }) : undefined}>
      {showVersion && (
        <h3 className="mb-3 font-display text-sm font-semibold text-fg-muted">{t('whatsNewVersion', { version: release.version })}</h3>
      )}
      <ul className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        {release.items.map(({ key, icon: Icon }) => (
          <li key={key} className="flex items-start gap-3.5" data-testid="whats-new-item">
            <span aria-hidden className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-accent">
              <Icon size={18} />
            </span>
            <div className="min-w-0">
              <p className="font-medium leading-snug text-fg">{t(`${key}Title`)}</p>
              <p className="mt-0.5 text-sm text-fg-muted">{t(`${key}Text`)}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function WhatsNewDialog({ since, auto, onClose }: WhatsNewDialogProps) {
  const { t, ready } = useOnboardingStrings();
  const info = useRpcQuery('app.info', undefined, { staleTime: Infinity });
  const settings = useRpcQuery('settings.get', undefined, { staleTime: Infinity });
  const sources = useRpcQuery('sources.list', undefined);
  const version = info.data?.version;
  const [listRef, scrollable] = useScrollable<HTMLDivElement>();

  const releases = useMemo<ReleaseNotes[]>(() => {
    if (version) return releasesToShow(RELEASE_NOTES, version, since);
    // Version unknown (app.info failed): a hand-made open still lists what there is.
    return info.isError && since === null ? [...RELEASE_NOTES] : [];
  }, [version, since, info.isError]);

  const closedRef = useRef(false);
  const lastSeen = settings.data?.lastSeenVersion;
  const close = useCallback(
    (then?: () => void) => {
      if (closedRef.current) return;
      closedRef.current = true;
      if (version && lastSeen !== version) void saveOnboarding({ lastSeenVersion: version });
      onClose();
      then?.();
    },
    [version, lastSeen, onClose],
  );

  // A startup open with nothing in range: remember the version and stay out of the way.
  const nothingToShow = auto && !!version && releases.length === 0;
  useEffect(() => {
    if (nothingToShow) close();
  }, [nothingToShow, close]);

  if (!ready || nothingToShow) return null;

  const loading = info.isPending;
  const canTour = (sources.data?.length ?? 0) > 0;

  return (
    <Dialog
      open
      onClose={() => close()}
      title={t('whatsNewTitle')}
      description={version ? t('whatsNewVersion', { version }) : undefined}
      size="lg"
      testId="whats-new"
      // The list scrolls inside its own region (a Tab stop while it overflows), not the dialog body.
      bodyClassName="flex flex-col overflow-hidden px-0 pb-0"
      footer={
        <>
          {canTour && (
            <Button variant="ghost" icon={<Compass aria-hidden size={16} />} onClick={() => close(openTour)} className="me-auto">
              {t('whatsNewTour')}
            </Button>
          )}
          <Button variant="primary" data-autofocus="" onClick={() => close()} data-testid="whats-new-close">
            {t('whatsNewClose')}
          </Button>
        </>
      }
    >
      <div
        ref={listRef}
        role="region"
        aria-label={t('whatsNewTitle')}
        tabIndex={scrollable ? 0 : undefined}
        className={cn('min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-1', scrollable && 'focus-visible:outline-offset-[-2px]')}
        data-testid="whats-new-list"
      >
        {loading ? (
          <NotesSkeleton label={t('loading', { ns: 'common' })} />
        ) : releases.length === 0 ? (
          <p className="py-6 text-center text-sm text-fg-muted" data-testid="whats-new-empty">
            {t('whatsNewEmpty')}
          </p>
        ) : (
          <div className="flex flex-col gap-7">
            {releases.map((r) => (
              <Release key={r.version} release={r} showVersion={releases.length > 1} />
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
