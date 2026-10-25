import { EllipsisVertical, EyeOff, Lock, SlidersHorizontal } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { Category } from '@/api/types';
import { useRouteIntent } from '@/shell/routeIntent';

import { Button, cn, ErrorState, IconButton, SearchInput, Select, Skeleton, useListVirtualizer, useRowHeight } from '@/ui';
import { intlLocale } from '@/lib/intl';
import { useLongPress } from '../hooks/useLongPress';
import { groupRegion, groupRegions, readRegion, writeRegion } from '../lib/groupRegion';
import { documentIsRtl } from '../lib/rtl';

/** A group row's slot at 100 %. */
const ROW = 36;
/**
 * The slot's vertical breathing room at 100 %, which compact density tightens:
 * 36 px less the text-sm line (1.25rem = 18.75 px at the 15 px root).
 */
const ROW_SPACING = 17;
/** Index of the "All channels" link in the keyboard order (the groups follow from 0). */
const ALL = -1;

export interface CategorySidebarProps {
  categories: Category[] | undefined;
  /** total categories including hidden ones (undefined while unknown) */
  hiddenCount: number;
  isLoading: boolean;
  error: unknown;
  onRetry(): void;
  activeId?: string;
  hrefFor(categoryId?: string): string;
  onManage(): void;
  onNavigate?(): void;
  totalLabel: string;
  /** Opens a group's context menu (right click, the context-menu key, Shift+F10). */
  onGroupMenu?(pos: { x: number; y: number }, category: Category): void;
  /** Parental Ask mode: the group asks for the PIN, so its row carries a lock. */
  isLocked?(categoryId: string): boolean;
  /**
   * LG-12: views pinned above "All channels" (Favorites, Recently watched). Their `id` goes through
   * `hrefFor` like a group's and is `activeId` while open; they are not filtered and have no menu.
   */
  pinned?: readonly { id: string; label: string; icon: ReactNode }[];
  /**
   * A single group holds what "All" holds: leave its row and the filter out (Radio, whose
   * playlists often file every station under one group), unless it is the open one.
   */
  hideLoneGroup?: boolean;
  /**
   * Where the region picker keeps its choice (`${sourceId}:${contentType}`). The picker shows when
   * most groups carry a country tag ("US| ", "UK: "), as in big international playlists.
   */
  regionScope?: string;
}

function linkClass(active: boolean): string {
  return `flex h-full items-center gap-2 rounded-md px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus ${
    active ? 'tuning-tick bg-selected font-medium text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg'
  }`;
}

/** The active row's count steps up to fg-muted with its label (both hold 4.5:1 on the selected fill). */
function countClass(active: boolean): string {
  return `text-xs tabular-nums ${active ? 'text-fg-muted' : 'text-fg-subtle'}`;
}

/** Case- and accent-insensitive form for the group filter: "espana" finds "España", "ÉCOLE" finds "ecole". */
export function foldForFilter(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

export function CategorySidebar(props: CategorySidebarProps) {
  const { t, i18n } = useTranslation('live');
  const fmt = useMemo(() => new Intl.NumberFormat(intlLocale(i18n.language)), [i18n.language]);
  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  // Rows follow the UI scale, and compact density tightens them.
  const rowHeight = useRowHeight(ROW, ROW_SPACING);

  const lone = !!props.hideLoneGroup && props.categories?.length === 1 && props.categories[0]!.id !== props.activeId;
  const regions = useMemo(() => groupRegions((props.categories ?? []).map((c) => c.name)), [props.categories]);
  // The pick of the scope on show: the sidebar stays mounted when Live TV moves to another source or
  // to Radio, so the stored pick is read again for the new scope in the same render.
  const [picked, setPicked] = useState(() => ({ scope: props.regionScope, tag: readRegion(props.regionScope) }));
  let regionPick = picked.tag;
  if (picked.scope !== props.regionScope) {
    regionPick = readRegion(props.regionScope);
    setPicked({ scope: props.regionScope, tag: regionPick });
  }
  // A tag the playlist no longer has shows every group.
  const region = regionPick && regions.some((r) => r.tag === regionPick) ? regionPick : null;
  const visible = useMemo(() => {
    if (lone) return [];
    const q = foldForFilter(filter.trim());
    const list = props.categories ?? [];
    // The open group stays listed whatever the region, so the list never loses the page on show.
    const inRegion = (c: Category) => !region || c.id === props.activeId || groupRegion(c.name) === region;
    return list.filter((c) => inRegion(c) && (!q || foldForFilter(c.name).includes(q)));
  }, [props.categories, filter, lone, region, props.activeId]);
  const allCount = useMemo(() => (props.categories ?? []).reduce((n, c) => n + c.itemCount, 0), [props.categories]);

  // The open group is in view on arrival, even when it is row 1500 of a virtualized list:
  // the first paint already starts a few rows above it, and later changes scroll to it.
  const activeIndex = useMemo(() => (props.activeId ? visible.findIndex((c) => c.id === props.activeId) : -1), [visible, props.activeId]);
  const initialTop = activeIndex > 3 ? (activeIndex - 3) * rowHeight : 0;
  const virtualizer = useListVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    // No initialRect: the window's size stands in until the sidebar's own comes in after the first
    // layout (P2-LIVE-1). A 600 px guess rendered the groups again before a tall window's first paint.
    initialOffset: initialTop,
  });
  // A new scale or density: drop the cached row sizes so every row takes the new height.
  const measuredHeight = useRef(rowHeight);
  useLayoutEffect(() => {
    if (measuredHeight.current === rowHeight) return;
    measuredHeight.current = rowHeight;
    virtualizer.measure();
  }, [rowHeight, virtualizer]);
  const scrolledFor = useRef<string | undefined>(activeIndex >= 0 ? props.activeId : undefined);
  useLayoutEffect(() => {
    // initialOffset placed the virtualizer; make the element agree with it.
    if (initialTop > 0 && scrollRef.current) scrollRef.current.scrollTop = initialTop;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (activeIndex < 0 || scrolledFor.current === props.activeId) return;
    scrolledFor.current = props.activeId;
    virtualizer.scrollToIndex(activeIndex, { align: 'auto' });
  }, [activeIndex, props.activeId, virtualizer]);

  const pinnedCount = props.pinned?.length ?? 0;
  // Roving focus: one tab stop in the list (the open group, else the first), arrows move between links.
  const [cursor, setCursor] = useState<number>(ALL);
  const tabStop = cursor !== ALL && cursor < visible.length ? cursor : activeIndex >= 0 ? activeIndex : 0;
  const focusPending = useRef<number | null>(null);
  useEffect(() => {
    const i = focusPending.current;
    if (i === null) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-cat-index="${i}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      focusPending.current = null;
    }
  });
  const moveTo = (i: number) => {
    const next = Math.max(ALL - pinnedCount, Math.min(visible.length - 1, i));
    if (next === ALL) {
      navRef.current?.querySelector<HTMLElement>('[data-cat-index="all"]')?.focus();
      return;
    }
    if (next < ALL) {
      // The pinned views sit above All channels, in order.
      navRef.current?.querySelector<HTMLElement>(`[data-cat-index="pin-${next - ALL + pinnedCount}"]`)?.focus();
      return;
    }
    focusPending.current = next;
    setCursor(next);
    virtualizer.scrollToIndex(next, { align: 'auto' });
    // Already rendered (the common case): focus now; the effect covers rows still off screen.
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-cat-index="${next}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      focusPending.current = null;
    }
  };
  const indexOf = (el: EventTarget): number | null => {
    if (!(el instanceof HTMLElement)) return null;
    const raw = el.dataset.catIndex;
    if (raw === undefined) return null;
    if (raw.startsWith('pin-')) return ALL - pinnedCount + Number(raw.slice(4));
    return raw === 'all' ? ALL : Number(raw);
  };
  /** The group menu for the focused link, anchored near its inline start (its right edge in RTL). */
  const openGroupMenu = (target: EventTarget, at: number): boolean => {
    const c = at === ALL ? undefined : visible[at];
    if (!c || !props.onGroupMenu || !(target instanceof HTMLElement)) return false;
    const r = target.getBoundingClientRect();
    props.onGroupMenu({ x: documentIsRtl() ? r.right - 32 : r.left + 32, y: r.bottom - 4 }, c);
    return true;
  };
  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const at = indexOf(e.target);
    if (at === null) return;
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      if (openGroupMenu(e.target, at)) e.preventDefault();
      return;
    }
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 480) / rowHeight) - 1);
    switch (e.key) {
      case 'ArrowDown':
        moveTo(at + 1);
        break;
      case 'ArrowUp':
        moveTo(at - 1);
        break;
      case 'PageDown':
        moveTo(at + page);
        break;
      case 'PageUp':
        moveTo(Math.max(0, at - page));
        break;
      case 'Home':
        moveTo(ALL - pinnedCount);
        break;
      case 'End':
        moveTo(visible.length - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // Read once for every row (P2-LIVE-3): a `useTranslation` per row subscribed each to i18next.
  const lockedLabel = t('locked');
  const menuLabel = t('groupMenu');
  const allHidden = !props.isLoading && !props.error && (props.categories?.length ?? 0) === 0 && props.hiddenCount > 0;
  const allActive = !props.activeId;

  return (
    <nav ref={navRef} aria-label={t('groups')} className="flex h-full min-h-0 flex-col" onKeyDown={onListKey}>
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        <h2 className="flex-1 text-sm font-semibold text-fg">{t('groups')}</h2>
        {regions.length > 0 && !lone ? (
          <Select
            aria-label={t('region')}
            title={t('region')}
            className="h-7 w-auto max-w-28 ps-2 pe-7 text-xs"
            value={region ?? ''}
            onValueChange={(v) => {
              const next = v || null;
              writeRegion(props.regionScope, next);
              setPicked({ scope: props.regionScope, tag: next });
              setCursor(ALL);
            }}
            options={[
              { value: '', label: t('allRegions') },
              ...regions.map((r) => ({ value: r.tag, label: `${r.tag} · ${fmt.format(r.groups)}` })),
            ]}
            data-testid="group-region"
          />
        ) : null}
        <IconButton size="sm" label={t('manageCategories')} icon={<SlidersHorizontal className="size-4" />} onClick={props.onManage} />
      </div>
      {lone ? null : (
        <div className="px-3 pb-2">
          <SearchInput
            size="sm"
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setCursor(ALL);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.preventDefault();
                e.stopPropagation();
                setFilter('');
              } else if (e.key === 'ArrowDown' && visible.length > 0) {
                // Down from the filter goes straight to the first match.
                e.preventDefault();
                e.stopPropagation();
                moveTo(0);
              }
            }}
            placeholder={t('filterGroups')}
            label={t('filterGroups')}
          />
        </div>
      )}

      {props.pinned?.map((p, k) => {
        const on = props.activeId === p.id;
        return (
          <div key={p.id} className="px-2" style={{ height: rowHeight }}>
            <ViewLink
              to={props.hrefFor(p.id)}
              onClick={props.onNavigate}
              data-cat-index={`pin-${k}`}
              aria-current={on ? 'page' : undefined}
              className={linkClass(on)}
            >
              <span aria-hidden className={`flex shrink-0 ${on ? 'text-accent' : 'text-fg-subtle'}`}>
                {p.icon}
              </span>
              <span className="flex-1 truncate">{p.label}</span>
            </ViewLink>
          </div>
        );
      })}
      <div className="px-2" style={{ height: rowHeight }}>
        {/* Plain links with an explicit aria-current: radio groups differ only in `?category=`, which NavLink ignores. */}
        <ViewLink
          to={props.hrefFor(undefined)}
          onClick={props.onNavigate}
          data-cat-index="all"
          aria-current={allActive ? 'page' : undefined}
          className={linkClass(allActive)}
        >
          <span className="flex-1 truncate">{props.totalLabel}</span>
          <span className={countClass(allActive)}>{props.categories ? fmt.format(allCount) : ''}</span>
        </ViewLink>
      </div>

      {props.error ? (
        <ErrorState error={props.error} onRetry={props.onRetry} />
      ) : props.isLoading ? (
        <div className="flex flex-col px-2 pt-0.5" aria-busy="true" aria-label={t('loadingGroups')}>
          {Array.from({ length: 10 }, (_, i) => (
            // One slot per row, like the loaded links, so the column does not shift.
            <div key={i} className="flex items-center px-2.5" style={{ height: rowHeight }}>
              <Skeleton className="h-3.5 flex-1" />
            </div>
          ))}
        </div>
      ) : allHidden ? (
        <div className="flex flex-col items-start gap-2 px-4 pt-3 text-sm text-fg-muted">
          <EyeOff className="size-4" aria-hidden />
          <p>{t('allGroupsHidden')}</p>
          <Button size="sm" onClick={props.onManage}>
            {t('showGroups')}
          </Button>
        </div>
      ) : visible.length === 0 && filter ? (
        <div className="flex flex-col items-start gap-2 px-4 pt-3 text-sm text-fg-muted">
          <p>{t('noGroupsMatch', { query: filter })}</p>
          <Button size="sm" onClick={() => setFilter('')}>
            {t('clearSearch')}
          </Button>
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3" data-testid="group-list">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const c = visible[v.index]!;
              const active = props.activeId === c.id;
              const locked = props.isLocked?.(c.id) ?? false;
              return (
                <div
                  key={c.id}
                  className="flex min-w-0 items-center"
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, height: v.size, transform: `translateY(${v.start}px)` }}
                >
                  <GroupLink
                    category={c}
                    index={v.index}
                    to={props.hrefFor(c.id)}
                    active={active}
                    locked={locked}
                    tabbable={v.index === tabStop}
                    count={fmt.format(c.itemCount)}
                    lockedLabel={lockedLabel}
                    menuLabel={menuLabel}
                    onNavigate={props.onNavigate}
                    onFocus={() => setCursor(v.index)}
                    onMenu={
                      props.onGroupMenu
                        ? (pos) => {
                            setCursor(v.index);
                            props.onGroupMenu?.(pos, c);
                          }
                        : undefined
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
      {props.hiddenCount > 0 && !allHidden ? (
        <button
          type="button"
          onClick={props.onManage}
          className="mx-3 mb-3 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg-subtle outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
        >
          <EyeOff className="size-3.5" aria-hidden />
          {t('hiddenGroupsCount', { count: props.hiddenCount })}
        </button>
      ) : null}
    </nav>
  );
}

/**
 * A pinned view's link or All channels. A rest of the pointer or focus on it asks for the view's
 * first data (`useRouteIntent`), as on a group's link.
 */
function ViewLink({ to, ...rest }: ComponentProps<typeof Link> & { to: string }) {
  const intent = useRouteIntent(to);
  return <Link {...intent} to={to} {...rest} />;
}

/** Made once, so a group row's re-render skips its icon (P2-LIVE-3). */
const GROUP_MENU_ICON = <EllipsisVertical size={16} />;

/**
 * A group's row: its link, and its menu (LG-13) from a right click, the context-menu key (the
 * list's own handler), a long press, or on touch a ⋮ button. iOS Safari fires no `contextmenu` on
 * a long press, so "Add all to list…" and "Open in TV guide" were out of reach on an iPhone or
 * iPad. The button, not the link, says it opens a menu: the link navigates.
 */
function GroupLink({
  category: c,
  index,
  to,
  active,
  locked,
  tabbable,
  count,
  lockedLabel,
  menuLabel,
  onNavigate,
  onFocus,
  onMenu,
}: {
  category: Category;
  index: number;
  to: string;
  active: boolean;
  locked: boolean;
  tabbable: boolean;
  count: string;
  /** `t('locked')` and `t('groupMenu')`, from the sidebar. */
  lockedLabel: string;
  menuLabel: string;
  onNavigate?(): void;
  onFocus(): void;
  onMenu?(pos: { x: number; y: number }): void;
}) {
  const longPress = useLongPress((x, y) => onMenu?.({ x, y }));
  // A rest on the link asks for the group's first page with its now/next and favourite flags, so
  // a click shows complete rows at once. Rows that scroll under a still pointer do not count.
  const intent = useRouteIntent(to);
  // Inside the row's slot (a flex row): the link, then the touch screen's ⋮.
  return (
    <>
      <Link
        {...intent}
        to={to}
        onClick={onNavigate}
        onFocus={(e) => {
          onFocus();
          intent.onFocus(e);
        }}
        data-cat-index={index}
        tabIndex={tabbable ? 0 : -1}
        aria-current={active ? 'page' : undefined}
        onContextMenu={
          onMenu
            ? (e) => {
                e.preventDefault();
                onMenu({ x: e.clientX, y: e.clientY });
              }
            : undefined
        }
        {...(onMenu ? longPress : undefined)}
        // No callout or text selection on a long press (iOS would offer to open the link).
        className={cn(linkClass(active), 'min-w-0 flex-1', onMenu && 'touch-manipulation select-none [-webkit-touch-callout:none]')}
        title={locked ? `${c.name} (${lockedLabel})` : c.name}
      >
        <span dir="auto" className="flex-1 truncate text-match-parent">{c.name}</span>
        {locked ? <Lock data-testid="group-locked" className="size-3.5 shrink-0 text-fg-subtle" role="img" aria-label={lockedLabel} /> : null}
        <span className={countClass(active)}>{count}</span>
      </Link>
      {onMenu ? (
        <IconButton
          size="sm"
          tabIndex={-1}
          label={menuLabel}
          aria-haspopup="menu"
          icon={GROUP_MENU_ICON}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            // Under the button from its inline start, as a channel row's ⋮ opens.
            onMenu({ x: documentIsRtl() ? r.right : r.left, y: r.bottom + 2 });
          }}
          // Touch only, as tall as the row (a mouse has the right click). 44 px wide; the row's own
          // height, so it never reaches into the next row.
          className="hidden h-full shrink-0 pointer-coarse:inline-flex pointer-coarse:min-h-0"
          data-testid="group-menu-button"
        />
      ) : null}
    </>
  );
}
