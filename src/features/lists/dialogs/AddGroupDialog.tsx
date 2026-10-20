/**
 * "Add all to list…" from a group's menu (LG-13): every channel of a source's group goes into a
 * list in one write, or into a new list named after the group. A 30-channel Sports list used to
 * take 30 rounds of right click, Add to list, tick.
 *
 * The group's channels load once, up to the 2000 a list can hold. Each list row adds them with
 * one press and then says how many were new; the core skips channels the list already has.
 */

import { useQuery } from '@tanstack/react-query';
import { Check, ListTree } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { rpc } from '@/api/transport';
import type { Channel, CustomList } from '@/api/types';
import { intlLocale } from '@/lib/intl';

import { Button, Dialog, ErrorState, Skeleton, cn } from '../deps';
import { NewListForm } from '../components/NewListForm';
import { useListActions } from '../hooks/useListActions';
import { useLists } from '../hooks/useLists';
import { MAX_ITEMS } from '../lib/cache';
import type { GroupTarget } from '../store';

/** Channels asked per request while loading a group (the core answers at most 1000). */
const LOAD_PAGE = 500;

/** Every channel of the group, in the source's order, up to what one list can hold. */
export async function loadGroupChannels(group: GroupTarget): Promise<Channel[]> {
  const out: Channel[] = [];
  for (let offset = 0; offset < MAX_ITEMS; offset += LOAD_PAGE) {
    const page = await rpc('catalog.channels', {
      sourceId: group.sourceId,
      categoryId: group.categoryId,
      ...(group.contentType === 'radio' ? { radio: true } : {}),
      query: { offset, limit: Math.min(LOAD_PAGE, MAX_ITEMS - offset) },
    });
    out.push(...page.items);
    if (page.items.length === 0 || out.length >= page.total) break;
  }
  return out.slice(0, MAX_ITEMS);
}

export function AddGroupDialog({ group, onClose }: { group: GroupTarget; onClose(): void }) {
  const { t, i18n } = useTranslation('lists');
  const fmt = new Intl.NumberFormat(intlLocale(i18n.language));
  const lists = useLists();
  const actions = useListActions();
  const channels = useQuery({
    queryKey: ['lists.groupChannels', group.sourceId, group.contentType, group.categoryId],
    queryFn: () => loadGroupChannels(group),
    staleTime: 60_000,
    retry: false,
  });
  const [done, setDone] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [pending, setPending] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const loaded = channels.data ?? [];
  const count = channels.data ? loaded.length : group.count;

  const add = async (list: CustomList) => {
    if (pending || !channels.data) return;
    setPending(list.id);
    const added = await actions.addMany(list, loaded);
    setPending(null);
    if (added === null) return;
    setDone((m) => new Map(m).set(list.id, added));
    setAnnounce(
      added === 0 ? t('groupAlreadyIn', { list: list.name }) : t('groupAdded', { count: added, formatted: fmt.format(added), list: list.name }),
    );
  };

  let body;
  if (channels.error || lists.error) {
    body = (
      <ErrorState
        size="inline"
        error={channels.error ?? lists.error}
        title={t('groupLoadFailed')}
        onRetry={() => {
          void channels.refetch();
          void lists.refetch();
        }}
      />
    );
  } else if (!channels.data || !lists.data) {
    body = (
      <div className="flex flex-col gap-2 py-1" role="status" aria-busy="true" aria-label={t('loadingChannels')}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-11 w-full rounded-md" />
        ))}
      </div>
    );
  } else if (lists.data.length === 0) {
    body = <p className="py-2 text-sm text-fg-muted">{t('pickerEmpty')}</p>;
  } else {
    body = (
      <ul className="-mx-2 flex max-h-[min(50vh,360px)] flex-col overflow-y-auto" aria-label={t('title')} data-testid="group-to-list-options">
        {lists.data.map((list) => {
          const added = done.get(list.id);
          const full = list.itemCount >= MAX_ITEMS;
          return (
            <li key={list.id} className="flex min-h-11 items-center gap-3 rounded-md px-2 py-1.5">
              <span className="flex min-w-0 flex-1 flex-col">
                <span dir="auto" className="truncate text-sm text-fg">
                  {list.name}
                </span>
                <span className="text-caption tabular-nums text-fg-subtle">
                  {full ? t('listFull') : t('channelCount', { count: list.itemCount, formatted: fmt.format(list.itemCount) })}
                </span>
              </span>
              {added !== undefined ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-caption text-fg-muted" data-testid="group-added">
                  <Check aria-hidden size={14} />
                  {added === 0 ? t('groupNothingNew') : t('groupAddedShort', { count: added, formatted: fmt.format(added) })}
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={full || (pending !== null && pending !== list.id)}
                  loading={pending === list.id}
                  onClick={() => void add(list)}
                  aria-label={t('groupAddTo', { list: list.name })}
                >
                  {t('groupAdd')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('groupTitle')}
      size="sm"
      testId="group-to-list"
      footer={
        <Button variant="primary" size="sm" onClick={onClose}>
          {t('done')}
        </Button>
      }
    >
      <div className="mb-3 flex items-center gap-3 rounded-md border border-edge bg-surface-2 p-2">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-3 text-fg-muted">
          <ListTree size={18} />
        </span>
        <div className="min-w-0">
          <p dir="auto" className="truncate text-sm font-medium text-fg">
            {group.name}
          </p>
          <p className="text-xs text-fg-muted">{t('channelCount', { count, formatted: fmt.format(count) })}</p>
        </div>
      </div>
      {channels.data && group.count > MAX_ITEMS ? (
        <p className="mb-3 rounded-md bg-surface-2 px-3 py-2 text-sm text-fg-muted" role="note">
          {t('groupCapped', { max: fmt.format(MAX_ITEMS) })}
        </p>
      ) : null}
      {body}
      <div className={cn('mt-3 border-t border-divider pt-3', !channels.data && 'pointer-events-none opacity-50')}>
        <p className="mb-2 text-xs text-fg-muted">{t('groupNewList')}</p>
        <NewListForm
          lists={lists.data}
          channels={loaded}
          initialName={group.name}
          onCreated={(l) => {
            setDone((m) => new Map(m).set(l.id, loaded.length));
            setAnnounce(t('groupAdded', { count: loaded.length, formatted: fmt.format(loaded.length), list: l.name }));
          }}
        />
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </Dialog>
  );
}
