import { useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { onAppEvent } from '@/api/events';
import { invalidate, rpcKey, useRpcQuery } from '@/api/query';
import { RpcError, rpc } from '@/api/transport';
import type { Source, SourceKind } from '@/api/types';

import { Button, Dialog, ErrorState, Skeleton, useShell, useShortcut, useToast } from './_shim';
import { AddSourceDialog, type AddSourceInitial } from './components/AddSourceDialog';
import { EditSourceDialog } from './components/EditSourceDialog';
import { Onboarding } from './components/Onboarding';
import { SourceCard } from './components/SourceCard';
import { newlyEnabledEpgUrls, refreshGuides, useGuideProgressFeed } from './lib/epgRefresh';
import { nextStepKey } from './lib/errors';
import { useImportProgressFeed, useImportProgressStore } from './lib/progress';
import { redactText } from './lib/redact';
import { applyOrder, moveItem } from './lib/reorder';
import { useNextFrame } from './lib/useNextFrame';

const KINDS: readonly SourceKind[] = ['m3u', 'xtream', 'stalker'];

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
  const { t } = useTranslation('sources');
  const { setHeader } = useShell();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  useImportProgressFeed();
  useGuideProgressFeed();

  const query = useRpcQuery('sources.list', undefined);
  const sources = useMemo(() => query.data ?? [], [query.data]);
  const progress = useImportProgressStore((s) => s.bySource);

  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(new Set());
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [editing, setEditing] = useState<Source | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [drag, setDrag] = useState<{ id: string; overId?: string; pos?: 'before' | 'after' } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
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
  const closeAdd = () => {
    const next = new URLSearchParams(params);
    next.delete('add');
    next.delete('kind');
    setParams(next, { replace: true });
  };

  useEffect(() => {
    setHeader({
      title: t('title'),
      subtitle: query.data ? t('subtitleCount', { count: query.data.length }) : undefined,
    });
  }, [setHeader, t, query.data]);

  useEffect(() => onAppEvent('sources.changed', () => void invalidate('sources.')), []);

  useShortcut('shift+n', () => openAdd(), { description: t('shortcutAddSource'), area: t('title') });

  const setCache = (list: Source[]) => queryClient.setQueryData(rpcKey('sources.list'), list);

  const refreshOne = async (s: Source): Promise<boolean> => {
    setRefreshing((prev) => new Set(prev).add(s.id));
    try {
      const updated = await rpc('sources.refresh', { id: s.id });
      await Promise.all([invalidate('sources.'), invalidate('catalog.')]);
      // A re-import can detect guide links that were not there before (new url-tvg, changed Xtream login).
      const guides = newlyEnabledEpgUrls(s.epg, updated.epg);
      if (guides.length > 0) void refreshGuides(guides);
      return !updated.lastError;
    } catch (e) {
      const err = RpcError.from(e);
      toast({
        variant: 'error',
        title: t('refreshFailedTitle', { name: s.name }),
        description: `${redactText(err.message)} ${t(nextStepKey(err))}`,
        action: err.retryable ? { label: t('tryAgain'), onClick: () => void refreshOne(s) } : undefined,
      });
      void invalidate('sources.');
      return false;
    } finally {
      setRefreshing((prev) => {
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
    }
  };

  const refreshAll = async () => {
    const targets = sources.filter((s) => s.m3u?.origin !== 'text');
    if (targets.length === 0) return;
    setRefreshingAll(true);
    let failed = 0;
    // One at a time: imports hold a write transaction each, and portals rate-limit.
    for (const s of targets) {
      if (!(await refreshOne(s))) failed += 1;
    }
    setRefreshingAll(false);
    toast(
      failed === 0
        ? { variant: 'success', title: t('refreshAllDone', { count: targets.length }) }
        : { variant: 'error', title: t('refreshAllPartial', { failed, count: targets.length }) },
    );
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
      toast({ variant: 'error', title: t('reorderFailed'), description: RpcError.from(e).message });
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

  const confirmRemove = async () => {
    if (!removing) return;
    const target = removing;
    const before = sources;
    setRemoveBusy(true);
    try {
      await rpc('sources.remove', { id: target.id });
      setCache(before.filter((s) => s.id !== target.id));
      useImportProgressStore.getState().clear(target.id);
      setRemoving(null);
      toast({ variant: 'success', title: t('removedTitle', { name: target.name }) });
      await Promise.all([invalidate('sources.'), invalidate('catalog.'), invalidate('favorites.'), invalidate('recent.'), invalidate('epg.')]);
    } catch (e) {
      const err = RpcError.from(e);
      toast({ variant: 'error', title: t('removeFailed', { name: target.name }), description: err.message });
    } finally {
      setRemoveBusy(false);
    }
  };

  let body: ReactNode;
  if (query.isPending) body = <SourcesSkeleton />;
  else if (query.isError) body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (sources.length === 0) body = <Onboarding onPick={(kind) => openAdd(kind)} />;
  else
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-fg-muted">{t('reorderHint')}</p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              icon={<RefreshCw aria-hidden className="size-4" />}
              loading={refreshingAll}
              onClick={() => void refreshAll()}
              data-testid="sources-refresh-all"
            >
              {t('refreshAll')}
            </Button>
            <Button variant="primary" icon={<Plus aria-hidden className="size-4" />} onClick={() => openAdd()} data-testid="sources-add">
              {t('addSource')}
            </Button>
          </div>
        </div>
        <ul ref={listRef} className="flex flex-col gap-3" aria-label={t('listLabel')} data-testid="sources-list">
          {sources.map((s, i) => (
            <SourceCard
              key={s.id}
              source={s}
              index={i}
              total={sources.length}
              progress={progress[s.id]}
              refreshing={refreshing.has(s.id)}
              dragging={drag?.id === s.id}
              dropTarget={drag && drag.id !== s.id && drag.overId === s.id ? (drag.pos ?? null) : null}
              onRefresh={() => void refreshOne(s)}
              onEdit={() => setEditing(s)}
              onRemove={() => setRemoving(s)}
              onMove={(to) => moveTo(s.id, to)}
              onDragStart={onDragStart(s.id)}
              onDragOver={onDragOver(s.id)}
              onDrop={onDrop(s.id)}
              onDragEnd={() => setDrag(null)}
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

      <EditSourceDialog source={editing} onClose={() => setEditing(null)} onRefresh={(s) => void refreshOne(s)} />

      <Dialog
        open={removing !== null}
        onClose={() => (removeBusy ? undefined : setRemoving(null))}
        title={t('removeTitle', { name: removing?.name ?? '' })}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)} disabled={removeBusy}>
              {t('cancel')}
            </Button>
            <Button variant="danger" loading={removeBusy} onClick={() => void confirmRemove()} data-testid="source-remove-confirm">
              {t('removeConfirm')}
            </Button>
          </>
        }
      >
        <p className="text-fg-muted">{t('removeBody')}</p>
      </Dialog>
    </div>
  );
}
