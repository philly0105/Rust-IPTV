/**
 * Home rails for custom lists: one rail per list switched to "Show on Home",
 * in the lists' order, with the channels' now-playing programme. Playing a
 * card zaps within that list. Loaded lazily by `CustomListRails` (rails.tsx).
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { itemKey, type Channel, type CustomList } from '@/api/types';

import { ChannelCard, DashboardRail, displayChannelName, toast, useDisplayPrefs, usePendingRemovals, useVisibleSources } from '../deps';
import { useListItems } from '../hooks/useLists';
import { playFromList } from '../lib/play';
import { listPath } from '../paths';

/** Cards per rail; "See all" opens the list. */
export const LIST_RAIL_LIMIT = 24;

function progress(start?: string, end?: string, offsetMinutes = 0): number | undefined {
  if (!start || !end) return undefined;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return undefined;
  return Math.max(0, Math.min(1, (Date.now() - offsetMinutes * 60_000 - s) / (e - s)));
}

function ListRail({ list, sourceName }: { list: CustomList; sourceName: Map<string, string> }) {
  const { t, i18n } = useTranslation('lists');
  const { t: tl } = useTranslation('live');
  const { t: ts } = useTranslation('shell');
  const prefs = useDisplayPrefs();
  const items = useListItems(list.id);
  // Channels of a source in its delete-undo window are already gone, as on the other Home rails.
  const removingSources = usePendingRemovals((s) => s.ids);
  const entries = useMemo(
    () => (removingSources.size === 0 ? items.data : items.data?.filter((e) => !removingSources.has(e.ref.sourceId))),
    [items.data, removingSources],
  );
  const channels = useMemo(
    () => (entries ?? []).flatMap((e) => (e.available && e.channel ? [e.channel] : [])).slice(0, LIST_RAIL_LIMIT),
    [entries],
  );
  const itemCount = list.itemCount - ((items.data?.length ?? 0) - (entries?.length ?? 0));
  const refs = useMemo(() => channels.map((c) => c.ref), [channels]);
  const offset = prefs.epgOffsetMinutes;
  const nowNext = useRpcQuery('epg.nowNext', offset ? { refs, offsetMinutes: offset } : { refs }, { enabled: refs.length > 0, staleTime: 60_000 });
  const fmt = new Intl.NumberFormat(i18n.language);

  return (
    <DashboardRail<Channel>
      id={`list-${list.id}`}
      title={list.name}
      items={items.data ? channels : undefined}
      loading={items.isPending}
      loaded={items.isSuccess}
      error={items.error ?? undefined}
      errorHint={t('localDataHint')}
      onRetry={() => void items.refetch()}
      seeAll={{ to: listPath(list.id) }}
      meta={<span className="text-xs tabular-nums text-fg-subtle">{t('channelCount', { count: itemCount, formatted: fmt.format(itemCount) })}</span>}
      getKey={(c) => itemKey(c.ref)}
      cardWidth={232}
      skeletonAspect={16 / 9}
      renderCard={(c, rail) => {
        const nn = nowNext.data?.[itemKey(c.ref)];
        const name = displayChannelName(c.name, prefs.stripCountryPrefix);
        return (
          <ChannelCard
            rail={rail}
            name={name}
            logoUrl={c.logoUrl}
            now={nn?.now?.title}
            nowProgress={progress(nn?.now?.start, nn?.now?.end, offset)}
            sourceName={sourceName.get(c.ref.sourceId)}
            isRadio={c.ref.contentType === 'radio'}
            ariaLabel={ts('playTitle', { title: name })}
            // Right click, the context-menu key and Shift+F10: Home's channel menu (its Play plays from the list too).
            channel={c}
            onPlay={() =>
              void playFromList(c, list.id, nn?.now?.title, name).catch((err: unknown) =>
                toast({ title: tl('playFailed', { name }), description: err instanceof Error ? err.message : undefined, variant: 'error' }),
              )
            }
          />
        );
      }}
    />
  );
}

/** The rails of `lists` (those with Show on Home), loaded lazily by `CustomListRails`. */
export function ListRails({ lists }: { lists: readonly CustomList[] }) {
  const sources = useVisibleSources();
  const sourceName = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s.name])), [sources.data]);
  return (
    <>
      {lists.map((l) => (
        <ListRail key={l.id} list={l} sourceName={sourceName} />
      ))}
    </>
  );
}
