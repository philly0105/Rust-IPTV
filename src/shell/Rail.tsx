import { ChevronDown, Keyboard, ListVideo, PanelLeftClose, PanelLeftOpen, Plus, RotateCw, Settings as SettingsIcon } from 'lucide-react';
import { type CSSProperties, type ReactNode, type RefObject, memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';

import { useRpcQuery } from '@/api/query';
import type { Source } from '@/api/types';
import { BrandMark, cn, hueOf, IconButton, initialsOf, Skeleton, Tooltip } from '@/ui';

import { useOffline } from './connection';
import { LIBRARY_LINKS, WATCH_LINKS, type NavLinkDef } from './navigation';
import { railLinks, routeSourceId } from './railLinks';
import { kindShortKey } from './sourceKind';
import { useShellStore } from './store';
import { useVisibleSources } from './useVisibleSources';

/**
 * One look for every rail row: rest (muted), hover (the see-through hover layer, full text),
 * pressed (the active layer), current (the neutral selected fill, tuning tick, accent icon). The
 * height is --rail-item-height, so compact density tightens the rail with everything else.
 * `dim`: a Library link while there are no sources, where every one of them opens empty.
 */
const itemClass = (active: boolean, collapsed: boolean, dim = false) =>
  cn(
    'group flex h-(--rail-item-height) items-center gap-3 rounded-md text-sm font-medium outline-offset-[-2px]',
    'motion-safe:transition-colors motion-safe:duration-150',
    collapsed ? 'justify-center px-0' : 'px-3',
    active
      ? 'tuning-tick bg-selected text-fg active:bg-active'
      : cn(dim ? 'text-fg-subtle' : 'text-fg-muted', 'hover:bg-hover hover:text-fg active:bg-active'),
  );

function RailNavLink({
  to,
  labelKey,
  icon: Icon,
  collapsed,
  end,
  tour,
  dim,
}: Pick<NavLinkDef, 'to' | 'labelKey' | 'icon' | 'end' | 'tour'> & { collapsed: boolean; dim?: boolean; tour?: string }) {
  const { t } = useTranslation('shell');
  const label = t(labelKey);
  return (
    <Tooltip content={collapsed ? label : null} side="inline-end" describe={false}>
      <NavLink
        to={to}
        end={end}
        data-tour={tour}
        aria-label={collapsed ? label : undefined}
        className={({ isActive }) => itemClass(isActive, collapsed, dim)}
      >
        {({ isActive }) => (
          <>
            <Icon aria-hidden size={18} className={cn('shrink-0', isActive && 'text-accent')} />
            {!collapsed && <span className="truncate">{label}</span>}
          </>
        )}
      </NavLink>
    </Tooltip>
  );
}

/**
 * A group's small label (Watch, Library, Sources). Collapsed, the rail has no room for words:
 * the label stays for screen readers and a short rule marks the break between the groups.
 */
function GroupLabel({ id, label, collapsed, action }: { id: string; label: string; collapsed: boolean; action?: ReactNode }) {
  if (collapsed) {
    return (
      <>
        <h2 id={id} className="sr-only">
          {label}
        </h2>
        <span aria-hidden className="mx-3 my-1.5 block border-t border-divider" data-rail-group-rule="" />
        {action && <div className="flex justify-center">{action}</div>}
      </>
    );
  }
  return (
    <div className="flex h-8 items-center justify-between ps-3 pe-1 pt-2">
      <h2 id={id} className="truncate text-caption font-medium text-fg-subtle">
        {label}
      </h2>
      {action}
    </div>
  );
}

/** A labelled group of rail links (Watch, Library). */
function RailGroup({
  id,
  label,
  links,
  collapsed,
  dim,
  first,
}: {
  id: string;
  label: string;
  links: readonly NavLinkDef[];
  collapsed: boolean;
  dim?: boolean;
  /** The first group sits straight under the brand row: no rule above it when collapsed. */
  first?: boolean;
}) {
  return (
    <div role="group" aria-labelledby={id} data-rail-group={id} className="flex flex-col">
      {collapsed && first ? (
        <h2 id={id} className="sr-only">
          {label}
        </h2>
      ) : (
        <GroupLabel id={id} label={label} collapsed={collapsed} />
      )}
      <ul className="flex flex-col gap-0.5">
        {links.map((l) => (
          <li key={l.to}>
            <RailNavLink {...l} collapsed={collapsed} dim={dim} />
          </li>
        ))}
      </ul>
    </div>
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

function SourceEntry({
  source,
  collapsed,
  active,
  only = false,
  tour,
}: {
  source: Source;
  collapsed: boolean;
  active: boolean;
  /** The only source: it opens expanded, so Live TV, Movies and Series are one click away (SH-rail-ia). */
  only?: boolean;
  tour?: 'live';
}) {
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
  // Collapsed, the entry is a menu and has nothing to expand (nor a radio probe to start).
  const [expanded, setExpanded] = useState(active || (only && !collapsed));
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
      <span className="inline-flex">
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
            tooltip={label}
            tooltipSide="inline-end"
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
          <Tooltip content={label} side="inline-end" describe={false}>
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
          </Tooltip>
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
          active ? 'text-fg hover:bg-hover active:bg-active' : 'text-fg-muted hover:bg-hover hover:text-fg active:bg-active',
        )}
      >
        <SourceMark source={source} />
        <span dir="auto" title={source.name} className="min-w-0 flex-1 truncate text-match-parent font-medium">
          {source.name}
        </span>
        {/* The kind, spoken after the name; on screen the monogram and the name are enough (SH-kind-labels-copy). */}
        <span className="sr-only">{`, ${t(kindShortKey(source.kind))}`}</span>
        {source.lastError && (
          // aria-label is not allowed on a plain span; the sr-only text joins the button's name.
          <span className="h-2 w-2 shrink-0 rounded-full bg-danger" title={t('sourceHasError')}>
            <span className="sr-only">{t('sourceHasError')}</span>
          </span>
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
                    isActive ? 'tuning-tick bg-selected font-medium text-fg active:bg-active' : 'text-fg-muted hover:bg-hover hover:text-fg active:bg-active',
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
 * The Watch links' most height: all of it while the rest keeps RAIL_SOURCES_MIN (10rem: a group
 * label and two or three rows), and never under half the rail, so a very short window splits
 * the room. A percentage of the rail's middle, which has a definite flexed height.
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

/** Where the zero-sources state already shows the add flow, the rail adds no second call to action. */
const ONBOARDING_ROUTES = new Set(['/dashboard', '/sources']);

/** Memoized (performance audit SH-1): it follows the location itself, so the shell's own re-renders pass it by. */
export const Rail = memo(function Rail({ collapsed, autoCollapsed }: { collapsed: boolean; autoCollapsed: boolean }) {
  const { t } = useTranslation('shell');
  const sources = useVisibleSources();
  const offline = useOffline();
  const toggleRail = useShellStore((s) => s.toggleRail);
  const toggleRailHidden = useShellStore((s) => s.toggleRailHidden);
  const setHelpOpen = useShellStore((s) => s.setHelpOpen);
  const location = useLocation();
  // The archive (`/live/archive/:id/...`) belongs to its source too: the rail marks and opens it.
  const activeSourceId = routeSourceId(location.pathname);
  const primaryRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollKey = `${location.pathname}|${sources.data ? 'ready' : 'pending'}`;
  const primaryFade = useRailScroll(primaryRef, scrollKey, [collapsed]);
  const fade = useRailScroll(scrollRef, scrollKey, [sources.data, collapsed]);
  const tourSourceId = liveTourSource(sources.data)?.id;
  const sourceCount = sources.data?.length ?? 0;
  const noSources = sources.isSuccess && sourceCount === 0;
  // Collapsed, each source is a menu: start its chunk now, while the sources still load.
  useEffect(() => {
    if (collapsed) void loadRailMenu().catch(() => {});
  }, [collapsed]);

  const addSource = (
    <Tooltip content={t('addSource')} describe={false}>
      <Link
        to="/sources?add=1"
        aria-label={t('addSource')}
        className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-fg-subtle hover:bg-hover hover:text-fg active:bg-active motion-safe:transition-colors"
      >
        <Plus aria-hidden size={16} />
      </Link>
    </Tooltip>
  );

  let sourceList: ReactNode;
  if (sources.isPending || (sources.isError && offline)) {
    // Also while the shell's offline strip is up: one surface reports the outage (SH-offline-stack).
    sourceList = (
      <div className={cn('flex flex-col gap-2 py-1', collapsed ? 'items-center' : 'px-3')} aria-hidden data-testid="rail-sources-pending">
        <Skeleton className={collapsed ? 'h-6 w-6' : 'h-6'} />
        <Skeleton className={collapsed ? 'h-6 w-6' : 'h-6 w-4/5'} />
      </div>
    );
  } else if (sources.isError) {
    sourceList = (
      <div data-testid="rail-sources-error" className={cn('flex items-center gap-2', collapsed ? 'justify-center' : 'justify-between ps-3 pe-1')}>
        <p role="alert" className={cn('min-w-0 text-sm text-danger', collapsed && 'sr-only')}>
          {t('sourcesLoadFailed')}
        </p>
        <IconButton
          size="sm"
          label={t('retry', { ns: 'common' })}
          tooltipSide="inline-end"
          onClick={() => void sources.refetch()}
          disabled={sources.isFetching}
          icon={<RotateCw aria-hidden size={15} className={cn(sources.isFetching && 'motion-safe:animate-spin')} />}
        />
      </div>
    );
  } else if (sources.data && sources.data.length > 0) {
    sourceList = (
      <ul className="flex flex-col gap-0.5" data-testid="rail-sources">
        {sources.data.map((s) => (
          <SourceEntry
            key={s.id}
            source={s}
            collapsed={collapsed}
            active={activeSourceId === s.id}
            only={sourceCount === 1}
            // The tour's "Live TV" step points at a source whose channels are there to watch.
            tour={s.id === tourSourceId ? 'live' : undefined}
          />
        ))}
      </ul>
    );
  } else if (!ONBOARDING_ROUTES.has(location.pathname)) {
    // No sources: one dashed row in the shape of the rows it stands for (SH-welcome-generic).
    sourceList = (
      <Tooltip content={collapsed ? t('addSource') : null} side="inline-end" describe={false}>
        <Link
          to="/sources?add=1"
          aria-label={collapsed ? t('addSource') : undefined}
          data-testid="rail-add-source"
          className={cn(
            itemClass(false, collapsed),
            'border border-dashed border-edge text-fg-muted hover:border-border hover:text-fg',
          )}
        >
          <Plus aria-hidden size={18} className="shrink-0" />
          {!collapsed && <span className="truncate">{t('addSource')}</span>}
        </Link>
      </Tooltip>
    );
  }

  const footerButton = 'text-fg-muted pointer-coarse:hidden';

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
          {/* The colour mark is the app icon: the same in every theme and accent, never tinted. */}
          <BrandMark size={collapsed ? 32 : 28} className="shrink-0" />
          {!collapsed && <span className="truncate font-display text-title-sm tracking-tight">{t('appName')}</span>}
        </Link>
      </div>

      {/*
        Two blocks that scroll apart: the Watch links stay put (scrolling on their own only when
        the window is too short to leave the rest 10rem), and Library and the sources share the
        rest. Opening a source's page reveals its link inside that block, so Home, Search and the
        guide stay on screen (L3-visual-2); one shared scroller pushed them out at every laptop
        height. Library scrolls with the sources rather than standing over them: pinned, it left
        the sources about 10rem at 768 px, too little for one expanded source.
      */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={primaryRef}
          data-testid="rail-primary"
          data-fade-top={primaryFade.top || undefined}
          data-fade-bottom={primaryFade.bottom || undefined}
          style={railFadeMask(primaryFade.top, primaryFade.bottom)}
          className={cn('shrink-0 overflow-y-auto overflow-x-hidden px-2 pb-1', RAIL_PRIMARY_MAX)}
        >
          <RailGroup id="rail-watch-heading" label={t('navGroupWatch')} links={WATCH_LINKS} collapsed={collapsed} first />
        </div>

        <div
          ref={scrollRef}
          data-testid="rail-scroll"
          data-fade-top={fade.top || undefined}
          data-fade-bottom={fade.bottom || undefined}
          style={railFadeMask(fade.top, fade.bottom)}
          className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-2 pb-3"
        >
          {/* With no sources every Library page opens empty: the group steps back (SH-welcome-generic). */}
          <RailGroup id="rail-library-heading" label={t('navGroupLibrary')} links={LIBRARY_LINKS} collapsed={collapsed} dim={noSources} />
          <div role="group" aria-labelledby="rail-sources-heading" className="flex flex-col gap-0.5">
            <GroupLabel
              id="rail-sources-heading"
              label={t('sources')}
              collapsed={collapsed}
              action={noSources || (sources.isError && !offline) ? undefined : addSource}
            />
            {sourceList}
            <RailNavLink to="/sources" labelKey="manageSources" icon={ListVideo} collapsed={collapsed} end />
          </div>
        </div>
      </div>

      {/* One row: Settings, then the keyboard reference and the sidebar toggle as icon buttons. */}
      <div className={cn('flex shrink-0 gap-0.5 border-t border-divider p-2', collapsed ? 'flex-col items-stretch' : 'items-center')}>
        <div className={cn(!collapsed && 'min-w-0 flex-1')}>
          <RailNavLink to="/settings" labelKey="navSettings" icon={SettingsIcon} collapsed={collapsed} />
        </div>
        <IconButton
          label={t('keyboardShortcuts')}
          shortcut="?"
          tooltipSide={collapsed ? 'inline-end' : 'top'}
          icon={<Keyboard aria-hidden size={18} />}
          onClick={() => setHelpOpen(true)}
          // Keyboard-only: a phone or tablet has nothing to type the combos on (SH-touch-chrome).
          className={cn(footerButton, collapsed ? 'h-(--rail-item-height) w-full' : 'size-(--rail-item-height)')}
          data-testid="rail-shortcuts"
        />
        {autoCollapsed ? (
          // Below lg the rail never expands; on a narrow window its icon column takes room, so it
          // can go away entirely. The header's Show sidebar button brings it back.
          <IconButton
            label={t('hideRail')}
            tooltipSide="inline-end"
            icon={<PanelLeftClose aria-hidden size={18} className="rtl:-scale-x-100" />}
            onClick={() => {
              // The rail and this button go: focus moves on to the header's Show sidebar button.
              flushSync(toggleRailHidden);
              document.querySelector<HTMLElement>('[data-testid="rail-show"]')?.focus();
            }}
            data-rail-hide=""
            className="h-(--rail-item-height) w-full text-fg-muted"
          />
        ) : (
          <IconButton
            label={collapsed ? t('expandRail') : t('collapseRail')}
            tooltipSide={collapsed ? 'inline-end' : 'top'}
            icon={
              collapsed ? (
                <PanelLeftOpen aria-hidden size={18} className="rtl:-scale-x-100" />
              ) : (
                <PanelLeftClose aria-hidden size={18} className="rtl:-scale-x-100" />
              )
            }
            onClick={toggleRail}
            className={cn('text-fg-muted', collapsed ? 'h-(--rail-item-height) w-full' : 'size-(--rail-item-height)')}
          />
        )}
      </div>
    </nav>
  );
});
