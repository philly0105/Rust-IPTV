// VOD queries hand TanStack's signal to rpcRaw, so a refetch that a newer one
// (or an unmount) replaced is aborted instead of running to the end.
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef } from '@/api/types';

const rpcRaw = vi.hoisted(() => vi.fn<(cmd: string, args?: unknown, opts?: { signal?: AbortSignal }) => Promise<unknown>>());
vi.mock('@/api/transport', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/transport')>()), rpcRaw }));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const { movieDetailQuery, seriesDetailQuery } = await import('../hooks/queries');

const REF: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: '7' };

afterEach(() => rpcRaw.mockReset());

/** Starts a fetch whose call never answers, cancels it, and checks the call's signal fired. */
async function expectCancelAborts(start: (qc: QueryClient) => Promise<void>, cmd: string) {
  rpcRaw.mockImplementation(() => new Promise(() => undefined));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  void start(qc);
  await vi.waitFor(() => expect(rpcRaw).toHaveBeenCalledTimes(1));
  const [called, , opts] = rpcRaw.mock.calls[0]!;
  expect(called).toBe(cmd);
  expect(opts?.signal?.aborted).toBe(false);
  await qc.cancelQueries();
  expect(opts?.signal?.aborted).toBe(true);
}

describe('VOD query signal', () => {
  it('a cancelled movie detail fetch aborts its call', async () => {
    await expectCancelAborts((qc) => qc.prefetchQuery(movieDetailQuery('xtream', REF)), 'xtream.vodDetail');
  });

  it('a cancelled series detail fetch aborts its call', async () => {
    await expectCancelAborts((qc) => qc.prefetchQuery(seriesDetailQuery('xtream', { ...REF, contentType: 'series' })), 'xtream.seriesDetail');
  });
});
