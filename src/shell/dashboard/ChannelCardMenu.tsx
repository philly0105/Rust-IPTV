/**
 * The dashboard's channel card menu (Run 2 C2/C3): right click, the context-menu
 * key or Shift+F10 on a live or radio card opens Play, Add to multi-view (TV
 * only), Add to list…, Rename… / Reset name / Hide channel and the parental
 * lock items, the channel entries of Live's menu. The cards ask for it through
 * `ChannelMenuContext` (cards.tsx), so any rail inside the host gets it by
 * passing `channel` to its ChannelCard.
 */

import { Play } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Channel, ItemRef, ItemSnapshot } from '@/api/types';
import { useChannelEditMenuItems } from '@/features/channeledit';
import { useAddToListMenuItem } from '@/features/lists/hooks/useAddToList';
import { ContextMenu, type MenuItem } from '@/features/live/components/ContextMenu';
import { channelInput } from '@/features/multiview/addChannel';
import { useMultiviewMenuItem } from '@/features/multiview/useMultiviewMenuItem';
import { useLockMenuItems } from '@/features/parental/lockMenu';

import { ChannelMenuContext, type ChannelMenuRequest } from './cards';

/**
 * The channel a favorite or recent entry stands for, from its saved snapshot:
 * enough for the menu (the ref, the name, the logo, the group name the list
 * picker shows). Category ids are not saved, so multi-view groups it with none.
 */
export function snapshotChannel(ref: ItemRef, snapshot: ItemSnapshot): Channel {
  const channel: Channel = {
    ref,
    name: snapshot.title,
    categoryId: '',
    categoryName: snapshot.subtitle ?? '',
    isRadio: ref.contentType === 'radio',
  };
  if (snapshot.posterUrl) channel.logoUrl = snapshot.posterUrl;
  return channel;
}

/** Provides the channel card menu to the cards below it and draws it. Mount once around the rails. */
export function ChannelMenuHost({ children }: { children: ReactNode }) {
  const { t } = useTranslation('shell');
  const [menu, setMenu] = useState<ChannelMenuRequest | null>(null);
  const close = useCallback(() => setMenu(null), []);

  const channel = menu?.channel ?? null;
  // C4: radio has no picture, so a station gets no multi-view entry.
  const multiviewItem = useMultiviewMenuItem(channel && channel.ref.contentType === 'live' ? channelInput(channel) : null);
  const addToListItem = useAddToListMenuItem(channel);
  const editItems = useChannelEditMenuItems(channel);
  const lockItems = useLockMenuItems(
    channel
      ? { sourceId: channel.ref.sourceId, contentType: channel.ref.contentType, kind: 'item', targetId: channel.ref.itemId, name: channel.name }
      : null,
    // Empty for snapshot channels (snapshots save no category id): the menu then offers the plain lock.
    { categoryId: channel?.categoryId },
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
    <ChannelMenuContext.Provider value={setMenu}>
      {children}
      <ContextMenu pos={menu?.pos ?? null} items={items} label={menu?.channel.name ?? ''} onClose={close} />
    </ChannelMenuContext.Provider>
  );
}
