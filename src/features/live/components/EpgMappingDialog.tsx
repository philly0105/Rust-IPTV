import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import type { Channel } from '@/api/types';

import { Button, Dialog, ErrorState, Skeleton, useToast, errorDescription } from '@/ui';
import { joinList } from '@/shell/dashboard/cards';
import { useDebounced } from '../hooks/useDebounced';
import { useDisplayPrefs } from '../hooks/useDisplayPrefs';
import { displayChannelName } from '../lib/channelName';
import { ChannelLogo } from './ChannelLogo';

/** Strips quality and country decorations so the first search is useful. */
export function mappingQuery(name: string): string {
  return name
    .replace(/^[A-Z]{2,3}\s*[:|-]\s*/, '')
    .replace(/\b(FHD|UHD|HD|SD|4K|HEVC|H265)\b/gi, '')
    .replace(/[[(].*?[\])]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function EpgMappingDialog({ channel, onClose }: { channel: Channel | null; onClose(): void }) {
  const { t, i18n } = useTranslation('live');
  const { toast } = useToast();
  const prefs = useDisplayPrefs();
  const open = !!channel;
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query.trim(), 250);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (channel) setQuery(mappingQuery(channel.name));
  }, [channel]);

  const resolution = useRpcQuery('epg.resolve', { ref: channel?.ref ?? { sourceId: '', contentType: 'live', itemId: '' } }, { enabled: open });
  const results = useRpcQuery('epg.channelsSearch', { query: debounced, limit: 50 }, { enabled: open && debounced.length > 0 });

  const apply = async (fn: () => Promise<unknown>, title: string) => {
    setBusy(true);
    try {
      await fn();
      await invalidate('epg.');
      toast({ title, variant: 'success' });
      onClose();
    } catch (err) {
      toast({ title: t('mappingFailed'), description: errorDescription(err), variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const current = resolution.data;
  const viaLabel = current
    ? {
        manual: t('mappingViaManual'),
        item: t('mappingViaItem'),
        name: t('mappingViaName'),
        none: t('mappingViaNone'),
      }[current.via]
    : '';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('epgMappingTitle', { name: displayChannelName(channel?.name, prefs.stripCountryPrefix) })}
      size="md"
      footer={
        <>
          <Button
            variant="ghost"
            disabled={busy || !channel}
            onClick={() => channel && void apply(() => rpc('epg.clearMapping', { ref: channel.ref }), t('mappingReset'))}
          >
            {t('mappingAutomatic')}
          </Button>
          <Button
            variant="ghost"
            disabled={busy || !channel}
            onClick={() => channel && void apply(() => rpc('epg.setMapping', { ref: channel.ref, epgChannelId: null }), t('mappingCleared'))}
          >
            {t('mappingNone')}
          </Button>
          <Button onClick={onClose}>{t('cancel')}</Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-fg-muted">
        {current ? (current.epgChannelId ? t('mappingCurrent', { id: current.epgChannelId, via: viaLabel }) : viaLabel) : ' '}
      </p>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('mappingSearch')}
        aria-label={t('mappingSearch')}
        className="mb-3 h-9 w-full rounded-md border border-border bg-surface-2 px-3 text-sm text-fg outline-none placeholder:text-fg-subtle focus:ring-2 focus:ring-accent"
      />
      {results.error ? (
        <ErrorState error={results.error} onRetry={() => void results.refetch()} />
      ) : debounced && results.isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : results.data && results.data.length === 0 ? (
        <p className="py-6 text-center text-sm text-fg-muted">{t('mappingNoResults', { query: debounced })}</p>
      ) : (
        <ul className="flex max-h-[min(320px,45vh)] flex-col overflow-y-auto" aria-label={t('mappingResults')}>
          {(results.data ?? []).map((m) => {
            const selected = current?.epgChannelId === m.channelId;
            return (
              <li key={`${m.epgUrl}|${m.channelId}`}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    channel &&
                    void apply(() => rpc('epg.setMapping', { ref: channel.ref, epgChannelId: m.channelId }), t('mappingSaved', { name: m.displayName }))
                  }
                  className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-start hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  <ChannelLogo src={m.icon} name={m.displayName} size={28} sourceId={channel?.ref.sourceId} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-fg">{m.displayName}</span>
                    <span className="truncate text-xs text-fg-subtle">{joinList([m.channelId, hostOf(m.epgUrl)], i18n.language)}</span>
                  </span>
                  {selected ? <Check className="size-4 text-accent" aria-label={t('mappingSelected')} /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
