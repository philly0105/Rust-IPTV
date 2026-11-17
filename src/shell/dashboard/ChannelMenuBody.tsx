/**
 * What the dashboard's card menus draw: the channel menu (Live TV's own, `useChannelMenuItems`:
 * Play, Open in TV guide, Favorite, Add to multi-view, Add to list…, the channel edits and the
 * parental lock items, headed by the channel), the plain action menu, and a poster's menu.
 * `ChannelMenuHost` (ChannelCardMenu.tsx) loads this module on its own, so Home's first render does
 * not wait for the multi-view, list, channel-edit, parental, poster and Live menu code it needs only
 * once a menu opens.
 */

import { CalendarClock } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useRpcQuery } from '@/api/query';
import type { Channel, ItemRef } from '@/api/types';
import { toggleFavoriteWithUndo } from '@/features/library/lib/favoriteToggle';
import { ContextMenu, type MenuItem } from '@/features/live/components/ContextMenu';
import { channelMenuHeader, useChannelMenuItems } from '@/features/live/hooks/useChannelMenuItems';
import { useDisplayPrefs } from '@/features/live/hooks/useDisplayPrefs';
import { useParentalStatus } from '@/features/parental/status';
import { useResumeLookup } from '@/features/vod/hooks/queries';
import { usePosterMenu } from '@/features/vod/hooks/usePosterMenu';
import { displayChannelName, plainChannelName } from '@/lib/channelName';

import { useVisibleSources } from '../useVisibleSources';
import { REMOVE_FAVORITE_ID, itemPath, type CardMenuRequest, type ChannelMenuRequest, type PosterMenuRequest } from './cards';

const NO_REF: ItemRef = { sourceId: '', contentType: 'live', itemId: '' };
/** A channel's group rarely changes; the lookup below is kept this long. */
const GROUP_STALE_MS = 5 * 60_000;

/** The guide at a channel's row: its group when the card knows it, else all channels (LG-01's `focus` link). */
function guideAt(channel: Channel): string {
  const q = new URLSearchParams({ source: channel.ref.sourceId });
  if (channel.categoryId) q.set('category', channel.categoryId);
  q.set('focus', channel.ref.itemId);
  return `/epg?${q.toString()}`;
}

/**
 * A poster's menu on Home: the Movies grids' menu (Play or Resume, Open details, My List, Mark as
 * watched), opened for each request and reporting back once it closes (`onClose`).
 */
function PosterMenu({ request, onClose }: { request: PosterMenuRequest | null; onClose: () => void }) {
  const navigate = useNavigate();
  // Read once a poster's menu has opened, so a started movie says Resume.
  const resume = useResumeLookup(request !== null);
  const { open, close, element, isOpen } = usePosterMenu({
    sourceKind: request?.sourceKind,
    resume,
    openDetails: (ref) => void navigate(itemPath(ref)),
  });
  useEffect(() => {
    if (request) open(request.item, 0, request.pos);
    else close();
  }, [request, open, close]);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (isOpen) wasOpen.current = true;
    else if (wasOpen.current) {
      wasOpen.current = false;
      onClose();
    }
  }, [isOpen, onClose]);
  return element;
}

/** The open channel menu, action menu or poster menu (at most one of them), or none while closed. */
export function ChannelMenuBody({
  menu,
  actions,
  poster,
  onClose,
  onPosterClose,
}: {
  menu: ChannelMenuRequest | null;
  actions: CardMenuRequest | null;
  poster: PosterMenuRequest | null;
  onClose: () => void;
  onPosterClose: () => void;
}) {
  const { t } = useTranslation('live');
  const navigate = useNavigate();
  const { stripCountryPrefix } = useDisplayPrefs();
  const sources = useVisibleSources();
  const request = menu?.channel ?? null;
  // Snapshot channels (favourites, recents) carry no category id. With parental controls on, the
  // open menu looks the channel up so its lock items can say 'Locked with its group'; the plain
  // lock shows until the answer comes (cached, so the next open has it at once). Off, no lookup.
  const parental = useParentalStatus();
  const lookUp = !!request && !request.categoryId && parental.data?.enabled === true;
  const row = useRpcQuery('catalog.item', { ref: request?.ref ?? NO_REF }, { enabled: lookUp, staleTime: GROUP_STALE_MS });
  const lookedUp = lookUp ? row.data?.categoryId : undefined;
  const channel = useMemo(() => (request && lookedUp ? { ...request, categoryId: lookedUp } : request), [request, lookedUp]);

  // The Favorite channels rail's own Remove (with its Undo) is the heart's removal there; elsewhere
  // the menu asks whether the channel is a favourite and toggles it as Live TV's menu does.
  const railRemove = menu?.extra?.find((e) => e.id === REMOVE_FAVORITE_ID);
  const contains = useRpcQuery('favorites.contains', { refs: [request?.ref ?? NO_REF] }, { enabled: !!request && !railRemove });
  const favorite = !request ? undefined : railRemove ? true : contains.data ? contains.data.some((r) => r.sourceId === request.ref.sourceId && r.contentType === request.ref.contentType && r.itemId === request.ref.itemId) : undefined;
  const onToggleFavorite = useCallback(
    (c: Channel, wasFavorite: boolean) => {
      if (wasFavorite && railRemove) return railRemove.onSelect();
      void toggleFavoriteWithUndo(c.ref, { title: c.name, subtitle: c.categoryName, posterUrl: c.logoUrl, contentType: c.ref.contentType }, plainChannelName(c.name, stripCountryPrefix), wasFavorite);
    },
    [railRemove, stripCountryPrefix],
  );
  const onPlay = useCallback(() => menu?.onPlay(), [menu]);
  // The rail's other actions (Remove from history, Remove from this list) sit with Organize, as on the Favorites page.
  const organize = useMemo(() => menu?.extra?.filter((e) => e !== railRemove).map((e): MenuItem => ({ id: e.id, label: e.label, icon: e.icon, onSelect: e.onSelect })), [menu, railRemove]);
  // A station has no row in the TV guide.
  const guide = useMemo(
    () => (channel && channel.ref.contentType === 'live' ? { label: t('openGroupInGuide'), icon: <CalendarClock className="size-4" />, onSelect: () => void navigate(guideAt(channel)) } : undefined),
    [channel, t, navigate],
  );
  const items = useChannelMenuItems(channel, {
    source: channel ? sources.data?.find((s) => s.id === channel.ref.sourceId) : undefined,
    favorite,
    onPlay,
    onToggleFavorite,
    organize,
    guide,
  });
  // Named on top, as Live TV's menu is: a phone's sheet covers the card it acts on.
  const name = displayChannelName(channel?.name, stripCountryPrefix);
  const header = channel ? channelMenuHeader(channel, name, menu?.nowTitle || undefined) : actions?.header;

  return (
    <>
      <ContextMenu
        pos={menu?.pos ?? actions?.pos ?? null}
        items={menu ? items : (actions?.items ?? [])}
        // Screen readers hear the cleaned name ("ESPN2 FHD (US)"), as toasts say it (w-a11y-03).
        label={menu ? plainChannelName(channel?.name, stripCountryPrefix) : (actions?.label ?? '')}
        header={header}
        onClose={onClose}
      />
      <PosterMenu request={poster} onClose={onPosterClose} />
    </>
  );
}
