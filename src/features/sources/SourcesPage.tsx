import { useQueryClient } from '@tanstack/react-query';
import { CircleStop, ListFilter, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { onAppEvent } from '@/api/events';
import { invalidate, rpcKey, useRpcQuery } from '@/api/query';
import { RpcError, rpc, rpcRaw } from '@/api/transport';
import { DEFAULT_SETTINGS, type Source, type SourceKind } from '@/api/types';

import { Button, EmptyState, ErrorState, Menu, Select, Skeleton, useToast } from '@/ui';
import { useShell, useShortcut } from '@/shell';
import { hasAccountInfo } from './components/AccountPanel';
import { AddSourceDialog, type AddSourceInitial } from './components/AddSourceDialog';
import { EditSourceDialog, type EditTab } from './components/EditSourceDialog';
import { Onboarding } from './components/Onboarding';
import { RemoveAllDialog } from './components/RemoveAllDialog';
import { SourceCard } from './components/SourceCard';
import { newlyEnabledEpgUrls, refreshGuides, useGuideProgressFeed } from './lib/epgRefresh';
import { nextStepKey, summaryKey } from './lib/errors';
import {
  DEFAULT_VIEW,
  KIND_FILTERS,
  SORTS,
  STATUS_FILTERS,
  applyView,
  isFiltered,
  isManualView,
  loadView,
  saveView,
  type KindFilter,
  type ListView,
  type SourceSort,
  type StatusFilter,
} from './lib/listView';
import { isRemovalPending, scheduleRemoval, usePendingRemovals } from './lib/pendingRemoval';
import { beginImport, cancelImport, useImportProgressFeed, useImportProgressStore, wasCancelled } from './lib/progress';
import { redactText } from './lib/redact';
import { applyOrder, moveItem } from './lib/reorder';
import { useNextFrame } from './lib/useNextFrame';

const KINDS: readonly SourceKind[] = ['m3u', 'xtream', 'stalker'];

/** How one refresh ended: `failed` includes an import that finished with `lastError`. */
type RefreshOutcome = 'ok' | 'failed' | 'cancelled';

function SourcesSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3" data-testid="sources-loading">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-lg border border-border bg-surface p-4">
          <Skeleton className="size-11 shrink-0" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-48 max-w-full" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <Skeleton className="hidden h-9 w-40 @3xl:block" />
        </div>
      ))}
    </div>
  );
}

export function SourcesPage() {
  const { t, i18n } = useTranslation('sources');
  const { setHeader } = useShell();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  useImportProgressFeed();
  useGuideProgressFeed();

  const query = useRpcQuery('sources.list', undefined);
  // Sources waiting out their Undo window (C9) stay hidden even when a refetch brings them back.
  const hidden = usePendingRemovals((s) => s.ids);
  const sources = useMemo(() => (query.data ?? []).filter((s) => !hidden.has(s.id)), [query.data, hidden]);
  const progress = useImportProgressStore((s) => s.bySource);
  const cancelling = useImportProgressStore((s) => s.cancelling);
  // account: subscription status, the refresh schedule and the expiry warning window, for the cards.
  const accounts = useRpcQuery('account.statusAll', undefined);
  const schedule = useRpcQuery('sources.schedule', undefined);
  const settings = useRpcQuery('settings.get', undefined, { staleTime: Infinity });
  const accountById = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.sourceId, a])), [accounts.data]);
  const scheduleById = useMemo(() => new Map((schedule.data?.sources ?? []).map((e) => [e.sourceId, e])), [schedule.data]);
  const warnDays = settings.data?.accountExpiryWarnDays ?? DEFAULT_SETTINGS.accountExpiryWarnDays;

  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(new Set());
  // 1-based position in a running "Refresh all", or null when none runs.
  const [refreshAllStep, setRefreshAllStep] = useState<{ current: number; total: number } | null>(null);
  const refreshingAll = refreshAllStep !== null;
  // Set by Stop: the running "Refresh all" cancels its current import and starts no more.
  const stopAllRef = useRef<{ stopped: boolean; currentId: string | null } | null>(null);
  const [stoppingAll, setStoppingAll] = useState(false);
  const [editing, setEditing] = useState<Source | null>(null);
  const [editTab, setEditTab] = useState<EditTab>('details');
  const [view, setViewState] = useState<ListView>(() => loadView());
  const [removeAllOpen, setRemoveAllOpen] = useState(false);
  const [removeAllBusy, setRemoveAllBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [drag, setDrag] = useState<{ id: string; overId?: string; pos?: 'before' | 'after' } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const setView = (patch: Partial<ListView>) =>
    setViewState((prev) => {
      const next = { ...prev, ...patch };
      saveView(next);
      return next;
    });
  const manual = isManualView(view);
  const shown = useMemo(() => applyView(sources, view, i18n.language), [sources, view, i18n.language]);
  const openEdit = (s: Source, tab: EditTab = 'details') => {
    setEditTab(tab);
    setEditing(s);
  };
  const nextFrame = useNextFrame();

  // `?add=<url>&kind=<kind>` opens the dialog (deep links, onboarding links from other pages).
  const addParam = params.get('add');
  const kindParam = params.get('kind');
  const addInitial: AddSourceInitial | undefined = useMemo(() => {
    if (addParam === null) return undefined;
    const kind = KINDS.includes(kindParam as SourceKind) ? (kindParam as SourceKind) : undefined;
    // `?add=1` (the shell's "add with no URL") and non-web schemes open an empty form.
    return { url: /^https?:\/\//i.test(addParam) ? addParam : undefined, kind };
  }, [addParam, kindParam]);
  const openAdd = useCallback(
    (kind?: SourceKind) => {
      const next = new URLSearchParams(params);
      next.set('add', '');
      if (kind) next.set('kind', kind);
      else next.delete('kind');
      setParams(next, { replace: true });
    },
    [params, setParams],
  );
  // account: `?account=<id>` (the dashboard's expiry alert) opens that source's subscription details.
  const accountParam = params.get('account');
  useEffect(() => {
    if (accountParam === null || !query.data) return;
    const target = query.data.find((s) => s.id === accountParam);
    const next = new URLSearchParams(params);
    next.delete('account');
    setParams(next, { replace: true });
    if (target) {
      setEditTab(hasAccountInfo(target) ? 'account' : 'details');
      setEditing(target);
    }
  }, [accountParam, query.data, params, setParams]);
  const closeAdd = () => {
    const next = new URLSearchParams(params);
    next.delete('add');
    next.delete('kind');
    setParams(next, { replace: true });
  };

  useEffect(() => {
    setHeader({
      title: t('title'),
      subtitle: query.data ? t('subtitleCount', { count: sources.length }) : undefined,
    });
  }, [setHeader, t, query.data, sources.length]);

  useEffect(() => onAppEvent('sources.changed', () => void invalidate('sources.')), []);

  useShortcut('shift+n', () => openAdd(), { description: t('shortcutAddSource'), area: t('title') });

  const setCache = (list: Source[]) => queryClient.setQueryData(rpcKey('sources.list'), list);

  const refreshOne = async (s: Source): Promise<RefreshOutcome> => {
    setRefreshing((prev) => new Set(prev).add(s.id));
    beginImport(s.id);
    try {
      const updated = await rpc('sources.refresh', { id: s.id });
      await Promise.all([invalidate('sources.'), invalidate('catalog.')]);
      // A re-import can detect guide links that were not there before (new url-tvg, changed Xtream login).
      const guides = newlyEnabledEpgUrls(s.epg, updated.epg);
      if (guides.length > 0) void refreshGuides(guides);
      return updated.lastError ? 'failed' : 'ok';
    } catch (e) {
      const err = RpcError.from(e);
      // A cancelled refresh is what the user asked for: the card shows it, no error toast.
      if (wasCancelled(s.id, err)) {
        void invalidate('sources.');
        return 'cancelled';
      }
      // Unknown failures keep the core's text: the generic summary would hide the only detail.
      const what = err.code === 'internal' ? redactText(err.message) : t(summaryKey(err));
      toast({
        variant: 'error',
        title: t('refreshFailedTitle', { name: s.name }),
        description: `${what} ${t(nextStepKey(err, s.kind))}`,
        // Bad credentials or a wrong address will fail the same way again: send the user to the settings.
        action:
          err.code === 'auth' || err.code === 'not_found' || err.code === 'invalid'
            ? { label: t('checkSettings'), onClick: () => openEdit(s) }
            : { label: t('tryAgain'), onClick: () => void refreshOne(s) },
      });
      void invalidate('sources.');
      return 'failed';
    } finally {
      setRefreshing((prev) => {
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
    }
  };

  // Pasted playlists have nothing to fetch again.
  const refreshable = sources.filter((s) => s.m3u?.origin !== 'text');
  const refreshAll = async () => {
    const targets = refreshable;
    if (targets.length === 0 || stopAllRef.current) return;
    const run = { stopped: false, currentId: null as string | null };
    stopAllRef.current = run;
    let failed = 0;
    let refreshed = 0;
    try {
      // One at a time: imports hold a write transaction each, and portals rate-limit.
      for (const [i, s] of targets.entries()) {
        if (run.stopped) break;
        // Removed (waiting for Undo) since the run started.
        if (isRemovalPending(s.id)) continue;
        setRefreshAllStep({ current: i + 1, total: targets.length });
        run.currentId = s.id;
        const outcome = await refreshOne(s);
        run.currentId = null;
        if (outcome === 'failed') failed += 1;
        else if (outcome === 'ok') refreshed += 1;
      }
    } finally {
      stopAllRef.current = null;
      setRefreshAllStep(null);
      setStoppingAll(false);
    }
    if (run.stopped) toast({ variant: 'info', title: t('refreshAllStopped', { done: refreshed, count: targets.length }) });
    else if (failed > 0) toast({ variant: 'error', title: t('refreshAllPartial', { failed, count: failed + refreshed }) });
    // Every one cancelled or removed on the way: the cards already say so.
    else if (refreshed > 0) toast({ variant: 'success', title: t('refreshAllDone', { count: refreshed }) });
  };

  /** Stop for "Refresh all": cancels the import that is running and skips the rest. */
  const stopRefreshAll = () => {
    const run = stopAllRef.current;
    if (!run || run.stopped) return;
    run.stopped = true;
    setStoppingAll(true);
    if (run.currentId) void cancelOne(run.currentId);
  };

  const cancelOne = async (id: string) => {
    try {
      await cancelImport(id);
    } catch (e) {
      toast({ variant: 'error', title: t('cancelFailed'), description: t(summaryKey(RpcError.from(e))) });
    }
  };

  const commitOrder = async (ids: string[], movedId: string) => {
    const before = sources;
    const next = applyOrder(sources, ids);
    setCache(next);
    const moved = next.findIndex((s) => s.id === movedId);
    const name = next[moved]?.name ?? '';
    setAnnouncement(t('movedAnnouncement', { name, position: moved + 1, total: next.length }));
    try {
      await rpc('sources.reorder', { ids });
    } catch (e) {
      setCache(before);
      toast({
        variant: 'error',
        title: t('reorderFailed'),
        description: redactText(RpcError.from(e).message),
        action: { label: t('tryAgain'), onClick: () => void commitOrder(ids, movedId) },
      });
    } finally {
      void invalidate('sources.');
    }
  };

  const moveTo = (id: string, to: number) => {
    const from = sources.findIndex((s) => s.id === id);
    if (from < 0 || from === to) return;
    const ids = moveItem(
      sources.map((s) => s.id),
      from,
      to,
    );
    void commitOrder(ids, id);
    // Keep keyboard focus on the moved card's grip after React re-renders.
    nextFrame(() => {
      // Match by attribute value rather than a selector: ids are opaque, and `CSS.escape` is not everywhere (jsdom).
      const cards = listRef.current?.querySelectorAll<HTMLElement>('[data-source-id]') ?? [];
      const card = [...cards].find((el) => el.dataset.sourceId === id);
      card?.querySelector<HTMLElement>('[data-grip="true"]')?.focus();
    });
  };

  const onDragStart = (id: string) => (e: DragEvent<HTMLElement>) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    setDrag({ id });
  };
  const onDragOver = (id: string) => (e: DragEvent<HTMLElement>) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    if (drag.overId !== id || drag.pos !== pos) setDrag({ ...drag, overId: id, pos });
  };
  const onDrop = (id: string) => (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    if (!drag || drag.id === id) {
      setDrag(null);
      return;
    }
    const ids = sources.map((s) => s.id).filter((x) => x !== drag.id);
    const targetIdx = ids.indexOf(id);
    ids.splice(drag.pos === 'after' ? targetIdx + 1 : targetIdx, 0, drag.id);
    setDrag(null);
    void commitOrder(ids, drag.id);
  };

  /**
   * Remove with Undo (C9): the card goes at once and a toast offers Undo for 8 s.
   * `sources.remove` goes out when the toast closes without Undo, or on pagehide.
   */
  const removeSource = (target: Source) => {
    // Keyboard focus was on the card's Remove button: move it to the neighbouring card (or Add).
    const order = shown.map((s) => s.id);
    const at = order.indexOf(target.id);
    const neighbour = order[at + 1] ?? order[at - 1];
    const sendRemove = async () => {
      try {
        await rpc('sources.remove', { id: target.id });
      } catch (e) {
        // Already gone (Remove all, another window): that is the outcome the user wanted.
        if (RpcError.from(e).code !== 'not_found') throw e;
      }
    };
    scheduleRemoval({
      id: target.id,
      toast: { variant: 'info', title: t('removedTitle', { name: target.name }), description: t('removedUndoHint') },
      undoLabel: t('undo'),
      remove: sendRemove,
      onRemoved: () => {
        const list = queryClient.getQueryData<Source[]>(rpcKey('sources.list'));
        if (list) setCache(list.filter((s) => s.id !== target.id));
        useImportProgressStore.getState().clear(target.id);
        void Promise.all([invalidate('sources.'), invalidate('catalog.'), invalidate('favorites.'), invalidate('recent.'), invalidate('epg.')]);
      },
      onFailed: (e) => {
        const err = RpcError.from(e);
        void invalidate('sources.');
        toast({
          variant: 'error',
          title: t('removeFailed', { name: target.name }),
          description: `${t(summaryKey(err))} ${t('removeFailedKept')}`,
          action: { label: t('tryAgain'), onClick: () => removeSource(target) },
        });
      },
      onUndone: () => {
        setAnnouncement(t('restoredAnnouncement', { name: target.name }));
        void invalidate('sources.');
      },
    });
    setAnnouncement(t('removedAnnouncement', { name: target.name }));
    nextFrame(() => {
      const cards = listRef.current?.querySelectorAll<HTMLElement>('[data-source-id]') ?? [];
      const card = [...cards].find((el) => el.dataset.sourceId === neighbour);
      const next = card?.querySelector<HTMLElement>('[data-testid="source-remove"]:not(:disabled)') ?? card?.querySelector<HTMLElement>('a');
      (next ?? document.querySelector<HTMLElement>('[data-testid="sources-add"], [data-testid="sources-onboarding"] button'))?.focus();
    });
  };

  const confirmRemoveAll = async () => {
    const before = sources;
    setRemoveAllBusy(true);
    try {
      await rpcRaw('sources.removeAll');
      setCache([]);
      for (const s of before) useImportProgressStore.getState().clear(s.id);
      setRemoveAllOpen(false);
      toast({ variant: 'success', title: t('removedAllTitle', { count: before.length }) });
      await Promise.all([invalidate('sources.'), invalidate('catalog.'), invalidate('favorites.'), invalidate('recent.'), invalidate('epg.')]);
    } catch (e) {
      toast({
        variant: 'error',
        title: t('removeAllFailed'),
        // The confirm dialog stays open for another try.
        description: redactText(RpcError.from(e).message),
      });
      void invalidate('sources.');
    } finally {
      setRemoveAllBusy(false);
    }
  };

  const sortOptions = SORTS.map((v) => ({ value: v, label: t(`sort_${v}`) }));
  const kindOptions = KIND_FILTERS.map((v) => ({ value: v, label: v === 'all' ? t('filterKindAll') : t(`kindLabel_${v}`) }));
  const statusOptions = STATUS_FILTERS.map((v) => ({ value: v, label: t(`filterStatus_${v}`) }));

  let body: ReactNode;
  if (query.isPending) body = <SourcesSkeleton />;
  else if (query.isError) body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (sources.length === 0) body = <Onboarding onPick={(kind) => openAdd(kind)} />;
  else
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('viewControls')} data-testid="sources-view">
            <ListFilter aria-hidden className="size-4 text-fg-subtle" />
            <Select
              aria-label={t('sortLabel')}
              value={view.sort}
              options={sortOptions}
              onValueChange={(v) => setView({ sort: v as SourceSort })}
              data-testid="sources-sort"
            />
            <Select
              aria-label={t('filterKindLabel')}
              value={view.kind}
              options={kindOptions}
              onValueChange={(v) => setView({ kind: v as KindFilter })}
              data-testid="sources-filter-kind"
            />
            <Select
              aria-label={t('filterStatusLabel')}
              value={view.status}
              options={statusOptions}
              onValueChange={(v) => setView({ status: v as StatusFilter })}
              data-testid="sources-filter-status"
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              icon={<RefreshCw aria-hidden className="size-4" />}
              loading={refreshingAll}
              disabled={refreshable.length === 0}
              onClick={() => void refreshAll()}
              data-testid="sources-refresh-all"
            >
              {refreshAllStep && refreshAllStep.total > 1 ? t('refreshAllProgress', refreshAllStep) : t('refreshAll')}
            </Button>
            {refreshingAll ? (
              <Button
                variant="ghost"
                icon={<CircleStop aria-hidden className="size-4" />}
                disabled={stoppingAll}
                onClick={stopRefreshAll}
                data-testid="sources-refresh-all-stop"
              >
                {stoppingAll ? t('refreshAllStopping') : t('refreshAllStop')}
              </Button>
            ) : null}
            <Button variant="primary" icon={<Plus aria-hidden className="size-4" />} onClick={() => openAdd()} data-testid="sources-add">
              {t('addSource')}
            </Button>
            <Menu
              label={t('moreActions')}
              items={[
                {
                  id: 'remove-all',
                  label: t('removeAllMenu'),
                  icon: <Trash2 aria-hidden className="size-4" />,
                  danger: true,
                  onSelect: () => setRemoveAllOpen(true),
                },
              ]}
            />
          </div>
        </div>
        <p className="text-sm text-fg-muted" data-testid="sources-view-hint">
          {manual
            ? t('reorderHint')
            : isFiltered(view)
              ? t('filteredHint', { shown: shown.length, total: sources.length })
              : t('sortedHint')}
          {!manual ? (
            <>
              {' '}
              <button
                type="button"
                className="font-medium text-accent underline-offset-2 hover:underline"
                onClick={() => setView(DEFAULT_VIEW)}
                data-testid="sources-view-reset"
              >
                {t('showYourOrder')}
              </button>
            </>
          ) : null}
        </p>
        {shown.length === 0 ? (
          <EmptyState
            size="inline"
            icon={<ListFilter aria-hidden className="size-6" />}
            title={t('filteredEmptyTitle')}
            description={t('filteredEmptyBody')}
            action={
              <Button variant="secondary" onClick={() => setView({ kind: 'all', status: 'all' })}>
                {t('clearFilters')}
              </Button>
            }
          />
        ) : null}
        <ul ref={listRef} className="flex flex-col gap-3" aria-label={t('listLabel')} data-testid="sources-list">
          {shown.map((s, i) => (
            <SourceCard
              key={s.id}
              source={s}
              index={i}
              total={shown.length}
              reorderable={manual}
              progress={progress[s.id]}
              refreshing={refreshing.has(s.id)}
              dragging={drag?.id === s.id}
              dropTarget={drag && drag.id !== s.id && drag.overId === s.id ? (drag.pos ?? null) : null}
              onRefresh={() => void refreshOne(s)}
              onEdit={() => openEdit(s)}
              onAccount={() => openEdit(s, 'account')}
              onRemove={() => removeSource(s)}
              onCancelImport={() => void cancelOne(s.id)}
              cancelling={cancelling[s.id] === true}
              onMove={(to) => moveTo(s.id, to)}
              onDragStart={onDragStart(s.id)}
              onDragOver={onDragOver(s.id)}
              onDrop={onDrop(s.id)}
              onDragEnd={() => setDrag(null)}
              account={accountById.get(s.id)}
              warnDays={warnDays}
              schedule={scheduleById.get(s.id)}
            />
          ))}
        </ul>
      </div>
    );

  return (
    <div className="@container mx-auto w-full max-w-6xl px-4 py-6 @2xl:px-8" data-testid="sources-page">
      {/* The page's single h1 (C16): the shell header shows the same title as a styled paragraph. */}
      <h1 className="sr-only">{t('title')}</h1>
      <p id="sources-reorder-help" className="sr-only">
        {t('reorderInstructions')}
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {body}

      <AddSourceDialog open={addInitial !== undefined} initial={addInitial} onClose={closeAdd} />

      <EditSourceDialog source={editing} initialTab={editTab} onClose={() => setEditing(null)} onRefresh={(s) => void refreshOne(s)} />

      <RemoveAllDialog
        open={removeAllOpen}
        count={sources.length}
        busy={removeAllBusy}
        onClose={() => setRemoveAllOpen(false)}
        onConfirm={() => void confirmRemoveAll()}
      />
    </div>
  );
}
