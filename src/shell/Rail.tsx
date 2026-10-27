import { ChevronDown, ChevronUp, Ellipsis, Keyboard, ListVideo, PanelLeftClose, PanelLeftOpen, Plus, RotateCw, Settings as SettingsIcon } from 'lucide-react';
import { type CSSProperties, type ReactNode, type RefObject, memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';

import { useRpcQuery } from '@/api/query';
import type { Source } from '@/api/types';
import { BrandMark, cn, IconButton, Skeleton, SourceMonogram, Tooltip } from '@/ui';

import { useOffline } from './connection';
import { LIBRARY_LINKS, readLastSource, sectionCurrent, watchLinks, type NavLinkDef } from './navigation';
import { railLinkCurrent, railLinks, routeSourceId } from './railLinks';
import { useRouteIntent } from './routeIntent';
import { kindShortKey } from './sourceKind';
import { useShellStore } from './store';
import { useVisibleSources } from './useVisibleSources';

/**
 * One look for every rail row: rest (muted), hover (the see-through hover layer, full text),
 * pressed (the active layer), current (the neutral selected fill, tuning tick, accent icon). The
 * height is --rail-item-height, so compact density tightens the rail with everything else.
 * `dim`: while there are no sources, a Library link (every one of them opens empty) and Live TV,
 * Movies and Series (they lead to adding a source).
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

/** The leading glyph's box: the 18 px icons and the source monograms both sit in it. */
const RAIL_GLYPH = 'inline-flex size-5 shrink-0 items-center justify-center';

/**
 * One rail link. `current`, when given, says whether it stands for the page on show, in place of
 * the router's match of `to`: Live TV, Movies and Series follow the source on show, and count
 * pages that sit beside their path (sectionCurrent).
 */
function RailNavLink({
  to,
  labelKey,
  icon: Icon,
  collapsed,
  end,
  tour,
  dim,
  current,
}: Pick<NavLinkDef, 'to' | 'labelKey' | 'icon' | 'end' | 'tour'> & { collapsed: boolean; dim?: boolean; tour?: string; current?: boolean }) {
  const { t } = useTranslation('shell');
  const label = t(labelKey);
  // A rest on the link starts the page's code and first data.
  const intent = useRouteIntent(to);
  const content = (active: boolean) => (
    <>
      {/* One 20 px box for every leading glyph (icons and source monograms), so the labels share a column. */}
      <span aria-hidden className={RAIL_GLYPH}>
        <Icon size={18} className={cn(active && 'text-accent')} />
      </span>
      {!collapsed && <span className="truncate">{label}</span>}
    </>
  );
  return (
    <Tooltip content={collapsed ? label : null} side="inline-end" describe={false}>
      {current === undefined ? (
        <NavLink
          {...intent}
          to={to}
          end={end}
          data-tour={tour}
          aria-label={collapsed ? label : undefined}
          className={({ isActive }) => itemClass(isActive, collapsed, dim)}
        >
          {({ isActive }) => content(isActive)}
        </NavLink>
      ) : (
        <Link
          {...intent}
          to={to}
          data-tour={tour}
          aria-label={collapsed ? label : undefined}
          aria-current={current ? 'page' : undefined}
          className={itemClass(current, collapsed, dim)}
        >
          {content(current)}
        </Link>
      )}
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
    // Sticky inside the scrolling block, so "Library" and "Sources" stay readable while their
    // links scroll under them; each label gives way to the next group's (it sticks within its group).
    // A short fade under it softens the row coming out from beneath it.
    <div
      className={cn(
        'sticky top-0 z-[1] flex h-8 items-center justify-between bg-surface ps-3 pe-1 pt-2',
        'after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-1.5 after:bg-linear-to-b after:from-surface after:to-transparent',
      )}
    >
      <h2 id={id} className="truncate text-caption font-medium text-fg-subtle">
        {label}
      </h2>
      {action}
    </div>
  );
}

/**
 * Whether Library's less used pages (`more` in LIBRARY_LINKS: Downloads, My videos, Scheduled,
 * Watch stats) show under its More row, kept across launches. Folded until the user opens it:
 * with all eight open, the rail ran past the fold on a 768 px window and hid the sources. A UI
 * preference, in localStorage like the rail's collapse.
 */
const RAIL_LIBRARY_MORE_KEY = 'tsrust.railLibraryMore';

function readLibraryMore(): boolean {
  try {
    return localStorage.getItem(RAIL_LIBRARY_MORE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeLibraryMore(open: boolean): void {
  try {
    localStorage.setItem(RAIL_LIBRARY_MORE_KEY, open ? '1' : '0');
  } catch {
    // storage blocked: the row still folds, until the next launch
  }
}

/**
 * The More row: a disclosure in the shape of a link row, quieter at rest (it opens links, it is
 * not a page), with a chevron that says which way it goes. Icon-only in the collapsed rail, where
 * the tooltip names it.
 */
function MoreToggle({ open, controls, collapsed, onToggle }: { open: boolean; controls: string; collapsed: boolean; onToggle(): void }) {
  const { t } = useTranslation('shell');
  // The phone tab bar's More: the same word, already short in every language.
  const label = t('tabMore');
  return (
    <Tooltip content={collapsed ? label : null} side="inline-end" describe={false}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controls}
        aria-label={collapsed ? label : undefined}
        onClick={onToggle}
        data-rail-more=""
        className={cn(itemClass(false, collapsed, true), 'w-full text-start')}
      >
        <span aria-hidden className={RAIL_GLYPH}>
          {collapsed && open ? <ChevronUp size={18} /> : <Ellipsis size={18} />}
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <ChevronDown aria-hidden size={14} className={cn('shrink-0 motion-safe:transition-transform', open && 'rotate-180')} />
          </>
        )}
      </button>
    </Tooltip>
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
  const { pathname } = useLocation();
  const moreId = useId();
  const main = links.filter((l) => !l.more);
  const more = links.filter((l) => l.more);
  // The folded link for the page that is open, if any.
  const current = more.find((l) => pathname === l.to || pathname.startsWith(`${l.to}/`))?.to ?? null;
  const [unfolded, setUnfolded] = useState(() => readLibraryMore() || current !== null);
  // Folded, More opens again when one of its pages opens (from a card, the palette, a shortcut),
  // so the current page is never a hidden link; in the same render, as a source's entry does.
  // Only a press is remembered. Tracked by page, so going from one of them to another with the
  // row folded opens it too.
  const [wasCurrent, setWasCurrent] = useState(current);
  if (current !== wasCurrent) {
    setWasCurrent(current);
    if (current !== null && !unfolded) setUnfolded(true);
  }
  const item = (l: NavLinkDef) => (
    // Keyed by section too: with no sources, Live TV, Movies and Series share one path.
    <li key={l.section ?? l.to}>
      <RailNavLink
        to={l.to}
        labelKey={l.labelKey}
        icon={l.icon}
        end={l.end}
        tour={l.tour}
        collapsed={collapsed}
        dim={dim || l.dim}
        current={l.section ? sectionCurrent(l.section, pathname) : undefined}
      />
    </li>
  );
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
        {main.map(item)}
        {more.length > 0 && (
          <li>
            <MoreToggle
              open={unfolded}
              controls={moreId}
              collapsed={collapsed}
              onToggle={() => {
                writeLibraryMore(!unfolded);
                setUnfolded(!unfolded);
              }}
            />
            {unfolded && (
              <ul id={moreId} className="mt-0.5 flex flex-col gap-0.5">
                {more.map(item)}
              </ul>
            )}
          </li>
        )}
      </ul>
    </div>
  );
}

function SourceMark({ source, size = 'sm', errorDot }: { source: Source; size?: 'sm' | 'md'; errorDot?: boolean }) {
  return (
    // sm fills the rail's 20 px glyph box (RAIL_GLYPH), so source names start on the nav labels' line.
    <SourceMonogram name={source.name} className={cn('relative rounded-sm', size === 'sm' ? 'size-5 text-2xs' : 'h-9 w-9 text-sm')}>
      {/* The collapsed rail has no room for the status column, so the error rides on the monogram. */}
      {errorDot && <span className="absolute -top-1 -end-1 h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-surface" />}
    </SourceMonogram>
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

/**
 * The sources are an accordion: one open at a time, so expanding a second one never pushes the
 * Library links and the group labels out of the rail. Which one the user left open (its id, or ''
 * after closing it) is kept across launches (SH-rail-ia): a user who keeps one of three sources
 * open finds it open next time. A UI preference, so in localStorage, not the core's settings. Only
 * a press writes it; a source opened because its page is showing is not remembered as opened.
 */
const RAIL_SOURCE_KEY = 'tsrust.railSource';

/** The source the user left open: its id, '' when they closed it, null when they never pressed one. */
function readRailSource(): string | null {
  try {
    return localStorage.getItem(RAIL_SOURCE_KEY);
  } catch {
    return null;
  }
}

function rememberRailSource(id: string | null): void {
  try {
    localStorage.setItem(RAIL_SOURCE_KEY, id ?? '');
  } catch {
    // storage blocked: the rail still opens and closes, it just forgets
  }
}

/**
 * The open source before the user presses one this session and while no source's page has opened
 * one: the one they left open, else none. The only source no longer opens by itself: Live TV,
 * Movies and Series are in the Watch group, and with its links open the rail ran past the fold at
 * laptop heights. Exported for tests.
 */
export function defaultOpenSource(sources: readonly Pick<Source, 'id'>[], remembered: string | null): string | null {
  return remembered && sources.some((s) => s.id === remembered) ? remembered : null;
}

function SourceEntry({
  source,
  collapsed,
  active,
  expanded,
  onToggle,
  tour,
}: {
  source: Source;
  collapsed: boolean;
  active: boolean;
  /** Its links show (the rail's accordion decides; collapsed, the entry is a menu instead). */
  expanded: boolean;
  onToggle: () => void;
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
      // data-rail-current: the menu trigger carries no aria-current, but the rail still scrolls
      // the source of the page on show into view (useRailScroll).
      <li ref={collapsedItemRef} data-tour={tour} data-rail-current={active || undefined} onPointerEnter={() => setWarm(true)} onFocus={() => setWarm(true)}>
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
              const current = railLinkCurrent(l, pathname);
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
          onToggle();
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
      {/* The sublinks hang off a line through the middle of the source mark: px-3 plus half its size-5. */}
      {expanded && (
        <ul id={listId} className="mt-0.5 mb-1 ms-[1.375rem] flex flex-col gap-0.5 border-s border-divider ps-2">
          {links.map((l) => {
            // A movie's page and the catch-up archive count too (railLinkCurrent), which NavLink's prefix match missed.
            const current = railLinkCurrent(l, pathname);
            return (
              <li key={l.id}>
                <SourceLink to={l.to} current={current}>
                  <l.icon aria-hidden size={15} className={cn('shrink-0', current && 'text-accent')} />
                  <span className="truncate">{t(l.labelKey)}</span>
                </SourceLink>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/** One of an open source's links (Live TV, Movies, …); a rest on it starts the page's code and first data. */
function SourceLink({ to, current, children }: { to: string; current: boolean; children: ReactNode }) {
  const intent = useRouteIntent(to);
  return (
    <Link
      {...intent}
      to={to}
      aria-current={current ? 'page' : undefined}
      className={cn(
        'flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-sm motion-safe:transition-colors motion-safe:duration-150',
        current ? 'tuning-tick bg-selected font-medium text-fg active:bg-active' : 'text-fg-muted hover:bg-hover hover:text-fg active:bg-active',
      )}
    >
      {children}
    </Link>
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
/**
 * `bottomSize`: how tall the bottom fade is. The sources' block fades over about a row (3rem), so a
 * row half under the footer divider dissolves instead of showing the top half of its name.
 */
export function railFadeMask(top: boolean, bottom: boolean, bottomSize = FADE): CSSProperties | undefined {
  if (!top && !bottom) return undefined;
  const stops = [top ? `transparent, #000 ${FADE}` : '#000', bottom ? `#000 calc(100% - ${bottomSize}), transparent` : '#000'];
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
    const reveal = () => {
      const active = scrolledFor.current === scrollKey ? null : el.querySelector<HTMLElement>('[aria-current="page"], [data-rail-current]');
      if (!active) return;
      scrolledFor.current = scrollKey;
      el.scrollTop += railRevealDelta(el.getBoundingClientRect(), active.getBoundingClientRect());
    };
    el.addEventListener('scroll', update, { passive: true });
    // P2-RAILS-2: the reveal and the first fade reading wait for the observer's first callback.
    // This effect runs right after a route's page committed, so reading here forced that page's
    // layout (31 ms at a 4x slowdown on a cold Movies landing); the callback comes after the
    // browser's own layout and before paint, so the link is in view in the first frame all the same,
    // and flushSync puts a fade that changed on screen in that frame too.
    let revealPending = true;
    const measure = () => {
      if (revealPending) {
        revealPending = false;
        reveal();
      }
      update();
    };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => flushSync(measure));
    if (ro) {
      ro.observe(el);
      for (const child of el.children) ro.observe(child);
    } else measure();
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
  // Live TV, Movies and Series open the source on show, else the one last opened.
  // Search is left out: the header's search box is the way in (notInRail).
  const watch = watchLinks(sources.data, activeSourceId ?? readLastSource()).filter((l) => !l.notInRail);
  // With two or more sources, the source of the page on show opens. A lone source stays as the
  // user left it: the Watch links already lead to its sections and mark its pages.
  const pageSource = sourceCount > 1 ? activeSourceId : undefined;
  // The sources' accordion. Undefined until this session decides (a press, or a page opening its
  // source); until then the remembered press is open.
  const [openSource, setOpenSource] = useState<string | null | undefined>(pageSource);
  // A source's page opening (from a card or the palette) opens its entry in the same render, not
  // in an effect a commit later: the rail's scroll effect runs once per route, and it must find
  // the active sub-link already on the page to bring it into view. Sources that load after the
  // page has opened open it then, in the render they arrive in.
  const [lastPageSource, setLastPageSource] = useState(pageSource);
  if (pageSource !== lastPageSource) {
    setLastPageSource(pageSource);
    if (pageSource) setOpenSource(pageSource);
  }
  const [remembered] = useState(readRailSource);
  const openId = openSource !== undefined ? openSource : defaultOpenSource(sources.data ?? [], remembered);
  const toggleSource = (id: string) => {
    const next = openId === id ? null : id;
    rememberRailSource(next);
    setOpenSource(next);
  };
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
            expanded={!collapsed && openId === s.id}
            onToggle={() => toggleSource(s.id)}
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
          <RailGroup id="rail-watch-heading" label={t('navGroupWatch')} links={watch} collapsed={collapsed} first />
        </div>

        <div
          ref={scrollRef}
          data-testid="rail-scroll"
          data-fade-top={fade.top || undefined}
          data-fade-bottom={fade.bottom || undefined}
          // No fade at the top: the sticky group label is that edge, and a fade would dim it.
          style={railFadeMask(false, fade.bottom, '3rem')}
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
        {/*
          Keyboard-only: a phone or tablet has nothing to type the combos on (SH-touch-chrome).
          Not in the icon-only rail either, where the footer stacks: its row went to the sources
          on a short window, and `?`, the palette and Settings all open the same reference.
        */}
        {!collapsed && (
          <IconButton
            label={t('keyboardShortcuts')}
            shortcut="?"
            tooltipSide="top"
            icon={<Keyboard aria-hidden size={18} />}
            onClick={() => setHelpOpen(true)}
            className={cn(footerButton, 'size-(--rail-item-height)')}
            data-testid="rail-shortcuts"
          />
        )}
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
