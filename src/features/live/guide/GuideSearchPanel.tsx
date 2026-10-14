/**
 * Guide search (Run 2 C5): a toolbar field (`/` focuses it) and a floating
 * results panel. Queries `epg.search` for the selected source 250 ms after
 * typing stops, from what airs now to 14 days ahead, and lists the hits by
 * day with channel, time and title. Choosing a hit moves the grid to it; each
 * hit also offers Watch (while it airs), Remind, Record and Record series.
 */

import type { TFunction } from 'i18next';
import { CalendarOff, Radio, SearchX, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useRpcQuery } from '@/api/query';
import type { GuideSearchHit } from '@/api/types';
import { ProgramActions } from '@/features/recording';
import { buttonClass, cn, EmptyState, ErrorState, IconButton, SearchInput, Skeleton } from '@/ui';

import { useDebounced } from '../hooks/useDebounced';
import { displayChannelName } from '../lib/channelName';
import { formatClock, formatDay, localDayDiff, ms, programWhen } from '../lib/epgTime';
import { ChannelLogo } from '../components/ChannelLogo';
import { displayHits, groupHitsByDay, hitKey, SEARCH_LIMIT, searchQuery, searchWindow } from './search';

/** Debounce before a query is sent. */
export const SEARCH_DEBOUNCE_MS = 250;

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
 * Where the results panel goes, horizontally: its inline end lined up with the field's, then slid
 * back inside `bounds` (the guide page) so that a field near the page's other edge (a phone, or a
 * toolbar that wrapped the field to the start of a row) never pushes it off screen or under the
 * rail. `left` is relative to the field's left edge; null when there is no room to measure.
 */
export function panelPlacement(field: Span, bounds: Span, maxWidth: number, rtl: boolean, margin = PANEL_MARGIN): { left: number; width: number } | null {
  const room = bounds.right - bounds.left - 2 * margin;
  if (!(room > 0)) return null;
  const width = Math.min(maxWidth, room);
  const want = rtl ? field.left : field.right - width;
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

export interface GuideSearchProps extends SharedProps {
  /** For the `/` shortcut. */
  inputRef: RefObject<HTMLInputElement | null>;
  className?: string;
}

/** The toolbar field with its results panel. */
export function GuideSearch({ inputRef, className, onSelect, onWatch, ...rest }: GuideSearchProps) {
  const { t } = useTranslation('guide');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // A press outside closes the panel; dialogs opened from a hit (Record series) are not outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node) || wrapRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-dialog-layer]')) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  // The panel is placed against the guide page, not just under the field: see panelPlacement.
  const [place, setPlace] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const field = wrap.getBoundingClientRect();
      const bounds = (wrap.closest<HTMLElement>(`[${SEARCH_BOUNDS_ATTR}]`) ?? document.documentElement).getBoundingClientRect();
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 15;
      const spot = panelPlacement(field, bounds, PANEL_MAX_REM * rem, getComputedStyle(wrap).direction === 'rtl');
      // No layout (jsdom, a hidden page): the classes' end-anchored fallback stays.
      if (!spot || field.width === 0) {
        setPlace(null);
        return;
      }
      const below = window.innerHeight - field.bottom - PANEL_GAP - PANEL_MARGIN;
      setPlace({ left: spot.left, width: spot.width, maxHeight: Math.max(160, Math.min(PANEL_MAX_HEIGHT_REM * rem, below)) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) inputRef.current?.focus();
  };

  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && open) {
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
  };

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <SearchInput
        ref={inputRef}
        size="sm"
        value={query}
        onChange={(v) => {
          setQuery(v);
          setOpen(v.trim().length > 0);
        }}
        onFocus={() => {
          if (query.trim()) setOpen(true);
        }}
        onKeyDown={onFieldKey}
        placeholder={t('searchPlaceholder')}
        label={t('searchLabel')}
        aria-controls={open ? panelId : undefined}
        className="w-full"
        data-testid="guide-search-input"
      />
      {open ? (
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
          // Physical `left` from the measurement wins over the logical end anchor, which would
          // over-constrain the box in RTL; the anchor is only the fallback before a layout exists.
          className={cn('absolute top-full z-30 mt-1.5', !place && 'end-0')}
          style={place ?? undefined}
        />
      ) : null}
    </div>
  );
}

export interface GuideSearchPanelProps extends SharedProps {
  id?: string;
  /** The field's text, as typed. */
  query: string;
  /** `refocus`: hand focus back to the field. */
  onClose(refocus: boolean): void;
  className?: string;
  /** Measured placement (left, width, max height), from GuideSearch. */
  style?: CSSProperties;
}

/** "Today", "Tomorrow" in the UI language, else the date. The join is the language's own (`dayHeading`). */
function dayHeading(day: number, now: number, locale: string, t: TFunction<'guide'>): string {
  const diff = localDayDiff(day, now);
  const date = formatDay(day, locale);
  if (diff < 0 || diff > 1) return date;
  const rel = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(diff, 'day');
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
  const days = useMemo(() => groupHitsByDay(hits ?? []), [hits]);
  const pending = settling || search.isFetching;

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
                <HitRow key={hitKey(h)} hit={h} now={now} lang={lang} strip={stripCountryPrefix} onSelect={onSelect} onWatch={onWatch} />
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
        'flex max-h-[min(34rem,calc(100dvh-9rem))] w-[min(30rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg border border-border bg-surface text-fg shadow-2',
        'motion-safe:animate-fade-in',
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-divider py-1.5 ps-4 pe-1.5">
        <h2 id={headingId} className="min-w-0 flex-1 truncate font-display text-[calc(13rem/15)] font-semibold">
          {t('searchResults')}
        </h2>
        <span className="font-display text-xs tabular-nums text-fg-subtle" aria-live="polite" data-testid="guide-search-count">
          {state === 'results' && hits ? t('resultsCount', { n: hits.length }) : ''}
        </span>
        <IconButton size="sm" label={t('closeSearch')} icon={<X className="size-4" aria-hidden />} onClick={() => onClose(true)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{body}</div>
    </div>
  );
}

function HitRow({
  hit,
  now,
  lang,
  strip,
  onSelect,
  onWatch,
}: {
  hit: GuideSearchHit;
  now: number;
  lang: string;
  strip?: boolean;
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
    <li className="group flex items-center gap-1 pe-2 hover:bg-surface-2" data-hit-row="" data-testid="guide-search-hit">
      <button
        type="button"
        data-hit=""
        onClick={() => onSelect(hit)}
        aria-label={t('hitLabel', { title: program.title, channel: name, time })}
        className="flex min-w-0 flex-1 items-center gap-3 py-2 ps-4 pe-1 text-start outline-none focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      >
        {/* Wide enough for a 12-hour "05:00 AM" on one line; a longer local format widens it, never wraps it. */}
        <span className="flex min-w-[4.5rem] shrink-0 flex-col items-start">
          <span className={cn('font-display text-[calc(14rem/15)] leading-tight font-semibold whitespace-nowrap tabular-nums', airing ? 'text-live' : 'text-fg')}>{time}</span>
          {airing ? <span className="text-[calc(10rem/15)] leading-tight text-live">{t('airingNow')}</span> : null}
        </span>
        <ChannelLogo src={hit.logoUrl} name={name} size={28} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span dir="auto" className="truncate text-sm font-medium text-match-parent">
            {program.title}
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
        <ProgramActions channelRef={hit.ref} channelName={name} program={program} now={now} variant="icons" />
      </span>
    </li>
  );
}
