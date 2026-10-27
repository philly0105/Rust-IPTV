/**
 * Guide search (Run 2 C5): the header's search field (`/` and Ctrl+F focus it) and a floating
 * results panel under it. Queries `epg.search` for the selected source 120 ms after
 * typing stops, from what airs now to 14 days ahead, and lists the hits by
 * day with channel, time and title. Choosing a hit moves the grid to it; each
 * hit also offers Watch (while it airs), Remind, Record and Record series.
 */

import type { TFunction } from 'i18next';
import { CalendarOff, Radio, SearchX, X } from 'lucide-react';
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useRpcQuery } from '@/api/query';
import type { GuideSearchHit } from '@/api/types';
import { ProgramActionsView, ScheduleMarkView, useProgramActionsShared, type ProgramActionsShared } from '@/features/recording';
import { useShell } from '@/shell';
import { buttonClass, cn, EmptyState, ErrorState, IconButton, Skeleton } from '@/ui';
import { intlLocale } from '@/lib/intl';

import { useDebounced } from '../hooks/useDebounced';
import { displayChannelName } from '../lib/channelName';
import { formatClock, formatDay, localDayDiff, ms, programWhen } from '../lib/epgTime';
import { ChannelLogo } from '../components/ChannelLogo';
import { displayHits, groupHitsByDay, hitKey, SEARCH_LIMIT, searchQuery, searchWindow } from './search';
import { useStable } from './useStable';

/** Debounce before a query is sent (the search itself answers within the 150 ms budget's rest). */
export const SEARCH_DEBOUNCE_MS = 120;
/**
 * Hits mounted with the first frame of an answer; the rest follow a batch per frame, so a
 * keystroke never mounts a hundred rows in one task (L2-perf-ui-2).
 */
export const HITS_FIRST_BATCH = 20;

/** The panel's widest, in rem (it follows the UI scale). */
const PANEL_MAX_REM = 30;
const PANEL_MAX_HEIGHT_REM = 34;
/** Room the panel keeps from the bounds' edges and the window's bottom, px. */
const PANEL_MARGIN = 8;
/** The gap between the field and the panel (`mt-1.5`), px. */
const PANEL_GAP = 6;
/** Marks the element the panel must stay inside (the guide page, beside the rail). */
export const SEARCH_BOUNDS_ATTR = 'data-guide-search-bounds';

interface Span {
  left: number;
  right: number;
}

/**
 * Where the results panel goes, horizontally: its inline start lined up with the field's (it hangs
 * from the field it answers, over the grid, not back over the pickers and the channel column), then slid
 * back inside `bounds` (the guide page) so that a field near the page's other edge (a phone, or a
 * toolbar that wrapped the field to the start of a row) never pushes it off screen or under the
 * rail. `left` is relative to the field's left edge; null when there is no room to measure.
 */
export function panelPlacement(field: Span, bounds: Span, maxWidth: number, rtl: boolean, margin = PANEL_MARGIN): { left: number; width: number } | null {
  const room = bounds.right - bounds.left - 2 * margin;
  if (!(room > 0)) return null;
  const width = Math.min(maxWidth, room);
  const want = rtl ? field.right - width : field.left;
  const left = Math.max(bounds.left + margin, Math.min(want, bounds.right - margin - width));
  return { left: left - field.left, width };
}

interface SharedProps {
  /** The grid's source: hits map to its channels. */
  sourceId: string;
  /** Display time = guide time + this. */
  offsetMinutes: number;
  now: number;
  stripCountryPrefix?: boolean;
  /** A hit in display time: move the grid to it. */
  onSelect(hit: GuideSearchHit): void;
  /** Play the channel of an airing hit. */
  onWatch(hit: GuideSearchHit): void;
}

export interface GuideHeaderSearchProps extends SharedProps {
  /** The header's title and subtitle, which this component sets along with the search slot. */
  title: string;
  subtitle?: string;
  /** The header's field, for the `/` shortcut. */
  inputRef: RefObject<HTMLInputElement | null>;
  /** No source yet (the sources list is loading): the field holds its place, disabled. */
  disabled?: boolean;
  /** False: the header has no field (no sources, or they failed to load: nothing to search). */
  field?: boolean;
  /** The header's actions (a phone's genre filter); left out with the field. */
  actions?: ReactNode;
}

/**
 * The guide's search in the shell header's search slot, where every page that searches its own
 * content has its field (and Ctrl+F reaches it), with the results panel hanging under it. It owns
 * the header (title, subtitle and the field) and the query, so typing re-renders this and the
 * header, not the grid. Renders the panel only; place it inside the page (SEARCH_BOUNDS_ATTR).
 */
export const GuideHeaderSearch = memo(function GuideHeaderSearch({ title, subtitle, inputRef, onSelect, onWatch, disabled, field = true, actions, ...rest }: GuideHeaderSearchProps) {
  const { t } = useTranslation('guide');
  const { setHeader } = useShell();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const shown = open && !disabled && field;

  // A press outside the field and the panel closes it; dialogs opened from a hit (Record series) are not outside.
  useEffect(() => {
    if (!shown) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      // The field's box holds its clear button too.
      if (inputRef.current?.parentElement?.contains(target) || document.getElementById(panelId)?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-dialog-layer]')) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [shown, inputRef, panelId]);

  // The panel hangs under the header's field, kept inside the guide page: see panelPlacement.
  const [place, setPlace] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!shown) return;
    const measure = () => {
      const input = inputRef.current;
      const panel = document.getElementById(panelId);
      if (!input || !panel) return;
      const field = (input.parentElement ?? input).getBoundingClientRect();
      const bounds = (panel.closest<HTMLElement>(`[${SEARCH_BOUNDS_ATTR}]`) ?? document.documentElement).getBoundingClientRect();
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 15;
      const spot = panelPlacement(field, bounds, PANEL_MAX_REM * rem, getComputedStyle(input).direction === 'rtl');
      // No layout (jsdom, a hidden page): the classes' fallback under the header stays.
      if (!spot || field.width === 0) {
        setPlace(null);
        return;
      }
      const top = field.bottom + PANEL_GAP;
      const below = window.innerHeight - top - PANEL_MARGIN;
      setPlace({ top, left: field.left + spot.left, width: spot.width, maxHeight: Math.max(160, Math.min(PANEL_MAX_HEIGHT_REM * rem, below)) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [shown, inputRef, panelId]);

  const close = useStable((refocus: boolean) => {
    setOpen(false);
    if (refocus) inputRef.current?.focus();
  });

  const placeholder = t('searchPlaceholder');
  const label = t('searchLabel');
  useEffect(() => {
    if (!field) {
      setHeader({ title, subtitle });
      return;
    }
    setHeader({
      title,
      subtitle,
      actions,
      search: {
        value: query,
        onChange: (v) => {
          setQuery(v);
          setOpen(v.trim().length > 0);
        },
        onFocus: () => {
          if (query.trim()) setOpen(true);
        },
        onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Escape' && shown) {
            // First Escape closes the panel, the next one clears the field.
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          } else if ((e.key === 'ArrowDown' || e.key === 'Enter') && query.trim()) {
            e.preventDefault();
            setOpen(true);
            // The first hit, once the panel shows one.
            requestAnimationFrame(() => document.getElementById(panelId)?.querySelector<HTMLElement>('[data-hit]')?.focus());
          }
        },
        placeholder,
        label,
        inputRef,
        controls: shown ? panelId : undefined,
        disabled,
      },
    });
  }, [setHeader, title, subtitle, actions, query, shown, placeholder, label, inputRef, panelId, disabled, field]);

  return shown ? (
    <GuideSearchPanel
      {...rest}
      id={panelId}
      query={query}
      onClose={close}
      onSelect={(hit) => {
        setOpen(false);
        onSelect(hit);
      }}
      onWatch={(hit) => {
        setOpen(false);
        onWatch(hit);
      }}
      // Fixed, so the header's edge and the page's scroll box do not clip it. Before a layout
      // exists it sits under the header at the page's end; the measurement places it under the field.
      className={cn('fixed z-30', !place && 'end-2 top-[calc(var(--header-height)+0.375rem)]')}
      style={place ?? undefined}
    />
  ) : null;
});

export interface GuideSearchPanelProps extends SharedProps {
  id?: string;
  /** The field's text, as typed. */
  query: string;
  /** `refocus`: hand focus back to the field. */
  onClose(refocus: boolean): void;
  className?: string;
  /** Measured placement (top, left, width, max height), from GuideHeaderSearch. */
  style?: CSSProperties;
}

/** "Today", "Tomorrow" in the UI language, else the date. The join is the language's own (`dayHeading`). */
function dayHeading(day: number, now: number, locale: string, t: TFunction<'guide'>): string {
  const diff = localDayDiff(day, now);
  const date = formatDay(day, locale);
  if (diff < 0 || diff > 1) return date;
  const rel = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' }).format(diff, 'day');
  return t('dayHeading', { rel: `${rel.charAt(0).toLocaleUpperCase(locale)}${rel.slice(1)}`, date });
}

export function GuideSearchPanel({ id, query, sourceId, offsetMinutes, now, stripCountryPrefix, onSelect, onWatch, onClose, className, style }: GuideSearchPanelProps) {
  const { t, i18n } = useTranslation('guide');
  const lang = i18n.language;
  const debounced = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const q = searchQuery(debounced);
  const typed = searchQuery(query);
  // Typing ahead of the debounce, or a request in flight: results on screen may be stale.
  const settling = typed !== q;
  const listRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  // "Guide not loaded": no enabled guide holds a programme. Searches wait for this answer.
  const guides = useRpcQuery('epg.sources', undefined, { staleTime: 60_000 });
  const noGuide = !!guides.data && !guides.data.some((g) => g.enabled && g.programCount > 0);

  const { from, to } = searchWindow(now, offsetMinutes);
  const search = useRpcQuery(
    'epg.search',
    { sourceId, query: q ?? '', from, to, limit: SEARCH_LIMIT },
    { enabled: !!q && !!sourceId && !guides.isLoading && !noGuide, staleTime: 60_000, keepPrevious: true },
  );
  const hits = useMemo(() => (search.data ? displayHits(search.data, offsetMinutes) : undefined), [search.data, offsetMinutes]);
  // A new answer mounts its first hits at once and the rest a batch per frame.
  const [shown, setShown] = useState<{ hits: typeof hits; n: number }>({ hits, n: HITS_FIRST_BATCH });
  const shownN = shown.hits === hits ? shown.n : HITS_FIRST_BATCH;
  if (shown.hits !== hits) setShown({ hits, n: HITS_FIRST_BATCH });
  const total = hits?.length ?? 0;
  useEffect(() => {
    if (shownN >= total) return;
    const id = requestAnimationFrame(() => setShown((s) => (s.hits === hits ? { hits, n: s.n + HITS_FIRST_BATCH } : s)));
    return () => cancelAnimationFrame(id);
  }, [hits, shownN, total]);
  const days = useMemo(() => groupHitsByDay((hits ?? []).slice(0, shownN)), [hits, shownN]);
  const pending = settling || search.isFetching;
  // One read of the schedule, rules and recording support for every hit's actions.
  const shared = useProgramActionsShared();
  // Stable for the memoised rows: each reads the latest callback.
  const handlers = useRef({ onSelect, onWatch });
  handlers.current = { onSelect, onWatch };
  const select = useMemo(() => (hit: GuideSearchHit) => handlers.current.onSelect(hit), []);
  const watch = useMemo(() => (hit: GuideSearchHit) => handlers.current.onWatch(hit), []);

  const focusHit = (from: HTMLElement | null, step: number | 'first' | 'last') => {
    const all = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-hit]') ?? [])];
    if (all.length === 0) return;
    const i = from ? all.indexOf(from) : -1;
    const next = step === 'first' ? 0 : step === 'last' ? all.length - 1 : Math.min(all.length - 1, Math.max(0, i + step));
    all[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys from a dialog a hit opened (a portal) bubble here through React; they are not the panel's.
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
      return;
    }
    const hit = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-hit-row]')?.querySelector<HTMLElement>('[data-hit]') ?? null : null;
    if (!hit) return;
    let step: number | 'first' | 'last' | null = null;
    if (e.key === 'ArrowDown') step = 1;
    else if (e.key === 'ArrowUp') step = -1;
    else if (e.key === 'Home') step = 'first';
    else if (e.key === 'End') step = 'last';
    if (step === null) return;
    e.preventDefault();
    if (step === -1 && hit === listRef.current?.querySelector('[data-hit]')) {
      // Up from the first hit goes back to the field.
      if (id) document.querySelector<HTMLElement>(`[aria-controls="${id}"]`)?.focus();
      return;
    }
    focusHit(hit, step);
  };

  let body;
  let state: 'hint' | 'noGuide' | 'loading' | 'error' | 'empty' | 'results';
  if (!typed) {
    state = 'hint';
    body = <p className="px-4 py-6 text-center text-sm text-fg-muted">{t('searchHint')}</p>;
  } else if (noGuide) {
    state = 'noGuide';
    body = (
      <EmptyState
        size="inline"
        icon={<CalendarOff size={20} aria-hidden />}
        title={t('searchNoGuide')}
        description={t('searchNoGuideHint')}
        action={
          <Link to="/settings/epg" className={buttonClass('secondary', 'sm')}>
            {t('epgSettings')}
          </Link>
        }
      />
    );
  } else if (search.error && !pending) {
    state = 'error';
    body = <ErrorState size="inline" error={search.error} retrying={search.isFetching} onRetry={() => void search.refetch()} />;
  } else if (!hits || !q || (hits.length === 0 && pending)) {
    state = 'loading';
    body = (
      <div className="flex flex-col gap-3 px-4 py-3" aria-hidden data-testid="guide-search-loading">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-4 w-[4.5rem]" />
            <Skeleton className="size-7" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (hits.length === 0) {
    state = 'empty';
    body = <EmptyState size="inline" icon={<SearchX size={20} aria-hidden />} title={t('searchEmpty', { query: q ?? typed })} description={t('searchEmptyHint')} />;
  } else {
    state = 'results';
    body = (
      <div ref={listRef} className={cn('flex flex-col', pending && 'opacity-70 motion-safe:transition-opacity')}>
        {days.map((d) => (
          <section key={d.day} aria-label={dayHeading(d.day, now, lang, t)}>
            <h3 className="sticky top-0 z-10 border-b border-divider bg-surface-2 px-4 py-1.5 text-xs font-medium text-fg-muted" data-testid="guide-search-day">
              {dayHeading(d.day, now, lang, t)}
            </h3>
            <ul className="flex flex-col divide-y divide-divider">
              {d.hits.map((h) => (
                <HitRow key={hitKey(h)} hit={h} now={now} lang={lang} strip={stripCountryPrefix} shared={shared} onSelect={select} onWatch={watch} />
              ))}
            </ul>
          </section>
        ))}
        {hits.length >= SEARCH_LIMIT ? <p className="px-4 py-3 text-center text-xs text-fg-subtle">{t('searchMore', { n: SEARCH_LIMIT })}</p> : null}
      </div>
    );
  }

  return (
    <div
      id={id}
      role="region"
      aria-labelledby={headingId}
      aria-busy={state === 'loading'}
      onKeyDown={onKeyDown}
      data-testid="guide-search-panel"
      data-state={state}
      style={style}
      className={cn(
        'flex max-h-[min(34rem,calc(100dvh-9rem))] w-[min(30rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg border border-edge bg-surface text-fg shadow-2',
        'motion-safe:animate-fade-in',
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-divider py-1.5 ps-4 pe-1.5">
        <h2 id={headingId} className="min-w-0 flex-1 truncate font-display text-[calc(13rem/15)] font-semibold">
          {t('searchResults')}
        </h2>
        <span className="font-display text-xs tabular-nums text-fg-subtle" aria-live="polite" data-testid="guide-search-count">
          {state === 'results' && hits ? t('resultCount', { count: hits.length }) : ''}
        </span>
        <IconButton size="sm" label={t('closeSearch')} icon={<X className="size-4" aria-hidden />} onClick={() => onClose(true)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{body}</div>
    </div>
  );
}

const HitRow = memo(function HitRow({
  hit,
  now,
  lang,
  strip,
  shared,
  onSelect,
  onWatch,
}: {
  hit: GuideSearchHit;
  now: number;
  lang: string;
  strip?: boolean;
  shared: ProgramActionsShared;
  onSelect(hit: GuideSearchHit): void;
  onWatch(hit: GuideSearchHit): void;
}) {
  const { t } = useTranslation('guide');
  const { program } = hit;
  const name = displayChannelName(hit.channelName, strip);
  const start = ms(program.start);
  const airing = programWhen(program, now) === 'now';
  const time = formatClock(start, lang);

  return (
    <li className="group flex items-center gap-1 pe-2 hover:bg-hover" data-hit-row="" data-testid="guide-search-hit">
      <button
        type="button"
        data-hit=""
        onClick={() => onSelect(hit)}
        aria-label={t('hitLabel', { title: program.title, channel: name, time })}
        className="flex min-w-0 flex-1 items-center gap-3 py-2 ps-4 pe-1 text-start outline-none focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
      >
        {/* Wide enough for a 12-hour "05:00 AM" on one line; a longer local format widens it, never wraps it. */}
        <span className="flex min-w-[4.5rem] shrink-0 flex-col items-start">
          {/* The title leads; the time is a quieter readout beside it. */}
          <span className={cn('font-numeric text-body-sm leading-tight whitespace-nowrap tabular-nums', airing ? 'text-live' : 'text-fg-muted')}>{time}</span>
          {airing ? <span className="text-[calc(10rem/15)] leading-tight text-live">{t('airingNow')}</span> : null}
        </span>
        <ChannelLogo src={hit.logoUrl} name={name} size={28} sourceId={hit.ref.sourceId} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span dir="auto" className="truncate text-sm font-medium text-match-parent">
              {program.title}
            </span>
            {/* recording: what is set shows at rest; the buttons that change it come on hover. */}
            <ScheduleMarkView index={shared.index} channelRef={hit.ref} program={program} />
          </span>
          <span className="flex min-w-0 gap-1.5 text-xs text-fg-muted">
            {hit.channelNumber !== undefined ? <span className="shrink-0 tabular-nums text-fg-subtle">{hit.channelNumber}</span> : null}
            <span dir="auto" className="truncate">
              {name}
            </span>
          </span>
        </span>
      </button>
      <span className="flex shrink-0 items-center">
        {airing ? (
          <IconButton size="sm" label={t('watchNow', { channel: name })} icon={<Radio className="size-4 text-live" aria-hidden />} onClick={() => onWatch(hit)} data-testid="guide-search-watch" />
        ) : null}
        {/* A column of record and remind buttons on every hit read as a list of alerts: they
            come with hover or focus. A touch screen has neither, and three 44 px buttons per hit
            left a phone's titles "W..": a tap shows the hit in the grid, and its cell's card has
            Remind and Record. */}
        <span className="flex items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:hidden" data-testid="guide-search-actions">
          <ProgramActionsView channelRef={hit.ref} channelName={name} program={program} now={now} variant="icons" shared={shared} />
        </span>
      </span>
    </li>
  );
});
