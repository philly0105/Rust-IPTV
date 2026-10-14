/**
 * The rename dialog's request, shared by every menu and shortcut that opens
 * it and the one {@link ChannelEditDialogHost} that shows it. Kept tiny: the
 * host lives in the shell's entry chunk and the dialog itself loads lazily.
 */

import { create } from 'zustand';

import type { Channel } from '@/api/types';

export interface RenameRequest {
  /** Bumps per request, so reopening for the same channel starts fresh. */
  id: number;
  channel: Channel;
}

export const useRenameStore = create<{ request: RenameRequest | null }>(() => ({ request: null }));

let nextId = 1;
let hosts = 0;

/** Called by the host while mounted. Returns the unregister function. */
export function registerRenameHost(): () => void {
  hosts += 1;
  return () => {
    hosts -= 1;
    if (hosts === 0) useRenameStore.setState({ request: null });
  };
}

/** Opens the rename dialog for `channel`. False (and nothing shown) when no host is mounted. */
export function openRenameDialog(channel: Channel): boolean {
  if (hosts === 0) {
    console.warn('[channeledit] ChannelEditDialogHost is not mounted; cannot rename');
    return false;
  }
  useRenameStore.setState({ request: { id: nextId++, channel } });
  return true;
}

export function closeRenameDialog(): void {
  useRenameStore.setState({ request: null });
}
