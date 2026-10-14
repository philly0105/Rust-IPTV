// Status cache and events (C2/C7): `parental.changed` becomes the cached
// status and refreshes what Hide mode filters; timed unlocks are re-checked
// when they run out.
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient } from '@/api/query';
import type { ParentalStatus } from '@/api/types';

import { lockNow, useParentalEvents, useParentalStatus } from '..';
import { catalogAffected, FILTERED_PREFIXES, hidesContent, STATUS_KEY, unlockRemainingMs } from '../status';
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

/** Seeds one cached query per prefix the core filters, plus the lock list, and returns their keys. */
function seedLists() {
  const keys = [
    ['catalog.channels', { sourceId: 'src1' }],
    ['favorites.list', null],
    ['recent.list', null],
    ['positions.continueWatching', null],
    ['watchlist.list', null],
    ['parental.locks', {}],
    ['epg.nowNext', null],
  ] as const;
  for (const k of keys) queryClient.setQueryData(k, []);
  const invalidated = (k: readonly unknown[]) => queryClient.getQueryState(k)?.isInvalidated ?? false;
  return { keys, invalidated };
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
    const { keys, invalidated } = seedLists();

    // Hide mode switches off (an unlock): every list the core filters refetches.
    act(() => emitEvent('parental.changed', s({ unlocked: true, unlockedUntil: new Date(Date.now() + 60_000).toISOString() })));
    expect(queryClient.getQueryData(STATUS_KEY)).toMatchObject({ unlocked: true });
    // Observers hear about cache writes on the next tick.
    await vi.waitFor(() => expect(result.current.data?.unlocked).toBe(true));
    for (const k of keys.slice(0, 6)) expect(invalidated(k), String(k[0])).toBe(true);
    // Unrelated queries are left alone.
    expect(invalidated(keys[6])).toBe(false);
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
    const { invalidated } = seedLists();
    // The core sends the same status after a lock-list change.
    act(() => emitEvent('parental.changed', s()));
    for (const p of FILTERED_PREFIXES) {
      const key = queryClient.getQueryCache().findAll().find((q) => String(q.queryKey[0]).startsWith(p))!.queryKey;
      expect(invalidated(key), p).toBe(true);
    }
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
