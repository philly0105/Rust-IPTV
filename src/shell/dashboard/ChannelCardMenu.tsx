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

import { useRpcQuery } from '@/api/query';
import type { Channel, ItemRef, ItemSnapshot } from '@/api/types';
import { useChannelEditMenuItems } from '@/features/channeledit';
import { useAddToListMenuItem } from '@/features/lists/hooks/useAddToList';
import { ContextMenu, type MenuItem } from '@/features/live/components/ContextMenu';
import { channelInput } from '@/features/multiview/addChannel';
import { useMultiviewMenuItem } from '@/features/multiview/useMultiviewMenuItem';
import { useLockMenuItems } from '@/features/parental/lockMenu';
import { useParentalStatus } from '@/features/parental/status';

import { CardMenuContext, ChannelMenuContext, type CardMenuRequest, type ChannelMenuRequest } from './cards';

/**
 * The channel a favorite or recent entry stands for, from its saved snapshot:
 * enough for the menu (the ref, the name, the logo, the group name the list
 * picker shows). Category ids are not saved, so multi-view groups it with none;
 * the menu looks the id up for its parental lock items (ChannelMenuHost).
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

const NO_REF: ItemRef = { sourceId: '', contentType: 'live', itemId: '' };
/** A channel's group rarely changes; the lookup below is kept this long. */
const GROUP_STALE_MS = 5 * 60_000;

/**
 * Provides the card menus to the cards below it and draws them: the channel menu, and the plain
 * action menu of a Continue watching card (CardMenuContext). One menu shows at a time. Mount once
 * around the rails.
 */
export function ChannelMenuHost({ children }: { children: ReactNode }) {
  const { t } = useTranslation('shell');
  const [menu, setMenuState] = useState<ChannelMenuRequest | null>(null);
  const [actions, setActions] = useState<CardMenuRequest | null>(null);
  const setMenu = useCallback((request: ChannelMenuRequest) => {
    setActions(null);
    setMenuState(request);
  }, []);
  const openActions = useCallback((request: CardMenuRequest) => {
    setMenuState(null);
    setActions(request);
  }, []);
  const close = useCallback(() => {
    setMenuState(null);
    setActions(null);
  }, []);

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
    <ChannelMenuContext.Provider value={setMenu}>
      <CardMenuContext.Provider value={openActions}>
        {children}
        <ContextMenu
          pos={menu?.pos ?? actions?.pos ?? null}
          items={menu ? items : (actions?.items ?? [])}
          label={menu?.channel.name ?? actions?.label ?? ''}
          onClose={close}
        />
      </CardMenuContext.Provider>
    </ChannelMenuContext.Provider>
  );
}
