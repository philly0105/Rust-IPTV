/**
 * "Edit channels" of one list: its channels in order, reorder by drag or
 * Alt+ArrowUp / Alt+ArrowDown, Remove with Undo. Channels the provider
 * dropped stay in place, greyed, so they can be removed too.
 */

import { ArrowLeft, ListOrdered, X } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { itemKey, type CustomListEntry } from '@/api/types';

import { Button, ChannelLogo, Dialog, EmptyState, ErrorState, IconButton, Skeleton, cn, displayChannelName, useDisplayPrefs, useVisibleSources } from '../deps';
import { SortableList } from '../components/SortableList';
import { useListActions } from '../hooks/useListActions';
import { useListItems, useLists } from '../hooks/useLists';
import { move } from '../lib/cache';
import { openManageLists } from '../store';

export function EditItemsDialog({ listId, fromManage, onClose }: { listId: string; fromManage: boolean; onClose(): void }) {
  const { t } = useTranslation('lists');
  const prefs = useDisplayPrefs();
  const lists = useLists();
  const list = lists.data?.find((l) => l.id === listId);
  const items = useListItems(listId);
  const actions = useListActions();
  const sources = useVisibleSources();
  const sourceName = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s.name])), [sources.data]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null | undefined>(undefined);

  const entries = items.data ?? [];
  const nameOf = (e: CustomListEntry) => displayChannelName(e.channel?.name ?? e.snapshot.title, prefs.stripCountryPrefix);

  useLayoutEffect(() => {
    if (focusAfter.current === undefined || !bodyRef.current) return;
    const key = focusAfter.current;
    focusAfter.current = undefined;
    const row = key ? bodyRef.current.querySelector(`[data-sort-key="${CSS.escape(key)}"]`) : null;
    (row?.querySelector<HTMLElement>('[data-sort-part="remove"]') ?? bodyRef.current.closest<HTMLElement>('[role="dialog"]'))?.focus();
  });

  const removeOne = (entry: CustomListEntry, index: number) => {
    if (!list) return;
    const next = entries[index + 1] ?? entries[index - 1];
    focusAfter.current = next ? itemKey(next.ref) : null;
    actions.removeEntries(list, [entry], nameOf(entry));
  };

  let body;
  const error = items.error ?? lists.error;
  if (error) {
    body = (
      <ErrorState
        size="inline"
        error={error}
        title={t('itemsLoadFailed')}
        onRetry={() => {
          void items.refetch();
          void lists.refetch();
        }}
      />
    );
  } else if (!items.data || !lists.data) {
    body = (
      <div className="flex flex-col gap-2" role="status" aria-busy="true" aria-label={t('loadingChannels')}>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-12 w-full rounded-md" />
        ))}
      </div>
    );
  } else if (!list) {
    body = <EmptyState size="inline" icon={<ListOrdered className="size-6" />} title={t('notFoundTitle')} description={t('notFoundHint')} />;
  } else if (entries.length === 0) {
    body = <EmptyState size="inline" icon={<ListOrdered className="size-6" />} title={t('listEmptyTitle')} description={t('listEmptyHint')} />;
  } else {
    body = (
      <div className="-mx-2 max-h-[min(60vh,520px)] overflow-y-auto px-2">
        <SortableList<CustomListEntry>
          items={entries}
          label={list.name}
          testId="edit-list-items"
          getKey={(e) => itemKey(e.ref)}
          getLabel={nameOf}
          onMove={(from, to) => actions.reorderEntries(list.id, move(entries, from, to))}
          rowClassName={(e) => (e.available ? undefined : 'text-fg-subtle')}
          renderRow={(entry, index) => {
            const name = nameOf(entry);
            const logo = entry.channel?.logoUrl ?? entry.snapshot.posterUrl;
            return (
              <>
                <span className={cn('flex min-w-0 flex-1 items-center gap-3 px-1', !entry.available && 'opacity-60 grayscale')}>
                  <ChannelLogo src={logo} name={name} size={32} />
                  <span className="min-w-0">
                    <span dir="auto" className="block truncate text-sm font-medium text-fg">
                      {name}
                    </span>
                    <span dir="auto" className="block truncate text-xs text-fg-subtle">
                      {entry.available ? (sourceName.get(entry.ref.sourceId) ?? t('unknownSource')) : t('unavailableHeading')}
                    </span>
                  </span>
                </span>
                <IconButton
                  size="sm"
                  variant="ghost"
                  data-sort-part="remove"
                  label={t('removeNamed', { name })}
                  icon={<X className="size-4" />}
                  className="hover:text-danger"
                  onClick={() => removeOne(entry, index)}
                />
              </>
            );
          }}
        />
      </div>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={list ? t('editTitle', { list: list.name }) : t('editChannels')}
      description={entries.length > 1 ? t('reorderHint') : undefined}
      size="md"
      testId="edit-list-dialog"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          {fromManage ? (
            <Button variant="ghost" size="sm" icon={<ArrowLeft className="size-4 rtl:rotate-180" />} onClick={() => openManageLists(listId)}>
              {t('backToLists')}
            </Button>
          ) : (
            <span />
          )}
          <Button variant="primary" size="sm" onClick={onClose}>
            {t('done')}
          </Button>
        </div>
      }
    >
      <div ref={bodyRef}>{body}</div>
    </Dialog>
  );
}
