import { useVirtualizer } from '@tanstack/react-virtual';
import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { itemKey, type Channel, type ChannelEdit } from '@/api/types';
import { ChannelLogo } from '@/features/live/components/ChannelLogo';
import { Badge, Button, Dialog, EmptyState, ErrorState, SearchInput, SkeletonList, cn, useRowHeight } from '@/ui';

import { isGoneAnswer, reportUnhideMany, unhideChannel, unhideMany } from './actions';
import { ITEM_STALE_MS, useDisplayName, useHiddenEdits } from './edits';

export interface HiddenChannelsPanelProps {
  sourceId: string;
  onClose: () => void;
}

interface Row {
  key: string;
  edit: ChannelEdit;
  /** Name shown in the app: the custom one when renamed. */
  name: string;
  /** The provider's name, when a custom one is set. */
  provider?: string;
}

/** Case- and accent-insensitive form for the filter: "espana" finds "España". */
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/**
 * The hidden-channels dialog body. Rows are virtualised and keyboard-driven
 * like the app's other lists: one Tab stop, arrows, Home/End and Page keys
 * move between rows, Enter or Space unhides. Unhiding moves focus to the row
 * that takes its place.
 */
export function HiddenChannelsPanel({ sourceId, onClose }: HiddenChannelsPanelProps) {
  const { t, i18n } = useTranslation('channels');
  const fmt = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const display = useDisplayName();
  const hidden = useHiddenEdits(sourceId);
  const [filter, setFilter] = useState('');
  const [busyAll, setBusyAll] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  /** Bumped when focus should follow `active` (arrow keys, a row leaving). */
  const [focusTick, setFocusTick] = useState(0);
  const rowHeight = useRowHeight(56, 16);

  const rows: Row[] = useMemo(
    () =>
      (hidden.data ?? []).map((edit) => {
        const provider = display(edit.originalName);
        const name = edit.name !== undefined ? display(edit.name) : provider;
        return { key: itemKey(edit.ref), edit, name, ...(edit.name !== undefined ? { provider } : {}) };
      }),
    [hidden.data, display],
  );
  const query = fold(filter.trim());
  const shown = useMemo(
    () => (query ? rows.filter((r) => fold(r.name).includes(query) || (r.provider !== undefined && fold(r.provider).includes(query))) : rows),
    [rows, query],
  );
  const mixed = useMemo(() => new Set(rows.map((r) => r.edit.ref.contentType)).size > 1, [rows]);

  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    initialRect: { width: 480, height: 360 },
  });
  useEffect(() => virtualizer.measure(), [rowHeight, virtualizer]);

  // Keep the active row inside the list as it shrinks (a row unhidden, a filter typed).
  const last = shown.length - 1;
  const current = Math.min(active, Math.max(last, 0));
  useEffect(() => {
    if (focusTick === 0) return;
    if (shown.length === 0) {
      // Nothing matches: back to the filter. Nothing left at all: Done.
      (query && rows.length > 0 ? searchRef.current : doneRef.current)?.focus();
      return;
    }
    virtualizer.scrollToIndex(current, { align: 'auto' });
    // The row renders after the scroll; focus it on the next frame.
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-index="${current}"] button`)?.focus();
    });
    // Only a new request moves focus; renders from the list refreshing do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick]);

  const move = (to: number) => {
    if (shown.length === 0) return;
    setActive(Math.max(0, Math.min(to, last)));
    setFocusTick((n) => n + 1);
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight || 360) / rowHeight) - 1);
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(current + 1),
      ArrowUp: () => move(current - 1),
      Home: () => move(0),
      End: () => move(last),
      PageDown: () => move(current + page),
      PageUp: () => move(current - page),
    };
    const run = keys[e.key];
    if (!run || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  };

  const unhideRow = (row: Row, index: number) => {
    // The row leaves the cached list at once: its neighbour takes its place, and the focus.
    setActive(index);
    setFocusTick((n) => n + 1);
    void unhideChannel({ ref: row.edit.ref, name: row.name }, t);
  };

  const unhideShown = async () => {
    if (busyAll || shown.length === 0) return;
    setBusyAll(true);
    try {
      const result = await unhideMany(
        sourceId,
        shown.map((r) => r.edit.ref),
      );
      reportUnhideMany(result, t);
    } finally {
      setBusyAll(false);
      setFocusTick((n) => n + 1);
    }
  };

  const total = rows.length;
  const summary = !hidden.data
    ? null
    : query
      ? t('matchCount', { shown: fmt.format(shown.length), total: fmt.format(total) })
      : t('hiddenCount', { count: total });

  let body;
  if (hidden.error) {
    body = <ErrorState size="inline" error={hidden.error} onRetry={() => void hidden.refetch()} retrying={hidden.isFetching} />;
  } else if (!hidden.data) {
    body = <SkeletonList rows={4} />;
  } else if (total === 0) {
    body = (
      <EmptyState
        size="inline"
        icon={<EyeOff size={22} />}
        title={t('noHiddenTitle')}
        description={t('noHiddenText')}
        className="py-10"
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-2">
        <SearchInput
          ref={searchRef}
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setActive(0);
          }}
          placeholder={t('filterHidden')}
          size="sm"
          onKeyDown={(e) => {
            // Down from the search field enters the list, as in the Live search.
            if (e.key === 'ArrowDown' && shown.length > 0) {
              e.preventDefault();
              move(0);
            }
          }}
          data-testid="hidden-channels-filter"
        />
        <p className="text-xs text-fg-subtle tabular-nums" aria-live="polite" data-testid="hidden-channels-summary">
          {summary}
        </p>
        {shown.length === 0 ? (
          <p className="py-8 text-center text-sm text-fg-muted">{t('noMatch')}</p>
        ) : (
          // Sized to its rows up to the cap, so two or three hidden channels leave no empty well.
          <div
            ref={scrollRef}
            id={listId}
            role="list"
            aria-label={t('hiddenTitle')}
            onKeyDown={onListKey}
            className="max-h-[min(380px,48vh)] overflow-y-auto overscroll-contain rounded-md border border-border bg-surface"
            data-testid="hidden-channels-list"
          >
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((v) => {
                const row = shown[v.index]!;
                return (
                  <HiddenRow
                    key={row.key}
                    row={row}
                    index={v.index}
                    size={shown.length}
                    top={v.start}
                    height={rowHeight}
                    tabbable={v.index === current}
                    showType={mixed}
                    onFocus={() => setActive(v.index)}
                    onUnhide={() => unhideRow(row, v.index)}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('hiddenTitle')}
      description={t('hiddenText')}
      size="md"
      // The body scrolls, so it clips: room above the filter for its focus outline (2px + 2px offset).
      bodyClassName="pt-1"
      testId="hidden-channels-dialog"
      footer={
        <>
          {total > 0 ? (
            <Button
              variant="secondary"
              className="me-auto"
              icon={<Eye aria-hidden size={16} />}
              loading={busyAll}
              disabled={shown.length === 0}
              onClick={() => void unhideShown()}
              data-testid="hidden-channels-unhide-all"
            >
              {query ? t('unhideShown') : t('unhideAll')}
            </Button>
          ) : null}
          <Button ref={doneRef} variant="primary" onClick={onClose}>
            {t('done')}
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}

function HiddenRow({
  row,
  index,
  size,
  top,
  height,
  tabbable,
  showType,
  onFocus,
  onUnhide,
}: {
  row: Row;
  index: number;
  size: number;
  top: number;
  height: number;
  tabbable: boolean;
  showType: boolean;
  onFocus: () => void;
  onUnhide: () => void;
}) {
  const { t } = useTranslation('channels');
  // The logo, and whether the provider still lists the channel. catalog.item still answers for hidden channels (C2);
  // a channel parental Hide mode locks answers not_found with details.parentalLocked and is still listed.
  const item = useRpcQuery('catalog.item', { ref: row.edit.ref }, { staleTime: ITEM_STALE_MS });
  const logo = item.data && 'logoUrl' in item.data ? (item.data as Channel).logoUrl : undefined;
  const gone = item.error != null && isGoneAnswer(item.error);
  const radio = row.edit.ref.contentType === 'radio';
  const detailId = `${row.key}-detail`;

  return (
    <div
      role="listitem"
      aria-setsize={size}
      aria-posinset={index + 1}
      data-index={index}
      data-testid="hidden-channel-row"
      style={{ position: 'absolute', top: 0, insetInline: 0, height, transform: `translateY(${top}px)` }}
      className="flex items-center gap-3 border-b border-divider px-3 last:border-b-0 has-[:focus-visible]:bg-surface-2"
    >
      <span className={cn(gone && 'opacity-50 grayscale')}>
        <ChannelLogo src={logo} name={row.name} size={32} sourceId={row.edit.ref.sourceId} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span dir="auto" className={cn('truncate text-sm font-medium', gone ? 'text-fg-muted' : 'text-fg')}>
          {row.name}
        </span>
        {gone || row.provider !== undefined || (showType && radio) ? (
          <span id={detailId} className="flex min-w-0 items-center gap-2 text-xs text-fg-subtle">
            {showType && radio ? <Badge variant="outline">{t('radioBadge')}</Badge> : null}
            {gone ? (
              <span className="truncate text-warning">{t('goneBadge')}</span>
            ) : row.provider !== undefined ? (
              <span className="truncate">
                {t('providerNameLabel')} <bdi>{row.provider}</bdi>
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="ghost"
        icon={<Eye aria-hidden size={16} />}
        tabIndex={tabbable ? 0 : -1}
        aria-label={t('unhideNamed', { name: row.name })}
        aria-describedby={gone || row.provider !== undefined ? detailId : undefined}
        onFocus={onFocus}
        onClick={onUnhide}
        className="shrink-0 text-fg"
        data-testid="hidden-channel-unhide"
      >
        <span aria-hidden className="max-[420px]:sr-only">
          {t('unhide')}
        </span>
      </Button>
    </div>
  );
}
