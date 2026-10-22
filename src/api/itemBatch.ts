/**
 * `catalog.item` for many rows at once. Live's Favorites and Recently watched, the guide's
 * Favorites and the channel pickers hold refs and ask for the channels of their rows: the 20 to 60
 * near the screen, in a picker the 60 it lists and 60 more per Show more. Each row keeps its own
 * `['catalog.item', { ref }]` cache entry, which the player and the other readers share, but the
 * refs asked for in the same tick go out as one `catalog.items` call; each entry then gets its own
 * row, or the error `catalog.item` would have given. One call per row queued 40 or more requests
 * on open and re-rendered the page once per answer.
 *
 * A sent batch is never aborted: the queries do not hand it their signal, so a row that scrolls
 * away does not cancel the rows still on screen, and its answer is cached like any other.
 *
 * It is part of the entry, through `batchedItemQuery` in `query.ts`. As a lazy module that Live,
 * the guide and the pickers share, it made a chunk under 4 kB, and the min-size merge put it in the
 * player's subtitle chunk and moved other small modules after it: the player's zap hooks ended up
 * in a chunk Search loads, and Search waited for the player's controls before its first render
 * (pnpm size:check). It cannot be a manual chunk like `src/lib/duration.ts`: Rollup puts a manual
 * chunk's imports in it too, and these are the entry's transport and types modules.
 */

import type { CatalogItemAnswer } from './rpc';
import { RpcError, rpcRaw, type RpcResult } from './transport';
import { itemKey, type ItemKey, type ItemRef } from './types';

/** Most refs per `catalog.items` call (the core's `MAX_ITEMS_REFS`). */
export const ITEMS_BATCH_MAX = 500;

type Item = RpcResult<'catalog.item'>;

interface Waiter {
  ref: ItemRef;
  resolve(item: Item): void;
  reject(err: unknown): void;
}

/** Refs asked for since the last flush, each with every query waiting on it. */
let pending: Map<ItemKey, Waiter[]> | null = null;

function settle(waiters: Waiter[], answer: CatalogItemAnswer | undefined): void {
  if (answer && 'item' in answer) {
    for (const w of waiters) w.resolve(answer.item);
    return;
  }
  const e = answer?.error;
  const err = e ? new RpcError(e.code, e.message, e.retryable, e.details) : new RpcError('internal', 'catalog.items gave no answer for this ref');
  for (const w of waiters) w.reject(err);
}

function send(batch: Waiter[][]): void {
  rpcRaw('catalog.items', { refs: batch.map((waiters) => waiters[0]!.ref) }).then(
    (answers) => batch.forEach((waiters, i) => settle(waiters, (answers as CatalogItemAnswer[] | undefined)?.[i])),
    (err: unknown) => {
      for (const waiters of batch) for (const w of waiters) w.reject(err);
    },
  );
}

function flush(): void {
  const batch = pending;
  pending = null;
  if (!batch) return;
  const groups = [...batch.values()];
  for (let i = 0; i < groups.length; i += ITEMS_BATCH_MAX) send(groups.slice(i, i + ITEMS_BATCH_MAX));
}

/**
 * The catalog row of `ref`, as `catalog.item` answers it, from the batch of this tick. A
 * microtask is enough: a list's queries start in one synchronous run as it mounts or its range
 * moves.
 */
export function batchedItem(ref: ItemRef): Promise<Item> {
  return new Promise<Item>((resolve, reject) => {
    if (!pending) {
      pending = new Map();
      queueMicrotask(flush);
    }
    const key = itemKey(ref);
    const waiters = pending.get(key);
    const w = { ref, resolve, reject };
    if (waiters) waiters.push(w);
    else pending.set(key, [w]);
  });
}
