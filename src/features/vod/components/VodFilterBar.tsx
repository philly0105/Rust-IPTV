import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { rpcKey } from '@/api/query';
import { rpc, type RpcError } from '@/api/transport';
import type { YearFacet } from '@/api/types';
import { Select, Skeleton, Toggle, cn } from '@/ui';

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

export interface VodFilterBarProps {
  sourceId: string;
  kind: VodKind;
  categoryId: string;
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
  hideWatched: boolean;
  onHideWatchedChange: (on: boolean) => void;
}

const CHIP =
  'relative inline-flex h-8 shrink-0 items-center rounded-full px-3 text-sm whitespace-nowrap tabular ' +
  'motion-safe:transition-[color,background-color,box-shadow] motion-safe:duration-150';
const CHIP_IDLE = 'bg-surface-2 text-fg-muted ring-1 ring-inset ring-border hover:bg-surface-3 hover:text-fg';
const CHIP_ON = 'bg-accent font-medium text-accent-fg ring-1 ring-inset ring-accent';

/** Sources whose facets had years this session: their row is worth reserving while it loads. */
const sourcesWithYears = new Set<string>();

/**
 * The filter row under a VOD grid's toolbar (C4): decade chips, an exact
 * From/To range, and "Hide watched". Each decade chip carries a level meter
 * (its share of the busiest decade), like a tuner's signal bar, so the shape
 * of the catalog shows before you pick. While "Hide watched" is on, the
 * facets are asked with `hideWatched`, so the counts and meters match what
 * the grid keeps.
 *
 * Only the chips scroll: their edge fades where more chips wait, and the
 * From/To selects and the switch stay in view beside them. When the bar is
 * narrower than 42rem (a phone, a narrow window) the chips take the first
 * line and the selects and the switch share the second. The page itself
 * never scrolls sideways.
 */
export function VodFilterBar({
  sourceId,
  kind,
  categoryId,
  stalker,
  yearsLikely,
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
      ...(hideWatched ? { hideWatched: true } : {}),
    }),
    [sourceId, kind, categoryId, hideWatched],
  );
  const facets = useQuery<YearFacet[], RpcError>({
    queryKey: rpcKey('catalog.yearFacets', facetArgs),
    queryFn: () => rpc('catalog.yearFacets', facetArgs),
    enabled: !stalker && !!sourceId,
    staleTime: 60_000,
    // Flipping Hide watched keeps the chips (and their old levels) until the new counts arrive, instead of skeletons.
    placeholderData: (prev, prevQuery) => {
      const p = prevQuery?.queryKey[1] as typeof facetArgs | null | undefined;
      return p && p.sourceId === sourceId && p.contentType === kind && p.categoryId === facetArgs.categoryId ? prev : undefined;
    },
  });
  const fmt = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);

  // A failed facet lookup still offers the decades, without levels.
  const chips: DecadeChip[] = facets.isError ? STALKER_DECADES.map((decade) => ({ decade })) : decadeChips(stalker, facets.data);
  const years = yearOptions(stalker || facets.isError, facets.data);
  const loading = !stalker && facets.isPending;
  const active = hasYearRange(range);
  const activeDecade = rangeDecade(range);
  const max = chips.reduce((m, c) => Math.max(m, c.count ?? 0), 0);
  if (!stalker && (facets.data?.length ?? 0) > 0) sourcesWithYears.add(sourceId);
  // Titles without any year: nothing to filter by, unless a link already set a range.
  const showYears = (loading && (yearsLikely || sourcesWithYears.has(sourceId))) || chips.length > 0 || active;
  const fades = useEdgeFades(`${loading}|${chips.map((c) => c.decade).join(',')}|${i18n.language}`);
  const { el: chipRow } = fades;
  // A range set by a link (or a pick made after scrolling) keeps its chip in view.
  useEffect(() => {
    const pressed = chipRow?.querySelector('[aria-pressed="true"]');
    if (chipRow && pressed) revealInRow(chipRow, pressed);
  }, [chipRow, active, activeDecade, loading]);

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
    // A size container: the layout follows the bar's own width (a sidebar can make it narrow on a wide screen).
    <div className="@container border-b border-divider px-4 py-2 md:px-8" data-testid="vod-filter-bar">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {showYears && (
          <div
            ref={fades.ref}
            role="group"
            aria-label={t('sort_year')}
            // Room for the focus halo, which the scroller would clip; `grow` takes back the negative margins.
            className="-mx-1.5 -my-1.5 flex min-w-0 grow basis-full items-center gap-1.5 overflow-x-auto px-1.5 py-1.5 [scrollbar-width:none] @2xl:basis-0"
            style={fades.style}
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
                        <span
                          aria-hidden
                          className={cn('absolute inset-x-3 bottom-1 h-0.5 overflow-hidden rounded-full', on ? 'bg-accent-fg/25' : 'bg-border')}
                          data-testid="decade-meter"
                        >
                          <span
                            className={cn('block h-full rounded-full', on ? 'bg-accent-fg/80' : 'bg-accent')}
                            style={{ width: `${Math.max(6, Math.round((c.count / max) * 100))}%` }}
                          />
                        </span>
                      )}
                    </button>
                  );
                })}
          </div>
        )}
        <div className="ms-auto flex min-w-0 basis-full flex-wrap items-center gap-x-4 gap-y-2 @2xl:basis-auto">
          {showYears && (
            <div role="group" aria-label={t('yearRange')} className="flex shrink-0 items-center gap-1.5" data-testid="vod-year-range">
              {/* Sets the exact range apart from the chips when they share a line. */}
              <span aria-hidden className="me-2.5 hidden h-5 w-px shrink-0 bg-divider @2xl:block" />
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
      </div>
    </div>
  );
}
