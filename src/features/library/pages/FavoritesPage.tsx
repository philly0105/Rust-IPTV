/**
 * /favorites (every source, with source badges) and /s/:sourceId/favorites.
 * Grouped live / movies / series; reorder by drag, by the arrow buttons, or
 * with alt+arrowup / alt+arrowdown on the focused row.
 */

import { k } from '../lib/keys';
import { Star } from 'lucide-react';
import { useCallback, useMemo, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { queryClient, rpcKey, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import { itemKey, sameRef, type FavoriteEntry, type ItemRef } from '@/api/types';

import { Button, EmptyState, ErrorState, Page, QualityFilterNote, SkeletonList, useLiveQuality, useShortcut, useToast, errorDescription } from '../deps';
import { BrowseAction, PageTitle, SectionHeading } from '../components/bits';
import { ENTRY_ROW_HEIGHT, EntryRow } from '../components/EntryRow';
import { VirtualRows } from '../components/VirtualRows';
import { useNamesSources, usePending, useSourcesById } from '../hooks/useLibraryData';
import { useNowOn } from '../hooks/useNowOn';
import { usePageHeader } from '../hooks/usePageHeader';
import { useUrlSearch } from '../hooks/useUrlSearch';
import {
  buildFavoriteRows,
  moveWithinGroup,
  reinsertFavorite,
  reorderArgs,
  sortFavorites,
  withPositions,
  type FavoriteRow,
} from '../lib/favorites';
import { SourceGoneError, openEntry, relativeTime } from '../lib/open';

const HEADER_HEIGHT = 56;
/**
 * The first heading has no group above it to keep apart from, so its row is only as tall as the
 * heading: the list's first line then sits where the other pages' first line does, under Page's
 * own top padding.
 */
const FIRST_HEADER_HEIGHT = 36;
const DRAG_MIME = 'application/x-tsrust-favorite';

function refKey(r: ItemRef): string {
  return `${r.sourceId}|${r.contentType}|${r.itemId}`;
}

function focusedRowKey(): string | undefined {
  const el = document.activeElement?.querySelector<HTMLElement>('[data-entry-key]');
  return el?.dataset['entryKey'];
}

export function FavoritesPage() {
  const { t, i18n } = useTranslation('library');
  const { sourceId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { byId: sources, isLoading: sourcesLoading } = useSourcesById();
  const args = useMemo(() => (sourceId ? { sourceId } : {}), [sourceId]);
  const query = useRpcQuery('favorites.list', args);
  const { pending, run } = usePending<string>();
  const [search, setSearch] = useUrlSearch();
  // An empty page may be the Live TV quality filter's doing: it leaves out the channels it hides.
  const quality = useLiveQuality();
  const [drag, setDrag] = useState<{ key: string; over?: { key: string; where: 'before' | 'after' } } | null>(null);

  const entries = useMemo(() => sortFavorites(query.data ?? []), [query.data]);
  const rows = useMemo(() => buildFavoriteRows(entries, search), [entries, search]);
  const source = sourceId ? sources.get(sourceId) : undefined;
  const refs = useMemo(() => entries.map((e) => e.ref), [entries]);
  const nowOn = useNowOn(refs);
  // Read from every favorite, not the search's matches, so the column does not come and go while typing.
  const namesSources = useNamesSources(refs, sources);

  const commitOrder = useCallback(
    async (next: FavoriteEntry[]) => {
      const key = rpcKey('favorites.list', args);
      const previous = queryClient.getQueryData<FavoriteEntry[]>(key);
      queryClient.setQueryData(key, withPositions(next));
      try {
        await rpc('favorites.reorder', reorderArgs(next, sourceId));
      } catch (err) {
        queryClient.setQueryData(key, previous);
        toast({ title: t('reorderFailed'), description: errorDescription(err), variant: 'error' });
      } finally {
        void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'favorites.list' });
      }
    },
    [args, sourceId, t, toast],
  );

  const move = useCallback(
    (ref: ItemRef, toIndex: number) => {
      const next = moveWithinGroup(entries, ref, toIndex);
      if (next.every((e, i) => e === entries[i])) return;
      void commitOrder(next);
    },
    [commitOrder, entries],
  );

  const remove = useCallback(
    (entry: FavoriteEntry) => {
      const index = entries.findIndex((e) => sameRef(e.ref, entry.ref));
      // Undo puts the favorite back in its old place. A toggle alone would add it
      // at the end, or switch it off again if it was re-added meanwhile.
      const restore = async () => {
        const present = await rpc('favorites.contains', { refs: [entry.ref] });
        if (!present.some((r) => sameRef(r, entry.ref))) await rpc('favorites.toggle', { ref: entry.ref, snapshot: entry.snapshot });
        if (index < 0) return;
        const current = await rpc('favorites.list', args);
        await rpc('favorites.reorder', reorderArgs(reinsertFavorite(current, entry, index), sourceId));
      };
      void run(refKey(entry.ref), async () => {
        try {
          await rpc('favorites.remove', { ref: entry.ref });
          toast({
            title: t('favoriteRemoved', { title: entry.snapshot.title }),
            variant: 'info',
            action: {
              label: t('undo'),
              onClick: () => {
                void restore()
                  .catch((err: unknown) => toast({ title: t('undoFailed'), description: errorDescription(err), variant: 'error' }))
                  .finally(() =>
                    queryClient.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('favorites.') }),
                  );
              },
            },
          });
        } catch (err) {
          toast({ title: t('removeFailed'), description: errorDescription(err), variant: 'error' });
        } finally {
          await queryClient.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('favorites.') });
        }
      });
    },
    [args, entries, run, sourceId, t, toast],
  );

  const open = useCallback(
    (entry: FavoriteEntry) => {
      // Channel up/down then walks this page's favorites in their order.
      openEntry(entry.ref, entry.snapshot, sources.get(entry.ref.sourceId), navigate, args).catch((err: unknown) => {
        toast({
          title: t('openFailed', { title: entry.snapshot.title }),
          description: err instanceof SourceGoneError ? t('sourceRemovedHint') : errorDescription(err),
          variant: 'error',
        });
      });
    },
    [args, navigate, sources, t, toast],
  );

  const moveFocused = (delta: -1 | 1) => {
    const key = focusedRowKey();
    const row = rows.find((r) => r.kind === 'item' && r.key === key);
    if (row?.kind === 'item') move(row.entry.ref, row.indexInGroup + delta);
  };
  const area = t('favoritesTitle');
  useShortcut('alt+arrowup', () => moveFocused(-1), { description: t('shortcutMoveUp'), area });
  useShortcut('alt+arrowdown', () => moveFocused(1), { description: t('shortcutMoveDown'), area });

  const title = source ? t('sourceFavoritesTitle', { source: source.name }) : t('favoritesTitle');
  // An empty page says so itself; "0 favorites" above it adds nothing (as on My Videos).
  const subtitle = query.data && entries.length > 0 ? t('favoritesCount', { count: entries.length }) : undefined;
  usePageHeader(title, subtitle, undefined, { value: search, onChange: setSearch, placeholder: t('searchFavorites') });

  const onDragStart = (row: Extract<FavoriteRow, { kind: 'item' }>) => (e: DragEvent<HTMLElement>) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_MIME, row.key);
    e.dataTransfer.setData('text/plain', row.entry.snapshot.title);
    setDrag({ key: row.key });
  };
  const dragRow = drag ? rows.find((r) => r.key === drag.key) : undefined;
  const onDragOver = (row: Extract<FavoriteRow, { kind: 'item' }>) => (e: DragEvent<HTMLElement>) => {
    if (!dragRow || dragRow.kind !== 'item' || dragRow.group !== row.group) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const where = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    if (drag?.over?.key !== row.key || drag.over.where !== where) setDrag({ key: drag?.key ?? row.key, over: { key: row.key, where } });
  };
  const onDrop = (row: Extract<FavoriteRow, { kind: 'item' }>) => (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    if (!dragRow || dragRow.kind !== 'item' || dragRow.group !== row.group || !drag?.over) {
      setDrag(null);
      return;
    }
    const from = dragRow.indexInGroup;
    let to = row.indexInGroup + (drag.over.where === 'after' ? 1 : 0);
    if (from < to) to -= 1;
    setDrag(null);
    move(dragRow.entry.ref, to);
  };

  const renderRow = (row: FavoriteRow) => {
    if (row.kind === 'header') return <SectionHeading title={t(k('group', row.group))} count={row.count} />;
    const e = row.entry;
    const isDragTarget = drag?.over?.key === row.key && drag.key !== row.key;
    return (
      <div className="h-full" data-entry-key={row.key}>
        <EntryRow
          entryRef={e.ref}
          snapshot={e.snapshot}
          source={sources.get(e.ref.sourceId)}
          showSource={!sourceId && namesSources}
          now={nowOn.get(itemKey(e.ref))}
          time={t('addedAgo', { time: relativeTime(e.addedAt, i18n.language) })}
          removeLabel={t('removeFavorite', { title: e.snapshot.title })}
          busy={pending.has(refKey(e.ref))}
          onOpen={() => open(e)}
          onRemove={() => remove(e)}
          reorder={
            search
              ? undefined
              : {
                  canUp: row.indexInGroup > 0,
                  canDown: row.indexInGroup < row.groupSize - 1,
                  onMove: (delta) => move(e.ref, row.indexInGroup + delta),
                  dragging: drag?.key === row.key,
                  dropTarget: isDragTarget && drag.over ? drag.over.where : null,
                  onDragStart: onDragStart(row),
                  onDragEnd: () => setDrag(null),
                  onDragOver: onDragOver(row),
                  onDrop: onDrop(row),
                }
          }
        />
      </div>
    );
  };

  let body;
  if (query.isLoading) body = <SkeletonList rows={8} className="pt-2" />;
  else if (query.isError) body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (entries.length === 0)
    body = (
      <EmptyState
        icon={<Star size={28} aria-hidden />}
        title={t('favoritesEmptyTitle')}
        description={sourceId ? t('favoritesEmptySourceBody') : sources.size === 0 && !sourcesLoading ? t('emptyNoSourcesBody') : t('favoritesEmptyBody')}
        action={
          <>
            <BrowseAction sourceId={sourceId} sources={sources} loading={sourcesLoading} />
            <QualityFilterNote quality={quality} />
          </>
        }
      />
    );
  else if (rows.length === 0) body = (
      <EmptyState
        title={t('noMatchTitle')}
        description={t('noMatchSearch', { query: search })}
        action={
          <Button onClick={() => setSearch('')} data-testid="library-clear-search">
            {t('clearSearch')}
          </Button>
        }
      />
    );
  else
    body = (
      <VirtualRows
        rows={rows}
        label={title}
        rowHeight={(r) => (r.kind === 'header' ? (r === rows[0] ? FIRST_HEADER_HEIGHT : HEADER_HEIGHT) : ENTRY_ROW_HEIGHT)}
        isFocusable={(r) => r.kind === 'item'}
        renderRow={renderRow}
        testId="favorites-list"
        // The hover fill bleeds into the gutter, so the artwork lines up with the headings and the
        // header title; the rows keep a reading width, so the time and actions sit near the title
        // on a wide window.
        className="-mx-2"
        listClassName="max-w-4xl"
        onRowKeyDown={(r, e) => {
          if (r.kind !== 'item') return;
          if (e.key === 'Enter') {
            e.preventDefault();
            open(r.entry);
          } else if (e.key === 'Delete') {
            e.preventDefault();
            remove(r.entry);
          }
        }}
      />
    );

  return (
    <Page width="default" className="flex min-h-0 min-w-0 flex-1 flex-col pb-4" data-testid="favorites-page">
      <PageTitle>{title}</PageTitle>
      {body}
    </Page>
  );
}

export default FavoritesPage;
