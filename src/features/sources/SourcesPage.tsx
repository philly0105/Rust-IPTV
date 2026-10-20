import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { CircleStop, ListFilter, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import { onAppEvent } from '@/api/events';
import { invalidate, rpcKey, useRpcQuery } from '@/api/query';
import { RpcError, rpc, rpcRaw, type CallOptions } from '@/api/transport';
import { DEFAULT_SETTINGS, type Source, type SourceKind } from '@/api/types';
import { HiddenChannelsDialog } from '@/features/channeledit';
import { useStable } from '@/features/live/guide/useStable';
import { removalMayNeedPin, unlockToRemoveSources } from '@/features/parental/gate';

import { Badge, Button, Dialog, EmptyState, ErrorState, Menu, Page, Select, Skeleton, TEXT_LINK, Tooltip, useToast, errorDescription } from '@/ui';
import { useShell, useShortcut } from '@/shell';
import { sourceHomePath } from '@/shell/railLinks';
import { useMediaQuery } from '@/shell/useMediaQuery';
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
import { beginImport, cancelImport, isRunningPhase, useImportProgressFeed, useImportProgressStore, wasCancelled } from './lib/progress';
import { formatCount } from './lib/format';
import { redactText } from './lib/redact';
import { dropSourcesFromLists } from './lib/userLists';
import { applyOrder, moveItem } from './lib/reorder';
import { useNextFrame } from './lib/useNextFrame';

const KINDS: readonly SourceKind[] = ['m3u', 'xtream', 'stalker'];

/** Up to this many sources the page shows no sort or filter controls (SS-10). */
const COMPACT_MAX = 2;

/** How one refresh ended: `failed` includes an import that finished with `lastError`. */
type RefreshOutcome = 'ok' | 'failed' | 'cancelled';

function SourcesSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3" data-testid="sources-loading">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-lg border border-edge bg-surface p-4">
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

/** An in-app path to return to (`/`, `/s/x/live`), never another origin (`//host`, `https://...`). */
function safeReturnPath(from: string | null): string | null {
  return from && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/\\') ? from : null;
}

export function SourcesPage() {
  const { t, i18n } = useTranslation('sources');
  const { setHeader } = useShell();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  useImportProgressFeed();
  useGuideProgressFeed();

  const query = useRpcQuery('sources.list', undefined);
  // Sources waiting out their Undo window (C9) stay hidden even when a refetch brings them back.
  const hidden = usePendingRemovals((s) => s.ids);
  const sources = useMemo(() => (query.data ?? []).filter((s) => !hidden.has(s.id)), [query.data, hidden]);
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
  // The source whose hidden and renamed channels are open (SS-3).
  const [editsFor, setEditsFor] = useState<string | null>(null);
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
  // With one or two sources there is nothing to sort or filter: the controls and the hint stay
  // away, and a sort or filter saved from a longer list does not hide a card the user cannot get back.
  const compact = sources.length <= COMPACT_MAX;
  // On a phone Refresh all waits in the More menu, so Add a source and More share one row; it comes
  // out as a button while it runs, to show its progress and Stop.
  const phone = useMediaQuery('(max-width: 639.98px)');
  const [viewSheetOpen, setViewSheetOpen] = useState(false);
  const activeView = compact ? DEFAULT_VIEW : view;
  const manual = isManualView(activeView);
  const shown = useMemo(() => applyView(sources, activeView, i18n.language), [sources, activeView, i18n.language]);
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
  // `&from=<path>`: the page that sent the user here to add a source. No page in the app sends it
  // now (Home's first-run welcome opens the dialog in place and does the same itself), but a link
  // can. After a successful add they go back there, to the content they came for. The very first
  // source opens on its own content instead (SS-6): its channels are one click from playing.
  const returnTo = safeReturnPath(params.get('from'));
  const addedRef = useRef<{ source: Source; first: boolean } | null>(null);
  const closeAdd = () => {
    const added = addedRef.current;
    if (added && returnTo && added.first) {
      addedRef.current = null;
      navigate(sourceHomePath(added.source), { replace: true });
      return;
    }
    if (added && returnTo) {
      addedRef.current = null;
      // The sender pushed this page: going back keeps history free of a second copy of it.
      const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
      if (idx > 0) navigate(-1);
      else navigate(returnTo, { replace: true });
      return;
    }
    addedRef.current = null;
    const next = new URLSearchParams(params);
    next.delete('add');
    next.delete('kind');
    next.delete('from');
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
      // Catalog queries refetch on the core's `sources.changed` when the catalog changed; an
      // unchanged playlist keeps them (ST-5).
      await invalidate('sources.');
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

  // Pasted and uploaded playlists are included: the core re-imports their stored text (no network),
  // which is how they pick up new import rules such as series grouping (FW-M3U-SERIES-MIGRATION).
  const refreshAll = async () => {
    const targets = sources;
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
        // Importing already (its own Refresh, the schedule, a sync): no second import (ST-2).
        if (isRunningPhase(useImportProgressStore.getState().bySource[s.id]?.phase)) continue;
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
        description: errorDescription(e, redactText),
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

  const onDragStart = (id: string, e: DragEvent<HTMLElement>) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    setDrag({ id });
  };
  const onDragOver = (id: string, e: DragEvent<HTMLElement>) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    if (drag.overId !== id || drag.pos !== pos) setDrag({ ...drag, overId: id, pos });
  };
  const onDrop = (id: string, e: DragEvent<HTMLElement>) => {
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
    // `call` carries keepalive when the page unloads before the undo window passed.
    const sendRemove = async (call?: CallOptions) => {
      try {
        await rpcRaw('sources.remove', { id: target.id }, call);
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
        // Its titles leave My List, Favorites, Recent and Continue watching now, before the
        // source is un-hidden: the rails must not show them again until the refetch lands.
        dropSourcesFromLists(queryClient, [target.id]);
        useImportProgressStore.getState().clear(target.id);
        void Promise.all([
          invalidate('sources.'),
          invalidate('catalog.'),
          invalidate('favorites.'),
          invalidate('recent.'),
          invalidate('positions.'),
          invalidate('watchlist.'),
          invalidate('epg.'),
        ]);
      },
      onFailed: (e) => {
        const err = RpcError.from(e);
        void invalidate('sources.');
        // Removal never contacts a provider: `auth` is the parental guard (an unlock ran out).
        const locked = err.code === 'auth';
        if (locked) void invalidate('parental.status');
        toast({
          variant: 'error',
          title: t('removeFailed', { name: target.name }),
          description: `${locked ? t('removeLockedText') : t(summaryKey(err))} ${t('removeFailedKept')}`,
          action: { label: t('tryAgain'), onClick: () => removeChecked(target) },
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
      // Remove sits in the card's More menu: the neighbour's menu button takes the same place.
      const next = card?.querySelector<HTMLElement>('[aria-haspopup="menu"]') ?? card?.querySelector<HTMLElement>('a');
      (next ?? document.querySelector<HTMLElement>('[data-testid="sources-add"], [data-testid="sources-onboarding"] button'))?.focus();
    });
  };

  /**
   * C2: a removed source takes its parental locks with it, so while controls are locked a source
   * with locks asks for the PIN (which unlocks the session) before the usual removal.
   */
  const removeChecked = (target: Source) => {
    if (!removalMayNeedPin()) return removeSource(target);
    void unlockToRemoveSources(target.id, {
      title: t('removeLockedTitle', { name: target.name }),
      description: t('removeLockedText'),
      confirmLabel: t('removeLockedConfirm'),
    }).then((ok) => {
      if (ok) removeSource(target);
    });
  };

  const openRemoveAll = () => {
    if (!removalMayNeedPin()) return setRemoveAllOpen(true);
    void unlockToRemoveSources(undefined, {
      title: t('removeAllLockedTitle'),
      description: t('removeLockedText'),
      confirmLabel: t('removeLockedConfirm'),
    }).then((ok) => {
      if (ok) setRemoveAllOpen(true);
    });
  };

  const confirmRemoveAll = async () => {
    const before = sources;
    setRemoveAllBusy(true);
    try {
      await rpcRaw('sources.removeAll');
      setCache([]);
      dropSourcesFromLists(queryClient, before.map((s) => s.id));
      for (const s of before) useImportProgressStore.getState().clear(s.id);
      setRemoveAllOpen(false);
      toast({ variant: 'success', title: t('removedAllTitle', { count: before.length }) });
      await Promise.all([
        invalidate('sources.'),
        invalidate('catalog.'),
        invalidate('favorites.'),
        invalidate('recent.'),
        invalidate('positions.'),
        invalidate('watchlist.'),
        invalidate('epg.'),
      ]);
    } catch (e) {
      toast({
        variant: 'error',
        title: t('removeAllFailed'),
        // The confirm dialog stays open for another try.
        description: errorDescription(e, redactText),
      });
      void invalidate('sources.');
    } finally {
      setRemoveAllBusy(false);
    }
  };

  // VD-5: one set of card handlers whose identity never changes, so the memoised cards re-render
  // only when their own props or their own import progress change.
  const cardRefresh = useStable((s: Source) => void refreshOne(s));
  const cardEdit = useStable((s: Source) => openEdit(s));
  const cardAccount = useStable((s: Source) => openEdit(s, 'account'));
  const cardChannelEdits = useStable((s: Source) => setEditsFor(s.id));
  const cardRemove = useStable((s: Source) => removeChecked(s));
  const cardCancel = useStable((id: string) => void cancelOne(id));
  const cardMove = useStable(moveTo);
  const cardDragStart = useStable(onDragStart);
  const cardDragOver = useStable(onDragOver);
  const cardDrop = useStable(onDrop);
  const cardDragEnd = useCallback(() => setDrag(null), []);

  const sortOptions = SORTS.map((v) => ({ value: v, label: t(`sort_${v}`) }));
  const kindOptions = KIND_FILTERS.map((v) => ({ value: v, label: v === 'all' ? t('filterKindAll') : t(`kindLabel_${v}`) }));
  const statusOptions = STATUS_FILTERS.map((v) => ({ value: v, label: t(`filterStatus_${v}`) }));
  // How many of the three differ from the default (the phone button's count).
  const viewChanges = (view.sort !== DEFAULT_VIEW.sort ? 1 : 0) + (view.kind !== DEFAULT_VIEW.kind ? 1 : 0) + (view.status !== DEFAULT_VIEW.status ? 1 : 0);
  // The same three selects in the toolbar (compact, sized to their text) and in the phone sheet
  // (labelled, full width).
  const viewSelects = (className: string, labelled = false) => (
    <>
      <Select
        wrapperClassName="min-w-0"
        className={className}
        label={labelled ? t('sortLabel') : undefined}
        aria-label={labelled ? undefined : t('sortLabel')}
        value={view.sort}
        options={sortOptions}
        onValueChange={(v) => setView({ sort: v as SourceSort })}
        data-testid="sources-sort"
      />
      <Select
        wrapperClassName="min-w-0"
        className={className}
        label={labelled ? t('filterKindLabel') : undefined}
        aria-label={labelled ? undefined : t('filterKindLabel')}
        value={view.kind}
        options={kindOptions}
        onValueChange={(v) => setView({ kind: v as KindFilter })}
        data-testid="sources-filter-kind"
      />
      <Select
        wrapperClassName="min-w-0"
        className={className}
        label={labelled ? t('filterStatusLabel') : undefined}
        aria-label={labelled ? undefined : t('filterStatusLabel')}
        value={view.status}
        options={statusOptions}
        onValueChange={(v) => setView({ status: v as StatusFilter })}
        data-testid="sources-filter-status"
      />
    </>
  );

  let body: ReactNode;
  if (query.isPending) body = <SourcesSkeleton />;
  else if (query.isError) body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (sources.length === 0) body = <Onboarding onPick={(kind) => openAdd(kind)} />;
  else
    body = (
      <div className="flex flex-col gap-4">
        <div className={clsx('flex flex-wrap items-center gap-3', compact ? 'justify-end' : 'justify-between')}>
          {compact || phone ? null : (
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('viewControls')} data-testid="sources-view">
              <ListFilter aria-hidden size={16} className="text-fg-subtle" />
              {viewSelects('h-9 w-auto')}
            </div>
          )}
          {/* Add and its More menu stay together; on phones the buttons fill their row. */}
          <div className="flex w-full flex-wrap gap-2 @md:w-auto">
            {phone && !refreshingAll ? null : (
              <Button
                variant="secondary"
                className="@max-md:flex-1"
                icon={<RefreshCw aria-hidden className="size-4" />}
                loading={refreshingAll}
                disabled={sources.length === 0}
                onClick={() => void refreshAll()}
                data-testid="sources-refresh-all"
              >
                {refreshAllStep && refreshAllStep.total > 1 ? t('refreshAllProgress', refreshAllStep) : t('refreshAll')}
              </Button>
            )}
            {refreshingAll ? (
              <Button
                variant="ghost"
                className="@max-md:flex-1"
                icon={<CircleStop aria-hidden className="size-4" />}
                disabled={stoppingAll}
                onClick={stopRefreshAll}
                data-testid="sources-refresh-all-stop"
              >
                {stoppingAll ? t('refreshAllStopping') : t('refreshAllStop')}
              </Button>
            ) : null}
            <div className="flex gap-2 @max-md:flex-1">
              {phone && !compact ? (
                // Phones: the sort and filters sit behind one button on the Add row, with the number
                // of active choices, and open in a bottom sheet (no three selects above the cards).
                <Tooltip content={t('viewControls')} describe={false}>
                  <Button
                    variant="secondary"
                    icon={<ListFilter aria-hidden size={16} />}
                    onClick={() => setViewSheetOpen(true)}
                    aria-haspopup="dialog"
                    className="shrink-0"
                    data-testid="sources-view-button"
                  >
                    <span className="sr-only">{t('viewControls')}</span>
                    {viewChanges > 0 ? <Badge data-testid="sources-view-count">{formatCount(viewChanges, i18n.language)}</Badge> : null}
                  </Button>
                </Tooltip>
              ) : null}
              <Button variant="primary" className="@max-md:flex-1" icon={<Plus aria-hidden className="size-4" />} onClick={() => openAdd()} data-testid="sources-add">
                {t('addSource')}
              </Button>
              <Menu
                label={t('moreActions')}
                items={[
                  ...(phone
                    ? [
                        {
                          id: 'refresh-all',
                          label: t('refreshAll'),
                          icon: <RefreshCw aria-hidden className="size-4" />,
                          disabled: refreshingAll,
                          onSelect: () => void refreshAll(),
                        },
                        { id: 'sep', type: 'separator' as const },
                      ]
                    : []),
                  {
                    id: 'remove-all',
                    label: t('removeAllMenu'),
                    icon: <Trash2 aria-hidden className="size-4" />,
                    danger: true,
                    onSelect: openRemoveAll,
                  },
                ]}
              />
            </div>
          </div>
        </div>
        {/* Your order needs no explanation: the grip's tooltip says how to move a card. */}
        {manual ? null : (
          <p className="text-sm text-fg-muted" data-testid="sources-view-hint">
            {isFiltered(activeView) ? t('filteredHint', { shown: shown.length, total: sources.length }) : t('sortedHint')}{' '}
            <button type="button" className={TEXT_LINK} onClick={() => setView(DEFAULT_VIEW)} data-testid="sources-view-reset">
              {t('showYourOrder')}
            </button>
          </p>
        )}
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
              refreshing={refreshing.has(s.id)}
              dragging={drag?.id === s.id}
              dropTarget={drag && drag.id !== s.id && drag.overId === s.id ? (drag.pos ?? null) : null}
              onRefresh={cardRefresh}
              onEdit={cardEdit}
              onAccount={cardAccount}
              onChannelEdits={cardChannelEdits}
              onRemove={cardRemove}
              onCancelImport={cardCancel}
              onMove={cardMove}
              onDragStart={cardDragStart}
              onDragOver={cardDragOver}
              onDrop={cardDrop}
              onDragEnd={cardDragEnd}
              account={accountById.get(s.id)}
              warnDays={warnDays}
              schedule={scheduleById.get(s.id)}
            />
          ))}
        </ul>
      </div>
    );

  return (
    <Page width="default" className="@container" data-testid="sources-page">
      {/* The page's single h1 (C16): the shell header shows the same title as a styled paragraph. */}
      <h1 className="sr-only">{t('title')}</h1>
      <p id="sources-reorder-help" className="sr-only">
        {t('reorderInstructions')}
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {body}

      <AddSourceDialog
        open={addInitial !== undefined}
        initial={addInitial}
        onClose={closeAdd}
        onAdded={(source, first) => {
          addedRef.current = { source, first };
        }}
      />

      <EditSourceDialog source={editing} initialTab={editTab} onClose={() => setEditing(null)} onRefresh={(s) => void refreshOne(s)} />

      <HiddenChannelsDialog sourceId={editsFor ?? ''} open={editsFor !== null} onOpenChange={(open) => !open && setEditsFor(null)} />

      <Dialog
        open={viewSheetOpen && phone && !compact}
        onClose={() => setViewSheetOpen(false)}
        title={t('viewControls')}
        size="sm"
        sheet
        testId="sources-view-sheet"
        footer={
          <>
            {viewChanges > 0 ? (
              <Button variant="ghost" onClick={() => setView(DEFAULT_VIEW)} data-testid="sources-view-sheet-reset">
                {t('showYourOrder')}
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => setViewSheetOpen(false)} data-testid="sources-view-sheet-done">
              {t('viewDone')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">{viewSelects('w-full', true)}</div>
      </Dialog>

      <RemoveAllDialog
        open={removeAllOpen}
        count={sources.length}
        busy={removeAllBusy}
        onClose={() => setRemoveAllOpen(false)}
        onConfirm={() => void confirmRemoveAll()}
      />
    </Page>
  );
}
