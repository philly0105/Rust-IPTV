/**
 * Undoable source removal (C9). Removing a source hides it at once and shows a
 * toast with Undo. `sources.remove` is sent when the undo window (UNDO_MS, its
 * own timer) passes without Undo, or right away on `pagehide` or a tray Quit
 * (`QUIT_FLUSH_EVENT`, where no pagehide fires), so closing or reloading the
 * app never strands a hidden source. The toast's life does not
 * decide: the toast stack evicts old toasts when many arrive at once, and
 * hover or focus can pause a toast indefinitely.
 *
 * State lives at module level, not in the Sources page: the removal still
 * commits when the user navigates away before the toast closes.
 */

import { create } from 'zustand';

import { QUIT_FLUSH_EVENT } from '@/api/window';
import { dismissToast, toast, type ToastOptions } from '@/ui';

/** How long Undo is offered. */
export const UNDO_MS = 8000;

interface HiddenStore {
  /** Ids hidden while their removal waits for the undo window to pass (or is being sent). */
  ids: ReadonlySet<string>;
}

export const usePendingRemovals = create<HiddenStore>(() => ({ ids: new Set<string>() }));

function setHidden(id: string, hidden: boolean): void {
  usePendingRemovals.setState((s) => {
    if (s.ids.has(id) === hidden) return s;
    const ids = new Set(s.ids);
    if (hidden) ids.add(id);
    else ids.delete(id);
    return { ids };
  });
}

interface Pending {
  toastId: string;
  /** Sends the removal now; settles when the core answered (never rejects). */
  commit(): Promise<void>;
  /** Forgets it without sending (tests). */
  drop(): void;
}

const pending = new Map<string, Pending>();
let flushBound = false;

export interface ScheduleRemovalOptions {
  id: string;
  /** The toast; its `action` is replaced by Undo and its duration by UNDO_MS. */
  toast: Omit<ToastOptions, 'action' | 'duration' | 'id'>;
  undoLabel: string;
  /** Sends `sources.remove`. Rejecting puts the source back and calls `onFailed`. */
  remove(): Promise<void>;
  /** After a successful remove (cache cleanup, invalidation). */
  onRemoved?(): void;
  onFailed?(error: unknown): void;
  /** After Undo; the source is visible again. */
  onUndone?(): void;
}

/** Hides the source and offers Undo; returns a function that undoes it (same as pressing Undo). */
export function scheduleRemoval(opts: ScheduleRemovalOptions): () => void {
  // A second remove of the same source while the first waits: keep the first.
  if (pending.has(opts.id)) return () => undefined;

  bindFlush();
  setHidden(opts.id, true);
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = () => {
    settled = true;
    clearTimeout(timer);
    pending.delete(opts.id);
  };

  const undo = () => {
    if (settled) return;
    finish();
    dismissToast(toastId);
    setHidden(opts.id, false);
    opts.onUndone?.();
  };

  const commit = (): Promise<void> => {
    if (settled) return Promise.resolve();
    finish();
    dismissToast(toastId);
    return opts
      .remove()
      .then(() => {
        // The caller drops it (and its titles in My List, Favorites, Recent, Continue watching)
        // from the caches first, so un-hiding cannot flash it back.
        opts.onRemoved?.();
        setHidden(opts.id, false);
      })
      .catch((e: unknown) => {
        setHidden(opts.id, false);
        opts.onFailed?.(e);
      });
  };

  const toastId = toast({
    ...opts.toast,
    duration: UNDO_MS,
    action: { label: opts.undoLabel, onClick: undo },
  });
  pending.set(opts.id, { toastId, commit, drop: finish });
  // commit() dismisses the toast, so Undo is never on screen after the removal went out.
  timer = setTimeout(() => void commit(), UNDO_MS);
  return undo;
}

/** Sends every waiting removal now (pagehide, tray Quit); settles when all are answered. */
export async function flushPendingRemovals(): Promise<void> {
  await Promise.all([...pending.values()].map((p) => p.commit()));
}

/** True while a removal of `id` waits for its undo window. */
export function isRemovalPending(id: string): boolean {
  return pending.has(id);
}

/** Test hook: forget waiting removals without sending them. */
export function resetPendingRemovalsForTests(): void {
  for (const p of [...pending.values()]) p.drop();
  pending.clear();
  usePendingRemovals.setState({ ids: new Set<string>() });
}

/** True for the quit event's detail: something with a `waitUntil(promise)`. */
function hasWaitUntil(detail: unknown): detail is { waitUntil(work: Promise<unknown>): void } {
  return typeof detail === 'object' && detail !== null && 'waitUntil' in detail && typeof detail.waitUntil === 'function';
}

function bindFlush(): void {
  if (flushBound || typeof window === 'undefined') return;
  flushBound = true;
  window.addEventListener('pagehide', () => void flushPendingRemovals());
  // Quit or window close: the app exits once the waitUntil work settles (or its 2.5 s budget,
  // `QUIT_FLUSH_BUDGET_MS`, runs out).
  window.addEventListener(QUIT_FLUSH_EVENT, (e) => {
    if (pending.size === 0) return;
    const work = flushPendingRemovals();
    const detail: unknown = e instanceof CustomEvent ? e.detail : undefined;
    if (hasWaitUntil(detail)) detail.waitUntil(work);
  });
}
