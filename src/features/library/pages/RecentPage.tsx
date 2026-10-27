/**
 * /recent (every source) and /s/:sourceId/recent: history by day. A title stopped part way shows
 * its progress on its own row and resumes from it, so it is listed once (no Continue watching
 * cards above the day that repeat it).
 */

import { k } from '../lib/keys';
import { History, Trash } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import { itemKey, type PlaybackPosition, type RecentEntry } from '@/api/types';
import { snapshotTitle } from '@/lib/title';

import { Button, EmptyState, ErrorState, Page, QualityFilterNote, clearSearches, recentSearchList, rememberSearch, useLiveQuality, useMediaQuery, usePlayerStore, useToast, errorDescription } from '../deps';
import { BrowseAction, ConfirmDialog, PageTitle, SectionHeading } from '../components/bits';
import { ENTRY_ROW_HEIGHT, EntryRow, EntryRowsSkeleton, type EntryResume } from '../components/EntryRow';
import { VirtualRows } from '../components/VirtualRows';
import { useNamesSources, usePending, useSourcesById } from '../hooks/useLibraryData';
import { useNowOn } from '../hooks/useNowOn';
import { usePageHeader } from '../hooks/usePageHeader';
import { useUrlSearch } from '../hooks/useUrlSearch';
import { formatClock } from '../lib/format';
import { SourceGoneError, detailPath, openEntry, relativeTime, resumePosition } from '../lib/open';
import {
  buildRecentRows,
  collectHistory,
  continueForSource,
  removeContinueCard,
  restoreArgs,
  restoreHistory,
  restorePositions,
  watchedFraction,
  type PositionCalls,
  type RecentRow,
} from '../lib/recent';

const positionCalls: PositionCalls = {
  forSeries: (a) => rpc('positions.forSeries', a),
  remove: (a) => rpc('positions.remove', a),
  set: (a) => rpc('positions.set', a),
};

const HEADER_HEIGHT = 56;
/** The first heading's row with nothing above it (see FavoritesPage). */
const FIRST_HEADER_HEIGHT = 36;
const RECENT_LIMIT = 500;
/**
 * As many saved spots as the history has rows, so every half-watched row in it shows its progress
 * and resumes; a shorter list left the older ones looking and opening like plain history. The VOD
 * grids and My List ask the same, so they share one answer. The core sends at most 200
 * (CONTINUE_MAX_LIMIT).
 */
const CONTINUE_LIMIT = RECENT_LIMIT;

export function RecentPage() {
  const { t, i18n } = useTranslation('library');
  const { sourceId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { byId: sources, isLoading: sourcesLoading } = useSourcesById();
  const args = useMemo(() => (sourceId ? { sourceId, limit: RECENT_LIMIT } : { limit: RECENT_LIMIT }), [sourceId]);
  // Watching anything changes both lists, so they are read fresh on every visit.
  const query = useRpcQuery('recent.list', args, { staleTime: 0 });
  const cont = useRpcQuery('positions.continueWatching', { limit: CONTINUE_LIMIT }, { staleTime: 0 });
  const { pending, run } = usePending<string>();
  const [search, setSearch] = useUrlSearch();
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  // An empty history may be the Live TV quality filter's doing: it leaves out the channels it hides.
  const quality = useLiveQuality();

  // Playback in the mini player saves positions and history while this page is
  // open; when it stops or switches title, refresh so progress and finished
  // items are right.
  const playingUrl = usePlayerStore((s) => s.source?.url);
  const seenUrl = useRef(playingUrl);
  useEffect(() => {
    if (seenUrl.current === playingUrl) return;
    seenUrl.current = playingUrl;
    void invalidate('positions.');
    void invalidate('recent.');
  }, [playingUrl]);

  const rows = useMemo(() => buildRecentRows(query.data ?? [], search), [query.data, search]);
  // Each title's saved spot, by its history entry's key: the row shows it and resumes from it.
  const resumable = useMemo(() => new Map(continueForSource(cont.data ?? [], sourceId).map((p) => [itemKey(p.ref), p])), [cont.data, sourceId]);
  const source = sourceId ? sources.get(sourceId) : undefined;
  const count = query.data?.length ?? 0;
  const refs = useMemo(() => (query.data ?? []).map((e) => e.ref), [query.data]);
  const nowOn = useNowOn(refs);
  // From the whole history, not the search's matches, so the column does not come and go while typing.
  const namesSources = useNamesSources(refs, sources);

  const remove = useCallback(
    (e: RecentEntry) => {
      const key = `${e.ref.sourceId}|${e.ref.contentType}|${e.ref.itemId}`;
      void run(key, async () => {
        try {
          await rpc('recent.remove', { ref: e.ref });
          toast({
            title: t('recentRemoved', { title: snapshotTitle(e.ref, e.snapshot.title).title }),
            variant: 'info',
            action: {
              label: t('undo'),
              onClick: () => {
                // The original date goes back too (C7), so the entry returns to its old place.
                void rpc('recent.add', restoreArgs(e))
                  .catch((err: unknown) => toast({ title: t('undoFailed'), description: errorDescription(err), variant: 'error' }))
                  .finally(() => invalidate('recent.'));
              },
            },
          });
        } catch (err) {
          toast({ title: t('removeFailed'), description: errorDescription(err), variant: 'error' });
        } finally {
          await invalidate('recent.');
        }
      });
    },
    [run, t, toast],
  );

  const open = useCallback(
    (e: { ref: RecentEntry['ref']; snapshot: RecentEntry['snapshot'] }) => {
      openEntry(e.ref, e.snapshot, sources.get(e.ref.sourceId), navigate).catch((err: unknown) => {
        toast({
          title: t('openFailed', { title: snapshotTitle(e.ref, e.snapshot.title).title }),
          description: err instanceof SourceGoneError ? t('sourceRemovedHint') : errorDescription(err),
          variant: 'error',
        });
      });
    },
    [navigate, sources, t, toast],
  );

  // Continue means resume: play from the saved spot (the dashboard rail does
  // the same). Without a snapshot to title it, the detail page is the way in.
  const openContinue = (p: PlaybackPosition) => {
    const path = detailPath(p.ref);
    if (!p.snapshot) {
      if (path) navigate(path);
      return;
    }
    const title = snapshotTitle(p.ref, p.snapshot.title).title;
    resumePosition(p, sources.get(p.ref.sourceId)).catch((err: unknown) => {
      toast({
        title: t('openFailed', { title }),
        description: err instanceof SourceGoneError ? t('sourceRemovedHint') : errorDescription(err),
        variant: 'error',
      });
    });
  };

  const removeContinue = async (p: PlaybackPosition) => {
    try {
      const removed = await removeContinueCard(p, positionCalls);
      const label = p.snapshot ? snapshotTitle(p.ref, p.snapshot.title).title : '';
      toast({
        title: t('continueRemoved', { title: label }),
        variant: 'info',
        action: {
          label: t('undo'),
          onClick: () => {
            void restorePositions(removed, positionCalls.set)
              .then((n) => {
                if (n < removed.length) toast({ title: t('undoFailed'), variant: 'error' });
              })
              .finally(() => invalidate('positions.'));
          },
        },
      });
    } catch (err) {
      toast({ title: t('removeFailed'), description: errorDescription(err), variant: 'error' });
    } finally {
      await invalidate('positions.');
    }
  };

  const undoClear = async (entries: RecentEntry[], searches: readonly string[]) => {
    // Oldest first, so the newest ends up first again.
    for (const q of [...searches].reverse()) rememberSearch(q);
    const restored = await restoreHistory(entries, (a) => rpc('recent.add', a));
    await invalidate('recent.');
    if (restored === entries.length) toast({ title: t('historyRestored'), variant: 'success' });
    else toast({ title: t('undoFailed'), description: t('historyRestorePartial', { restored, total: entries.length }), variant: 'error' });
  };

  const clearAll = async () => {
    setClearing(true);
    try {
      // Kept in memory so Undo can put every entry back with its own date.
      const before = await collectHistory((a) => rpc('recent.list', a), sourceId, sources.keys());
      await rpc('recent.clear', sourceId ? { sourceId } : {});
      // The whole history takes the search page's recent searches with it: they say what was looked
      // for as plainly as the list says what was watched. Per source, they stay (they have no source).
      const searches = sourceId ? [] : recentSearchList();
      if (!sourceId) clearSearches();
      toast({
        title: t('historyCleared'),
        variant: 'success',
        ...(before.length > 0 || searches.length > 0 ? { action: { label: t('undo'), onClick: () => void undoClear(before, searches) } } : {}),
      });
    } catch (err) {
      toast({ title: t('clearFailed'), description: errorDescription(err), variant: 'error' });
    } finally {
      setClearing(false);
      setConfirmClear(false);
      await invalidate('recent.');
    }
  };

  // On a phone the header has no room for Clear history beside the title and the search: even as an
  // icon it cut "Recently watched" short (L3-visual-6). There it sits above the list, with the count
  // the header's subtitle shows only on wider screens.
  const phone = useMediaQuery('(width < 40rem)', false);
  const headerActions = useMemo(
    () =>
      count > 0 && !phone ? (
        <Button size="sm" variant="ghost" icon={<Trash size={15} aria-hidden />} onClick={() => setConfirmClear(true)}>
          {t('clearHistory')}
        </Button>
      ) : undefined,
    [count, phone, t],
  );
  const title = source ? t('sourceRecentTitle', { source: source.name }) : t('recentTitle');
  // As on Favorites: no history search over an empty history.
  const searchable = !query.data || count > 0 || search !== '';
  usePageHeader(
    title,
    query.data && count > 0 ? t('recentCount', { count }) : undefined,
    headerActions,
    searchable ? { value: search, onChange: setSearch, placeholder: t('searchRecent') } : undefined,
  );

  // A row with a saved spot resumes it, as the Continue watching card it replaces did (and Home's
  // still does); its page stays one menu item away.
  const activate = (e: RecentEntry) => {
    const p = resumable.get(itemKey(e.ref));
    if (p) openContinue(p);
    else open(e);
  };

  const resumeOf = (e: RecentEntry, title: string): EntryResume | undefined => {
    const p = resumable.get(itemKey(e.ref));
    if (!p) return undefined;
    const at = formatClock(p.positionSeconds);
    return {
      fraction: watchedFraction(p),
      minutesLeft: p.durationSeconds ? Math.max(1, Math.round((p.durationSeconds - p.positionSeconds) / 60)) : undefined,
      at,
      // A series names the episode it goes back to.
      episode: p.episodeId ? p.snapshot?.subtitle : undefined,
      label: t('continueTitle', { title, time: at }),
      onDetails: () => open(e),
      onForget: () => void removeContinue(p),
    };
  };

  const renderRow = (row: RecentRow) => {
    if (row.kind === 'header') return <SectionHeading title={t(k('bucket', row.bucket))} count={row.count} />;
    const e = row.entry;
    const key = `${e.ref.sourceId}|${e.ref.contentType}|${e.ref.itemId}`;
    const title = snapshotTitle(e.ref, e.snapshot.title).title;
    return (
      <EntryRow
        entryRef={e.ref}
        snapshot={e.snapshot}
        source={sources.get(e.ref.sourceId)}
        showSource={!sourceId && namesSources}
        now={nowOn.get(itemKey(e.ref))}
        time={relativeTime(e.viewedAt, i18n.language)}
        removeLabel={t('removeRecent', { title })}
        menuRemoveLabel={t('removeFromHistory')}
        busy={pending.has(key)}
        resume={resumeOf(e, title)}
        onOpen={() => activate(e)}
        onRemove={() => remove(e)}
      />
    );
  };

  let body;
  if (query.isLoading) body = <EntryRowsSkeleton />;
  else if (query.isError) body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (count === 0)
    body = (
      <EmptyState
        icon={<History size={28} aria-hidden />}
        title={t('recentEmptyTitle')}
        description={!sourceId && sources.size === 0 && !sourcesLoading ? t('emptyNoSourcesBody') : t('recentEmptyBody')}
        action={
          <>
            <BrowseAction sourceId={sourceId} sources={sources} loading={sourcesLoading} />
            <QualityFilterNote quality={quality} />
          </>
        }
      />
    );
  else if (rows.length === 0 && search) body = (
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
        // The first day's heading row is only as tall as the heading (as on Favorites).
        rowHeight={(r) => (r.kind === 'header' ? (r === rows[0] ? FIRST_HEADER_HEIGHT : HEADER_HEIGHT) : ENTRY_ROW_HEIGHT)}
        isFocusable={(r) => r.kind === 'item'}
        renderRow={renderRow}
        testId="recent-list"
        // As on Favorites: the hover fill bleeds into the gutter and the rows keep a reading width.
        className="-mx-2"
        listClassName="max-w-4xl"
        onRowKeyDown={(r, ev) => {
          if (r.kind !== 'item') return;
          if (ev.key === 'Enter') {
            ev.preventDefault();
            activate(r.entry);
          } else if (ev.key === 'Delete') {
            ev.preventDefault();
            remove(r.entry);
          }
        }}
      />
    );

  return (
    <Page width="default" className="flex min-h-0 min-w-0 flex-1 flex-col pb-4" data-testid="recent-page">
      <PageTitle>{title}</PageTitle>
      {phone && count > 0 && !query.isLoading && !query.isError ? (
        <div className="mb-2 flex min-h-8 items-center justify-between gap-3" data-testid="recent-phone-bar">
          <p className="min-w-0 truncate text-sm tabular-nums text-fg-muted">{t('recentCount', { count })}</p>
          <Button size="sm" variant="ghost" icon={<Trash size={15} aria-hidden />} onClick={() => setConfirmClear(true)}>
            {t('clearHistory')}
          </Button>
        </div>
      ) : null}
      {body}
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        busy={clearing}
        danger
        title={t('clearHistoryTitle')}
        description={source ? t('clearHistorySourceBody', { source: source.name }) : t('clearHistoryBody')}
        confirmLabel={t('clearHistory')}
        onConfirm={() => void clearAll()}
      />
    </Page>
  );
}

export default RecentPage;
