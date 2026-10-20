import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { rpcKey } from '@/api/query';
import { rpc, type RpcError } from '@/api/transport';
import type { YearFacet } from '@/api/types';
import { Select, Skeleton, cn } from '@/ui';
import { intlLocale } from '@/lib/intl';

import { revealInRow, useEdgeFades } from '../hooks/useEdgeFades';
import { ALL_CATEGORIES, type VodKind } from '../lib/paging';
import {
  STALKER_DECADES,
  decadeChips,
  decadeRange,
  hasYearRange,
  rangeDecade,
  yearOptions,
  type DecadeChip,
  type YearRange,
} from '../lib/years';

/** What a grid's year filter reads: the grid's source, kind and category, and its range in the URL. */
export interface YearFilterProps {
  sourceId: string;
  kind: VodKind;
  categoryId: string;
  /**
   * False while the source record is still loading (its kind unknown): the bar holds its place
   * with placeholder chips and asks for nothing yet. Defaults to true.
   */
  ready?: boolean;
  /** Stalker portals: fixed decades, filtered on loaded pages. */
  stalker: boolean;
  /**
   * Whether this kind of source usually gives years (Xtream does, M3U mostly
   * not). Placeholder chips show while the facets load only when it does, or
   * when this source has shown years before, so the row doesn't pop in and out.
   */
  yearsLikely: boolean;
  range: YearRange;
  onRangeChange: (range: YearRange) => void;
  /** The facets count only what "Hide watched" keeps while it is on. */
  hideWatched: boolean;
}

const CHIP =
  'relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm whitespace-nowrap tabular ' +
  'motion-safe:transition-[color,background-color,box-shadow] motion-safe:duration-150';
// Idle chips are a quiet fill with no outline (VL-grid-toolbars); a chosen filter is neutral
// (inverted), and amber is kept for actions and progress.
const CHIP_IDLE = 'bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg';
const CHIP_ON = 'bg-fg font-medium text-bg';

/** Sources whose facets had years this session: their row is worth reserving while it loads. */
const sourcesWithYears = new Set<string>();

/**
 * The year facets of one grid and what the decade chips and the From/To range draw from them
 * (C4). While "Hide watched" is on, the facets are asked with `hideWatched`, so the counts match
 * what the grid keeps. The grid's toolbar draws the chips in its row and the range in its Filters
 * panel from one call (VL-grid-toolbars).
 */
export function useYearFilter({ sourceId, kind, categoryId, ready = true, stalker, yearsLikely, range, onRangeChange, hideWatched }: YearFilterProps) {
  const { t, i18n } = useTranslation('vod');
  const facetArgs = useMemo(
    () => ({
      sourceId,
      contentType: kind,
      ...(categoryId && categoryId !== ALL_CATEGORIES ? { categoryId } : {}),
      ...(hideWatched ? { hideWatched: true } : {}),
    }),
    [sourceId, kind, categoryId, hideWatched],
  );
  const facets = useQuery<YearFacet[], RpcError>({
    queryKey: rpcKey('catalog.yearFacets', facetArgs),
    queryFn: () => rpc('catalog.yearFacets', facetArgs),
    enabled: ready && !stalker && !!sourceId,
    staleTime: 60_000,
    // Flipping Hide watched keeps the chips (and their old counts) until the new counts arrive, instead of skeletons.
    placeholderData: (prev, prevQuery) => {
      const p = prevQuery?.queryKey[1] as typeof facetArgs | null | undefined;
      return p && p.sourceId === sourceId && p.contentType === kind && p.categoryId === facetArgs.categoryId ? prev : undefined;
    },
  });
  const fmt = useMemo(() => new Intl.NumberFormat(intlLocale(i18n.language)), [i18n.language]);

  // A failed facet lookup still offers the decades, without counts.
  const chips: DecadeChip[] = facets.isError ? STALKER_DECADES.map((decade) => ({ decade })) : decadeChips(stalker, facets.data);
  const years = yearOptions(stalker || facets.isError, facets.data);
  const loading = !stalker && facets.isPending;
  const active = hasYearRange(range);
  const activeDecade = rangeDecade(range);
  if (!stalker && (facets.data?.length ?? 0) > 0) sourcesWithYears.add(sourceId);
  // Titles without any year: nothing to filter by, unless a link already set a range.
  const showYears = (loading && (yearsLikely || sourcesWithYears.has(sourceId))) || chips.length > 0 || active;

  const pickDecade = (decade: number) => onRangeChange(activeDecade === decade ? {} : decadeRange(decade));
  const setBound = (which: 'from' | 'to', raw: string) => {
    const value = raw ? Number(raw) : undefined;
    const next: YearRange = { ...range };
    if (value === undefined) delete next[which];
    else next[which] = value;
    if (next.from !== undefined && next.to !== undefined && next.from > next.to) [next.from, next.to] = [next.to, next.from];
    onRangeChange(next);
  };
  // A range set by a link may name a year the options lack; keep it selectable.
  const optionsFor = (which: 'from' | 'to') => {
    const list = [...years];
    const current = range[which];
    if (current !== undefined && !list.includes(current)) list.push(current);
    list.sort((a, b) => b - a);
    return [{ value: '', label: which === 'from' ? t('yearFrom') : t('yearTo') }, ...list.map((y) => ({ value: String(y), label: String(y) }))];
  };
  return { chips, loading, active, activeDecade, showYears, range, fmt, pickDecade, setBound, optionsFor, clear: () => onRangeChange({}) };
}

export type YearFilter = ReturnType<typeof useYearFilter>;

/**
 * The decade chips, in a row that scrolls sideways on its own: its edge fades where more chips
 * wait, and a vertical wheel moves it. Each chip shows its title count in the muted tone, so the
 * shape of the catalog shows before you pick.
 */
export function DecadeChips({ filter, className }: { filter: YearFilter; className?: string }) {
  const { t, i18n } = useTranslation('vod');
  const { chips, loading, active, activeDecade, fmt } = filter;
  const fades = useEdgeFades(`${loading}|${chips.map((c) => c.decade).join(',')}|${i18n.language}`);
  const { el: chipRow } = fades;
  // A range set by a link (or a pick made after scrolling) keeps its chip in view.
  useEffect(() => {
    const pressed = chipRow?.querySelector('[aria-pressed="true"]');
    if (chipRow && pressed) revealInRow(chipRow, pressed);
  }, [chipRow, active, activeDecade, loading]);
  if (!filter.showYears) return null;
  return (
    <div
      ref={fades.ref}
      role="group"
      aria-label={t('sort_year')}
      // Room for the focus halo, which the scroller would clip.
      className={cn('-mx-1.5 -my-1.5 flex min-w-0 items-center gap-1.5 overflow-x-auto px-1.5 py-1.5 [scrollbar-width:none]', className)}
      style={fades.style}
      data-testid="vod-year-filter"
    >
      <button type="button" aria-pressed={!active} className={cn(CHIP, !active ? CHIP_ON : CHIP_IDLE)} onClick={filter.clear}>
        {t('yearAll')}
      </button>
      {loading
        ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-16 shrink-0 rounded-full" />)
        : chips.map((c) => {
            const on = activeDecade === c.decade;
            const name = t('decade', { decade: c.decade });
            return (
              <button
                key={c.decade}
                type="button"
                aria-pressed={on}
                aria-label={c.count !== undefined ? `${name}, ${t('titleCount', { count: c.count, formatted: fmt.format(c.count) })}` : undefined}
                className={cn(CHIP, on ? CHIP_ON : CHIP_IDLE)}
                onClick={() => filter.pickDecade(c.decade)}
              >
                {name}
                {c.count !== undefined && (
                  <span aria-hidden data-testid="decade-count" className={cn('text-xs', on ? 'text-bg/70' : 'text-fg-subtle')}>
                    {fmt.format(c.count)}
                  </span>
                )}
              </button>
            );
          })}
    </div>
  );
}

/** The exact From/To range, apart from the chips (the grid's Filters panel). */
export function YearRangeFields({ filter, className }: { filter: YearFilter; className?: string }) {
  const { t } = useTranslation('vod');
  const { range, activeDecade, loading } = filter;
  if (!filter.showYears) return null;
  return (
    <div role="group" aria-label={t('yearRange')} className={cn('flex shrink-0 items-center gap-1.5', className)} data-testid="vod-year-range">
      <Select
        aria-label={t('yearFrom')}
        options={filter.optionsFor('from')}
        value={range.from !== undefined ? String(range.from) : ''}
        onValueChange={(v) => filter.setBound('from', v)}
        className={cn('tabular h-8 w-auto min-w-24', range.from !== undefined && activeDecade === undefined && 'border-accent text-fg')}
        wrapperClassName="shrink-0"
        disabled={loading}
      />
      <Select
        aria-label={t('yearTo')}
        options={filter.optionsFor('to')}
        value={range.to !== undefined ? String(range.to) : ''}
        onValueChange={(v) => filter.setBound('to', v)}
        className={cn('tabular h-8 w-auto min-w-24', range.to !== undefined && activeDecade === undefined && 'border-accent text-fg')}
        wrapperClassName="shrink-0"
        disabled={loading}
      />
    </div>
  );
}
