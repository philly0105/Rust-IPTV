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
import { isDesktop } from '@/api/transport';
import { Badge, Button, cn, Dialog, Skeleton } from '@/ui';

import { releasesToShow } from './decide';
import { RELEASE_NOTES, notesFor, type ReleaseNoteItem, type ReleaseNotes } from './notes';
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
    <div role="status" aria-busy="true" className="flex flex-col gap-5" data-testid="whats-new-loading">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-60 rounded-lg" />
      <div className="flex flex-col gap-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton className="size-4 shrink-0 rounded-xs" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-11/12" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** How many items of the newest release lead in the highlights panel; the rest follow as a compact list. */
const HIGHLIGHTS = 3;

/**
 * One of the newest release's leading changes: a row of the highlights panel, its icon in a tile
 * beside the title and text. Rows at every width: three columns in the dialog were about 185 px
 * each, and their texts ran to five lines.
 */
function Highlight({ item }: { item: ReleaseNoteItem }) {
  const { t } = useOnboardingStrings();
  const Icon = item.icon;
  return (
    <li className="flex items-start gap-3 p-4" data-testid="whats-new-item" data-highlight="">
      <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-edge bg-surface text-fg">
        <Icon size={18} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-body font-semibold leading-snug text-fg">{t(`${item.key}Title`)}</p>
        <p className="text-body-sm text-pretty text-fg-muted">{t(`${item.key}Text`)}</p>
      </div>
    </li>
  );
}

/** Any other change: one row, the icon small and quiet, the text in full. */
function Row({ item }: { item: ReleaseNoteItem }) {
  const { t } = useOnboardingStrings();
  const Icon = item.icon;
  return (
    <li className="flex items-start gap-3 py-3" data-testid="whats-new-item">
      <Icon aria-hidden size={16} className="mt-0.5 shrink-0 text-fg-subtle" />
      <div className="min-w-0">
        <p className="text-body-sm font-medium text-fg">{t(`${item.key}Title`)}</p>
        <p className="text-body-sm text-fg-muted">{t(`${item.key}Text`)}</p>
      </div>
    </li>
  );
}

/**
 * One release. The newest leads with its first three changes as highlight rows, then the rest as
 * a single-column list; older releases (opened by hand from About) are lists under a version
 * badge. The release the dialog's description names (the running version) has no heading of its
 * own, so its badge never stands alone on a row above the highlights.
 */
function Release({ release, showVersion, lead }: { release: ReleaseNotes; showVersion: boolean; lead: boolean }) {
  const { t } = useOnboardingStrings();
  const highlights = lead ? release.items.slice(0, HIGHLIGHTS) : [];
  const rest = lead ? release.items.slice(HIGHLIGHTS) : release.items;
  return (
    <section aria-label={showVersion ? t('whatsNewVersion', { version: release.version }) : undefined} className="flex flex-col gap-3">
      {showVersion && (
        <h3 className="flex items-center gap-2">
          <Badge className="tabular-nums">{t('whatsNewVersion', { version: release.version })}</Badge>
        </h3>
      )}
      {highlights.length > 0 && (
        <ul className="flex flex-col divide-y divide-divider rounded-lg border border-edge bg-surface-2" data-testid="whats-new-highlights">
          {highlights.map((item) => (
            <Highlight key={item.key} item={item} />
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <ul className="flex flex-col divide-y divide-divider">
          {rest.map((item) => (
            <Row key={item.key} item={item} />
          ))}
        </ul>
      )}
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
    // Only what applies here: a browser does not hear about the desktop window (SR-9).
    if (version) return notesFor(releasesToShow(RELEASE_NOTES, version, since), isDesktop);
    // Version unknown (app.info failed): a hand-made open still lists what there is.
    return info.isError && since === null ? notesFor(RELEASE_NOTES, isDesktop) : [];
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
      // The running version, in the header; older releases listed under it carry their own badge.
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
            <div className="flex flex-col gap-8">
              {releases.map((r, i) => (
                <Release key={r.version} release={r} showVersion={releases.length > 1 && r.version !== version} lead={i === 0} />
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
