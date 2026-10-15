/**
 * "Add to list": one check box per list (checked where the channel already
 * is), applied at once, plus an inline "New list" that starts with the
 * channel. Lists at the 2000-channel limit cannot take one more.
 */

import { Check } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel, CustomList } from '@/api/types';

import { Button, ChannelLogo, Dialog, ErrorState, Skeleton, cn, displayChannelName, useDisplayPrefs } from '../deps';
import { NewListForm } from '../components/NewListForm';
import { useListActions } from '../hooks/useListActions';
import { useLists, useListsContaining } from '../hooks/useLists';
import { MAX_ITEMS } from '../lib/cache';

export function PickerDialog({ channel, onClose }: { channel: Channel; onClose(): void }) {
  const { t, i18n } = useTranslation('lists');
  const prefs = useDisplayPrefs();
  const name = displayChannelName(channel.name, prefs.stripCountryPrefix);
  const lists = useLists();
  const containing = useListsContaining(channel.ref);
  const actions = useListActions();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [announce, setAnnounce] = useState('');
  const fmt = new Intl.NumberFormat(i18n.language);

  const member = new Set(containing.data ?? []);
  const ready = lists.isSuccess && containing.isSuccess;
  const error = lists.error ?? containing.error;

  const toggle = async (list: CustomList, next: boolean) => {
    if (pending.has(list.id)) return;
    setPending((p) => new Set(p).add(list.id));
    const ok = await actions.setMember(list, channel, next);
    setPending((p) => {
      const out = new Set(p);
      out.delete(list.id);
      return out;
    });
    if (ok) setAnnounce(next ? t('addedTo', { list: list.name }) : t('removedFromList', { list: list.name }));
  };

  let body;
  if (error) {
    body = (
      <ErrorState
        size="inline"
        error={error}
        title={t('loadFailed')}
        onRetry={() => {
          void lists.refetch();
          void containing.refetch();
        }}
      />
    );
  } else if (!ready) {
    body = (
      <div className="flex flex-col gap-2 py-1" role="status" aria-busy="true" aria-label={t('loading')}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full rounded-md" />
        ))}
      </div>
    );
  } else if (lists.data.length === 0) {
    body = <p className="py-2 text-sm text-fg-muted">{t('pickerEmpty')}</p>;
  } else {
    body = (
      <ul className="-mx-2 flex max-h-[min(50vh,360px)] flex-col overflow-y-auto" aria-label={t('title')} data-testid="list-picker-options">
        {lists.data.map((list) => {
          const checked = member.has(list.id);
          const full = !checked && list.itemCount >= MAX_ITEMS;
          const busy = pending.has(list.id);
          return (
            <li key={list.id}>
              <label
                className={cn(
                  'flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
                  (full || busy) && 'cursor-default',
                  full && 'opacity-60',
                )}
              >
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={checked}
                  disabled={full}
                  aria-busy={busy || undefined}
                  aria-describedby={full ? `full-${list.id}` : undefined}
                  onChange={(e) => void toggle(list, e.target.checked)}
                />
                <span
                  aria-hidden
                  className={cn(
                    'inline-flex size-5 shrink-0 items-center justify-center rounded border motion-safe:transition-colors',
                    checked ? 'border-accent bg-accent text-accent-fg' : 'border-fg-subtle bg-surface',
                    busy && 'motion-safe:animate-pulse',
                  )}
                >
                  {checked ? <Check className="size-3.5" strokeWidth={3} /> : null}
                </span>
                <span dir="auto" className="min-w-0 flex-1 truncate text-sm text-fg">
                  {list.name}
                </span>
                <span id={`full-${list.id}`} className="shrink-0 text-xs tabular-nums text-fg-subtle">
                  {full ? t('listFull') : fmt.format(list.itemCount)}
                </span>
              </label>
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
      title={t('addToListTitle')}
      size="sm"
      testId="list-picker"
      footer={
        <Button variant="primary" size="sm" onClick={onClose}>
          {t('done')}
        </Button>
      }
    >
      <div className="mb-3 flex items-center gap-3 rounded-md border border-divider bg-surface-2 p-2">
        <ChannelLogo src={channel.logoUrl} name={name} size={36} sourceId={channel.ref.sourceId} />
        <div className="min-w-0">
          <p dir="auto" className="truncate text-sm font-medium text-fg">
            {name}
          </p>
          {channel.categoryName ? (
            <p dir="auto" className="truncate text-xs text-fg-muted">
              {channel.categoryName}
            </p>
          ) : null}
        </div>
      </div>
      {body}
      <div className="mt-3 border-t border-divider pt-3">
        <NewListForm lists={lists.data} channel={channel} autoFocus={ready && lists.data.length === 0} onCreated={(l) => setAnnounce(t('addedTo', { list: l.name }))} />
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </Dialog>
  );
}
