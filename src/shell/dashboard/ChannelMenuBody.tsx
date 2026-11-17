/**
 * What the dashboard's card menus draw: the channel menu's items (Play, Add to multi-view, Add to
 * list…, the channel edits and the parental lock items), the menu itself, and a poster's menu.
 * `ChannelMenuHost` (ChannelCardMenu.tsx) loads this module on its own, so Home's first render does
 * not wait for the multi-view, list, channel-edit, parental, poster and Live menu code it needs only
 * once a menu opens.
 */

import { Play } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useRpcQuery } from '@/api/query';
import type { ItemRef } from '@/api/types';
import { useChannelEditMenuItems } from '@/features/channeledit';
import { useAddToListMenuItem } from '@/features/lists/hooks/useAddToList';
import { ContextMenu, type MenuEntry } from '@/features/live/components/ContextMenu';
import { channelInput } from '@/features/multiview/addChannel';
import { useMultiviewMenuItem } from '@/features/multiview/useMultiviewMenuItem';
import { useLockMenuItems } from '@/features/parental/lockMenu';
import { useParentalStatus } from '@/features/parental/status';
import { useResumeLookup } from '@/features/vod/hooks/queries';
import { usePosterMenu } from '@/features/vod/hooks/usePosterMenu';

import { itemPath, type CardMenuRequest, type ChannelMenuRequest, type PosterMenuRequest } from './cards';

const NO_REF: ItemRef = { sourceId: '', contentType: 'live', itemId: '' };
/** A channel's group rarely changes; the lookup below is kept this long. */
const GROUP_STALE_MS = 5 * 60_000;

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
  const { t } = useTranslation('shell');
  const channel = menu?.channel ?? null;
  // C4: radio has no picture, so a station gets no multi-view entry.
  const multiviewItem = useMultiviewMenuItem(channel && channel.ref.contentType === 'live' ? channelInput(channel) : null);
  const addToListItem = useAddToListMenuItem(channel);
  const editItems = useChannelEditMenuItems(channel);
  // Snapshot channels (favourites, recents) carry no category id. With parental controls on, the
  // open menu looks the channel up so its lock items can say 'Locked with its group'; the plain
  // lock shows until the answer comes (cached, so the next open has it at once). Off, no lookup.
  const parental = useParentalStatus();
  const lookUp = !!channel && !channel.categoryId && parental.data?.enabled === true;
  const row = useRpcQuery('catalog.item', { ref: channel?.ref ?? NO_REF }, { enabled: lookUp, staleTime: GROUP_STALE_MS });
  const categoryId = channel?.categoryId || (lookUp ? row.data?.categoryId : undefined) || undefined;
  const lockItems = useLockMenuItems(
    channel
      ? { sourceId: channel.ref.sourceId, contentType: channel.ref.contentType, kind: 'item', targetId: channel.ref.itemId, name: channel.name }
      : null,
    { categoryId },
  );

  const items = useMemo((): MenuEntry[] => {
    if (!menu) return [];
    return [
      { id: 'play', label: t('play'), icon: <Play className="size-4" />, onSelect: menu.onPlay },
      ...(menu.channel.ref.contentType === 'live' ? [multiviewItem] : []),
      ...(addToListItem ? [addToListItem] : []),
      ...editItems,
      ...lockItems,
      ...(menu.extra?.length ? [{ id: 'rail-sep', type: 'separator' as const }, ...menu.extra] : []),
    ];
  }, [menu, t, multiviewItem, addToListItem, editItems, lockItems]);

  return (
    <>
      <ContextMenu
        pos={menu?.pos ?? actions?.pos ?? null}
        items={menu ? items : (actions?.items ?? [])}
        label={menu?.channel.name ?? actions?.label ?? ''}
        header={menu ? undefined : actions?.header}
        onClose={onClose}
      />
      <PosterMenu request={poster} onClose={onPosterClose} />
    </>
  );
}
