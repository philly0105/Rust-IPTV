/**
 * Channel edit writes with their toasts: hide (with Undo), unhide (with
 * Undo), rename and reset (with Undo). Every write refreshes the caches it
 * changes, and a failure says what went wrong in words the user can act on.
 *
 * Unhiding works for a channel the provider has dropped (the core clears its
 * hidden mark whether or not the catalog still has it), but hiding needs the
 * channel in the catalog. So the unhide toasts tell the two apart: a dropped
 * channel is "removed from Hidden channels", not "back", and Undo hides
 * again only what can be hidden.
 */

import type { TFunction } from 'i18next';

import { queryClient, rpcKey } from '@/api/query';
import { isParentalLocked, rpc, RpcError } from '@/api/transport';
import { itemKey, sameRef, type ChannelEdit, type ItemRef } from '@/api/types';
import { toast } from '@/ui';

import { afterEditChange, ITEM_STALE_MS, patchHidden, restoreHidden } from './edits';

export type T = TFunction<'channels'>;

/** One channel to act on, with the name the toasts show. */
export interface EditTarget {
  ref: ItemRef;
  /** Display name (custom name when renamed, country tag stripped per Settings). */
  name: string;
}

/** A ref the core refused, with its answer. */
export interface Refused {
  ref: ItemRef;
  error: RpcError;
}

/** Refs the core takes per `channels.setHidden` call (C2). */
export const HIDE_BATCH = 500;

/** Calls in flight at once when refs go one at a time (lookups, a batch retried ref by ref). */
const PARALLEL = 6;

/** Why a write failed, as a toast description. A channel the provider dropped gets its own words. */
export function failureText(err: unknown, t: T): string {
  const e = RpcError.from(err);
  if (e.code === 'not_found') return t('goneText');
  return e.message;
}

/** "The provider no longer lists this channel / these channels." */
function goneText(count: number, t: T): string {
  return count === 1 ? t('goneText') : t('goneManyText');
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function eachLimit<I>(items: readonly I[], limit: number, fn: (item: I) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * `channels.setHidden` for any number of refs, {@link HIDE_BATCH} per call.
 * The core writes nothing of a batch when one of its refs is missing from the
 * catalog (`not_found`: hiding needs the channel, and an older core said so
 * for unhiding too), so such a batch is retried ref by ref and only the
 * missing refs fail. `onLanded` sees refs as the core accepts them.
 */
async function setHiddenMany(
  refs: readonly ItemRef[],
  hidden: boolean,
  onLanded?: (refs: readonly ItemRef[]) => void,
): Promise<{ done: ItemRef[]; failed: Refused[] }> {
  const done: ItemRef[] = [];
  const failed: Refused[] = [];
  const landed = (r: readonly ItemRef[]) => {
    done.push(...r);
    onLanded?.(r);
  };
  for (let i = 0; i < refs.length; i += HIDE_BATCH) {
    const batch = refs.slice(i, i + HIDE_BATCH);
    try {
      await rpc('channels.setHidden', { refs: batch, hidden });
      landed(batch);
      continue;
    } catch (err) {
      const e = RpcError.from(err);
      if (e.code !== 'not_found' || batch.length === 1) {
        for (const ref of batch) failed.push({ ref, error: e });
        continue;
      }
    }
    await eachLimit(batch, PARALLEL, async (ref) => {
      try {
        await rpc('channels.setHidden', { refs: [ref], hidden });
        landed([ref]);
      } catch (err) {
        failed.push({ ref, error: RpcError.from(err) });
      }
    });
  }
  return { done, failed };
}

/**
 * True when a `catalog.item` answer says the provider dropped the channel:
 * `not_found`, unless parental Hide mode locks it (`details.parentalLocked`),
 * which keeps it in the catalog.
 */
export function isGoneAnswer(err: unknown): boolean {
  return RpcError.from(err).code === 'not_found' && !isParentalLocked(err);
}

/**
 * Splits refs by whether the provider still lists them. `catalog.item`
 * answers for hidden channels too (C2), so `not_found` means the channel has
 * left the playlist, unless parental Hide mode locks it (then it is listed).
 * Answers share the cache of the hidden-channels rows, which ask the same, so
 * a row the dialog has shown costs no call, whichever way it answered. A
 * lookup that fails for another reason counts as listed.
 */
async function splitByPresence(refs: readonly ItemRef[]): Promise<{ listed: ItemRef[]; gone: ItemRef[] }> {
  const gone = new Set<string>();
  await eachLimit(refs, PARALLEL, async (ref) => {
    const queryKey = rpcKey('catalog.item', { ref });
    // fetchQuery reuses fresh data but always asks again after an error (the
    // query marks every error invalidated); reuse a recent not_found too, unless
    // a lookup is already under way, which fetchQuery joins.
    const cached = queryClient.getQueryState<unknown, RpcError>(queryKey);
    if (
      cached?.status === 'error' &&
      cached.fetchStatus === 'idle' &&
      isGoneAnswer(cached.error) &&
      Date.now() - cached.errorUpdatedAt < ITEM_STALE_MS
    ) {
      gone.add(itemKey(ref));
      return;
    }
    try {
      await queryClient.fetchQuery({ queryKey, queryFn: () => rpc('catalog.item', { ref }), staleTime: ITEM_STALE_MS });
    } catch (err) {
      if (isGoneAnswer(err)) gone.add(itemKey(ref));
    }
  });
  return {
    listed: refs.filter((r) => !gone.has(itemKey(r))),
    gone: refs.filter((r) => gone.has(itemKey(r))),
  };
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
 * (default) the toast can hide it again. A channel the provider has dropped
 * leaves the hidden list without coming back anywhere: its toast says so and
 * offers no Undo, since the core cannot hide a channel it does not have.
 * Resolves true once the hidden mark is gone.
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
    // Before the refresh below, which would mark the cached answer stale.
    const { gone } = await splitByPresence([target.ref]);
    void afterEditChange();
    if (gone.length > 0) {
      toast({ variant: 'info', title: t('removedToast', { name: target.name }), description: t('goneText') });
      return true;
    }
    toast({
      variant: 'success',
      title: t('unhiddenToast', { name: target.name }),
      ...(undo ? { action: { label: t('undo'), onClick: () => void hideAgain([target.ref], t) } } : {}),
    });
    return true;
  });
}

/**
 * Undo of an unhide: hides `refs` again, quietly unless the core refuses
 * some (the provider dropped them since), and then says how many could not
 * be hidden again and why.
 *
 * `maybeGone` are refs the unhide toast already called removed, because
 * `catalog.item` answered `not_found` for them. A core older than the
 * `details.parentalLocked` mark answers that for a parental-locked channel
 * too, so they are offered to the core as well, one batch at a time: a batch
 * holding a truly dropped channel is refused as a whole and stays quiet, as
 * the toast promised nothing for them.
 */
async function hideAgain(refs: readonly ItemRef[], t: T, maybeGone: readonly ItemRef[] = []): Promise<void> {
  try {
    const { failed } = await setHiddenMany(refs, true);
    for (let i = 0; i < maybeGone.length; i += HIDE_BATCH) {
      await rpc('channels.setHidden', { refs: maybeGone.slice(i, i + HIDE_BATCH), hidden: true }).catch(() => undefined);
    }
    if (failed.length === 0) return;
    const other = failed.find((f) => f.error.code !== 'not_found');
    toast({
      variant: 'error',
      title: failed.length === refs.length ? t('undoFailed') : t('hideAgainFailed', { count: failed.length }),
      description: other ? other.error.message : goneText(failed.length, t),
    });
  } finally {
    void afterEditChange();
  }
}

/** Result of {@link unhideMany}. */
export interface UnhideManyResult {
  /** Unhidden and still in the provider's playlist: back in lists, search and the guide. */
  back: ItemRef[];
  /**
   * Unhidden although the provider no longer lists them: they left the
   * hidden list and show nowhere, and cannot be hidden again.
   */
  removed: ItemRef[];
  /** Refs the core refused; they stay hidden. */
  failed: Refused[];
}

/**
 * Unhides many channels of one source, {@link HIDE_BATCH} refs per call. The
 * core unhides refs the catalog no longer has (B1), so `not_found` should not
 * come back; if an older core answers it, the batch is retried ref by ref and
 * only the missing ones fail. Rows leave the cached hidden list as they
 * succeed. The unhidden refs are then split into those back in the playlist
 * and those the provider dropped.
 */
export async function unhideMany(sourceId: string, refs: readonly ItemRef[]): Promise<UnhideManyResult> {
  const drop = (gone: readonly ItemRef[]) => {
    const keys = new Set(gone.map(itemKey));
    patchHidden(sourceId, (l) => l.filter((e) => !keys.has(itemKey(e.ref))));
  };
  const { done, failed } = await setHiddenMany(refs, false, drop);
  // Before the refresh below, so the rows' cached catalog.item answers are reused.
  const { listed, gone } = await splitByPresence(done);
  void afterEditChange();
  return { back: listed, removed: gone, failed };
}

/**
 * Toasts for {@link unhideMany}: how many came back (with Undo that hides
 * them again) and how many the provider dropped, then how many could not be
 * unhidden.
 */
export function reportUnhideMany(result: UnhideManyResult, t: T): void {
  const { back, removed, failed } = result;
  if (back.length > 0) {
    toast({
      variant: 'success',
      title: t('unhiddenMany', { count: back.length }),
      ...(removed.length > 0 ? { description: t('removedManyText', { count: removed.length }) } : {}),
      action: { label: t('undo'), onClick: () => void hideAgain(back, t, removed) },
    });
  } else if (removed.length > 0) {
    toast({ variant: 'info', title: t('removedMany', { count: removed.length }), description: goneText(removed.length, t) });
  }
  if (failed.length > 0) {
    const other = failed.find((f) => f.error.code !== 'not_found');
    toast({
      variant: 'error',
      title: t('unhideManyFailed', { count: failed.length }),
      description: other ? other.error.message : goneText(failed.length, t),
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
