import { useVirtualizer } from '@tanstack/react-virtual';
import { EyeOff, Search, SlidersHorizontal } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';

import type { Category } from '@/api/types';

import { Button, ErrorState, IconButton, Skeleton } from '../_shim';

const ROW = 36;

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

export function CategorySidebar(props: CategorySidebarProps) {
  const { t } = useTranslation('live');
  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = props.categories ?? [];
    return q ? list.filter((c) => c.name.toLowerCase().includes(q)) : list;
  }, [props.categories, filter]);
  const allCount = useMemo(() => (props.categories ?? []).reduce((n, c) => n + c.itemCount, 0), [props.categories]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 10,
    initialRect: { width: 240, height: 600 },
  });

  const allHidden = !props.isLoading && !props.error && (props.categories?.length ?? 0) === 0 && props.hiddenCount > 0;

  return (
    <nav aria-label={t('groups')} className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        <h2 className="flex-1 text-sm font-semibold text-fg">{t('groups')}</h2>
        <IconButton size="sm" label={t('manageCategories')} icon={<SlidersHorizontal className="size-4" />} onClick={props.onManage} />
      </div>
      <div className="px-3 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface-2 px-2 text-sm focus-within:ring-2 focus-within:ring-accent">
          <Search className="size-3.5 text-fg-subtle" aria-hidden />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('filterGroups')}
            aria-label={t('filterGroups')}
            className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-subtle"
          />
        </label>
      </div>

      <div className="px-2" style={{ height: ROW }}>
        <NavLink end to={props.hrefFor(undefined)} onClick={props.onNavigate} className={() => linkClass(!props.activeId)}>
          <span className="flex-1 truncate">{props.totalLabel}</span>
          <span className={countClass(!props.activeId)}>{props.categories ? allCount.toLocaleString() : ''}</span>
        </NavLink>
      </div>

      {props.error ? (
        <ErrorState error={props.error} onRetry={props.onRetry} />
      ) : props.isLoading ? (
        <div className="flex flex-col gap-2 px-3 pt-2" aria-busy="true" aria-label={t('loadingGroups')}>
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="h-6" />
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
        <p className="px-4 pt-3 text-sm text-fg-muted">{t('noGroupsMatch', { query: filter })}</p>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const c = visible[v.index]!;
              return (
                <div key={c.id} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW, transform: `translateY(${v.start}px)` }}>
                  <NavLink
                    to={props.hrefFor(c.id)}
                    onClick={props.onNavigate}
                    className={() => linkClass(props.activeId === c.id)}
                    title={c.name}
                  >
                    <span className="flex-1 truncate">{c.name}</span>
                    <span className={countClass(props.activeId === c.id)}>{c.itemCount.toLocaleString()}</span>
                  </NavLink>
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
          className="mx-3 mb-3 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg-subtle hover:bg-surface-2 hover:text-fg"
        >
          <EyeOff className="size-3.5" aria-hidden />
          {t('hiddenGroupsCount', { count: props.hiddenCount })}
        </button>
      ) : null}
    </nav>
  );
}
