import { useVirtualizer } from '@tanstack/react-virtual';
import { EyeOff, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { Category } from '@/api/types';

import { Button, ErrorState, IconButton, Skeleton } from '@/ui';

const ROW = 36;
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
}

function linkClass(active: boolean): string {
  return `flex h-full items-center gap-2 rounded-md px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent ${
    active ? 'bg-accent/15 font-medium text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
  }`;
}

/** fg-subtle drops to 4:1 on the amber-tinted active row in the dark theme; fg-muted holds 4.5:1 there. */
function countClass(active: boolean): string {
  return `text-xs tabular-nums ${active ? 'text-fg-muted' : 'text-fg-subtle'}`;
}

/** Case- and accent-insensitive form for the group filter: "espana" finds "España", "ÉCOLE" finds "ecole". */
export function foldForFilter(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

export function CategorySidebar(props: CategorySidebarProps) {
  const { t, i18n } = useTranslation('live');
  const fmt = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);

  const visible = useMemo(() => {
    const q = foldForFilter(filter.trim());
    const list = props.categories ?? [];
    return q ? list.filter((c) => foldForFilter(c.name).includes(q)) : list;
  }, [props.categories, filter]);
  const allCount = useMemo(() => (props.categories ?? []).reduce((n, c) => n + c.itemCount, 0), [props.categories]);

  // The open group is in view on arrival, even when it is row 1500 of a virtualized list:
  // the first paint already starts a few rows above it, and later changes scroll to it.
  const activeIndex = useMemo(() => (props.activeId ? visible.findIndex((c) => c.id === props.activeId) : -1), [visible, props.activeId]);
  const initialTop = activeIndex > 3 ? (activeIndex - 3) * ROW : 0;
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 10,
    initialRect: { width: 240, height: 600 },
    initialOffset: initialTop,
  });
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
    const next = Math.max(ALL, Math.min(visible.length - 1, i));
    if (next === ALL) {
      navRef.current?.querySelector<HTMLElement>('[data-cat-index="all"]')?.focus();
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
    return raw === 'all' ? ALL : Number(raw);
  };
  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const at = indexOf(e.target);
    if (at === null) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 480) / ROW) - 1);
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
        moveTo(ALL);
        break;
      case 'End':
        moveTo(visible.length - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const allHidden = !props.isLoading && !props.error && (props.categories?.length ?? 0) === 0 && props.hiddenCount > 0;
  const allActive = !props.activeId;

  return (
    <nav ref={navRef} aria-label={t('groups')} className="flex h-full min-h-0 flex-col" onKeyDown={onListKey}>
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        <h2 className="flex-1 text-sm font-semibold text-fg">{t('groups')}</h2>
        <IconButton size="sm" label={t('manageCategories')} icon={<SlidersHorizontal className="size-4" />} onClick={props.onManage} />
      </div>
      <div className="px-3 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface-2 px-2 text-sm focus-within:ring-2 focus-within:ring-accent">
          <Search className="size-3.5 text-fg-subtle" aria-hidden />
          <input
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
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
            aria-label={t('filterGroups')}
            className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-subtle"
          />
        </label>
      </div>

      <div className="px-2" style={{ height: ROW }}>
        {/* Plain links with an explicit aria-current: radio groups differ only in `?category=`, which NavLink ignores. */}
        <Link
          to={props.hrefFor(undefined)}
          onClick={props.onNavigate}
          data-cat-index="all"
          aria-current={allActive ? 'page' : undefined}
          className={linkClass(allActive)}
        >
          <span className="flex-1 truncate">{props.totalLabel}</span>
          <span className={countClass(allActive)}>{props.categories ? fmt.format(allCount) : ''}</span>
        </Link>
      </div>

      {props.error ? (
        <ErrorState error={props.error} onRetry={props.onRetry} />
      ) : props.isLoading ? (
        <div className="flex flex-col px-2 pt-0.5" aria-busy="true" aria-label={t('loadingGroups')}>
          {Array.from({ length: 10 }, (_, i) => (
            // One 36px slot per row, like the loaded links, so the column does not shift.
            <div key={i} className="flex items-center px-2.5" style={{ height: ROW }}>
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
              return (
                <div key={c.id} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW, transform: `translateY(${v.start}px)` }}>
                  <Link
                    to={props.hrefFor(c.id)}
                    onClick={props.onNavigate}
                    onFocus={() => setCursor(v.index)}
                    data-cat-index={v.index}
                    tabIndex={v.index === tabStop ? 0 : -1}
                    aria-current={active ? 'page' : undefined}
                    className={linkClass(active)}
                    title={c.name}
                  >
                    <span dir="auto" className="flex-1 truncate text-match-parent">{c.name}</span>
                    <span className={countClass(active)}>{fmt.format(c.itemCount)}</span>
                  </Link>
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
          className="mx-3 mb-3 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg-subtle outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
        >
          <EyeOff className="size-3.5" aria-hidden />
          {t('hiddenGroupsCount', { count: props.hiddenCount })}
        </button>
      ) : null}
    </nav>
  );
}
