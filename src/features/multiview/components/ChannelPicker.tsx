import { Check, LoaderCircle, Plus, TriangleAlert, Tv } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useRpcQuery } from '@/api/query';
import { sameRef, type Channel, type Source } from '@/api/types';

import { addToWall, channelInput, replaceOnWall } from '../addChannel';
import { Button, buttonClass, cn, Dialog, EmptyState, ErrorState, SearchInput, Select, SkeletonList, toast } from '../deps';
import { MAX_TILES } from '../layout';
import { useMultiviewStore } from '../store';
import { useSourceLoads, useSources } from '../useWallData';
import { ChannelMark } from './ChannelMark';

/** What the picker is for: filling free slots, or changing the channel of one tile. */
export type PickerMode = { kind: 'add' } | { kind: 'replace'; key: string };

export interface ChannelPickerProps {
  open: boolean;
  mode: PickerMode;
  onClose(): void;
}

/** Channels per page when browsing a source; "Show more" adds another page. */
export const PAGE_SIZE = 60;
/** Most results a search asks for. */
export const SEARCH_LIMIT = 60;
const ALL = '';

/** The source the picker opened on last time (this session). */
let lastSource: string | undefined;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Sources that have live channels, in the rail's order. */
function liveSources(list: readonly Source[] | undefined): Source[] {
  return (list ?? []).filter((s) => s.channelCount > 0).sort((a, b) => a.position - b.position);
}

/**
 * Picks live channels for the wall: browse a source, or search one or every source. In add
 * mode it stays open so several channels go up in a row (each through the parental gate);
 * in replace mode the first pick closes it.
 */
export function ChannelPicker({ open, mode, onClose }: ChannelPickerProps) {
  const { t } = useTranslation(['multiview', 'common']);
  const tiles = useMultiviewStore((s) => s.tiles);
  const sourcesQ = useRpcQuery('sources.list', undefined, { enabled: open });
  const sources = useMemo(() => liveSources(sourcesQ.data), [sourcesQ.data]);
  const [source, setSource] = useState<string>(ALL);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [pending, setPending] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const q = useDebounced(query.trim(), 200);
  const replacing = mode.kind === 'replace' ? tiles.find((t) => t.key === mode.key) : undefined;
  const replaceSlot = replacing ? tiles.indexOf(replacing) + 1 : 0;
  const full = mode.kind === 'add' && tiles.length >= MAX_TILES;
  // Every connection of the chosen account already plays on the wall: one more may be refused.
  const { byId } = useSources(open);
  const loads = useSourceLoads(tiles, byId);
  // Sources a pick would push past their limit. Replacing a tile with a channel of its own
  // source adds no connection, so that source is left out.
  const limited = useMemo(
    () => loads.filter((l) => l.max > 0 && l.tiles >= l.max && (mode.kind === 'add' || replacing?.ref.sourceId !== l.sourceId)),
    [loads, mode.kind, replacing?.ref.sourceId],
  );
  const limitedIds = useMemo(() => new Set(limited.map((l) => l.sourceId)), [limited]);
  // One source: its warning. All sources: every source at its limit, and its rows marked.
  const atLimit = source === ALL ? limited : limited.filter((l) => l.sourceId === source);

  // Each opening starts from a clean search, on the last source used (or the replaced tile's).
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setLimit(PAGE_SIZE);
    setPending(null);
  }, [open]);
  useEffect(() => {
    if (!open || sources.length === 0) return;
    const preferred = replacing?.ref.sourceId ?? lastSource;
    setSource((cur) => {
      if (cur !== ALL && sources.some((s) => s.id === cur)) return cur;
      return sources.find((s) => s.id === preferred)?.id ?? sources[0]!.id;
    });
    // Only on opening and when the source list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sources]);
  useEffect(() => setLimit(PAGE_SIZE), [source, q]);

  const searching = q.length > 0;
  const browse = useRpcQuery(
    'catalog.channels',
    { sourceId: source, query: { offset: 0, limit } },
    { enabled: open && !searching && source !== ALL, keepPrevious: true },
  );
  const search = useRpcQuery(
    'catalog.search',
    { query: q, contentTypes: ['live'], limit: SEARCH_LIMIT, ...(source !== ALL ? { sourceId: source } : {}) },
    { enabled: open && searching, keepPrevious: true },
  );
  const active = searching ? search : browse;
  const channels: Channel[] = useMemo(
    () => (searching ? (search.data?.live ?? []) : (browse.data?.items ?? [])).filter((c) => !c.isRadio && c.ref.contentType === 'live'),
    [searching, search.data, browse.data],
  );
  const total = searching ? channels.length : (browse.data?.total ?? 0);
  const sourceName = (id: string) => sources.find((s) => s.id === id)?.name ?? '';

  const pick = async (ch: Channel) => {
    if (pending) return;
    const input = channelInput(ch);
    const key = `${ch.ref.sourceId}|${ch.ref.itemId}`;
    setPending(key);
    lastSource = ch.ref.sourceId;
    try {
      if (mode.kind === 'replace') {
        const r = await replaceOnWall(mode.key, input);
        if (r === 'replaced') onClose();
        else if (r === 'gateFailed') toast({ variant: 'error', title: t('toastGateFailed'), description: t('toastGateFailedHint') });
        else if (r === 'missing') onClose();
        return;
      }
      const r = await addToWall(input);
      if (r === 'gateFailed') toast({ variant: 'error', title: t('toastGateFailed'), description: t('toastGateFailedHint') });
      // Filling the last slot ends the job.
      if (r === 'added' && useMultiviewStore.getState().tiles.length >= MAX_TILES) onClose();
    } finally {
      setPending(null);
    }
  };

  /** Arrow keys walk the rows; ArrowUp from the first row goes back to the search box. */
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-picker-row]') ?? []);
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowDown') next = rows[Math.min(rows.length - 1, i + 1)];
    else if (e.key === 'ArrowUp') next = i <= 0 ? (searchRef.current ?? undefined) : rows[i - 1];
    else if (e.key === 'Home') next = rows[0];
    else if (e.key === 'End') next = rows[rows.length - 1];
    else return;
    e.preventDefault();
    e.stopPropagation();
    next?.focus();
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowDown') return;
    const first = listRef.current?.querySelector<HTMLButtonElement>('button[data-picker-row]');
    if (!first) return;
    e.preventDefault();
    e.stopPropagation();
    first.focus();
  };

  const title = mode.kind === 'replace' ? t('pickerReplaceTitle', { slot: replaceSlot }) : t('pickerAddTitle');
  const sourceOptions = [
    { value: ALL, label: t('pickerAllSources') },
    ...sources.map((s) => ({ value: s.id, label: s.name })),
  ];

  let body;
  if (sourcesQ.isPending) {
    body = <SkeletonList rows={6} />;
  } else if (sourcesQ.isError) {
    body = <ErrorState size="inline" error={sourcesQ.error} onRetry={() => void sourcesQ.refetch()} />;
  } else if (sources.length === 0) {
    body = (
      <EmptyState
        size="inline"
        icon={<Tv aria-hidden className="size-5" />}
        title={t('noSourcesTitle')}
        description={t('pickerNoSources')}
        action={
          <Link to="/sources" className={buttonClass('primary', 'sm')} onClick={onClose}>
            {t('noSourcesAction')}
          </Link>
        }
      />
    );
  } else if (!searching && source === ALL) {
    body = <EmptyState size="inline" icon={<Tv aria-hidden className="size-5" />} title={t('pickerAllPrompt')} description={t('pickerAllPromptHint')} />;
  } else if (active.isPending) {
    body = <SkeletonList rows={6} />;
  } else if (active.isError && channels.length === 0) {
    body = <ErrorState size="inline" error={active.error} onRetry={() => void active.refetch()} />;
  } else if (channels.length === 0) {
    body = (
      <EmptyState
        size="inline"
        icon={<Tv aria-hidden className="size-5" />}
        title={searching ? t('pickerEmptySearch', { query: q }) : t('pickerEmptySource')}
      />
    );
  } else {
    body = (
      <>
        <p className="sr-only" role="status">
          {t('pickerResults', { count: total })}
        </p>
        <ul ref={listRef} onKeyDown={onListKey} className="flex flex-col gap-0.5" aria-label={title} data-testid="multiview-picker-list">
          {channels.map((ch) => {
            const slotOf = tiles.findIndex((tile) => sameRef(tile.ref, ch.ref));
            const onWall = slotOf >= 0;
            const isCurrent = replacing ? sameRef(replacing.ref, ch.ref) : false;
            const rowKey = `${ch.ref.sourceId}|${ch.ref.itemId}`;
            const busy = pending === rowKey;
            const disabled = (onWall && !isCurrent) || (full && !onWall) || (pending !== null && !busy);
            const label = mode.kind === 'replace' ? t('pickerPickLabel', { name: ch.name }) : t('pickerAddLabel', { name: ch.name });
            // Under "All sources" the banner cannot say which rows it means: the rows say it.
            const rowLimited = source === ALL && !onWall && !disabled && limitedIds.has(ch.ref.sourceId);
            return (
              <li key={rowKey}>
                <button
                  type="button"
                  data-picker-row=""
                  data-testid="multiview-picker-row"
                  disabled={disabled || isCurrent}
                  aria-label={onWall ? `${ch.name}, ${t('pickerOnSlot', { slot: slotOf + 1 })}` : rowLimited ? `${label}, ${t('errorLimitTitle')}` : label}
                  data-at-limit={rowLimited ? 'true' : undefined}
                  aria-busy={busy || undefined}
                  onClick={() => void pick(ch)}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-3 rounded-md px-2.5 py-2 text-start outline-none',
                    'hover:bg-surface-2 active:bg-surface-3 focus-visible:ring-2 focus-visible:ring-focus',
                    'disabled:cursor-default disabled:hover:bg-transparent',
                    'motion-safe:transition-colors motion-safe:duration-100',
                  )}
                >
                  <ChannelMark src={ch.logoUrl} sourceId={ch.ref.sourceId} name={ch.name} className="size-9 rounded-md" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span dir="auto" className={cn('truncate text-start text-sm font-medium', disabled && !onWall ? 'text-fg-muted' : 'text-fg')}>
                      {ch.number !== undefined ? <span className="me-2 font-display tabular-nums text-fg-muted">{ch.number}</span> : null}
                      {ch.name}
                    </span>
                    <span className="flex min-w-0 gap-2 text-xs text-fg-muted">
                      <span dir="auto" className="truncate">
                        {ch.categoryName}
                      </span>
                      {source === ALL ? (
                        <span dir="auto" className="shrink-0 truncate text-fg-subtle">
                          {sourceName(ch.ref.sourceId)}
                        </span>
                      ) : null}
                      {rowLimited ? (
                        <span className="inline-flex min-w-0 items-center gap-1" data-testid="multiview-picker-row-limit">
                          <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />
                          <span className="truncate">{t('errorLimitTitle')}</span>
                        </span>
                      ) : null}
                    </span>
                  </span>
                  {busy ? (
                    <LoaderCircle aria-hidden className="size-4 shrink-0 text-fg-muted motion-safe:animate-spin" />
                  ) : onWall ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-accent/15 px-1.5 py-0.5 text-xs font-medium text-fg">
                      <Check aria-hidden className="size-3.5 text-accent" />
                      {t('pickerOnSlot', { slot: slotOf + 1 })}
                    </span>
                  ) : !disabled ? (
                    <span aria-hidden className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-fg-muted">
                      <Plus className="size-3.5" />
                      {mode.kind === 'replace' ? t('pickerPick') : t('pickerAdd')}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
        {!searching && channels.length < total ? (
          <div className="flex justify-center pt-2">
            <Button variant="ghost" size="sm" loading={browse.isFetching} onClick={() => setLimit((l) => l + PAGE_SIZE)}>
              {t('pickerShowMore')}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={mode.kind === 'add' ? t('pickerCount', { n: tiles.length, max: MAX_TILES }) : undefined}
      size="lg"
      testId="multiview-picker"
      initialFocus={searchRef}
      bodyClassName="flex min-h-0 flex-col gap-3"
      footer={
        mode.kind === 'add' ? (
          <Button variant="primary" onClick={onClose}>
            {t('pickerDone')}
          </Button>
        ) : undefined
      }
    >
      {sources.length > 0 ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Select
            label={t('pickerSource')}
            options={sourceOptions}
            value={source}
            onValueChange={(v) => setSource(v)}
            wrapperClassName="sm:w-56 sm:shrink-0"
          />
          <SearchInput
            ref={searchRef}
            value={query}
            onChange={setQuery}
            onKeyDown={onSearchKey}
            placeholder={t('pickerSearch')}
            label={t('pickerSearch')}
            className="min-w-0 flex-1"
          />
        </div>
      ) : null}
      {full ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-fg" role="status">
          {t('pickerFull')}
        </p>
      ) : atLimit.length > 0 ? (
        <div className="flex flex-col gap-2" role="status">
          {atLimit.map((l) => (
            <p
              key={l.sourceId}
              className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-fg"
              data-testid="multiview-picker-limit"
            >
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>{t('pickerAtLimit', { source: l.name || t('limitUnknownSource') })}</span>
            </p>
          ))}
        </div>
      ) : null}
      <div className="max-h-[min(26rem,55dvh)] min-h-40 overflow-y-auto">{body}</div>
    </Dialog>
  );
}
