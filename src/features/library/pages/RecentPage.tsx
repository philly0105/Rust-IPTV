/** /recent (every source) and /s/:sourceId/recent: history by day plus continue watching. */

import { k } from '../lib/keys';
import { History, Trash } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import { RpcError, rpc } from '@/api/transport';
import type { PlaybackPosition, RecentEntry } from '@/api/types';

import { Button, EmptyState, ErrorState, SkeletonList, useToast } from '../deps';
import { ConfirmDialog, PageTitle, SectionHeading } from '../components/bits';
import { CONTINUE_RAIL_HEIGHT, ContinueRail } from '../components/ContinueRail';
import { ENTRY_ROW_HEIGHT, EntryRow } from '../components/EntryRow';
import { VirtualRows } from '../components/VirtualRows';
import { usePending, useSourcesById } from '../hooks/useLibraryData';
import { usePageHeader } from '../hooks/usePageHeader';
import { SourceGoneError, detailPath, openEntry, relativeTime } from '../lib/open';
import { buildRecentRows, continueForSource, type RecentRow } from '../lib/recent';

const HEADER_HEIGHT = 48;
const RECENT_LIMIT = 500;
const CONTINUE_LIMIT = 20;

export function RecentPage() {
  const { t, i18n } = useTranslation('library');
  const { sourceId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { byId: sources } = useSourcesById();
  const args = useMemo(() => (sourceId ? { sourceId, limit: RECENT_LIMIT } : { limit: RECENT_LIMIT }), [sourceId]);
  const query = useRpcQuery('recent.list', args);
  const cont = useRpcQuery('positions.continueWatching', { limit: CONTINUE_LIMIT });
  const { pending, run } = usePending<string>();
  const [search, setSearch] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

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
        } catch (err) {
          toast({ title: t('removeFailed'), description: RpcError.from(err).message, variant: 'error' });
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
          title: t('openFailed', { title: e.snapshot.title }),
          description: err instanceof SourceGoneError ? t('sourceRemovedHint') : RpcError.from(err).message,
          variant: 'error',
        });
      });
    },
    [navigate, sources, t, toast],
  );

  const openContinue = (p: PlaybackPosition) => {
    const path = detailPath(p.ref);
    if (path) navigate(path);
    else if (p.snapshot) open({ ref: p.ref, snapshot: p.snapshot });
  };

  const removeContinue = async (p: PlaybackPosition) => {
    try {
      await rpc('positions.remove', p.episodeId ? { ref: p.ref, episodeId: p.episodeId } : { ref: p.ref });
    } catch (err) {
      toast({ title: t('removeFailed'), description: RpcError.from(err).message, variant: 'error' });
    } finally {
      await invalidate('positions.');
    }
  };

  const clearAll = async () => {
    setClearing(true);
    try {
      await rpc('recent.clear', sourceId ? { sourceId } : {});
      toast({ title: t('historyCleared'), variant: 'success' });
    } catch (err) {
      toast({ title: t('clearFailed'), description: RpcError.from(err).message, variant: 'error' });
    } finally {
      setClearing(false);
      setConfirmClear(false);
      await invalidate('recent.');
    }
  };

  const headerActions = useMemo(
    () =>
      count > 0 ? (
        <Button size="sm" variant="ghost" icon={<Trash size={15} aria-hidden />} onClick={() => setConfirmClear(true)}>
          {t('clearHistory')}
        </Button>
      ) : undefined,
    [count, t],
  );
  const title = source ? t('sourceRecentTitle', { source: source.name }) : t('recentTitle');
  usePageHeader(title, query.data ? t('recentCount', { count }) : undefined, headerActions, {
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
        removeLabel={t('removeRecent', { title: e.snapshot.title })}
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
    body = <EmptyState icon={<History size={28} aria-hidden />} title={t('recentEmptyTitle')} description={t('recentEmptyBody')} />;
  else if (rows.length === 0 && search) body = <EmptyState title={t('noMatchTitle')} description={t('noMatchSearch', { query: search })} />;
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
    <div
      className="mx-auto flex h-[calc(100dvh-var(--header-height))] w-full max-w-[1400px] min-w-0 flex-col px-6 pb-4 pt-4"
      data-testid="recent-page"
    >
      <PageTitle>{title}</PageTitle>
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
    </div>
  );
}

export default RecentPage;
