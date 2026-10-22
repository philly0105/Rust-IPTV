/**
 * "Edit channels" of one list: its channels in order, reorder by drag or
 * Alt+ArrowUp / Alt+ArrowDown, Remove with Undo. Channels the provider
 * dropped stay in place, greyed, so they can be removed too.
 */

import { ArrowLeft, ListOrdered, X } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { itemKey, type CustomListEntry } from '@/api/types';

import {
  Button,
  ChannelLogo,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  QualityFilterNote,
  Skeleton,
  cn,
  displayChannelName,
  useDisplayPrefs,
  useLiveQuality,
  useRowHeight,
  useVisibleSources,
} from '../deps';
import { SortableList } from '../components/SortableList';
import { useListActions } from '../hooks/useListActions';
import { useListItems, useLists } from '../hooks/useLists';
import { move } from '../lib/cache';
import { openManageLists } from '../store';

/**
 * A row at 100 %: the two text lines (text-sm and text-xs, 33.75 px), its py-1.5 padding and its
 * border. The padding is the part compact density tightens.
 */
const ROW_PX = 46;
const ROW_SPACING_PX = 11;

export function EditItemsDialog({ listId, fromManage, onClose }: { listId: string; fromManage: boolean; onClose(): void }) {
  const { t } = useTranslation('lists');
  const prefs = useDisplayPrefs();
  const lists = useLists();
  const list = lists.data?.find((l) => l.id === listId);
  const items = useListItems(listId);
  // The Live TV quality filter leaves out the channels it hides: an empty list may be its doing.
  const quality = useLiveQuality();
  const actions = useListActions();
  const sources = useVisibleSources();
  const sourceName = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s.name])), [sources.data]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null | undefined>(undefined);
  // A list holds up to 2,000 channels: only the rows near the screen are mounted.
  const rowHeight = useRowHeight(ROW_PX, ROW_SPACING_PX);
  const virtual = useMemo(() => ({ rowHeight, scrollerClassName: '-mx-2 max-h-[min(60vh,520px)] overflow-y-auto px-2' }), [rowHeight]);

  const entries = items.data ?? [];
  const strip = prefs.stripCountryPrefix;
  const nameOf = useCallback((e: CustomListEntry) => displayChannelName(e.channel?.name ?? e.snapshot.title, strip), [strip]);

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
  // SortableList's rows are memoized: they get callbacks that stay the same while the entries
  // change and read the latest ones, so a move re-renders the two rows it swaps, not up to 2,000.
  const latest = useRef({ removeOne, entries, list });
  latest.current = { removeOne, entries, list };
  const onRemove = useCallback((entry: CustomListEntry, index: number) => latest.current.removeOne(entry, index), []);
  const onMove = useCallback(
    (from: number, to: number) => {
      const { list: l, entries: all } = latest.current;
      if (l) actions.reorderEntries(l.id, move(all, from, to));
    },
    [actions],
  );
  const renderRow = useCallback(
    (entry: CustomListEntry, index: number) => (
      <EditItemRow
        entry={entry}
        index={index}
        name={nameOf(entry)}
        source={entry.available ? (sourceName.get(entry.ref.sourceId) ?? t('unknownSource')) : t('unavailableHeading')}
        removeLabel={t('removeNamed', { name: nameOf(entry) })}
        onRemove={onRemove}
      />
    ),
    [nameOf, sourceName, t, onRemove],
  );

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
    body = (
      <EmptyState
        size="inline"
        icon={<ListOrdered className="size-6" />}
        title={t('listEmptyTitle')}
        description={t('listEmptyHint')}
        action={quality.filtering ? <QualityFilterNote quality={quality} /> : undefined}
      />
    );
  } else {
    body = (
      <SortableList<CustomListEntry>
        items={entries}
        virtual={virtual}
        label={list.name}
        testId="edit-list-items"
        getKey={entryKey}
        getLabel={nameOf}
        onMove={onMove}
        rowClassName={unavailableClass}
        renderRow={renderRow}
      />
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

const entryKey = (e: CustomListEntry) => itemKey(e.ref);
const unavailableClass = (e: CustomListEntry) => (e.available ? undefined : 'text-fg-subtle');

/** One channel's row after the grip: its logo, name and source, and Remove. */
function EditItemRow({
  entry,
  index,
  name,
  source,
  removeLabel,
  onRemove,
}: {
  entry: CustomListEntry;
  index: number;
  name: string;
  source: string;
  removeLabel: string;
  onRemove(entry: CustomListEntry, index: number): void;
}) {
  return (
    <>
      <span className={cn('flex min-w-0 flex-1 items-center gap-3 px-1', !entry.available && 'opacity-60 grayscale')}>
        <ChannelLogo src={entry.channel?.logoUrl ?? entry.snapshot.posterUrl} name={name} size={32} sourceId={entry.ref.sourceId} />
        <span className="min-w-0">
          <span dir="auto" className="block truncate text-sm font-medium text-fg">
            {name}
          </span>
          <span dir="auto" className="block truncate text-xs text-fg-subtle">
            {source}
          </span>
        </span>
      </span>
      <IconButton
        size="sm"
        variant="ghost"
        data-sort-part="remove"
        label={removeLabel}
        icon={<X className="size-4" />}
        className="hover:text-danger"
        onClick={() => onRemove(entry, index)}
      />
    </>
  );
}
