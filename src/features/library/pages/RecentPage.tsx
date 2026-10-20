/** /recent (every source) and /s/:sourceId/recent: history by day plus continue watching. */

import { k } from '../lib/keys';
import { History, Trash } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import type { PlaybackPosition, RecentEntry } from '@/api/types';
import { snapshotTitle } from '@/lib/title';

import { Button, EmptyState, ErrorState, Page, SkeletonList, useMediaQuery, usePlayerStore, useToast, errorDescription } from '../deps';
import { BrowseAction, ConfirmDialog, PageTitle, SectionHeading } from '../components/bits';
import { CONTINUE_RAIL_HEIGHT, ContinueRail } from '../components/ContinueRail';
import { ENTRY_ROW_HEIGHT, EntryRow } from '../components/EntryRow';
import { VirtualRows } from '../components/VirtualRows';
import { usePending, useSourcesById } from '../hooks/useLibraryData';
import { usePageHeader } from '../hooks/usePageHeader';
import { useUrlSearch } from '../hooks/useUrlSearch';
import { SourceGoneError, detailPath, openEntry, relativeTime, resumePosition } from '../lib/open';
import {
  buildRecentRows,
  collectHistory,
  continueForSource,
  removeContinueCard,
  restoreArgs,
  restoreHistory,
  restorePositions,
  type PositionCalls,
  type RecentRow,
} from '../lib/recent';

const positionCalls: PositionCalls = {
  forSeries: (a) => rpc('positions.forSeries', a),
  remove: (a) => rpc('positions.remove', a),
  set: (a) => rpc('positions.set', a),
};

const HEADER_HEIGHT = 48;
const RECENT_LIMIT = 500;
const CONTINUE_LIMIT = 20;

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
  const continuing = useMemo(() => continueForSource(cont.data ?? [], sourceId), [cont.data, sourceId]);
  const source = sourceId ? sources.get(sourceId) : undefined;
  const count = query.data?.length ?? 0;

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

  const undoClear = async (entries: RecentEntry[]) => {
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
      toast({
        title: t('historyCleared'),
        variant: 'success',
        ...(before.length > 0 ? { action: { label: t('undo'), onClick: () => void undoClear(before) } } : {}),
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
  usePageHeader(title, query.data && count > 0 ? t('recentCount', { count }) : undefined, headerActions, {
    value: search,
    onChange: setSearch,
    placeholder: t('searchRecent'),
  });

  const rail =
    continuing.length > 0 && !search ? <ContinueRail positions={continuing} onOpen={openContinue} onRemove={(p) => void removeContinue(p)} /> : null;

  const renderRow = (row: RecentRow) => {
    if (row.kind === 'header') return <SectionHeading title={t(k('bucket', row.bucket))} count={row.count} />;
    const e = row.entry;
    const key = `${e.ref.sourceId}|${e.ref.contentType}|${e.ref.itemId}`;
    return (
      <EntryRow
        entryRef={e.ref}
        snapshot={e.snapshot}
        source={sources.get(e.ref.sourceId)}
        showSource={!sourceId}
        time={relativeTime(e.viewedAt, i18n.language)}
        removeLabel={t('removeRecent', { title: snapshotTitle(e.ref, e.snapshot.title).title })}
        busy={pending.has(key)}
        onOpen={() => open(e)}
        onRemove={() => remove(e)}
      />
    );
  };

  let body;
  if (query.isLoading) body = <SkeletonList rows={8} className="pt-2" />;
  else if (query.isError) body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (count === 0 && !rail)
    body = (
      <EmptyState
        icon={<History size={28} aria-hidden />}
        title={t('recentEmptyTitle')}
        description={!sourceId && sources.size === 0 && !sourcesLoading ? t('emptyNoSourcesBody') : t('recentEmptyBody')}
        action={<BrowseAction sourceId={sourceId} sources={sources} loading={sourcesLoading} />}
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
        header={rail}
        headerHeight={rail ? CONTINUE_RAIL_HEIGHT : 0}
        rowHeight={(r) => (r.kind === 'header' ? HEADER_HEIGHT : ENTRY_ROW_HEIGHT)}
        isFocusable={(r) => r.kind === 'item'}
        renderRow={renderRow}
        testId="recent-list"
        onRowKeyDown={(r, ev) => {
          if (r.kind !== 'item') return;
          if (ev.key === 'Enter') {
            ev.preventDefault();
            open(r.entry);
          } else if (ev.key === 'Delete') {
            ev.preventDefault();
            remove(r.entry);
          }
        }}
      />
    );

  return (
    <Page width="default" className="flex h-[calc(100dvh-var(--header-height))] min-w-0 flex-col pb-4 pt-4" data-testid="recent-page">
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
