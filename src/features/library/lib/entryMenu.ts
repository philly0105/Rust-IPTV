/**
 * The light half of a library channel row's menu (library-04): what a page asks for, and the keys
 * and Add to list. The menu itself (EntryChannelMenu, with Live TV's menu code) loads on first use.
 */

import type { Channel, ItemRef, ItemSnapshot } from '@/api/types';
import type { MenuItem } from '@/features/live/components/ContextMenu';
import { openListPicker } from '@/features/lists/store';

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

/** The channel a saved entry stands for, from its snapshot, until the catalog's row is in. */
export function snapshotChannel(ref: ItemRef, snapshot: ItemSnapshot): Channel {
  const channel: Channel = { ref, name: snapshot.title, categoryId: '', categoryName: snapshot.subtitle ?? '', isRadio: ref.contentType === 'radio' };
  if (snapshot.posterUrl) channel.logoUrl = snapshot.posterUrl;
  return channel;
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
