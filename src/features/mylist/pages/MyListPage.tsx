/**
 * /my-list: every saved movie and series in the user's order.
 *
 * Two views (a UI preference kept in localStorage): a poster grid, the default, and the list with
 * ranks, progress, Play and drag handles. The keys below work the same on a focused card or row.
 *
 * Filter by type (pill tabs with counts), sort by the user's order, newest
 * add or title, hide watched titles, and search from the page toolbar; all
 * four live in the URL. The search stays out of the shell header so a
 * phone-width header keeps its room for the page title. In the user's own order each row shows its rank and
 * can be moved by drag (fine pointers), by the up/down buttons, or with
 * Alt+ArrowUp / Alt+ArrowDown on the focused row; moves inside a filtered
 * view reshuffle only the rows on screen. Enter opens the focused title,
 * Delete removes it (with Undo) and W marks a movie watched or unwatched.
 */

import { SearchX, SquareCheckBig, Tv } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useRpcQuery } from '@/api/query';
import { itemKey, sameRef, type ItemKey, type PlaybackPosition, type WatchlistEntry } from '@/api/types';
import { itemPath } from '@/shell/dashboard/cards';
import { intlLocale } from '@/lib/intl';
import { snapshotTitle } from '@/lib/title';

import { CARD_CAPTION_HEIGHT, MyListCard } from '../components/MyListCard';
import { MyListEmpty } from '../components/MyListEmpty';
import { MyListRow, MyListSkeleton, ROW_HEIGHT, type RowReorder } from '../components/MyListRow';
import { MyListToolbar } from '../components/MyListToolbar';
import {
  Button,
  EmptyState,
  ErrorState,
  Page,
  VirtualCardGrid,
  VirtualRows,
  errorDescription,
  POSTER_GAP,
  useCoverColumn,
  usePendingRemovals,
  useShell,
  useShortcut,
  useToast,
  useVisibleSources,
} from '../deps';
import { useListParams } from '../hooks/useListParams';
import { useMyList } from '../hooks/useMyList';
import { useMyListActions } from '../hooks/useMyListActions';
import { readList } from '../lib/cache';
import { buildView, moveInSubset, relativeTime } from '../lib/list';
import { readView, writeView, type MyListView } from '../lib/view';

const DRAG_MIME = 'application/x-tsrust-mylist';

/** The continue-watching answer the VOD grids read too (the same arguments, so one request serves both). */
const RESUME_LOOKUP = { limit: 500 } as const;

/**
 * Watched ticks and order change only through writes that invalidate the list
 * (this page's actions, the toggles, `watchlist.changed`, a finishing save and
 * mark-watched through invalidateWatched) and playback rows (linked in
 * lib/cache.ts). A visit within this time shows the cached list as it is
 * instead of reading it again (L3-vod-7).
 */
const MY_LIST_STALE_MS = 5 * 60_000;

/** A move by one place, given the row's index among the rows on screen. */
const step = (delta: -1 | 1) => (from: number) => from + delta;

interface Row {
  key: ItemKey;
  kind: 'entry';
  entry: WatchlistEntry;
  /** Index among the rows on screen. */
  index: number;
}

/** The entry key of the row that has focus (the row itself, or one of its buttons after a click), if any. */
function focusedKey(): string | undefined {
  const item = document.activeElement?.closest<HTMLElement>('[role="listitem"]');
  return item?.querySelector<HTMLElement>('[data-mylist-key]')?.dataset['mylistKey'];
}

/** The list item holding the row for `key`, if it is rendered. */
function listItemOf(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-mylist-key="${CSS.escape(key)}"]`)?.closest<HTMLElement>('[role="listitem"]') ?? null;
}

/**
 * Keeps focus on a row that just moved. React moves the row's DOM node, and a
 * moved node loses focus; putting it back in a layout effect, before the
 * browser paints, means the focus ring never flickers and the next Alt+Arrow
 * key repeat still finds the row. A frame later is the fallback for a row the
 * virtualizer has not rendered yet.
 */
function useRefocusAfterMove(rows: unknown) {
  const pendingKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = pendingKey.current;
    if (!key) return;
    pendingKey.current = null;
    const now = listItemOf(key);
    if (now) {
      if (document.activeElement !== now) now.focus({ preventScroll: false });
      return;
    }
    requestAnimationFrame(() => {
      const later = listItemOf(key);
      if (later && document.activeElement !== later) later.focus({ preventScroll: false });
    });
  }, [rows]);
  return useCallback((key: string) => {
    pendingKey.current = key;
  }, []);
}

export function MyListPage() {
  const { t, i18n } = useTranslation('mylist');
  const navigate = useNavigate();
  const { setHeader } = useShell();
  const query = useMyList({ staleTime: MY_LIST_STALE_MS });
  const sources = useVisibleSources();
  const hiddenSources = usePendingRemovals((s) => s.ids);
  const [params, setParams] = useListParams();
  const { pending, remove, toggleWatched, reorder } = useMyListActions();
  const [drag, setDrag] = useState<{ key: string; over?: { key: string; where: 'before' | 'after' } } | null>(null);
  const [layout, setLayoutState] = useState<MyListView>(readView);
  const setLayout = useCallback((v: MyListView) => {
    setLayoutState(v);
    writeView(v);
  }, []);
  const column = useCoverColumn();
  const language = i18n.language;

  const all = query.data;
  const view = useMemo(
    () =>
      buildView(all ?? [], {
        filter: params.filter,
        sort: params.sort,
        hideWatched: params.hideWatched,
        query: params.query,
        language,
        hiddenSources,
      }),
    [all, params, language, hiddenSources],
  );
  const rows = useMemo<Row[]>(() => view.rows.map((entry, index) => ({ key: itemKey(entry.ref), kind: 'entry', entry, index })), [view.rows]);
  const canReorder = params.sort === 'order';
  const refocus = useRefocusAfterMove(rows);

  // Rank = place in the whole (visible) list, so a filtered view still says "7th in your list".
  const ranks = useMemo(() => {
    const nf = new Intl.NumberFormat(intlLocale(language));
    return new Map(view.base.map((e, i) => [itemKey(e.ref), nf.format(i + 1)]));
  }, [view.base, language]);

  const sourcesById = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s])), [sources.data]);
  const { toast } = useToast();

  // VL-mylist-rows: how far each saved title got (newest position per title; a series names the
  // episode it resumes), so a row shows its progress and plays from there.
  const continueQ = useRpcQuery('positions.continueWatching', RESUME_LOOKUP, { staleTime: 30_000 });
  const resumeByKey = useMemo(() => {
    const out = new Map<string, PlaybackPosition>();
    for (const p of continueQ.data ?? []) {
      if (p.watched || !p.durationSeconds || !(p.positionSeconds > 0)) continue;
      const key = itemKey(p.ref);
      if (!out.has(key)) out.set(key, p);
    }
    return out;
  }, [continueQ.data]);
  const manySources = useMemo(() => new Set(view.base.map((e) => e.ref.sourceId)).size > 1, [view.base]);

  const title = t('title');
  // An empty list says so in the page; "0 titles" in the header adds nothing.
  const subtitle = all && view.base.length > 0 ? t('count', { count: view.base.length }) : undefined;
  const { query: search } = params;
  const onSearch = useCallback((value: string) => setParams({ query: value }), [setParams]);
  useEffect(() => {
    setHeader({ title, ...(subtitle ? { subtitle } : {}) });
  }, [setHeader, title, subtitle]);

  /** Enter or ArrowDown in the search box: on to the list's current row. */
  const focusList = useCallback(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="mylist-list"]');
    (list?.querySelector<HTMLElement>('[role="listitem"][tabindex="0"]') ?? list?.querySelector<HTMLElement>('[role="listitem"]'))?.focus();
  }, []);

  const open = useCallback((e: WatchlistEntry) => void navigate(itemPath(e.ref)), [navigate]);
  /**
   * Plays a row: from its saved position (a series with the rest of the season queued, as from its
   * page), or a movie from the start. Loaded on use, so the page does not carry the player.
   */
  const play = useCallback(
    (e: WatchlistEntry) => {
      const saved = resumeByKey.get(itemKey(e.ref));
      const position: PlaybackPosition = saved
        ? { ...saved, snapshot: saved.snapshot ?? e.snapshot }
        : { ref: e.ref, positionSeconds: 0, updatedAt: e.addedAt, watched: e.watched, snapshot: e.snapshot };
      void import('@/features/library/lib/open')
        .then(({ resumePosition }) => resumePosition(position, sourcesById.get(e.ref.sourceId)))
        .catch((err: unknown) =>
          toast({
            title: err instanceof Error && err.name === 'SourceGoneError' ? t('errorSourceGone') : t('playFailed'),
            ...(err instanceof Error && err.name === 'SourceGoneError' ? {} : { description: errorDescription(err) }),
            variant: 'error',
          }),
        );
    },
    [resumeByKey, sourcesById, toast, t],
  );

  // The rows on screen: a move reshuffles only these (moves need the user's order, so they are a filter of the list).
  const visibleKeys = useMemo(() => new Set<string>(rows.map((r) => r.key)), [rows]);

  /**
   * Moves `entry` to the place `place` picks among the rows on screen, given
   * its current index there. It reads the cache rather than this render's
   * list: every move patches the cache at once, so key repeats that land
   * before React re-renders still stack instead of repeating the first move.
   */
  const move = useCallback(
    (entry: WatchlistEntry, place: (from: number, subset: readonly WatchlistEntry[]) => number) => {
      const current = readList() ?? all;
      if (!current || !canReorder) return;
      const subset = current.filter((e) => visibleKeys.has(itemKey(e.ref)));
      const from = subset.findIndex((e) => sameRef(e.ref, entry.ref));
      if (from < 0) return;
      const next = moveInSubset(current, subset, entry.ref, place(from, subset));
      if (next === current) return;
      const key = itemKey(entry.ref);
      // Only a row that had focus gets it back; a drag never pulls focus out of the search box.
      if (focusedKey() === key) refocus(key);
      reorder(next);
    },
    [all, canReorder, visibleKeys, reorder, refocus],
  );

  /** Runs `fn` on the row that has focus; keys pressed elsewhere on the page do nothing. */
  const onFocused = (fn: (row: Row) => void) => {
    const key = focusedKey();
    const row = key ? rows.find((r) => r.key === key) : undefined;
    if (row) fn(row);
  };
  useShortcut('alt+arrowup', () => onFocused((r) => move(r.entry, step(-1))), { description: t('shortcutMoveUp'), area: title, enabled: canReorder });
  useShortcut('alt+arrowdown', () => onFocused((r) => move(r.entry, step(1))), { description: t('shortcutMoveDown'), area: title, enabled: canReorder });
  useShortcut('delete', () => onFocused((r) => remove(r.entry)), { description: t('shortcutRemove'), area: title, enabled: rows.length > 0 });
  useShortcut(
    'w',
    () =>
      onFocused((r) => {
        if (r.entry.ref.contentType === 'movie') toggleWatched(r.entry);
      }),
    { description: t('shortcutWatched'), area: title, enabled: rows.length > 0 },
  );

  // The reorder handlers read the latest render through this ref, so one object
  // serves every row for the page's lifetime and memoized rows stay put.
  const latest = useRef({ rows, drag, move });
  useLayoutEffect(() => {
    latest.current = { rows, drag, move };
  });
  const reorderHandlers = useMemo<RowReorder>(
    () => ({
      onMove: (entry, delta) => latest.current.move(entry, step(delta)),
      onDragStart: (entry, e) => {
        const key = itemKey(entry.ref);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DRAG_MIME, key);
        e.dataTransfer.setData('text/plain', entry.snapshot.title);
        setDrag({ key });
      },
      onDragEnd: () => setDrag(null),
      onDragOver: (entry, e) => {
        const { drag: current, rows: shown } = latest.current;
        if (!current || !shown.some((r) => r.key === current.key)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = e.currentTarget.getBoundingClientRect();
        const where = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        const key = itemKey(entry.ref);
        setDrag((d) => (d && (d.over?.key !== key || d.over.where !== where) ? { key: d.key, over: { key, where } } : d));
      },
      onDrop: (entry, e) => {
        e.preventDefault();
        const { drag: current, rows: shown, move: moveEntry } = latest.current;
        setDrag(null);
        const dragRow = current ? shown.find((r) => r.key === current.key) : undefined;
        const over = current?.over;
        if (!dragRow || !over) return;
        const key = itemKey(entry.ref);
        moveEntry(dragRow.entry, (from, subset) => {
          const target = subset.findIndex((x) => itemKey(x.ref) === key);
          if (target < 0) return from;
          let to = target + (over.where === 'after' ? 1 : 0);
          if (from < to) to -= 1;
          return to;
        });
      },
    }),
    [],
  );

  const dateFormat = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(intlLocale(language), { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }
  }, [language]);

  /** How far a title got: 0..1 and its words ("12 minutes left", or the episode a series resumes). */
  const progressOf = (key: string) => {
    const saved = resumeByKey.get(key);
    const left = saved?.durationSeconds ? Math.max(1, Math.round((saved.durationSeconds - saved.positionSeconds) / 60)) : undefined;
    // A series names the episode it resumes; a movie, the time left.
    const label = saved ? (saved.episodeId && saved.snapshot?.subtitle ? saved.snapshot.subtitle : left !== undefined ? t('minutesLeft', { count: left }) : undefined) : undefined;
    const fraction = saved?.durationSeconds ? Math.min(1, saved.positionSeconds / saved.durationSeconds) : undefined;
    return { saved, label, fraction };
  };

  const renderRow = (row: Row) => {
    const e = row.entry;
    const at = Date.parse(e.addedAt);
    const ago = relativeTime(e.addedAt, language);
    const { saved, label: progressLabel, fraction } = progressOf(row.key);
    return (
      <MyListRow
        entry={e}
        rank={canReorder ? ranks.get(row.key) : undefined}
        source={manySources ? sourcesById.get(e.ref.sourceId) : undefined}
        added={ago ? t('addedAgo', { time: ago }) : ''}
        addedTitle={Number.isFinite(at) ? dateFormat.format(at) : ''}
        busy={pending.has(row.key)}
        {...(canReorder
          ? {
              reorder: reorderHandlers,
              canUp: row.index > 0,
              canDown: row.index < rows.length - 1,
              dragging: drag?.key === row.key,
              dropTarget: drag?.over?.key === row.key && drag.key !== row.key ? drag.over.where : null,
            }
          : {})}
        onOpen={open}
        onRemove={remove}
        onToggleWatched={toggleWatched}
        // A series with nothing started has no one episode to play: its page picks one.
        onPlay={e.ref.contentType === 'movie' || saved ? play : undefined}
        progress={fraction}
        progressLabel={progressLabel}
      />
    );
  };

  const renderCard = (row: Row) => {
    const { label, fraction } = progressOf(row.key);
    return <MyListCard entry={row.entry} busy={pending.has(row.key)} progress={fraction} progressLabel={label} onRemove={remove} />;
  };

  let body;
  if (query.isPending) {
    body = <MyListSkeleton label={t('loading')} />;
  } else if (query.isError && !all) {
    body = <ErrorState error={query.error} hint={t('errorHint')} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  } else if (view.base.length === 0) {
    body = <MyListEmpty sources={sources.data} {...(params.filter !== 'all' ? { kind: params.filter } : {})} />;
  } else if (view.typed.length === 0) {
    body = (
      <EmptyState
        icon={<Tv size={28} aria-hidden />}
        title={params.filter === 'movie' ? t('emptyMoviesTitle') : t('emptySeriesTitle')}
        description={params.filter === 'movie' ? t('emptyMoviesBody') : t('emptySeriesBody')}
        action={
          <Button onClick={() => setParams({ filter: 'all' })} data-testid="mylist-show-all">
            {t('showAll')}
          </Button>
        }
      />
    );
  } else if (view.unwatched.length === 0) {
    body = (
      <EmptyState
        icon={<SquareCheckBig size={28} aria-hidden />}
        title={t('allWatchedTitle')}
        description={t('allWatchedBody', { count: view.typed.length })}
        action={
          <Button onClick={() => setParams({ hideWatched: false })} data-testid="mylist-show-watched">
            {t('showWatched')}
          </Button>
        }
      />
    );
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        icon={<SearchX size={28} aria-hidden />}
        title={t('noMatchTitle')}
        description={t('noMatchBody', { query: search })}
        action={
          <Button onClick={() => setParams({ query: '' })} data-testid="mylist-clear-search">
            {t('clearSearch')}
          </Button>
        }
      />
    );
  } else if (layout === 'grid') {
    body = (
      <VirtualCardGrid<Row>
        items={rows}
        itemKey={(r) => r.key}
        label={title}
        cardLabel={(r) => {
          const name = snapshotTitle(r.entry.ref, r.entry.snapshot.title).title;
          return r.entry.watched ? `${name}, ${t('watched')}` : name;
        }}
        render={renderCard}
        onActivate={(r) => open(r.entry)}
        postersFillCells
        captionHeight={CARD_CAPTION_HEIGHT}
        minColumnWidth={column}
        gap={POSTER_GAP}
        className="-mx-2 px-2 pt-1"
        testId="mylist-list"
      />
    );
  } else {
    body = (
      <VirtualRows
        rows={rows}
        label={title}
        rowHeight={() => ROW_HEIGHT}
        isFocusable={() => true}
        renderRow={renderRow}
        testId="mylist-list"
        // A reading width: the actions stay near the title on a wide window.
        listClassName="max-w-5xl"
        onRowKeyDown={(row, e) => {
          // Delete, W and Alt+arrows are page shortcuts (listed in the ? overlay); Enter opens.
          if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            open(row.entry);
          }
        }}
      />
    );
  }

  const showToolbar = !query.isPending && view.base.length > 0;

  return (
    <Page width={layout === 'grid' ? 'wide' : 'default'} className="flex min-h-0 min-w-0 flex-1 flex-col pb-4" data-testid="mylist-page" data-view={layout}>
      {/* C16: the page's single h1; the shell header shows the same text as a paragraph. */}
      <h1 className="sr-only">{title}</h1>
      {showToolbar && (
        <MyListToolbar
          className="mb-3 shrink-0 border-b border-divider pb-3"
          filter={params.filter}
          sort={params.sort}
          hideWatched={params.hideWatched}
          counts={view.counts}
          watchedCount={view.typed.filter((e) => e.watched).length}
          query={search}
          onQuery={onSearch}
          onLeaveSearch={focusList}
          onFilter={(filter) => setParams({ filter })}
          onSort={(sort) => setParams({ sort })}
          onHideWatched={(hideWatched) => setParams({ hideWatched })}
          view={layout}
          onView={setLayout}
        />
      )}
      {body}
    </Page>
  );
}

export default MyListPage;
