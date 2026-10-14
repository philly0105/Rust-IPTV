/**
 * /my-list: every saved movie and series in the user's order.
 *
 * Filter by type (pill tabs with counts), sort by the user's order, newest
 * add or title, hide watched titles, and search from the shell header; all
 * four live in the URL. In the user's own order each row shows its rank and
 * can be moved by drag (fine pointers), by the up/down buttons, or with
 * Alt+ArrowUp / Alt+ArrowDown on the focused row; moves inside a filtered
 * view reshuffle only the rows on screen. Enter opens the focused title,
 * Delete removes it (with Undo) and W marks a movie watched or unwatched.
 */

import { SearchX, SquareCheckBig, Tv } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { itemKey, sameRef, type ItemKey, type WatchlistEntry } from '@/api/types';

import { MyListEmpty } from '../components/MyListEmpty';
import { MyListRow, MyListSkeleton, ROW_HEIGHT, type RowReorder } from '../components/MyListRow';
import { MyListToolbar } from '../components/MyListToolbar';
import { Button, EmptyState, ErrorState, VirtualRows, itemPath, usePendingRemovals, useShell, useShortcut, useVisibleSources } from '../deps';
import { useListParams } from '../hooks/useListParams';
import { useMyList } from '../hooks/useMyList';
import { useMyListActions } from '../hooks/useMyListActions';
import { readList } from '../lib/cache';
import { buildView, moveInSubset, relativeTime } from '../lib/list';

const DRAG_MIME = 'application/x-tsrust-mylist';

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
  // staleTime 0: watched ticks change from the player and the detail pages.
  const query = useMyList({ staleTime: 0 });
  const sources = useVisibleSources();
  const hiddenSources = usePendingRemovals((s) => s.ids);
  const [params, setParams] = useListParams();
  const { pending, remove, toggleWatched, reorder } = useMyListActions();
  const [drag, setDrag] = useState<{ key: string; over?: { key: string; where: 'before' | 'after' } } | null>(null);
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
    const nf = new Intl.NumberFormat(language);
    return new Map(view.base.map((e, i) => [itemKey(e.ref), nf.format(i + 1)]));
  }, [view.base, language]);

  const sourcesById = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s])), [sources.data]);
  const manySources = useMemo(() => new Set(view.base.map((e) => e.ref.sourceId)).size > 1, [view.base]);

  const title = t('title');
  const subtitle = all ? t('count', { count: view.base.length }) : undefined;
  const { query: search } = params;
  const onSearch = useCallback((value: string) => setParams({ query: value }), [setParams]);
  const placeholder = t('searchPlaceholder');
  useEffect(() => {
    setHeader({ title, ...(subtitle ? { subtitle } : {}), search: { value: search, onChange: onSearch, placeholder } });
  }, [setHeader, title, subtitle, search, onSearch, placeholder]);

  const open = useCallback((e: WatchlistEntry) => void navigate(itemPath(e.ref)), [navigate]);

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
  const step = (delta: -1 | 1) => (from: number) => from + delta;

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

  const dragRow = drag ? rows.find((r) => r.key === drag.key) : undefined;
  const reorderProps = (row: Row): RowReorder | undefined => {
    if (!canReorder) return undefined;
    return {
      canUp: row.index > 0,
      canDown: row.index < rows.length - 1,
      onMove: (delta) => move(row.entry, step(delta)),
      dragging: drag?.key === row.key,
      dropTarget: drag?.over?.key === row.key && drag.key !== row.key ? drag.over.where : null,
      onDragStart: (e: DragEvent<HTMLElement>) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DRAG_MIME, row.key);
        e.dataTransfer.setData('text/plain', row.entry.snapshot.title);
        setDrag({ key: row.key });
      },
      onDragEnd: () => setDrag(null),
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!dragRow) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = e.currentTarget.getBoundingClientRect();
        const where = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        if (drag?.over?.key !== row.key || drag.over.where !== where) setDrag({ key: dragRow.key, over: { key: row.key, where } });
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        const over = drag?.over;
        setDrag(null);
        if (!dragRow || !over) return;
        move(dragRow.entry, (from, subset) => {
          const target = subset.findIndex((x) => itemKey(x.ref) === row.key);
          if (target < 0) return from;
          let to = target + (over.where === 'after' ? 1 : 0);
          if (from < to) to -= 1;
          return to;
        });
      },
    };
  };

  const dateFormat = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }
  }, [language]);

  const renderRow = (row: Row) => {
    const e = row.entry;
    const at = Date.parse(e.addedAt);
    const ago = relativeTime(e.addedAt, language);
    return (
      <MyListRow
        entry={e}
        rank={canReorder ? ranks.get(row.key) : undefined}
        source={manySources ? sourcesById.get(e.ref.sourceId) : undefined}
        added={ago ? t('addedAgo', { time: ago }) : ''}
        addedTitle={Number.isFinite(at) ? dateFormat.format(at) : ''}
        busy={pending.has(row.key)}
        reorder={reorderProps(row)}
        onOpen={() => open(e)}
        onRemove={() => remove(e)}
        onToggleWatched={() => toggleWatched(e)}
      />
    );
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
  } else {
    body = (
      <VirtualRows
        rows={rows}
        label={title}
        rowHeight={() => ROW_HEIGHT}
        isFocusable={() => true}
        renderRow={renderRow}
        testId="mylist-list"
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
    <div
      className="mx-auto flex h-[calc(100dvh-var(--header-height))] w-full max-w-[1100px] min-w-0 flex-col px-3 pb-4 pt-3 sm:px-6"
      data-testid="mylist-page"
    >
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
          onFilter={(filter) => setParams({ filter })}
          onSort={(sort) => setParams({ sort })}
          onHideWatched={(hideWatched) => setParams({ hideWatched })}
        />
      )}
      {body}
    </div>
  );
}

export default MyListPage;
