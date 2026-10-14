/**
 * Deleting a list waits for its Undo toast. The list leaves every view at
 * once (`useLists` filters it out), but `lists.remove` only goes to the core
 * once the toast is gone: timed out, dismissed, or settled early because a
 * new name or the 50-list limit needs its place. Undo just drops the pending
 * delete, so the list comes back exactly as it was: same id, every channel
 * (also the hidden and parentally hidden ones that `lists.items` never
 * returns, so no client-side copy could restore them), Home rail and place.
 *
 * Closing the page (`pagehide`) or quitting the desktop app (`QUIT_FLUSH_EVENT`,
 * whose quit waits for the call) with a delete still pending sends it right
 * away; if that request never lands the list simply survives, which loses nothing.
 */

import { RpcError } from '@/api/transport';
import type { CustomList } from '@/api/types';
import { QUIT_FLUSH_EVENT, type QuitFlushDetail } from '@/api/window';
import { useToastStore, type ToastOptions } from '@/ui';

import { useDeletingLists } from '../store';
import { patchLists, refreshLists } from './cache';

interface PendingDelete {
  list: CustomList;
  toastId: string;
  /** Sends the delete now (once); resolves when the core has answered. */
  settle(): Promise<void>;
  /** Forgets the delete without sending it (Undo, test reset). */
  drop(): void;
}

const pending = new Map<string, PendingDelete>();

function publish(): void {
  useDeletingLists.setState({ ids: new Set(pending.keys()) });
}

export function isDeletePending(id: string): boolean {
  return pending.has(id);
}

export interface DeleteLaterOptions {
  /** Shows the "Deleted" toast with the given Undo action; returns its id. */
  showToast(action: NonNullable<ToastOptions['action']>): string;
  undoLabel: string;
  /** The core call. A list that is already gone counts as deleted. */
  remove(): Promise<void>;
  /** The core refused: the list is back in view; tell the user. */
  onFailed(err: unknown): void;
}

/** Hides `list` now and deletes it once its Undo toast goes away. No-op while one is pending for it. */
export function deleteLater(list: CustomList, opts: DeleteLaterOptions): void {
  if (pending.has(list.id)) return;
  let done = false;
  let unsubscribe = () => {};
  let settled: Promise<void> | undefined;

  const send = async () => {
    try {
      await opts.remove();
      // Gone from the cache before it leaves the pending set, so it never flashes back.
      patchLists((ls) => ls.filter((l) => l.id !== list.id));
    } catch (err) {
      if (RpcError.from(err).code !== 'not_found') opts.onFailed(err);
    } finally {
      pending.delete(list.id);
      publish();
      void refreshLists();
    }
  };

  const entry: PendingDelete = {
    list,
    toastId: '',
    settle: () => {
      if (!settled) {
        done = true;
        unsubscribe();
        settled = send();
      }
      return settled;
    },
    drop: () => {
      if (done) return;
      done = true;
      unsubscribe();
      pending.delete(list.id);
      publish();
    },
  };
  pending.set(list.id, entry);
  publish();

  entry.toastId = opts.showToast({
    label: opts.undoLabel,
    onClick: () => {
      entry.drop();
      void refreshLists();
    },
  });
  // However the toast leaves (time-out, its close button, Escape), the delete goes through.
  unsubscribe = useToastStore.subscribe((s) => {
    if (!s.toasts.some((t) => t.id === entry.toastId)) void entry.settle();
  });
  if (!useToastStore.getState().toasts.some((t) => t.id === entry.toastId)) void entry.settle();
}

/**
 * Sends the pending deletes that `match` picks right away (their Undo toasts
 * close) and waits for the core, e.g. before creating a list whose name a
 * pending one still holds.
 */
export async function settleDeletes(match: (list: CustomList) => boolean = () => true): Promise<void> {
  const due = [...pending.values()].filter((p) => match(p.list));
  await Promise.all(
    due.map((p) => {
      const done = p.settle();
      useToastStore.getState().dismiss(p.toastId);
      return done;
    }),
  );
}

/**
 * `next` (the visible lists in a new order) with the pending ones put back
 * at their places in `all`, so a reorder still names every list the core has.
 */
export function withPendingLists(next: readonly CustomList[], all: readonly CustomList[] | undefined): CustomList[] {
  const out = next.filter((l) => !pending.has(l.id));
  (all ?? []).forEach((l, i) => {
    if (pending.has(l.id)) out.splice(Math.min(i, out.length), 0, l);
  });
  return out;
}

/** Tests: forget every pending delete without sending it. */
export function resetPendingDeletes(): void {
  for (const p of [...pending.values()]) p.drop();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void settleDeletes());
  // The desktop app's quit (tray Quit, the window's X, Alt+F4) fires no pagehide; it waits for
  // the work handed to `waitUntil` (up to `QUIT_FLUSH_BUDGET_MS`) before it exits.
  window.addEventListener(QUIT_FLUSH_EVENT, (e) => {
    if (pending.size === 0) return;
    const work = settleDeletes();
    (e as CustomEvent<QuitFlushDetail>).detail?.waitUntil(work);
  });
}
