/**
 * Which lists dialog is open. Anything can open one (a menu item, the `l`
 * shortcut, the sidebar, the list page); `ListsDialogHost`, mounted once by
 * the shell, renders it. Kept tiny so the shell's entry chunk only pays for
 * this store and the host; the dialogs themselves load on first open.
 */

import { create } from 'zustand';

import type { Channel } from '@/api/types';

/** A source's group, offered whole to a list (LG-13: the group menu's "Add all to list…"). */
export interface GroupTarget {
  sourceId: string;
  contentType: 'live' | 'radio';
  categoryId: string;
  name: string;
  /** The group's channel count as the sidebar shows it. */
  count: number;
}

export type ListsDialog =
  | { kind: 'picker'; channel: Channel }
  | { kind: 'group'; group: GroupTarget }
  | { kind: 'add'; listId: string }
  | { kind: 'create'; channel?: Channel; openAfter: boolean }
  | { kind: 'manage'; focusId?: string }
  | { kind: 'items'; listId: string; fromManage: boolean };

interface ListsDialogState {
  dialog: ListsDialog | null;
  /** Bumped on every open, so reopening the same dialog remounts it fresh. */
  seq: number;
}

export const useListsDialogs = create<ListsDialogState>(() => ({ dialog: null, seq: 0 }));

const open = (dialog: ListsDialog) => useListsDialogs.setState((s) => ({ dialog, seq: s.seq + 1 }));

/** "Add to list": checkboxes for every list plus an inline "New list". */
export function openListPicker(channel: Channel): void {
  open({ kind: 'picker', channel });
}

/** "Add all to list…": every channel of a group into a list, or a new list named after it. */
export function openAddGroupToList(group: GroupTarget): void {
  open({ kind: 'group', group });
}

/** "Add channels" on a list's page: browse and search sources, adding as you go. */
export function openAddChannels(listId: string): void {
  open({ kind: 'add', listId });
}

/** "New list"; with `channel`, the new list starts with it. `openAfter` navigates to the new list. */
export function openCreateList(opts: { channel?: Channel; openAfter?: boolean } = {}): void {
  open({ kind: 'create', ...(opts.channel ? { channel: opts.channel } : {}), openAfter: opts.openAfter ?? false });
}

/** "Manage lists": rename, reorder, Home rail, delete. `focusId` starts on that list's row. */
export function openManageLists(focusId?: string): void {
  open({ kind: 'manage', ...(focusId ? { focusId } : {}) });
}

/** "Edit channels" of one list: reorder and remove. `fromManage` adds a Back to "Manage lists". */
export function openEditListItems(listId: string, opts: { fromManage?: boolean } = {}): void {
  open({ kind: 'items', listId, fromManage: opts.fromManage ?? false });
}

export function closeListsDialog(): void {
  useListsDialogs.setState({ dialog: null });
}

/**
 * Lists whose delete waits on its Undo toast (see `lib/pendingDeletes`).
 * `useLists` leaves them out of every view. Here rather than there so the
 * entry chunk (Home's rails read `useLists`) only pays for this store.
 */
export const useDeletingLists = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set<string>() }));
