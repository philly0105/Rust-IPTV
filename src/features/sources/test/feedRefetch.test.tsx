// F5-5: the guide and import progress feeds leave the refetch to the change event the core sends after
// their final event, so a guide refresh or a failed import costs one refetch round, not two, and a 304
// keeps the cached guide windows (EP-2). The events go through the real event binding of api/query.
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEvent } from '@/api/types';

/** A fake event bus that dispatches like api/events: every onAnyAppEvent handler first, then the typed ones. */
const bus = vi.hoisted(() => ({
  any: new Set<(e: AppEvent) => void>(),
  typed: new Map<string, Set<(p: unknown) => void>>(),
}));

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: () => Promise.reject(new Error('no rpc here')),
  rpcRaw: () => Promise.reject(new Error('no rpc here')),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: (type: string, h: (p: unknown) => void) => {
    const set = bus.typed.get(type) ?? new Set();
    bus.typed.set(type, set);
    set.add(h);
    return () => set.delete(h);
  },
  onAnyAppEvent: (h: (e: AppEvent) => void) => {
    bus.any.add(h);
    return () => bus.any.delete(h);
  },
}));

const { EVENT_BURST_MS, bindEventInvalidation, queryClient, rpcKey } = await import('@/api/query');
const { useGuideProgressFeed, useGuideProgressStore } = await import('../lib/epgRefresh');
const { resetProgressForTests, useImportProgressFeed } = await import('../lib/progress');

/** The core's status-only epg.changed after a 304 (ingest.rs STATUS_ONLY). */
const STATUS_ONLY = { reason: 'status' };

function emit(type: string, payload: unknown): void {
  act(() => {
    for (const h of bus.any) h({ type, payload } as AppEvent);
    for (const h of bus.typed.get(type) ?? []) h(payload);
  });
}

/** Lets every burst flush and every refetch it started settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, EVENT_BURST_MS * 3));
  });
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** An active query under `key`, counting its fetches; each takes a few ms, so a second round cancels and restarts it. */
function mountQuery(key: readonly unknown[], feed: () => void) {
  const count = { fetches: 0 };
  renderHook(
    () => {
      feed();
      return useQuery({
        queryKey: key,
        queryFn: async () => {
          count.fetches += 1;
          await new Promise((r) => setTimeout(r, 10));
          return {};
        },
      });
    },
    { wrapper },
  );
  return count;
}

let unbind: () => void = () => undefined;

beforeEach(() => {
  queryClient.clear();
  unbind = bindEventInvalidation();
});
afterEach(() => {
  cleanup();
  unbind();
  resetProgressForTests();
  useGuideProgressStore.setState({ byUrl: {} });
});

describe('guide progress feed', () => {
  const gridKey = rpcKey('epg.grid', { refs: [], from: '2026-10-31T00:00:00.000Z', to: '2026-10-31T06:00:00.000Z', withDescription: true });

  it('keeps the guide windows after a refresh that ended on a 304', async () => {
    const count = mountQuery(gridKey, useGuideProgressFeed);
    await settle();
    expect(count.fetches).toBe(1);
    // An inactive cached window from an earlier guide visit.
    const old = rpcKey('epg.grid', { refs: [], from: '2026-10-30T00:00:00.000Z', to: '2026-10-30T06:00:00.000Z', withDescription: true });
    queryClient.setQueryData(old, {});

    emit('epg.progress', { url: 'http://a/epg.xml', phase: 'done', programs: 1200 });
    emit('epg.changed', STATUS_ONLY);
    await settle();
    // Before F5-5 the feed refetched every 'epg.' query on 'done': 1 more here, and the old window stale.
    expect(count.fetches).toBe(1);
    expect(queryClient.getQueryState(old)?.isInvalidated).toBe(false);
    expect(useGuideProgressStore.getState().byUrl['http://a/epg.xml']?.phase).toBe('done');
  });

  it('refetches the guide windows once after a refresh that changed the guide, or failed', async () => {
    const count = mountQuery(gridKey, useGuideProgressFeed);
    await settle();
    emit('epg.progress', { url: 'http://a/epg.xml', phase: 'done', programs: 1200 });
    emit('epg.changed', {});
    await settle();
    // Before F5-5: 2, the feed's own round and the event's, which cancelled and restarted it.
    expect(count.fetches).toBe(2);

    emit('epg.progress', { url: 'http://a/epg.xml', phase: 'error', programs: 0, message: 'HTTP 404' });
    emit('epg.changed', {});
    await settle();
    expect(count.fetches).toBe(3);
  });
});

describe('import progress feed', () => {
  const listKey = rpcKey('sources.list');

  it.each(['error', 'cancelled'] as const)('fetches the sources once after a run that ended %s', async (phase) => {
    const count = mountQuery(listKey, useImportProgressFeed);
    await settle();
    expect(count.fetches).toBe(1);
    emit('import.progress', { sourceId: 'a', phase: 'parsing', done: 10 });
    emit('import.progress', { sourceId: 'a', phase, done: 10 });
    // The core follows a failed or cancelled run with a status change.
    emit('sources.changed', { reason: 'status' });
    await settle();
    // Before F5-5: 3, the feed's own round at once and the event's 50 ms later.
    expect(count.fetches).toBe(2);
  });

  it('fetches the sources once after a run that finished', async () => {
    const count = mountQuery(listKey, useImportProgressFeed);
    await settle();
    emit('import.progress', { sourceId: 'a', phase: 'done', done: 10 });
    emit('sources.changed', { reason: 'catalog' });
    await settle();
    expect(count.fetches).toBe(2);
  });

  it('still refetches the sources on its own when no event follows', async () => {
    const count = mountQuery(listKey, useImportProgressFeed);
    await settle();
    emit('import.progress', { sourceId: 'a', phase: 'cancelled', done: 0 });
    await settle();
    expect(count.fetches).toBe(2);
  });
});
