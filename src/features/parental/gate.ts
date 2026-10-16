/**
 * The parental gate (contract C2): asks for the PIN before locked content
 * plays or opens in Ask mode.
 *
 * Hide mode needs no gate, because the core never hands out locked items
 * there; with controls off, or while an unlock is active, nothing is asked.
 * In Ask mode `parental.check` decides what is locked right now, and the
 * PIN dialog shown by {@link ParentalGateHost} unlocks the session.
 *
 * Requests queue in a small store the host renders from: unlock requests
 * (from {@link ensureUnlocked}, merged so concurrent calls share one dialog)
 * and plain PIN prompts (from {@link requestPin}, used by context-menu
 * actions that need the PIN to remove a lock).
 */

import { create } from 'zustand';

import { queryClient } from '@/api/query';
import { RpcError, rpc } from '@/api/transport';
import type { ItemRef, ParentalStatus } from '@/api/types';

import { allowedSince, applyStatus, currentStatus, STATUS_KEY } from './status';

/** One thing about to play or open. `title` (optional) names it in the PIN dialog. */
export interface ParentalGateItem {
  ref: ItemRef;
  categoryId?: string;
  title?: string;
}

/** Most items one `parental.check` call accepts (C2). */
export const CHECK_BATCH = 500;

interface RequestBase {
  id: number;
  /** `Date.now()` when the dialog was asked for. */
  openedAt: number;
  waiters: ((ok: boolean) => void)[];
}

/** Unlock the session so locked items can play (Ask mode). */
export interface UnlockRequest extends RequestBase {
  kind: 'unlock';
  /** The locked items, for the dialog's wording. */
  items: ParentalGateItem[];
}

/** Any other action that needs the PIN once (removing a lock from a menu). */
export interface PinRequest extends RequestBase {
  kind: 'pin';
  title: string;
  description?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Runs the command with the PIN; rejects with the core's error (auth = wrong PIN). */
  submit: (pin: string) => Promise<void>;
}

export type GateRequest = UnlockRequest | PinRequest;

/** Pending PIN requests; the host shows the first. */
export const useGateStore = create<{ queue: GateRequest[] }>(() => ({ queue: [] }));

let nextId = 1;
let hosts = 0;

/** Called by {@link ParentalGateHost} while mounted. Returns the unregister function. */
export function registerGateHost(): () => void {
  hosts += 1;
  return () => {
    hosts -= 1;
    // A host that goes away with requests open cannot answer them: refuse them, never hang.
    if (hosts === 0) for (const r of useGateStore.getState().queue) settleGate(r.id, false);
  };
}

/** Ends a request: removes it from the queue and resolves every waiter. Idempotent. */
export function settleGate(id: number, ok: boolean): void {
  const req = useGateStore.getState().queue.find((r) => r.id === id);
  if (!req) return;
  useGateStore.setState((s) => ({ queue: s.queue.filter((r) => r.id !== id) }));
  for (const w of req.waiters) w(ok);
}

function noHost(): boolean {
  if (hosts > 0) return false;
  console.warn('[parental] ParentalGateHost is not mounted; refusing a PIN request');
  return true;
}

const refKey = (r: ItemRef): string => `${r.sourceId}|${r.contentType}|${r.itemId}`;

/**
 * The refs among `items` that are locked right now (`parental.check`,
 * batched by {@link CHECK_BATCH}). Titles never leave the app.
 */
export async function lockedRefs(items: readonly ParentalGateItem[]): Promise<Set<string>> {
  const unique = new Map<string, { ref: ItemRef; categoryId?: string }>();
  for (const { ref, categoryId } of items) {
    const key = refKey(ref);
    if (!unique.has(key)) unique.set(key, categoryId ? { ref, categoryId } : { ref });
  }
  const all = [...unique.values()];
  const out = new Set<string>();
  for (let i = 0; i < all.length; i += CHECK_BATCH) {
    const locked = await rpc('parental.check', { items: all.slice(i, i + CHECK_BATCH) });
    for (const r of locked) out.add(refKey(r));
  }
  return out;
}

/** Whether the gate should look further: controls on and in Ask mode (C2). */
function gateApplies(s: ParentalStatus): boolean {
  return s.enabled && s.mode === 'ask';
}

/**
 * Opens (or joins) the shared unlock dialog. `checkedAt` is when the core was
 * asked what is locked: a status at or after it that allows playback (another
 * dialog's unlock finished meanwhile) lets the request through unasked.
 */
function askForUnlock(items: ParentalGateItem[], checkedAt: number): Promise<boolean> {
  if (noHost()) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const { queue } = useGateStore.getState();
    const open = queue.find((r): r is UnlockRequest => r.kind === 'unlock');
    if (open) {
      // Concurrent calls share one dialog: the new waiter joins, its items add to the wording.
      const known = new Set(open.items.map((i) => refKey(i.ref)));
      const merged: UnlockRequest = {
        ...open,
        items: [...open.items, ...items.filter((i) => !known.has(refKey(i.ref)))],
        waiters: [...open.waiters, resolve],
      };
      useGateStore.setState({ queue: queue.map((r) => (r.id === open.id ? merged : r)) });
      return;
    }
    if (allowedSince(checkedAt)) {
      resolve(true);
      return;
    }
    const req: UnlockRequest = { kind: 'unlock', id: nextId++, openedAt: checkedAt, items, waiters: [resolve] };
    useGateStore.setState({ queue: [...queue, req] });
  });
}

/**
 * Resolves true when playback or opening may proceed (C2). Asks for the PIN
 * (PinDialog via ParentalGateHost) when any item is locked in Ask mode; in
 * Hide mode, with controls off, or while unlocked it resolves true without
 * asking. Cancelling the dialog resolves false. Concurrent calls share one
 * dialog and resolve together.
 *
 * A core without parental controls (`unsupported`) has nothing locked. Any
 * other failure to check refuses (false): the gate fails closed.
 */
export async function ensureUnlocked(items: readonly ParentalGateItem[]): Promise<boolean> {
  if (items.length === 0) return true;
  try {
    const status = await currentStatus();
    if (!gateApplies(status)) return true;
    // The core is the judge of what is locked now (an unlock may have run out or started elsewhere).
    const checkedAt = Date.now();
    const locked = await lockedRefs(items);
    if (locked.size === 0) return true;
    return await askForUnlock(items.filter((i) => locked.has(refKey(i.ref))), checkedAt);
  } catch (err) {
    const e = RpcError.from(err);
    if (e.code === 'unsupported') return true;
    console.error('[parental] could not check parental locks', e);
    reportCheckFailure(e);
    return false;
  }
}

/** Shows why the gate refused; set by the host (it owns translations and toasts). */
let reportCheckFailure: (e: RpcError) => void = () => undefined;

/** The host's error reporter for failed checks. Returns the reset function. */
export function setCheckFailureReporter(fn: (e: RpcError) => void): () => void {
  reportCheckFailure = fn;
  return () => {
    if (reportCheckFailure === fn) reportCheckFailure = () => undefined;
  };
}

/**
 * Asks for the PIN once and runs `submit` with it (the dialog shows wrong-PIN
 * and lockout states from its rejection). Resolves true after `submit`
 * succeeds, false when cancelled. Strings are already translated.
 */
export function requestPin(opts: Omit<PinRequest, 'kind' | 'id' | 'openedAt' | 'waiters'>): Promise<boolean> {
  if (noHost()) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const req: PinRequest = { ...opts, kind: 'pin', id: nextId++, openedAt: Date.now(), waiters: [resolve] };
    useGateStore.setState((s) => ({ queue: [...s.queue, req] }));
  });
}

/**
 * True when removing a source may need the PIN first: the cached status says a PIN is set and no
 * unlock is running. Nothing cached yet counts as false; the core still has the last word.
 */
export function removalMayNeedPin(): boolean {
  const s = queryClient.getQueryData<ParentalStatus>(STATUS_KEY);
  return !!s && s.enabled && !s.unlocked;
}

/**
 * A removed source takes its parental locks with it, so while controls are locked the core
 * refuses `sources.remove` and `sources.removeAll` (`auth`) for sources that have locks. When
 * the source (`sourceId` omitted: any source) has a lock, this asks for the PIN and unlocks the
 * session with it. Resolves true when the removal may go ahead, false when the prompt was
 * cancelled. A failed check goes ahead: the core refuses what it must. Strings are translated.
 */
export async function unlockToRemoveSources(
  sourceId: string | undefined,
  prompt: Pick<PinRequest, 'title' | 'description' | 'confirmLabel'>,
): Promise<boolean> {
  try {
    const s = await currentStatus();
    if (!s.enabled || s.unlocked) return true;
    const locks = await rpc('parental.locks', sourceId === undefined ? {} : { sourceId });
    if (locks.length === 0) return true;
  } catch {
    return true;
  }
  return requestPin({
    ...prompt,
    submit: async (pin) => {
      applyStatus(await rpc('parental.unlock', { pin }));
    },
  });
}
