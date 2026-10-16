import {
  // recording:
  AlarmClock,
  Bookmark,
  CalendarRange,
  ChartColumn,
  ChevronDown,
  Download,
  HardDrive,
  Heart,
  History,
  House,
  Keyboard,
  LayoutGrid,
  ListOrdered,
  ListVideo,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCw,
  Search,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import { type CSSProperties, type RefObject, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';

import { useRpcQuery } from '@/api/query';
import type { Source, SourceKind } from '@/api/types';
import { cn, hueOf, initialsOf, Skeleton } from '@/ui';

import { railLinks } from './railLinks';
import { useShellStore } from './store';
import { useVisibleSources } from './useVisibleSources';

interface PrimaryLink {
  to: string;
  labelKey: string;
  icon: LucideIcon;
  end?: boolean;
  /** First-run tour anchor (Run 3 C7, `src/features/onboarding/tour/steps.ts`). */
  tour?: 'vod' | 'search';
}

// Home is a house, not a layout glyph: collapsed, the rail is icons only, and a
// tile-shaped Home would echo Multi-view's grid (LayoutGrid, as in its page and menus).
const PRIMARY: PrimaryLink[] = [
  { to: '/dashboard', labelKey: 'navDashboard', icon: House },
  // The tour's search step points here only while the rail is auto-collapsed (below lg), where
  // the header's "Search everything" button folds away; from lg up the header keeps the anchor.
  { to: '/search', labelKey: 'navSearch', icon: Search, tour: 'search' },
  { to: '/epg', labelKey: 'navGuide', icon: CalendarRange },
  { to: '/multiview', labelKey: 'navMultiview', icon: LayoutGrid },
  { to: '/favorites', labelKey: 'navFavorites', icon: Heart },
  // The tour's "Movies, series and My List" step points here: unlike a source's Movies link, it
  // is always on screen, also in the collapsed rail.
  { to: '/my-list', labelKey: 'navMyList', icon: Bookmark, tour: 'vod' },
  // Run 2: custom channel lists and watch stats reuse their pages' titles.
  { to: '/lists', labelKey: 'lists:title', icon: ListOrdered },
  { to: '/recent', labelKey: 'navRecent', icon: History },
  { to: '/downloads', labelKey: 'navDownloads', icon: Download },
  { to: '/my-videos', labelKey: 'navMyVideos', icon: HardDrive },
  // recording:
  { to: '/scheduled', labelKey: 'navScheduled', icon: AlarmClock },
  { to: '/stats', labelKey: 'stats:title', icon: ChartColumn },
];

const KIND_LABEL: Record<SourceKind, string> = { m3u: 'M3U', xtream: 'XC', stalker: 'STB' };

/**
 * One look for every rail row: rest (muted), hover (soft fill, full text),
 * pressed (deeper fill), current (tuning tick, accent icon). The height is
 * --rail-item-height, so compact density tightens the rail with everything else.
 */
const itemClass = (active: boolean, collapsed: boolean) =>
  cn(
    'group flex h-(--rail-item-height) items-center gap-3 rounded-md text-sm font-medium outline-offset-[-2px]',
    'motion-safe:transition-colors motion-safe:duration-150',
    collapsed ? 'justify-center px-0' : 'px-3',
    active ? 'tuning-tick bg-surface-2 text-fg active:bg-surface-3' : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg active:bg-surface-3',
  );

function RailNavLink({ to, labelKey, icon: Icon, collapsed, end, tour }: PrimaryLink & { collapsed: boolean }) {
  const { t } = useTranslation('shell');
  const label = t(labelKey);
  return (
    <NavLink
      to={to}
      end={end}
      data-tour={tour}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      className={({ isActive }) => itemClass(isActive, collapsed)}
    >
      {({ isActive }) => (
        <>
          <Icon aria-hidden size={18} className={cn('shrink-0', isActive && 'text-accent')} />
          {!collapsed && <span className="truncate">{label}</span>}
        </>
      )}
    </NavLink>
  );
}

function SourceMark({ source, size = 'sm', errorDot }: { source: Source; size?: 'sm' | 'md'; errorDot?: boolean }) {
  const hue = hueOf(source.name);
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-sm font-display font-semibold text-white',
        size === 'sm' ? 'h-6 w-6 text-xs' : 'h-9 w-9 text-sm',
      )}
      style={{ background: `linear-gradient(150deg, hsl(${hue} 42% 38%), hsl(${(hue + 36) % 360} 48% 24%))` }}
    >
      {initialsOf(source.name)}
      {/* The collapsed rail has no room for the status column, so the error rides on the monogram. */}
      {errorDot && <span className="absolute -top-1 -end-1 h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-surface" />}
    </span>
  );
}

/**
 * How far the rail must scroll so `target` sits inside `box` with `pad` to spare: 0 when it
 * already does. A target taller than the box keeps its top edge in view (the source row the user
 * just opened), so the scroll never pushes the row itself out above. Exported for tests.
 */
export function railRevealDelta(box: { top: number; bottom: number }, target: { top: number; bottom: number }, pad = 24): number {
  if (target.top < box.top) return target.top - box.top - pad;
  if (target.bottom > box.bottom) return Math.min(target.bottom - box.bottom + pad, target.top - box.top - pad);
  return 0;
}

type MenuComponent = typeof import('@/ui/Menu').Menu;
let railMenu: MenuComponent | null = null;
let railMenuLoad: Promise<MenuComponent> | null = null;

/**
 * The collapsed rail's source menu loads in its own chunk: a static import put src/ui/Menu.tsx
 * (about 10 kB) into the entry chunk for a menu only the collapsed rail shows (L2-checks-2).
 * The collapsed rail asks for it as it mounts, before its sources load, so the entries normally
 * render the real menu from the start.
 */
function loadRailMenu(): Promise<MenuComponent> {
  railMenuLoad ??= import('@/ui/Menu').then((m) => (railMenu = m.Menu));
  return railMenuLoad;
}

/** The menu component once loaded, and a function that asks for it again. */
function useRailMenu(want: boolean): [MenuComponent | null, () => void] {
  const [menu, setMenu] = useState(() => railMenu);
  const live = useRef(true);
  const request = useCallback(() => {
    loadRailMenu().then(
      (m) => {
        if (live.current) setMenu(() => m);
      },
      () => {
        // A failed chunk load leaves the look-alike button, and the next press tries again.
        railMenuLoad = null;
      },
    );
  }, []);
  useEffect(() => {
    live.current = true;
    if (want && !menu) request();
    return () => {
      live.current = false;
    };
  }, [want, menu, request]);
  return [menu, request];
}

function SourceEntry({ source, collapsed, active, tour }: { source: Source; collapsed: boolean; active: boolean; tour?: 'live' }) {
  const { t } = useTranslation('shell');
  const [RailMenu, requestRailMenu] = useRailMenu(collapsed);
  const collapsedItemRef = useRef<HTMLLIElement>(null);
  // What the user did to the look-alike trigger before the menu arrived: focused it (focus moves
  // to the real trigger) or pressed it (the menu opens as it arrives).
  const intent = useRef<'focus' | 'open' | null>(null);
  useLayoutEffect(() => {
    const was = intent.current;
    if (!RailMenu || !was) return;
    intent.current = null;
    const trigger = collapsedItemRef.current?.querySelector('button');
    if (!trigger) return;
    trigger.focus();
    if (was === 'open') trigger.click();
  }, [RailMenu]);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [expanded, setExpanded] = useState(active);
  // Opening a source from a card or the palette expands its entry in the same render, not in an
  // effect a commit later: the rail's scroll effect runs once per route, and it must find the
  // active sub-link already on the page to bring it into view.
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setExpanded(true);
  }
  // The collapsed rail's menu lists Radio only once the m3u radio probe has answered: hovering
  // or focusing the monogram starts it, so a narrow window pays for no probe it never opens.
  const [warm, setWarm] = useState(false);
  const itemRef = useRef<HTMLLIElement>(null);
  const revealOnExpand = useRef(false);

  const radio = useRpcQuery(
    'catalog.channels',
    { sourceId: source.id, query: { offset: 0, limit: 1 }, radio: true },
    { enabled: source.kind === 'm3u' && (expanded || active || (collapsed && warm)), staleTime: 5 * 60_000 },
  );
  const links = railLinks(source, { hasRadio: (radio.data?.total ?? 0) > 0 });
  // Source ids may hold spaces or other characters an IDREF cannot carry.
  const listId = useId();

  // A source the user opens by hand slides its links into view: below the fold, a rotating
  // chevron alone says nothing happened.
  useEffect(() => {
    if (!expanded || !revealOnExpand.current) return;
    revealOnExpand.current = false;
    const item = itemRef.current;
    const box = item?.closest<HTMLElement>('[data-testid="rail-scroll"]');
    if (!item || !box) return;
    const delta = railRevealDelta(box.getBoundingClientRect(), item.getBoundingClientRect());
    if (delta === 0) return;
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (typeof box.scrollTo === 'function') box.scrollTo({ top: box.scrollTop + delta, behavior: smooth ? 'smooth' : 'auto' });
    else box.scrollTop += delta;
  }, [expanded]);

  if (collapsed) {
    const label = source.lastError ? `${source.name}, ${t('sourceHasError')}` : source.name;
    // Icons only, so the monogram opens the source's own links (Live, Movies, Series, Radio,
    // Favorites, Recent) in a menu: below lg the rail never expands, and a lone link to Live
    // left a phone with no way to its movies or series.
    const triggerClassName = cn(itemClass(active, true), 'w-full');
    const trigger = (
      <span title={label} className="inline-flex">
        <SourceMark source={source} errorDot={!!source.lastError} />
      </span>
    );
    const open = () => {
      intent.current = 'open';
      requestRailMenu();
    };
    return (
      <li ref={collapsedItemRef} data-tour={tour} onPointerEnter={() => setWarm(true)} onFocus={() => setWarm(true)}>
        {RailMenu ? (
          <RailMenu
            label={label}
            align="start"
            // Beside the monogram, not over the next ones: the rail is one icon wide.
            placement="inline-end"
            triggerClassName={triggerClassName}
            trigger={trigger}
            items={links.map((l) => {
              const current = pathname === l.to || pathname.startsWith(`${l.to}/`);
              return {
                id: l.id,
                label: t(l.labelKey),
                icon: <l.icon size={15} className={cn(current && 'text-accent')} />,
                hint: current ? <span className="sr-only">{t('railCurrentPage')}</span> : undefined,
                onSelect: () => navigate(l.to),
              };
            })}
          />
        ) : (
          // The menu's own trigger, as it renders closed, until the menu's chunk is in.
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={false}
            aria-label={label}
            className={triggerClassName}
            data-rail-menu-pending=""
            onClick={open}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                open();
              }
            }}
            onFocus={() => {
              intent.current ??= 'focus';
            }}
            onBlur={(e) => {
              // Focus moved on to another control; a blur with no next element is this button leaving.
              if (e.relatedTarget && intent.current === 'focus') intent.current = null;
            }}
          >
            {trigger}
          </button>
        )}
      </li>
    );
  }

  return (
    <li ref={itemRef}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        data-tour={tour}
        onClick={() => {
          revealOnExpand.current = !expanded;
          setExpanded((v) => !v);
        }}
        className={cn(
          'flex h-(--rail-item-height) w-full items-center gap-3 rounded-md px-3 text-start text-sm motion-safe:transition-colors motion-safe:duration-150',
          active ? 'text-fg hover:bg-surface-2/60 active:bg-surface-3' : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg active:bg-surface-3',
        )}
      >
        <SourceMark source={source} />
        <span dir="auto" title={source.name} className="min-w-0 flex-1 truncate text-match-parent font-medium">
          {source.name}
        </span>
        {source.lastError ? (
          // aria-label is not allowed on a plain span; the sr-only text joins the button's name.
          <span className="h-2 w-2 shrink-0 rounded-full bg-danger" title={t('sourceHasError')}>
            <span className="sr-only">{t('sourceHasError')}</span>
          </span>
        ) : (
          <span className="shrink-0 text-2xs font-semibold text-fg-subtle">{KIND_LABEL[source.kind]}</span>
        )}
        <ChevronDown
          aria-hidden
          size={14}
          className={cn('shrink-0 text-fg-subtle motion-safe:transition-transform', expanded ? 'rotate-0' : '-rotate-90 rtl:rotate-90')}
        />
      </button>
      {/* The sublinks hang off a line through the middle of the source mark: px-3 plus half its w-6. */}
      {expanded && (
        <ul id={listId} className="mt-0.5 mb-1 ms-6 flex flex-col gap-0.5 border-s border-divider ps-2">
          {links.map((l) => (
            <li key={l.id}>
              <NavLink
                to={l.to}
                className={({ isActive }) =>
                  cn(
                    'flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-sm motion-safe:transition-colors motion-safe:duration-150',
                    isActive ? 'tuning-tick bg-surface-2 font-medium text-fg active:bg-surface-3' : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg active:bg-surface-3',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <l.icon aria-hidden size={15} className={cn('shrink-0', isActive && 'text-accent')} />
                    <span className="truncate">{t(l.labelKey)}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The global links' most height: all of it while the sources keep RAIL_SOURCES_MIN (10rem: their
 * heading and two or three sources), and never under half the rail, so a very short window
 * splits the room. A percentage of the rail's middle, which has a definite flexed height.
 */
const RAIL_PRIMARY_MAX = 'max-h-[max(50%,calc(100%-10rem))]';

/**
 * The source the first-run tour's "Live TV" step points at: the first with live channels and no
 * import error, else the first with live channels at all, else none (the step then shows as a
 * centred card). The first in the list could be one that failed to import (L3-app-6).
 */
export function liveTourSource(sources: readonly Source[] | undefined): Source | undefined {
  const watchable = (sources ?? []).filter((s) => s.channelCount > 0);
  return watchable.find((s) => !s.lastError) ?? watchable[0];
}

/** Fade masks for the rail's scrolling list: a soft edge where links continue out of view. */
const FADE = '24px';
export function railFadeMask(top: boolean, bottom: boolean): CSSProperties | undefined {
  if (!top && !bottom) return undefined;
  const stops = [top ? `transparent, #000 ${FADE}` : '#000', bottom ? `#000 calc(100% - ${FADE}), transparent` : '#000'];
  const image = `linear-gradient(to bottom, ${stops.join(', ')})`;
  return { maskImage: image, WebkitMaskImage: image };
}

/**
 * At laptop heights the rail's links overflow: the edge that has more links fades out, and on
 * every route change the active link scrolls into the visible part of its list (only the rail
 * scrolls, never the page). The global links and the sources scroll apart (see Rail).
 */
function useRailScroll(ref: RefObject<HTMLDivElement | null>, scrollKey: string, deps: readonly unknown[]): { top: boolean; bottom: boolean } {
  const [fade, setFade] = useState({ top: false, bottom: false });
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const top = el.scrollTop > 1;
      const bottom = el.scrollHeight - el.clientHeight - el.scrollTop > 1;
      setFade((f) => (f.top === top && f.bottom === bottom ? f : { top, bottom }));
    };
    // Once per route, so a refetch never undoes the user's own scrolling of the rail. The route
    // only counts as handled once its link was found: the source links arrive with the sources.
    const active = scrolledFor.current === scrollKey ? null : el.querySelector<HTMLElement>('[aria-current="page"]');
    if (active) {
      scrolledFor.current = scrollKey;
      el.scrollTop += railRevealDelta(el.getBoundingClientRect(), active.getBoundingClientRect());
    }
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (ro) {
      ro.observe(el);
      for (const child of el.children) ro.observe(child);
    }
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, ...deps]);
  return fade;
}

export function Rail({ collapsed, autoCollapsed }: { collapsed: boolean; autoCollapsed: boolean }) {
  const { t } = useTranslation('shell');
  const sources = useVisibleSources();
  const toggleRail = useShellStore((s) => s.toggleRail);
  const setHelpOpen = useShellStore((s) => s.setHelpOpen);
  const location = useLocation();
  const activeSourceId = /^\/s\/([^/]+)/.exec(location.pathname)?.[1];
  const primaryRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollKey = `${location.pathname}|${sources.data ? 'ready' : 'pending'}`;
  const primaryFade = useRailScroll(primaryRef, scrollKey, [collapsed]);
  const fade = useRailScroll(scrollRef, scrollKey, [sources.data, collapsed]);
  const tourSourceId = liveTourSource(sources.data)?.id;
  // Collapsed, each source is a menu: start its chunk now, while the sources still load.
  useEffect(() => {
    if (collapsed) void loadRailMenu().catch(() => {});
  }, [collapsed]);

  return (
    <nav
      aria-label={t('mainNavigation')}
      data-testid="shell-rail"
      data-collapsed={collapsed || undefined}
      className={cn(
        'flex h-full shrink-0 flex-col border-e border-divider bg-surface',
        collapsed ? 'w-(--rail-width-collapsed)' : 'w-(--rail-width)',
      )}
    >
      <div className={cn('flex h-(--header-height) shrink-0 items-center gap-2', collapsed ? 'justify-center px-2' : 'px-4')}>
        <Link to="/dashboard" className="flex min-w-0 items-center gap-2.5 rounded-md" aria-label={t('appName')}>
          <span aria-hidden className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-3">
            <span className="absolute inset-x-2 bottom-2 h-0.5 rounded-full bg-fg-subtle/60" />
            <span className="absolute bottom-2 left-[55%] h-4 w-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />
          </span>
          {!collapsed && <span className="truncate font-display text-lg font-semibold tracking-wide">{t('appName')}</span>}
        </Link>
      </div>

      {/*
        Two lists that scroll apart: the global links keep their full height (scrolling on their
        own only when the window is too short to leave the sources 10rem), and the
        sources take the rest. Opening a source's page reveals its link inside the sources list,
        so Home, Search and the guide stay on screen (L3-visual-2); one shared scroller pushed
        them out at every laptop height.
      */}
      <div className="flex min-h-0 flex-1 flex-col gap-5">
        <div
          ref={primaryRef}
          data-testid="rail-primary"
          data-fade-top={primaryFade.top || undefined}
          data-fade-bottom={primaryFade.bottom || undefined}
          style={railFadeMask(primaryFade.top, primaryFade.bottom)}
          className={cn('shrink-0 overflow-y-auto overflow-x-hidden px-2', RAIL_PRIMARY_MAX)}
        >
          <ul className="flex flex-col gap-0.5">
            {PRIMARY.map((l) => (
              <li key={l.to}>
                <RailNavLink {...l} collapsed={collapsed} tour={l.tour === 'search' && !autoCollapsed ? undefined : l.tour} />
              </li>
            ))}
          </ul>
        </div>

        <div
          ref={scrollRef}
          data-testid="rail-scroll"
          data-fade-top={fade.top || undefined}
          data-fade-bottom={fade.bottom || undefined}
          style={railFadeMask(fade.top, fade.bottom)}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-2 pb-3"
        >
          <section aria-labelledby="rail-sources-heading" className="flex flex-col gap-1">
            <div className={cn('flex items-center', collapsed ? 'justify-center' : 'justify-between px-3')}>
              <h2 id="rail-sources-heading" className={cn('text-xs font-semibold text-fg-subtle', collapsed && 'sr-only')}>
                {t('sources')}
              </h2>
              <Link
                to="/sources?add=1"
                title={t('addSource')}
                aria-label={t('addSource')}
                className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-2 hover:text-fg active:bg-surface-3 motion-safe:transition-colors"
              >
                <Plus aria-hidden size={16} />
              </Link>
            </div>
            {sources.isPending ? (
              <div className="flex flex-col gap-2 px-3 py-1" aria-hidden>
                <Skeleton className="h-6" />
                <Skeleton className="h-6 w-4/5" />
              </div>
            ) : sources.isError ? (
              <div
                data-testid="rail-sources-error"
                className={cn('flex items-center gap-2', collapsed ? 'justify-center' : 'justify-between ps-3 pe-1')}
              >
                <p role="alert" className={cn('min-w-0 text-sm text-danger', collapsed && 'sr-only')}>
                  {t('sourcesLoadFailed')}
                </p>
                <button
                  type="button"
                  onClick={() => void sources.refetch()}
                  disabled={sources.isFetching}
                  title={t('retry', { ns: 'common' })}
                  aria-label={t('retry', { ns: 'common' })}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:bg-surface-2 hover:text-fg active:bg-surface-3 motion-safe:transition-colors disabled:opacity-50"
                >
                  <RotateCw aria-hidden size={15} className={cn(sources.isFetching && 'motion-safe:animate-spin')} />
                </button>
              </div>
            ) : sources.data && sources.data.length > 0 ? (
              <ul className="flex flex-col gap-0.5" data-testid="rail-sources">
                {sources.data.map((s) => (
                  <SourceEntry
                    key={s.id}
                    source={s}
                    collapsed={collapsed}
                    active={activeSourceId === encodeURIComponent(s.id) || activeSourceId === s.id}
                    // The tour's "Live TV" step points at a source whose channels are there to watch.
                    tour={s.id === tourSourceId ? 'live' : undefined}
                  />
                ))}
              </ul>
            ) : (
              !collapsed && (
                <p className="px-3 text-sm text-fg-muted">
                  {t('noSourcesYet')}{' '}
                  <Link to="/sources?add=1" className="rounded-sm font-medium text-accent hover:underline active:text-accent-pressed">
                    {t('addFirstSource')}
                  </Link>
                </p>
              )
            )}
            <RailNavLink to="/sources" labelKey="manageSources" icon={ListVideo} collapsed={collapsed} end />
          </section>
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-0.5 border-t border-divider p-2">
        <RailNavLink to="/settings" labelKey="navSettings" icon={SettingsIcon} collapsed={collapsed} />
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          title={collapsed ? t('keyboardShortcuts') : undefined}
          aria-label={collapsed ? t('keyboardShortcuts') : undefined}
          className={itemClass(false, collapsed)}
        >
          <Keyboard aria-hidden size={18} className="shrink-0" />
          {!collapsed && <span className="truncate">{t('keyboardShortcuts')}</span>}
        </button>
        {!autoCollapsed && (
          <button
            type="button"
            onClick={toggleRail}
            aria-label={collapsed ? t('expandRail') : t('collapseRail')}
            title={collapsed ? t('expandRail') : t('collapseRail')}
            className={itemClass(false, collapsed)}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden size={18} className="shrink-0 rtl:-scale-x-100" />
            ) : (
              <PanelLeftClose aria-hidden size={18} className="shrink-0 rtl:-scale-x-100" />
            )}
            {!collapsed && <span className="truncate">{t('collapseRail')}</span>}
          </button>
        )}
      </div>
    </nav>
  );
}
