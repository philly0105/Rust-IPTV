/**
 * What the dashboard's card menus draw: the channel menu's items (Play, Add to multi-view, Add to
 * list…, the channel edits and the parental lock items) and the menu itself. `ChannelMenuHost`
 * (ChannelCardMenu.tsx) loads this module on its own, so Home's first render does not wait for
 * the multi-view, list, channel-edit, parental and Live menu code it needs only once a menu opens.
 */

import { Play } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import type { ItemRef } from '@/api/types';
import { useChannelEditMenuItems } from '@/features/channeledit';
import { useAddToListMenuItem } from '@/features/lists/hooks/useAddToList';
import { ContextMenu, type MenuItem } from '@/features/live/components/ContextMenu';
import { channelInput } from '@/features/multiview/addChannel';
import { useMultiviewMenuItem } from '@/features/multiview/useMultiviewMenuItem';
import { useLockMenuItems } from '@/features/parental/lockMenu';
import { useParentalStatus } from '@/features/parental/status';

import type { CardMenuRequest, ChannelMenuRequest } from './cards';

const NO_REF: ItemRef = { sourceId: '', contentType: 'live', itemId: '' };
/** A channel's group rarely changes; the lookup below is kept this long. */
const GROUP_STALE_MS = 5 * 60_000;

/** The open channel menu or action menu (at most one of the two), or neither while closed. */
export function ChannelMenuBody({ menu, actions, onClose }: { menu: ChannelMenuRequest | null; actions: CardMenuRequest | null; onClose: () => void }) {
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

  const items = useMemo((): MenuItem[] => {
    if (!menu) return [];
    return [
      { id: 'play', label: t('play'), icon: <Play className="size-4" />, onSelect: menu.onPlay },
      ...(menu.channel.ref.contentType === 'live' ? [multiviewItem] : []),
      ...(addToListItem ? [addToListItem] : []),
      ...editItems,
      ...lockItems,
    ];
  }, [menu, t, multiviewItem, addToListItem, editItems, lockItems]);

  return (
    <ContextMenu
      pos={menu?.pos ?? actions?.pos ?? null}
      items={menu ? items : (actions?.items ?? [])}
      label={menu?.channel.name ?? actions?.label ?? ''}
      onClose={onClose}
    />
  );
}
