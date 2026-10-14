/**
 * Channel edit writes with their toasts: hide (with Undo), unhide (with
 * Undo), rename and reset (with Undo). Every write refreshes the caches it
 * changes, and a failure says what went wrong in words the user can act on.
 */

import type { TFunction } from 'i18next';

import { rpc, RpcError } from '@/api/transport';
import { itemKey, sameRef, type ChannelEdit, type ItemRef } from '@/api/types';
import { toast } from '@/ui';

import { afterEditChange, patchHidden, restoreHidden } from './edits';

export type T = TFunction<'channels'>;

/** One channel to act on, with the name the toasts show. */
export interface EditTarget {
  ref: ItemRef;
  /** Display name (custom name when renamed, country tag stripped per Settings). */
  name: string;
}

/** Refs the core takes per `channels.setHidden` call (C2). */
export const HIDE_BATCH = 500;

/** Why a write failed, as a toast description. A channel the provider dropped gets its own words. */
export function failureText(err: unknown, t: T): string {
  const e = RpcError.from(err);
  if (e.code === 'not_found') return t('goneText');
  return e.message;
}

/** Hides and unhides in flight, by ref key: a held Shift+Delete or a double click sends once. */
const inFlight = new Set<string>();

async function once(ref: ItemRef, run: () => Promise<boolean>): Promise<boolean> {
  const key = itemKey(ref);
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  try {
    return await run();
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Hides one channel: it leaves every list, search and the guide. The toast
 * offers Undo and points at where hidden channels are kept. Resolves true
 * once hidden.
 */
export function hideChannel(target: EditTarget, t: T): Promise<boolean> {
  return once(target.ref, async () => {
    try {
      await rpc('channels.setHidden', { refs: [target.ref], hidden: true });
    } catch (err) {
      toast({ variant: 'error', title: t('hideFailed', { name: target.name }), description: failureText(err, t) });
      return false;
    }
    void afterEditChange();
    toast({
      variant: 'success',
      title: t('hiddenToast', { name: target.name }),
      description: t('hiddenToastText'),
      action: { label: t('undo'), onClick: () => void unhideChannel(target, t, { undo: false }) },
    });
    return true;
  });
}

/**
 * Shows a hidden channel again. The cached hidden list drops it at once (the
 * dialog row goes away) and comes back if the core refuses. With `undo`
 * (default) the toast can hide it again. Resolves true once visible.
 */
export function unhideChannel(target: EditTarget, t: T, opts: { undo?: boolean } = {}): Promise<boolean> {
  const { undo = true } = opts;
  return once(target.ref, async () => {
    const before = patchHidden(target.ref.sourceId, (l) => l.filter((e) => !sameRef(e.ref, target.ref)));
    try {
      await rpc('channels.setHidden', { refs: [target.ref], hidden: false });
    } catch (err) {
      restoreHidden(target.ref.sourceId, before);
      toast({ variant: 'error', title: t('unhideFailed', { name: target.name }), description: failureText(err, t) });
      return false;
    }
    void afterEditChange();
    toast({
      variant: 'success',
      title: t('unhiddenToast', { name: target.name }),
      ...(undo ? { action: { label: t('undo'), onClick: () => void hideAgain([target.ref], t) } } : {}),
    });
    return true;
  });
}

/** Undo of an unhide: hides the refs again, quietly unless it fails. */
async function hideAgain(refs: readonly ItemRef[], t: T): Promise<void> {
  try {
    for (let i = 0; i < refs.length; i += HIDE_BATCH) {
      await rpc('channels.setHidden', { refs: refs.slice(i, i + HIDE_BATCH), hidden: true });
    }
  } catch (err) {
    toast({ variant: 'error', title: t('undoFailed'), description: failureText(err, t) });
  } finally {
    void afterEditChange();
  }
}

/** Result of {@link unhideMany}: refs shown again, and refs the core refused. */
export interface UnhideManyResult {
  done: ItemRef[];
  failed: { ref: ItemRef; error: RpcError }[];
}

/** Calls at once when one batch is retried ref by ref. */
const PARALLEL = 4;

/**
 * Unhides many channels of one source, `HIDE_BATCH` refs per call. The core
 * now unhides refs the catalog no longer has (B1), so `not_found` should not
 * come back; if an older core answers it, the batch is retried ref by ref and
 * only the missing ones fail. Rows leave the cached hidden list as they succeed.
 */
export async function unhideMany(sourceId: string, refs: readonly ItemRef[]): Promise<UnhideManyResult> {
  const done: ItemRef[] = [];
  const failed: UnhideManyResult['failed'] = [];
  const drop = (gone: readonly ItemRef[]) => {
    const keys = new Set(gone.map(itemKey));
    patchHidden(sourceId, (l) => l.filter((e) => !keys.has(itemKey(e.ref))));
  };
  for (let i = 0; i < refs.length; i += HIDE_BATCH) {
    const batch = refs.slice(i, i + HIDE_BATCH);
    try {
      await rpc('channels.setHidden', { refs: batch, hidden: false });
      done.push(...batch);
      drop(batch);
      continue;
    } catch (err) {
      const e = RpcError.from(err);
      if (e.code !== 'not_found' || batch.length === 1) {
        for (const ref of batch) failed.push({ ref, error: e });
        continue;
      }
    }
    for (let j = 0; j < batch.length; j += PARALLEL) {
      await Promise.all(
        batch.slice(j, j + PARALLEL).map(async (ref) => {
          try {
            await rpc('channels.setHidden', { refs: [ref], hidden: false });
            done.push(ref);
            drop([ref]);
          } catch (err) {
            failed.push({ ref, error: RpcError.from(err) });
          }
        }),
      );
    }
  }
  void afterEditChange();
  return { done, failed };
}

/** Toasts for {@link unhideMany}: how many came back (with Undo), and how many could not. */
export function reportUnhideMany(result: UnhideManyResult, t: T): void {
  if (result.done.length > 0) {
    const refs = result.done;
    toast({
      variant: 'success',
      title: t('unhiddenMany', { count: refs.length }),
      action: { label: t('undo'), onClick: () => void hideAgain(refs, t) },
    });
  }
  if (result.failed.length > 0) {
    const gone = result.failed.every((f) => f.error.code === 'not_found');
    toast({
      variant: 'error',
      title: t('unhideManyFailed', { count: result.failed.length }),
      description: gone ? t('goneText') : result.failed[0]!.error.message,
    });
  }
}

/** Sets (or, with `null`, removes) a custom name. Throws the core's error. */
export async function renameChannel(ref: ItemRef, name: string | null): Promise<ChannelEdit | null> {
  const row = await rpc('channels.rename', { ref, name });
  void afterEditChange();
  return row;
}

/**
 * The toast after a rename or reset, with Undo back to `previous` (the
 * custom name before, or null for the provider's name).
 */
export function renamedToast(ref: ItemRef, shown: string, previous: string | null, wasReset: boolean, t: T): void {
  toast({
    variant: 'success',
    title: wasReset ? t('nameResetToast', { name: shown }) : t('renamedToast', { name: shown }),
    action: {
      label: t('undo'),
      onClick: () =>
        void renameChannel(ref, previous).catch((err: unknown) =>
          toast({ variant: 'error', title: t('undoFailed'), description: failureText(err, t) }),
        ),
    },
  });
}

/** "Reset name" from a menu: back to the provider's name, with Undo. */
export async function resetName(ref: ItemRef, edit: ChannelEdit, provider: string, t: T): Promise<boolean> {
  try {
    await renameChannel(ref, null);
  } catch (err) {
    toast({ variant: 'error', title: t('renameFailed'), description: failureText(err, t) });
    return false;
  }
  renamedToast(ref, provider, edit.name ?? null, true, t);
  return true;
}
