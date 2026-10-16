/**
 * Channel edits UI (C2): rename and hide live channels and radio stations.
 *
 * - `useChannelEditMenuItems(channel)`: Rename..., Reset name (only when
 *   renamed) and Hide channel (toast with Undo) for any channel menu.
 * - `ChannelEditDialogHost`: the rename dialog; mount once in the shell.
 * - `HiddenChannelsDialog`: one source's hidden channels, with search,
 *   Unhide and Unhide all.
 * - `useHiddenChannelCount(sourceId)`: for a "Hidden channels (n)" entry.
 * - `useChannelEditShortcuts(focused)`: F2 renames, Shift+Delete hides the
 *   focused row; mount in the Live page. Overlay entries:
 *   `{ combo: 'f2', descKey: 'channels:shortcutRename', area: 'Live' }` and
 *   `{ combo: 'shift+delete', descKey: 'channels:shortcutHide', area: 'Live' }`.
 *
 * The dialogs download on first use, so the entry chunk only carries the
 * hooks, the host and the store. `preloadChannelEditDialogs()` fetches them
 * ahead of time (the Live page does at idle), so the first F2 opens at once.
 */

export { ChannelEditDialogHost } from './DialogHost';
export { HiddenChannelsDialog } from './HiddenChannelsDialog';
export { preloadChannelEditDialogs } from './preload';
export type { HiddenChannelsDialogProps } from './HiddenChannelsDialog';
export { useHiddenChannelCount } from './edits';
export { HIDE_COMBO, RENAME_COMBO, useChannelEditMenuItems } from './menu';
export { NAME_MAX, planRename } from './name';
export type { RenamePlan } from './name';
export { useChannelEditShortcuts } from './shortcuts';
export { openRenameDialog } from './store';
