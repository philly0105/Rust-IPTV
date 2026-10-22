/**
 * The `catalog.item` batcher: refs asked for in one tick go out as one `catalog.items` call, each
 * cache entry gets its own row or `catalog.item`'s error, and no query's signal reaches the call.
 */
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { rpcKey } from '@/api/query';
import { isParentalLocked, RpcError, rpcRaw } from '@/api/transport';
import type { ItemRef } from '@/api/types';

import { batchedItem, batchedItemQuery, ITEMS_BATCH_MAX } from '../lib/itemBatch';
import { makeChannel } from './harness';

vi.mock('@/api/transport', async (orig) => ({ ...(await orig<object>()), rpcRaw: vi.fn() }));

const raw = vi.mocked(rpcRaw);
const ref = (i: number): ItemRef => makeChannel(i).ref;
const indexOf = (r: ItemRef) => Number(r.itemId.slice(1));
/** A core that knows c0..c9; c7 is locked by Hide mode, the rest are dropped. */
function core() {
  raw.mockImplementation(async (cmd, args) => {
    expect(cmd).toBe('catalog.items');
    return (args as { refs: ItemRef[] }).refs.map((r) => {
      const i = indexOf(r);
      if (i === 7) return { error: { code: 'not_found', message: 'catalog item c7 is locked by parental controls', retryable: false, details: { parentalLocked: true } } };
      return i < 10 ? { item: makeChannel(i) } : { error: { code: 'not_found', message: `catalog item c${i} not found`, retryable: false } };
    });
  });
}
const settled = <T,>(p: Promise<T>) => p.then((v) => ({ ok: v }), (e: unknown) => ({ err: e }));

afterEach(() => raw.mockReset());

describe('batchedItem', () => {
  it('sends the refs of one tick as one call, each once, and answers each ref', async () => {
    core();
    const out = await Promise.all([batchedItem(ref(1)), batchedItem(ref(2)), batchedItem(ref(1))]);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0]).toEqual(['catalog.items', { refs: [ref(1), ref(2)] }]);
    expect(out.map((c) => 'name' in c && c.name)).toEqual(['Channel 1', 'Channel 2', 'Channel 1']);
  });

  it("rejects a ref with catalog.item's own error, parentalLocked included", async () => {
    core();
    const [locked, gone, fine] = await Promise.all([settled(batchedItem(ref(7))), settled(batchedItem(ref(12))), settled(batchedItem(ref(3)))]);
    expect('err' in locked && locked.err).toBeInstanceOf(RpcError);
    const lockedErr = (locked as { err: RpcError }).err;
    expect(lockedErr.code).toBe('not_found');
    expect(isParentalLocked(lockedErr)).toBe(true);
    const goneErr = (gone as { err: RpcError }).err;
    expect(goneErr.code).toBe('not_found');
    expect(isParentalLocked(goneErr)).toBe(false);
    expect(fine).toEqual({ ok: makeChannel(3) });
  });

  it('rejects every ref of a call that failed as a whole', async () => {
    raw.mockRejectedValue(new RpcError('network', 'unreachable', true));
    const out = await Promise.all([settled(batchedItem(ref(1))), settled(batchedItem(ref(2)))]);
    expect(out.map((o) => 'err' in o && (o.err as RpcError).code)).toEqual(['network', 'network']);
  });

  it('starts a new call in a later tick, and splits a batch past the core limit', async () => {
    core();
    await batchedItem(ref(1));
    await batchedItem(ref(2));
    expect(raw).toHaveBeenCalledTimes(2);
    raw.mockClear();
    const many = Array.from({ length: ITEMS_BATCH_MAX + 3 }, (_, i) => settled(batchedItem(ref(i))));
    await Promise.all(many);
    expect(raw.mock.calls.map(([, a]) => (a as { refs: ItemRef[] }).refs.length)).toEqual([ITEMS_BATCH_MAX, 3]);
  });

  it("feeds each ref's own catalog.item key, and a cancelled query does not abort the others' call", async () => {
    let answer!: () => void;
    raw.mockImplementation(
      (_cmd, args) =>
        new Promise((resolve) => {
          answer = () => resolve((args as { refs: ItemRef[] }).refs.map((r) => ({ item: makeChannel(indexOf(r)) })));
        }),
    );
    const client = new QueryClient();
    const a = client.fetchQuery(batchedItemQuery(ref(4), 60_000));
    const b = settled(client.fetchQuery(batchedItemQuery(ref(5), 60_000)));
    await Promise.resolve();
    await client.cancelQueries({ queryKey: rpcKey('catalog.item', { ref: ref(5) }) });
    answer();
    expect(await a).toEqual(makeChannel(4));
    await b;
    // The call carried no abort signal, and the ref still wanted got its answer in the cache.
    expect(raw.mock.calls).toHaveLength(1);
    expect(raw.mock.calls[0]).toHaveLength(2);
    expect(client.getQueryData(rpcKey('catalog.item', { ref: ref(4) }))).toEqual(makeChannel(4));
  });
});
