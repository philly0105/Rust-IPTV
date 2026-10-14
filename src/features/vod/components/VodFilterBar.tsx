import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { Select, Skeleton, Toggle, cn } from '@/ui';

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

export interface VodFilterBarProps {
  sourceId: string;
  kind: VodKind;
  categoryId: string;
  /** Stalker portals: fixed decades, filtered on loaded pages. */
  stalker: boolean;
  range: YearRange;
  onRangeChange: (range: YearRange) => void;
  hideWatched: boolean;
  onHideWatchedChange: (on: boolean) => void;
}

const CHIP =
  'relative inline-flex h-8 shrink-0 items-center rounded-full px-3 text-sm whitespace-nowrap tabular ' +
  'motion-safe:transition-[color,background-color,box-shadow] motion-safe:duration-150';
const CHIP_IDLE = 'bg-surface-2 text-fg-muted ring-1 ring-inset ring-border hover:bg-surface-3 hover:text-fg';
const CHIP_ON = 'bg-accent font-medium text-accent-fg ring-1 ring-inset ring-accent';

/**
 * The filter row under a VOD grid's toolbar (C4): decade chips, an exact
 * From/To range, and "Hide watched". Each decade chip carries a level meter
 * (its share of the busiest decade), like a tuner's signal bar, so the shape
 * of the catalog shows before you pick. On a phone the chips scroll inside
 * the row; the page itself never scrolls sideways.
 */
export function VodFilterBar({
  sourceId,
  kind,
  categoryId,
  stalker,
  range,
  onRangeChange,
  hideWatched,
  onHideWatchedChange,
}: VodFilterBarProps) {
  const { t, i18n } = useTranslation('vod');
  const facetArgs = useMemo(
    () => ({
      sourceId,
      contentType: kind,
      ...(categoryId && categoryId !== ALL_CATEGORIES ? { categoryId } : {}),
    }),
    [sourceId, kind, categoryId],
  );
  const facets = useRpcQuery('catalog.yearFacets', facetArgs, { enabled: !stalker && !!sourceId, staleTime: 60_000 });
  const fmt = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);

  // A failed facet lookup still offers the decades, without levels.
  const chips: DecadeChip[] = facets.isError ? STALKER_DECADES.map((decade) => ({ decade })) : decadeChips(stalker, facets.data);
  const years = yearOptions(stalker || facets.isError, facets.data);
  const loading = !stalker && facets.isPending;
  const active = hasYearRange(range);
  const activeDecade = rangeDecade(range);
  const max = chips.reduce((m, c) => Math.max(m, c.count ?? 0), 0);
  // Titles without any year: nothing to filter by, unless a link already set a range.
  const showYears = loading || chips.length > 0 || active;

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

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-divider px-4 py-2 md:px-8" data-testid="vod-filter-bar">
      {showYears && (
        <div
          role="group"
          aria-label={t('sort_year')}
          // Room for the focus halo, which the scroller would clip.
          className="-mx-1.5 -my-1.5 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-1.5 py-1.5 [scrollbar-width:none]"
          data-testid="vod-year-filter"
        >
          <button type="button" aria-pressed={!active} className={cn(CHIP, !active ? CHIP_ON : CHIP_IDLE)} onClick={() => onRangeChange({})}>
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
                    onClick={() => pickDecade(c.decade)}
                  >
                    {name}
                    {c.count !== undefined && max > 0 && (
                      <span aria-hidden className={cn('absolute inset-x-3 bottom-1 h-0.5 overflow-hidden rounded-full', on ? 'bg-accent-fg/25' : 'bg-border')}>
                        <span
                          className={cn('block h-full rounded-full', on ? 'bg-accent-fg/80' : 'bg-accent')}
                          style={{ width: `${Math.max(6, Math.round((c.count / max) * 100))}%` }}
                        />
                      </span>
                    )}
                  </button>
                );
              })}
          <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-divider" />
          <Select
            aria-label={t('yearFrom')}
            options={optionsFor('from')}
            value={range.from !== undefined ? String(range.from) : ''}
            onValueChange={(v) => setBound('from', v)}
            className={cn('tabular h-8 w-24', range.from !== undefined && activeDecade === undefined && 'border-accent text-fg')}
            wrapperClassName="shrink-0"
            disabled={loading}
          />
          <Select
            aria-label={t('yearTo')}
            options={optionsFor('to')}
            value={range.to !== undefined ? String(range.to) : ''}
            onValueChange={(v) => setBound('to', v)}
            className={cn('tabular h-8 w-24', range.to !== undefined && activeDecade === undefined && 'border-accent text-fg')}
            wrapperClassName="shrink-0"
            disabled={loading}
          />
        </div>
      )}
      <Toggle
        className="ms-auto shrink-0 items-center gap-2"
        label={t('hideWatched')}
        checked={hideWatched}
        onChange={onHideWatchedChange}
      />
    </div>
  );
}
