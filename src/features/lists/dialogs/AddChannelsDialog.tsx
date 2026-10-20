/**
 * "Add channels" on a list's page (LG-13): browse a source by group, favorites, recent or another
 * list, or search, and add or take out channels with one press each. The list used to grow only
 * from Live, one right click at a time.
 *
 * Built on the same browse hook and scope picker as the multi-view picker, so both pick the same
 * way. Each press is applied at once, like the "Add to list" check boxes.
 */

import { Check, LoaderCircle, Plus, Tv } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { itemKey, type Channel, type ItemKey } from '@/api/types';
import { intlLocale } from '@/lib/intl';

import {
  Button,
  ChannelLogo,
  Dialog,
  EmptyState,
  ErrorState,
  SCOPE_ALL,
  ScopePicker,
  SearchInput,
  Select,
  SkeletonList,
  buttonClass,
  cn,
  displayChannelName,
  nowTitleOf,
  scopeOfList,
  useBrowseSections,
  useChannelBrowse,
  useDisplayPrefs,
  useVisibleSources,
  type BrowseScope,
} from '../deps';
import { useListActions } from '../hooks/useListActions';
import { useListItems, useLists } from '../hooks/useLists';
import { MAX_ITEMS } from '../lib/cache';

const PAGE = 60;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function AddChannelsDialog({ listId, onClose }: { listId: string; onClose(): void }) {
  const { t, i18n } = useTranslation('lists');
  const { t: tl } = useTranslation('live');
  const fmt = new Intl.NumberFormat(intlLocale(i18n.language));
  const { stripCountryPrefix } = useDisplayPrefs();
  const lists = useLists();
  const list = lists.data?.find((l) => l.id === listId);
  const items = useListItems(listId);
  const actions = useListActions();
  const sourcesQ = useVisibleSources();
  const sources = useMemo(() => (sourcesQ.data ?? []).filter((s) => s.channelCount > 0).sort((a, b) => a.position - b.position), [sourcesQ.data]);

  // Membership as the dialog last applied it: a press flips it at once, the refetch confirms.
  const [overrides, setOverrides] = useState<ReadonlyMap<ItemKey, boolean>>(() => new Map());
  const member = useMemo(() => new Set((items.data ?? []).map((e) => itemKey(e.ref))), [items.data]);
  const inList = (c: Channel) => overrides.get(itemKey(c.ref)) ?? member.has(itemKey(c.ref));
  const [pending, setPending] = useState<ItemKey | null>(null);
  const [announce, setAnnounce] = useState('');

  // Start on the source the list draws from most, else the first one with channels.
  const [source, setSource] = useState('');
  useEffect(() => {
    if (source || sources.length === 0) return;
    const counts = new Map<string, number>();
    for (const e of items.data ?? []) counts.set(e.ref.sourceId, (counts.get(e.ref.sourceId) ?? 0) + 1);
    const most = [...counts.entries()].sort((a, b) => b[1] - a[1]).find(([id]) => sources.some((s) => s.id === id))?.[0];
    setSource(most ?? sources[0]!.id);
  }, [sources, items.data, source]);
  const [scope, setScope] = useState<BrowseScope>(SCOPE_ALL);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const q = useDebounced(query.trim(), 200);
  useEffect(() => setLimit(PAGE), [source, scope, q]);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const allSections = useBrowseSections(source, true);
  // The list being filled is not a place to browse.
  const sections = useMemo(
    () => allSections.map((s) => (s.id === 'views' ? { ...s, options: s.options.filter((o) => o.value !== scopeOfList(listId)) } : s)),
    [allSections, listId],
  );
  const browse = useChannelBrowse({ enabled: !!source, sourceId: source, scope, query: q, limit });
  const full = !!list && list.itemCount >= MAX_ITEMS;

  const toggle = async (ch: Channel) => {
    if (!list || pending) return;
    const key = itemKey(ch.ref);
    const next = !inList(ch);
    if (next && full) return;
    setPending(key);
    setOverrides((m) => new Map(m).set(key, next));
    const ok = await actions.setMember(list, ch, next);
    setPending(null);
    const name = displayChannelName(ch.name, stripCountryPrefix);
    if (!ok) {
      setOverrides((m) => {
        const out = new Map(m);
        out.delete(key);
        return out;
      });
      return;
    }
    setAnnounce(next ? t('addedNamed', { name, list: list.name }) : t('removedFrom', { name, list: list.name }));
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-add-row]') ?? []);
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

  let body;
  if (sourcesQ.isPending || items.isPending) {
    body = <SkeletonList rows={6} />;
  } else if (sourcesQ.isError) {
    body = <ErrorState size="inline" error={sourcesQ.error} onRetry={() => void sourcesQ.refetch()} />;
  } else if (sources.length === 0) {
    body = (
      <EmptyState
        size="inline"
        icon={<Tv aria-hidden className="size-5" />}
        title={tl('noChannels')}
        action={
          <Link to="/sources" className={buttonClass('primary', 'sm')} onClick={onClose}>
            {tl('openSources')}
          </Link>
        }
      />
    );
  } else if (browse.isPending) {
    body = <SkeletonList rows={6} />;
  } else if (browse.isError && browse.channels.length === 0) {
    body = <ErrorState size="inline" error={browse.error} onRetry={browse.refetch} />;
  } else if (browse.channels.length === 0) {
    body = <EmptyState size="inline" icon={<Tv aria-hidden className="size-5" />} title={q ? tl('noSearchResults', { query: q }) : tl('emptyGroup')} />;
  } else {
    body = (
      <>
        <ul ref={listRef} onKeyDown={onListKey} className="flex flex-col gap-0.5" aria-label={t('addChannels')} data-testid="add-channels-list">
          {browse.channels.map((ch) => {
            const key = itemKey(ch.ref);
            const name = displayChannelName(ch.name, stripCountryPrefix);
            const on = inList(ch);
            const busy = pending === key;
            const nowTitle = nowTitleOf(browse.nowNext, ch);
            return (
              <li key={key}>
                <button
                  type="button"
                  data-add-row=""
                  // Named by the channel and its second line; aria-pressed says whether it is in the list.
                  aria-label={[name, nowTitle ?? ch.categoryName].filter(Boolean).join(', ')}
                  aria-pressed={on}
                  aria-busy={busy || undefined}
                  disabled={(!on && full) || (pending !== null && !busy)}
                  onClick={() => void toggle(ch)}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-3 rounded-md px-2.5 py-2 text-start outline-none hover:bg-hover active:bg-active focus-visible:ring-2 focus-visible:ring-focus',
                    'disabled:cursor-default disabled:hover:bg-transparent motion-safe:transition-colors motion-safe:duration-100',
                  )}
                >
                  <ChannelLogo src={ch.logoUrl} name={name} size={36} sourceId={ch.ref.sourceId} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span dir="auto" className="truncate text-sm font-medium text-fg">
                      {ch.number !== undefined ? <span className="me-2 font-numeric tabular-nums text-fg-muted">{ch.number}</span> : null}
                      {name}
                    </span>
                    <span dir="auto" className="truncate text-xs text-fg-muted">
                      {nowTitle ?? ch.categoryName}
                    </span>
                  </span>
                  {busy ? (
                    <LoaderCircle aria-hidden className="size-4 shrink-0 text-fg-muted motion-safe:animate-spin" />
                  ) : on ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-surface-3 px-1.5 py-0.5 text-xs font-medium text-fg">
                      <Check aria-hidden className="size-3.5 text-fg-muted" />
                      {t('inList')}
                    </span>
                  ) : (
                    <span aria-hidden className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-fg-muted">
                      <Plus className="size-3.5" />
                      {t('groupAdd')}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {browse.channels.length < browse.total ? (
          <div className="flex justify-center pt-2">
            {/* A page that failed is asked again first: the pages after it would not show. */}
            <Button variant="ghost" size="sm" loading={browse.isFetching} onClick={() => (browse.isError ? browse.refetch() : setLimit((l) => l + PAGE))}>
              {t('showMore')}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={list ? t('addChannelsTo', { list: list.name }) : t('addChannels')}
      description={list ? t('channelCount', { count: list.itemCount, formatted: fmt.format(list.itemCount) }) : undefined}
      size="lg"
      testId="add-channels"
      initialFocus={searchRef}
      bodyClassName="flex min-h-0 flex-col gap-3"
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('done')}
        </Button>
      }
    >
      {sources.length > 0 ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          {sources.length > 1 ? (
            <Select
              label={tl('guideSource')}
              options={sources.map((s) => ({ value: s.id, label: s.name }))}
              value={source}
              onValueChange={(v) => {
                setSource(v);
                if (!scope.startsWith('@')) setScope(SCOPE_ALL);
              }}
              wrapperClassName="sm:w-52 sm:shrink-0"
            />
          ) : null}
          <div className="flex min-w-0 flex-col gap-1.5 sm:w-44 sm:shrink-0">
            <span className="text-sm font-medium text-fg" aria-hidden>
              {tl('pickerShow')}
            </span>
            <ScopePicker label={tl('pickerShow')} value={scope} sections={sections} onChange={setScope} className="h-10" testId="add-channels-scope" />
          </div>
          <SearchInput
            ref={searchRef}
            value={query}
            onChange={setQuery}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown') return;
              const first = listRef.current?.querySelector<HTMLButtonElement>('button[data-add-row]');
              if (!first) return;
              e.preventDefault();
              first.focus();
            }}
            placeholder={tl('searchChannels')}
            label={tl('searchChannels')}
            className="min-w-0 flex-1"
          />
        </div>
      ) : null}
      {full ? (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-fg-muted" role="note">
          {t('errorListFull', { max: MAX_ITEMS })}
        </p>
      ) : null}
      <div className="max-h-[min(26rem,55dvh)] min-h-40 overflow-y-auto">{body}</div>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </Dialog>
  );
}
