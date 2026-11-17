/**
 * Guide search (Run 2 C5): the header's search field (`/` and Ctrl+F focus it) and a floating
 * results panel under it. 120 ms after typing stops it asks for the source's channels whose name
 * matches (a few, listed first: choosing one moves the grid to its row) and `epg.search` for
 * programmes from what airs now to 14 days ahead, listed by day with time, title and channel. A
 * show on several channels at the same time is one row, its other channels behind "+N channels",
 * as the Search page folds them. Choosing a hit moves the grid to it; each hit also offers Watch
 * (while it airs), Remind, Record and Record series. The last row hands the query to the app's
 * Search page.
 */

import type { TFunction } from 'i18next';
import { CalendarOff, Radio, Search, SearchX, X } from 'lucide-react';
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useRpcQuery } from '@/api/query';
import type { Channel, GuideSearchHit } from '@/api/types';
import { ProgramActionsView, ScheduleMarkView, useProgramActionsShared, type ProgramActionsShared } from '@/features/recording';
import { useShell } from '@/shell';
import { SearchEverythingLink } from '@/shell/SearchEverythingLink';
import { buttonClass, cn, EmptyState, ErrorState, IconButton, Skeleton, TOUCH_TARGET } from '@/ui';
import { intlLocale, numberFormat } from '@/lib/intl';

import { useDebounced } from '../hooks/useDebounced';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { displayChannelName, isSeparatorName, plainChannelName } from '../lib/channelName';
import { formatClock, formatDay, localDayDiff, ms, programWhen } from '../lib/epgTime';
import { ChannelLogo, ChannelName } from '../components/ChannelLogo';
import { displayHits, foldHits, groupHitsByDay, hitKey, SEARCH_LIMIT, searchQuery, searchWindow } from './search';
import { useStable } from './useStable';

/** Debounce before a query is sent (the search itself answers within the 150 ms budget's rest). */
export const SEARCH_DEBOUNCE_MS = 120;
/**
 * Hits mounted with the first frame of an answer; the rest follow a batch per frame, so a
 * keystroke never mounts a hundred rows in one task (L2-perf-ui-2).
 */
export const HITS_FIRST_BATCH = 20;
/** Channels listed above the programmes: enough to find "espn" among its variants, few enough to leave room. */
export const CHANNEL_HITS = 5;

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
  /** A channel whose name matched: move the grid to its row. */
  onSelectChannel(channel: Channel): void;
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
export const GuideHeaderSearch = memo(function GuideHeaderSearch({ title, subtitle, inputRef, onSelect, onSelectChannel, onWatch, disabled, field = true, actions, ...rest }: GuideHeaderSearchProps) {
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

  // The header field is 24vw wide: below about 1360 px the full hint ("Search programmes and
  // channels") was cut mid-word, losing the part that says channels are searchable, so a
  // narrower field shows the field's name instead.
  const roomy = useMediaQuery('(min-width: 1360px)');
  const label = t('searchLabel');
  const placeholder = roomy ? t('searchPlaceholder') : label;
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
      onSelectChannel={(channel) => {
        setOpen(false);
        onSelectChannel(channel);
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

export function GuideSearchPanel({ id, query, sourceId, offsetMinutes, now, stripCountryPrefix, onSelect, onSelectChannel, onWatch, onClose, className, style }: GuideSearchPanelProps) {
  const { t, i18n } = useTranslation('guide');
  const { t: tl } = useTranslation('live');
  const { t: ts } = useTranslation('shell');
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
  // A user who types a channel's name to find its row: the source's channels that match, by name.
  const channelSearch = useRpcQuery(
    'catalog.channels',
    { sourceId, query: { offset: 0, limit: CHANNEL_HITS, search: q ?? '' } },
    { enabled: !!q && !!sourceId, staleTime: 60_000, keepPrevious: true },
  );
  // A provider's heading row ("#### SKY SPORTS ####") is no channel to jump to.
  const channels = q ? (channelSearch.data?.items ?? []).filter((c) => !isSeparatorName(c.name)) : [];
  // The same show on several channels at once is one row (the Search page's folding).
  const hits = useMemo(() => (search.data ? foldHits(displayHits(search.data, offsetMinutes)) : undefined), [search.data, offsetMinutes]);
  // A new answer mounts its first hits at once and the rest a batch per frame.
  const [shown, setShown] = useState<{ hits: typeof hits; n: number }>({ hits, n: HITS_FIRST_BATCH });
  const shownN = shown.hits === hits ? shown.n : HITS_FIRST_BATCH;
  if (shown.hits !== hits) setShown({ hits, n: HITS_FIRST_BATCH });
  const total = hits?.length ?? 0;
  // The core stopped at the limit: later airings exist past the last one listed (one show on 59
  // channels at once takes 59 of the 100), so the count is a floor and the end says how far it got.
  const capped = (search.data?.length ?? 0) >= SEARCH_LIMIT;
  useEffect(() => {
    if (shownN >= total) return;
    const id = requestAnimationFrame(() => setShown((s) => (s.hits === hits ? { hits, n: s.n + HITS_FIRST_BATCH } : s)));
    return () => cancelAnimationFrame(id);
  }, [hits, shownN, total]);
  const days = useMemo(() => groupHitsByDay((hits ?? []).slice(0, shownN)), [hits, shownN]);
  // Rows whose other channels are listed.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useMemo(() => (key: string) => setOpened((o) => {
    const next = new Set(o);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);
  const pending = settling || search.isFetching;
  // One read of the schedule, rules and recording support for every hit's actions.
  const shared = useProgramActionsShared();
  // Stable for the memoised rows: each reads the latest callback.
  const handlers = useRef({ onSelect, onWatch });
  handlers.current = { onSelect, onWatch };
  const select = useMemo(() => (hit: GuideSearchHit) => handlers.current.onSelect(hit), []);
  const channelsRef = useRef(onSelectChannel);
  channelsRef.current = onSelectChannel;
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
    // Under matching channels, one quiet line: the empty state's icon and hint would outweigh them.
    body =
      channels.length > 0 ? (
        <p className="px-4 py-3 text-body-sm text-fg-muted" data-testid="guide-search-no-programmes">
          {t('searchNoProgrammes', { query: q ?? typed })}
        </p>
      ) : (
        <EmptyState
          size="inline"
          icon={<SearchX size={20} aria-hidden />}
          title={t('searchEmpty', { query: q ?? typed })}
          description={t('searchEmptyHint')}
          // The guide holds programmes; the search of everything also finds channels, movies and series.
          action={<SearchEverythingLink query={q ?? typed} size="sm" />}
        />
      );
  } else {
    state = 'results';
    body = (
      <div className={cn('flex flex-col', pending && 'opacity-70 motion-safe:transition-opacity')}>
        {days.map((d) => (
          <section key={d.day} aria-label={dayHeading(d.day, now, lang, t)}>
            <h3 className="sticky top-0 z-10 border-b border-divider bg-surface-2 px-4 py-1.5 text-xs font-medium text-fg-muted" data-testid="guide-search-day">
              {dayHeading(d.day, now, lang, t)}
            </h3>
            <ul className="flex flex-col divide-y divide-divider">
              {d.hits.map((h) => (
                <HitRow
                  key={hitKey(h)}
                  hit={h.first}
                  also={h.also}
                  opened={opened.has(hitKey(h))}
                  onToggle={toggle}
                  now={now}
                  lang={lang}
                  strip={stripCountryPrefix}
                  shared={shared}
                  onSelect={select}
                  onWatch={watch}
                />
              ))}
            </ul>
          </section>
        ))}
        {capped ? (
          <p className="px-4 py-3 text-center text-xs text-fg-subtle" data-testid="guide-search-more">
            {t('searchMore', { time: `${formatDay(ms(hits[hits.length - 1]!.program.start), lang)} ${formatClock(ms(hits[hits.length - 1]!.program.start), lang)}` })}
          </p>
        ) : null}
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
          {state === 'results' && hits ? t(capped ? 'resultCountMore' : 'resultCount', { count: hits.length }) : ''}
        </span>
        <IconButton size="sm" label={t('closeSearch')} icon={<X className="size-4" aria-hidden />} onClick={() => onClose(true)} />
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {channels.length > 0 && state !== 'hint' ? (
          <section aria-label={tl('channels')} data-testid="guide-search-channels">
            <h3 className="sticky top-0 z-10 border-b border-divider bg-surface-2 px-4 py-1.5 text-xs font-medium text-fg-muted">{tl('channels')}</h3>
            <ul className="flex flex-col divide-y divide-divider">
              {channels.map((ch) => (
                <li key={ch.ref.itemId} className="flex hover:bg-hover" data-hit-row="">
                  <button
                    type="button"
                    data-hit=""
                    onClick={() => channelsRef.current(ch)}
                    data-testid="guide-search-channel"
                    className="flex min-w-0 flex-1 items-center gap-3 py-2 ps-4 pe-2 text-start outline-none focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
                  >
                    {/* The programme rows' time column, so the logos line up; the number sits at its
                        end, beside the logo, as the grid's channel column puts it. */}
                    <span className="min-w-[4.5rem] shrink-0 text-end font-numeric text-body-sm tabular-nums text-fg-muted">{ch.number ?? ''}</span>
                    <ChannelLogo src={ch.logoUrl} name={displayChannelName(ch.name, stripCountryPrefix)} size={28} sourceId={ch.ref.sourceId} />
                    <ChannelName name={ch.name} strip={stripCountryPrefix} className="min-w-0 flex-1 truncate text-sm font-medium" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {body}
        {/* Not what was meant: the same words across the whole library. */}
        {typed ? (
          <div data-hit-row="">
            <Link
              to={`/search?q=${encodeURIComponent(typed)}`}
              onClick={() => onClose(false)}
              data-hit=""
              className="flex items-center gap-3 border-t border-divider px-4 py-2.5 text-body-sm text-fg outline-none hover:bg-hover focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
              data-testid="guide-search-everything"
            >
              <Search size={16} aria-hidden className="shrink-0 text-fg-muted" />
              <span dir="auto" className="min-w-0 truncate">
                {ts('searchFor', { query: typed })}
              </span>
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Other channels listed at first when a row's "+N channels" opens, as the Search page lists them:
 * on a large library one show airs on dozens of regional and backup copies, and all of them at
 * once pushed the next shows out of the panel. "Show all" lists the rest.
 */
export const ALSO_SHOWN = 8;

const HitRow = memo(function HitRow({
  hit,
  also,
  opened,
  onToggle,
  now,
  lang,
  strip,
  shared,
  onSelect,
  onWatch,
}: {
  hit: GuideSearchHit;
  /** The same show at the same time on other channels. */
  also: readonly GuideSearchHit[];
  /** Those channels are listed under the row. */
  opened: boolean;
  onToggle(key: string): void;
  now: number;
  lang: string;
  strip?: boolean;
  shared: ProgramActionsShared;
  onSelect(hit: GuideSearchHit): void;
  onWatch(hit: GuideSearchHit): void;
}) {
  const { t } = useTranslation('guide');
  const { t: tv } = useTranslation('vod');
  const { t: ts } = useTranslation('shell');
  const { program } = hit;
  const name = displayChannelName(hit.channelName, strip);
  // Screen readers hear the cleaned name ("ESPN HD (US)").
  const srName = plainChannelName(hit.channelName, strip);
  const start = ms(program.start);
  const airing = programWhen(program, now) === 'now';
  const time = formatClock(start, lang);

  const key = hitKey(hit);
  const [all, setAll] = useState(false);
  if (all && !opened) setAll(false);
  const alsoList = useRef<HTMLUListElement>(null);
  // "Show all" goes as it is pressed: focus moves on to the first channel it brought in.
  const focusFirstMore = useRef(false);
  useLayoutEffect(() => {
    if (!all || !focusFirstMore.current) return;
    focusFirstMore.current = false;
    alsoList.current?.querySelectorAll<HTMLElement>('[data-hit]')[ALSO_SHOWN]?.focus();
  }, [all]);
  return (
    <li data-testid="guide-search-hit">
      <div className="group flex items-center gap-1 pe-2 hover:bg-hover" data-hit-row="">
        <button
          type="button"
          data-hit=""
          onClick={() => onSelect(hit)}
          aria-label={t('hitLabel', { title: program.title, channel: srName, time })}
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
              <ChannelName name={hit.channelName} strip={strip} srName={srName} className="min-w-0 truncate" />
            </span>
          </span>
        </button>
        <span className="flex shrink-0 items-center">
          {airing ? (
            <IconButton size="sm" label={t('watchNow', { channel: srName })} icon={<Radio className="size-4 text-live" aria-hidden />} onClick={() => onWatch(hit)} data-testid="guide-search-watch" />
          ) : null}
          {/* A column of record and remind buttons on every hit read as a list of alerts: they
              come with hover or focus. A touch screen has neither, and three 44 px buttons per hit
              left a phone's titles "W..": a tap shows the hit in the grid, and its cell's card has
              Remind and Record. */}
          <span className="flex items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:hidden" data-testid="guide-search-actions">
            <ProgramActionsView channelRef={hit.ref} channelName={name} program={program} now={now} variant="icons" shared={shared} />
          </span>
        </span>
      </div>
      {also.length > 0 ? (
        // The same show on other channels at that time: behind one quiet button, under the title.
        <div className="ps-[calc(7rem+28px)] pe-2 pb-1.5">
          <button
            type="button"
            aria-expanded={opened}
            onClick={() => onToggle(key)}
            data-testid="guide-search-also-toggle"
            className={cn(
              '-ms-1 inline-flex items-center rounded-xs px-1 text-caption font-medium text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus',
              TOUCH_TARGET,
            )}
          >
            {opened ? tv('showLess') : `+${ts('countChannels', { count: also.length })}`}
          </button>
        </div>
      ) : null}
      {opened ? (
        <ul ref={alsoList} className="flex flex-col pb-1" data-testid="guide-search-also">
          {(all ? also : also.slice(0, ALSO_SHOWN)).map((a) => {
            const other = displayChannelName(a.channelName, strip);
            const otherSr = plainChannelName(a.channelName, strip);
            return (
              <li key={hitKey(a)} className="flex items-center gap-1 pe-2 hover:bg-hover" data-hit-row="">
                <button
                  type="button"
                  data-hit=""
                  onClick={() => onSelect(a)}
                  aria-label={t('hitLabel', { title: program.title, channel: otherSr, time })}
                  className="flex min-w-0 flex-1 items-center gap-3 py-1.5 ps-[calc(7rem+28px)] pe-1 text-start text-xs text-fg-muted outline-none focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
                >
                  <ChannelLogo src={a.logoUrl} name={other} size={20} sourceId={a.ref.sourceId} />
                  <span className="flex min-w-0 gap-1.5">
                    {a.channelNumber !== undefined ? <span className="shrink-0 tabular-nums text-fg-subtle">{a.channelNumber}</span> : null}
                    <ChannelName name={a.channelName} strip={strip} className="min-w-0 truncate" />
                  </span>
                </button>
                {airing ? (
                  <IconButton size="sm" label={t('watchNow', { channel: other })} icon={<Radio className="size-4 text-live" aria-hidden />} onClick={() => onWatch(a)} />
                ) : null}
              </li>
            );
          })}
          {also.length > ALSO_SHOWN && !all ? (
            <li className="ps-[calc(7rem+28px)] pe-2" data-hit-row="">
              <button
                type="button"
                data-hit=""
                onClick={() => {
                  focusFirstMore.current = true;
                  setAll(true);
                }}
                data-testid="guide-search-also-all"
                className={cn(
                  '-ms-1 inline-flex items-center rounded-xs px-1 text-caption font-medium text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus',
                  TOUCH_TARGET,
                )}
              >
                {/* Counts every channel, the one in the row's title too, as the Search page's does. */}
                {`${tv('showAll')} (${numberFormat(intlLocale(lang)).format(also.length + 1)})`}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
});
