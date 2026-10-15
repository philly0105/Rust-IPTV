// Status cache and events (C2/C7): `parental.changed` becomes the cached
// status and refreshes what Hide mode filters; timed unlocks are re-checked
// when they run out.
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import type { ParentalStatus } from '@/api/types';

import { lockNow, useParentalEvents, useParentalStatus } from '..';
import { afterLockChange, catalogAffected, FILTERED_PREFIXES, hidesContent, STATUS_KEY, unlockRemainingMs } from '../status';
import { core, emitEvent, listenerCount } from './harness';

vi.mock('@/api/transport', async (orig) => {
  const actual = await orig<typeof import('@/api/transport')>();
  const { core } = await import('./harness');
  const call = async (cmd: string, args?: unknown) => {
    try {
      return await core.call(cmd, args);
    } catch (e) {
      throw actual.RpcError.from(e);
    }
  };
  return { ...actual, rpc: call, rpcRaw: call };
});
vi.mock('@/api/events', async () => (await import('./harness')).eventsMock);

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

const base: ParentalStatus = { enabled: true, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 };
const s = (patch: Partial<ParentalStatus> = {}): ParentalStatus => ({ ...base, ...patch });

/**
 * Seeds one cached query per read the core filters, plus the lock list, and
 * returns their keys; `unrelated` are queries Hide mode does not change.
 */
function seedLists() {
  const keys = [
    ['catalog.channels', { sourceId: 'src1' }],
    ['favorites.list', null],
    ['recent.list', null],
    ['positions.continueWatching', null],
    ['watchlist.list', null],
    ['lists.list', null],
    ['lists.items', { id: 'l1' }],
    ['epg.search', { sourceId: 'src1', query: 'news' }],
    ['stats.summary', { days: 7, today: '2026-10-14' }],
    // Portal pages and details: the core filters or refuses them in Hide mode too.
    ['stalker.movies', { sourceId: 'portal', query: { offset: 0, limit: 56 } }],
    ['stalker.search', { sourceId: 'portal', query: 'night', contentType: 'movie' }],
    ['stalker.seriesDetail', { ref: { sourceId: 'portal', contentType: 'series', itemId: 's1' } }],
    ['xtream.vodDetail', { ref: { sourceId: 'src1', contentType: 'movie', itemId: 'm1' } }],
    ['parental.locks', {}],
  ] as const;
  const unrelated = [['epg.nowNext', null]] as const;
  for (const k of [...keys, ...unrelated]) queryClient.setQueryData(k, []);
  const invalidated = (k: readonly unknown[]) => queryClient.getQueryState(k)?.isInvalidated ?? false;
  return { keys, unrelated, invalidated };
}

beforeEach(() => {
  core.reset({ pin: '2580' });
  queryClient.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useParentalEvents', () => {
  it('puts the event payload in the status cache and refreshes the filtered lists', async () => {
    const { result } = renderHook(
      () => {
        useParentalEvents();
        return useParentalStatus();
      },
      { wrapper },
    );
    await vi.waitFor(() => expect(result.current.data).toBeDefined());
    const { keys, unrelated, invalidated } = seedLists();

    // Hide mode switches off (an unlock): every list the core filters refetches.
    act(() => emitEvent('parental.changed', s({ unlocked: true, unlockedUntil: new Date(Date.now() + 60_000).toISOString() })));
    expect(queryClient.getQueryData(STATUS_KEY)).toMatchObject({ unlocked: true });
    // Observers hear about cache writes on the next tick.
    await vi.waitFor(() => expect(result.current.data?.unlocked).toBe(true));
    for (const k of keys) expect(invalidated(k), String(k[0])).toBe(true);
    // Unrelated queries (the rest of the guide) are left alone.
    for (const k of unrelated) expect(invalidated(k), String(k[0])).toBe(false);
  });

  it('does not reload the catalog for a wrong PIN while Hide mode keeps filtering', () => {
    renderHook(() => useParentalEvents(), { wrapper });
    queryClient.setQueryData(STATUS_KEY, s());
    const { invalidated } = seedLists();
    act(() => emitEvent('parental.changed', s({ failedAttempts: 1 })));
    expect(invalidated(['catalog.channels', { sourceId: 'src1' }])).toBe(false);
    // The lock list and checks always follow.
    expect(invalidated(['parental.locks', {}])).toBe(true);
  });

  it('reloads the catalog when a lock is added or removed in Hide mode', () => {
    renderHook(() => useParentalEvents(), { wrapper });
    queryClient.setQueryData(STATUS_KEY, s());
    const seeded = FILTERED_PREFIXES.map((p) => [p.endsWith('.') ? `${p}list` : p, { seed: p }] as const);
    for (const k of seeded) queryClient.setQueryData(k, []);
    queryClient.setQueryData(['epg.nowNext', null], []);
    // The core sends the same status after a lock-list change.
    act(() => emitEvent('parental.changed', s()));
    // Nothing shows them, so the next visit loads fresh instead of drawing the old data first.
    for (const k of seeded) expect(queryClient.getQueryState(k), String(k[0])).toBeUndefined();
    expect(queryClient.getQueryState(['epg.nowNext', null])?.isInvalidated).toBe(false);
  });

  it('drops cached portal pages and details when Hide mode filters again, and refetches the ones on screen', async () => {
    queryClient.setQueryData(STATUS_KEY, s({ unlocked: true }));
    renderHook(() => useParentalEvents(), { wrapper });
    // A Stalker grid page on screen, served by the core (which drops hidden titles once locked).
    let locked = false;
    const pageKey = ['stalker.movies', { sourceId: 'portal', categoryId: 'c1' }];
    const page = renderHook(
      () => useQuery({ queryKey: pageKey, queryFn: async () => (locked ? ['Safe'] : ['Safe', 'Locked']) }),
      { wrapper },
    );
    await vi.waitFor(() => expect(page.result.current.data).toEqual(['Safe', 'Locked']));
    // Browsed while unlocked: other pages, a search, a hover-prefetched detail.
    const { keys, invalidated } = seedLists();

    locked = true;
    act(() => emitEvent('parental.changed', s()));
    for (const k of keys.filter(([cmd]) => !cmd.startsWith('parental.'))) {
      expect(queryClient.getQueryState(k), String(k[0])).toBeUndefined();
    }
    // Not something Hide mode filters: refreshed, kept.
    expect(invalidated(['parental.locks', {}])).toBe(true);
    expect(queryClient.getQueryState(['epg.nowNext', null])).toBeDefined();
    // The page on screen stays mounted and refetches in place.
    await vi.waitFor(() => expect(page.result.current.data).toEqual(['Safe']));
  });

  it('keeps cached data when Hide mode stops filtering (an unlock only shows more)', () => {
    queryClient.setQueryData(STATUS_KEY, s());
    renderHook(() => useParentalEvents(), { wrapper });
    const { keys, invalidated } = seedLists();
    act(() => emitEvent('parental.changed', s({ enabled: false })));
    for (const k of keys) expect(invalidated(k), String(k[0])).toBe(true);
  });

  it('afterLockChange drops cached portal details only while Hide mode filters', () => {
    const detail = ['stalker.vodDetail', { ref: { sourceId: 'portal', contentType: 'movie', itemId: 'm9' } }] as const;
    queryClient.setQueryData(STATUS_KEY, s({ unlocked: true }));
    queryClient.setQueryData(detail, { item: { title: 'Locked' } });
    afterLockChange();
    expect(queryClient.getQueryData(detail)).toBeDefined();

    queryClient.setQueryData(STATUS_KEY, s());
    afterLockChange();
    expect(queryClient.getQueryState(detail)).toBeUndefined();
  });

  it('refreshes adult categories and lock checks after an import or a source change', () => {
    renderHook(() => useParentalEvents(), { wrapper });
    const adult = ['parental.adultCategories', { sourceId: 'src1', contentType: 'live' }] as const;
    const check = ['parental.check', { items: [] }] as const;
    const stale = (k: readonly unknown[]) => queryClient.getQueryState(k)?.isInvalidated ?? false;
    const seed = () => {
      queryClient.setQueryData(adult, ['c1']);
      queryClient.setQueryData(check, []);
    };

    seed();
    act(() => emitEvent('import.progress', { sourceId: 'src1', phase: 'parsing', done: 10 }));
    expect(stale(adult)).toBe(false);
    act(() => emitEvent('import.progress', { sourceId: 'src1', phase: 'done', done: 100 }));
    expect(stale(adult)).toBe(true);
    expect(stale(check)).toBe(true);

    seed();
    act(() => emitEvent('sources.changed', {}));
    expect(stale(adult)).toBe(true);
    expect(stale(check)).toBe(true);
  });

  it('stops listening on unmount', () => {
    const view = renderHook(() => useParentalEvents(), { wrapper });
    expect(listenerCount('parental.changed')).toBe(1);
    view.unmount();
    expect(listenerCount('parental.changed')).toBe(0);
  });

  it('asks the core again when a timed unlock runs out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    core.reset({ pin: '2580', unlockedUntil: Date.now() + 60_000 });
    const { result } = renderHook(
      () => {
        useParentalEvents();
        return useParentalStatus();
      },
      { wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.data?.unlocked).toBe(true);
    const before = core.callsOf('parental.status').length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(core.callsOf('parental.status').length).toBeGreaterThan(before);
    expect(result.current.data?.unlocked).toBe(false);
  });
});

describe('lockNow', () => {
  it('ends the unlock and applies the new status', async () => {
    core.reset({ pin: '2580', unlockedUntil: Date.now() + 60_000 });
    queryClient.setQueryData(STATUS_KEY, core.status());
    const next = await lockNow();
    expect(next.unlocked).toBe(false);
    expect(queryClient.getQueryData(STATUS_KEY)).toMatchObject({ unlocked: false });
  });
});

describe('status helpers', () => {
  it('hidesContent only while Hide mode is on and locked', () => {
    expect(hidesContent(s())).toBe(true);
    expect(hidesContent(s({ unlocked: true }))).toBe(false);
    expect(hidesContent(s({ mode: 'ask' }))).toBe(false);
    expect(hidesContent(s({ enabled: false }))).toBe(false);
  });

  it('catalogAffected', () => {
    expect(catalogAffected(undefined, s())).toBe(true);
    expect(catalogAffected(s(), s({ unlocked: true }))).toBe(true);
    expect(catalogAffected(s({ mode: 'ask' }), s())).toBe(true);
    expect(catalogAffected(s(), s({ enabled: false }))).toBe(true);
    expect(catalogAffected(s(), s({ autoAdult: false }))).toBe(true);
    expect(catalogAffected(s(), s())).toBe(true);
    expect(catalogAffected(s(), s({ failedAttempts: 2 }))).toBe(false);
    expect(catalogAffected(s({ failedAttempts: 4 }), s({ failedAttempts: 5, retryAfterSeconds: 30 }))).toBe(false);
    // Nothing is filtered before or after: nothing to reload.
    expect(catalogAffected(s({ mode: 'ask' }), s({ mode: 'ask', autoAdult: false }))).toBe(false);
    expect(catalogAffected(s({ enabled: false }), s({ enabled: false }))).toBe(false);
  });

  it('unlockRemainingMs', () => {
    const now = Date.parse('2026-10-13T10:00:00Z');
    expect(unlockRemainingMs(undefined, now)).toBeNull();
    expect(unlockRemainingMs(s(), now)).toBeNull();
    expect(unlockRemainingMs(s({ unlocked: true }), now)).toBeNull();
    expect(unlockRemainingMs(s({ unlocked: true, unlockedUntil: '2026-10-13T10:05:00Z' }), now)).toBe(300_000);
    expect(unlockRemainingMs(s({ unlocked: true, unlockedUntil: '2026-10-13T09:59:00Z' }), now)).toBe(0);
    expect(unlockRemainingMs(s({ unlocked: true, unlockedUntil: 'garbage' }), now)).toBeNull();
  });
});
