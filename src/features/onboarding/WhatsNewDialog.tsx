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

interface ScrollEdges {
  /** The content is taller than the region. */
  scrollable: boolean;
  /** Scrolled to the top (or not scrollable). */
  atStart: boolean;
  /** Scrolled to the bottom (or not scrollable). */
  atEnd: boolean;
}

const NO_SCROLL: ScrollEdges = { scrollable: false, atStart: true, atEnd: true };

/**
 * Whether the list overflows, and whether it sits at either end. The list is a Tab stop only
 * while it scrolls (keyboard users can scroll it; nobody tabs through a dead stop), and a fade
 * marks each edge that has more content past it, so a row cut by the footer reads as "scroll
 * for more". `contentKey` re-measures when the content swaps (skeleton to list).
 */
function useScrollEdges<T extends HTMLElement>(contentKey: string): [RefCallback<T>, ScrollEdges] {
  const [el, setEl] = useState<T | null>(null);
  const [edges, setEdges] = useState<ScrollEdges>(NO_SCROLL);
  useEffect(() => {
    if (!el) return;
    const check = () => {
      const scrollable = el.scrollHeight > el.clientHeight + 1;
      const next: ScrollEdges = {
        scrollable,
        atStart: !scrollable || el.scrollTop <= 1,
        atEnd: !scrollable || el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
      };
      setEdges((prev) =>
        prev.scrollable === next.scrollable && prev.atStart === next.atStart && prev.atEnd === next.atEnd ? prev : next,
      );
    };
    check();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    ro?.observe(el);
    for (const child of Array.from(el.children)) ro?.observe(child);
    el.addEventListener('scroll', check, { passive: true });
    return () => {
      ro?.disconnect();
      el.removeEventListener('scroll', check);
    };
  }, [el, contentKey]);
  return [setEl, edges];
}

/** A fade over one edge of the list while more content lies past it. Inset 2 px so the list's focus ring stays visible. */
function EdgeFade({ edge, shown }: { edge: 'top' | 'bottom'; shown: boolean }) {
  return (
    <div
      aria-hidden
      data-testid={`whats-new-fade-${edge}`}
      data-shown={shown || undefined}
      className={cn(
        'pointer-events-none absolute inset-x-[2px] from-surface to-transparent motion-safe:transition-opacity motion-safe:duration-150',
        edge === 'top' ? 'top-[2px] h-6 bg-gradient-to-b' : 'bottom-[2px] h-12 bg-gradient-to-t',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    />
  );
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
            <span aria-hidden className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-muted">
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

  const releases = useMemo<ReleaseNotes[]>(() => {
    if (version) return releasesToShow(RELEASE_NOTES, version, since);
    // Version unknown (app.info failed): a hand-made open still lists what there is.
    return info.isError && since === null ? [...RELEASE_NOTES] : [];
  }, [version, since, info.isError]);
  const loading = info.isPending;
  const [listRef, edges] = useScrollEdges<HTMLDivElement>(`${loading}|${releases.map((r) => r.version).join(',')}`);

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
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={listRef}
          role="region"
          aria-label={t('whatsNewTitle')}
          tabIndex={edges.scrollable ? 0 : undefined}
          className={cn('min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-1', edges.scrollable && 'focus-visible:outline-offset-[-2px]')}
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
        <EdgeFade edge="top" shown={!edges.atStart} />
        <EdgeFade edge="bottom" shown={!edges.atEnd} />
      </div>
    </Dialog>
  );
}
