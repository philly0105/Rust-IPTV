/**
 * The channel menu of a live or radio row on Favorites and Recently watched (library-04): Live TV's
 * own menu (`useChannelMenuItems`: Play, catch-up, Favorite, Add to multi-view, Add to list…, the
 * channel edits and the parental lock; matching a guide channel stays on Live TV), with the page's own entries among
 * Organize (Favorites' moves, Recently watched's Remove from history). A channel used to get a
 * three-item menu here, so a favourite could not go to a channel list or to multi-view.
 *
 * It opens at once from the row's saved snapshot; the catalog's row (`catalog.item`, cached and
 * shared with the player) fills in catch-up and the group when it arrives.
 */

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import type { Channel, ItemRef, ItemSnapshot, Source } from '@/api/types';
import { ContextMenu, type MenuItem } from '@/features/live/components/ContextMenu';
import { channelMenuHeader, useChannelMenuItems } from '@/features/live/hooks/useChannelMenuItems';
import { useDisplayPrefs } from '@/features/live/hooks/useDisplayPrefs';
import { displayChannelName } from '@/features/live/lib/channelName';
import { openListPicker } from '@/features/lists/store';

import { errorDescription, useToast } from '../deps';

export interface EntryMenuRequest {
  pos: { x: number; y: number };
  ref: ItemRef;
  snapshot: ItemSnapshot;
  /** What is on now, for the phone sheet's header. */
  nowTitle?: string | undefined;
  onPlay(): void;
  /** The page's own entries, at the end of Organize. */
  organize: MenuItem[];
  /**
   * Favorites passes its own remove (with Undo, back in its place) for the menu's favourite toggle,
   * and knows the answer; elsewhere the menu asks and toggles as Live TV does.
   */
  removeFavorite?: () => void;
}

const NO_REF: ItemRef = { sourceId: '', contentType: 'live', itemId: '' };
/** A channel's catch-up and group rarely change; the lookup is kept this long. */
const ITEM_STALE_MS = 5 * 60_000;

/** The channel a saved entry stands for, from its snapshot, until the catalog's row is in. */
function snapshotChannel(ref: ItemRef, snapshot: ItemSnapshot): Channel {
  const channel: Channel = { ref, name: snapshot.title, categoryId: '', categoryName: snapshot.subtitle ?? '', isRadio: ref.contentType === 'radio' };
  if (snapshot.posterUrl) channel.logoUrl = snapshot.posterUrl;
  return channel;
}

export function EntryChannelMenu({ request, sources, onClose }: { request: EntryMenuRequest | null; sources: ReadonlyMap<string, Source>; onClose(): void }) {
  const { t: tl } = useTranslation('live');
  const { toast } = useToast();
  const { stripCountryPrefix } = useDisplayPrefs();
  const ref = request?.ref ?? NO_REF;
  const item = useRpcQuery('catalog.item', { ref }, { enabled: !!request, staleTime: ITEM_STALE_MS });
  const asks = !!request && !request.removeFavorite;
  const contains = useRpcQuery('favorites.contains', { refs: [ref] }, { enabled: asks });
  const channel = useMemo((): Channel | null => {
    if (!request) return null;
    const row = item.data;
    return row && 'categoryName' in row ? (row as Channel) : snapshotChannel(request.ref, request.snapshot);
  }, [request, item.data]);
  const favorite = !request ? undefined : request.removeFavorite ? true : contains.data?.some((r) => r.itemId === ref.itemId && r.sourceId === ref.sourceId && r.contentType === ref.contentType);

  const onToggleFavorite = useCallback(
    (c: Channel, wasFavorite: boolean) => {
      if (wasFavorite && request?.removeFavorite) {
        request.removeFavorite();
        return;
      }
      const name = displayChannelName(c.name, stripCountryPrefix);
      void rpc('favorites.toggle', { ref: c.ref, snapshot: { title: c.name, subtitle: c.categoryName, posterUrl: c.logoUrl, contentType: c.ref.contentType } })
        .then((res) => toast({ title: res.isFavorite ? tl('favoriteAdded', { name }) : tl('favoriteRemoved', { name }), variant: 'success' }))
        .catch((err: unknown) =>
          toast({ title: wasFavorite ? tl('favoriteRemoveFailed') : tl('favoriteAddFailed'), description: errorDescription(err), variant: 'error' }),
        )
        .finally(() => void invalidate('favorites.'));
    },
    [request, stripCountryPrefix, tl, toast],
  );
  const onPlay = useCallback(() => request?.onPlay(), [request]);

  const items = useChannelMenuItems(channel, {
    source: channel ? sources.get(channel.ref.sourceId) : undefined,
    favorite,
    onPlay,
    onToggleFavorite,
    organize: request?.organize,
  });
  const header = channel ? channelMenuHeader(channel, displayChannelName(channel.name, stripCountryPrefix), request?.nowTitle) : undefined;

  return <ContextMenu pos={request?.pos ?? null} items={items} header={header} label={displayChannelName(channel?.name, stripCountryPrefix)} onClose={onClose} />;
}

/** The keys that open a focused row's menu: the context-menu key and Shift+F10. */
export function isMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}

/** L on a focused channel row: the list picker, as on Live TV's rows. */
export function isAddToListKey(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === 'l' || e.code === 'KeyL');
}

export function addEntryToList(ref: ItemRef, snapshot: ItemSnapshot): void {
  openListPicker(snapshotChannel(ref, snapshot));
}
