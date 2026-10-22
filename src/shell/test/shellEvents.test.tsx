import { act, cleanup } from '@testing-library/react';
import { Outlet } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient, rpcKey, type RpcCommand } from '@/api/query';
import type { AppEvent, Settings } from '@/api/types';
import { useToastStore } from '@/ui';

import { renderRoutes, rpcMock, settings } from './harness';

type ConnState = 'connecting' | 'open' | 'closed';

/** A fake event bus that dispatches like api/events: every onAnyAppEvent handler first, then the typed ones. */
const bus = vi.hoisted(() => ({
  any: new Set<(e: AppEvent) => void>(),
  typed: new Map<string, Set<(p: unknown) => void>>(),
  state: new Set<(s: ConnState) => void>(),
  current: 'connecting' as ConnState,
}));

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
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
  onConnectionState: (h: (s: ConnState) => void) => {
    bus.state.add(h);
    h(bus.current);
    return () => bus.state.delete(h);
  },
}));

const { EVENT_INVALIDATION, useShellEvents } = await import('../effects');
const { BACK_ONLINE_MS, ConnectionBanner, ConnectionWatcher, OFFLINE_GRACE_MS, useConnectionStore } = await import('../connection');

function emit(type: string, payload: unknown): void {
  act(() => {
    for (const h of bus.any) h({ type, payload } as AppEvent);
    for (const h of bus.typed.get(type) ?? []) h(payload);
  });
}

function setConnection(s: ConnState): void {
  act(() => {
    bus.current = s;
    for (const h of bus.state) h(s);
  });
}

function Layout() {
  useShellEvents();
  return <Outlet />;
}

function mount(): void {
  renderRoutes([{ path: '/', element: <Layout />, children: [{ index: true, element: <div>home</div> }] }], '/');
}

const connectionToast = () => useToastStore.getState().toasts.find((t) => t.id === 'connection');
const scheduleKey = rpcKey('sources.schedule');
const scheduleInvalidated = () => queryClient.getQueryState(scheduleKey)?.isInvalidated ?? false;

beforeEach(() => {
  rpcMock.reset();
  bus.current = 'connecting';
  useToastStore.getState().clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('settings.changed: refresh interval', () => {
  it('no longer refetches the schedule on every settings.changed', () => {
    expect(EVENT_INVALIDATION['settings.changed']).toBeUndefined();
  });

  it('invalidates sources.schedule only when the refresh interval changed', () => {
    mount();
    queryClient.setQueryData(rpcKey('settings.get'), settings({ sourceRefreshIntervalHours: 12 }));
    queryClient.setQueryData(scheduleKey, { sources: [] });

    // A lastRoute write: the payload reaches the cache first (bindEventInvalidation), the interval did not move.
    emit('settings.changed', settings({ sourceRefreshIntervalHours: 12, lastRoute: '/live' }));
    expect(queryClient.getQueryData<Settings>(rpcKey('settings.get'))?.lastRoute).toBe('/live');
    expect(scheduleInvalidated()).toBe(false);

    emit('settings.changed', settings({ sourceRefreshIntervalHours: 24, lastRoute: '/live' }));
    expect(scheduleInvalidated()).toBe(true);
  });

  it('takes the first settings.changed before settings load as the baseline', () => {
    mount();
    queryClient.setQueryData(scheduleKey, { sources: [] });

    emit('settings.changed', settings({ sourceRefreshIntervalHours: 24 }));
    expect(scheduleInvalidated()).toBe(false);

    emit('settings.changed', settings({ sourceRefreshIntervalHours: 0 }));
    expect(scheduleInvalidated()).toBe(true);
  });
});

describe('settings.changed: live quality filter', () => {
  const FILTERED = ['catalog.channels', 'favorites.list', 'recent.list', 'lists.items', 'epg.search', 'live.alternates'] as const;
  const stale = (cmd: RpcCommand) => queryClient.getQueryState(rpcKey(cmd))?.isInvalidated ?? false;
  const seed = () => {
    for (const cmd of [...FILTERED, 'epg.grid'] as const) queryClient.setQueryData(rpcKey(cmd), {});
  };

  it('refetches every list the core filters when the minimum or the untagged toggle changes', async () => {
    mount();
    queryClient.setQueryData(rpcKey('settings.get'), settings());
    seed();

    emit('settings.changed', settings({ liveMinQuality: 'fhd' }));
    for (const cmd of FILTERED) await vi.waitFor(() => expect(stale(cmd), cmd).toBe(true));
    // epg.search is matched exactly: the guide windows stay.
    expect(stale('epg.grid')).toBe(false);

    seed();
    emit('settings.changed', settings({ liveMinQuality: 'fhd', liveHideUntagged: true }));
    await vi.waitFor(() => expect(stale('catalog.channels')).toBe(true));
  });

  it('still refetches after the optimistic cache write of the new value', async () => {
    mount();
    queryClient.setQueryData(rpcKey('settings.get'), settings());
    seed();

    // useUpdateSettings writes the cache first; the core's echo follows.
    queryClient.setQueryData(rpcKey('settings.get'), settings({ liveMinQuality: 'hd' }));
    emit('settings.changed', settings({ liveMinQuality: 'hd' }));
    await vi.waitFor(() => expect(stale('catalog.channels')).toBe(true));

    seed();
    queryClient.setQueryData(rpcKey('settings.get'), settings({ liveMinQuality: null }));
    emit('settings.changed', settings({ liveMinQuality: null }));
    await vi.waitFor(() => expect(stale('favorites.list')).toBe(true));
  });

  it('takes the first value as the baseline and ignores a lastRoute write', () => {
    mount();
    seed();

    // Before settings load: the first event is the baseline, even with a minimum set.
    emit('settings.changed', settings({ liveMinQuality: 'uhd' }));
    emit('settings.changed', settings({ liveMinQuality: 'uhd', lastRoute: '/live' }));
    expect(FILTERED.filter(stale)).toEqual([]);
  });

  it('ignores the untagged toggle while no minimum is set', () => {
    mount();
    queryClient.setQueryData(rpcKey('settings.get'), settings());
    seed();

    emit('settings.changed', settings({ liveHideUntagged: true }));
    expect(FILTERED.filter(stale)).toEqual([]);
  });
});

describe('downloads.update (XB2-33)', () => {
  it('refetches the download and My videos lists, not the download folder', async () => {
    expect(EVENT_INVALIDATION['downloads.update']).toBeUndefined();
    mount();
    const stale = (cmd: 'downloads.list' | 'downloads.dir' | 'myvideos.list') => queryClient.getQueryState(rpcKey(cmd))?.isInvalidated ?? false;
    queryClient.setQueryData(rpcKey('downloads.list'), []);
    queryClient.setQueryData(rpcKey('downloads.dir'), { path: 'D:/Videos' });
    queryClient.setQueryData(rpcKey('myvideos.list'), []);

    emit('downloads.update', {});
    // Events are batched into one refetch round per burst.
    await vi.waitFor(() => expect(stale('downloads.list')).toBe(true));
    expect(stale('myvideos.list')).toBe(true);
    expect(stale('downloads.dir')).toBe(false);
  });
});

describe('epg.changed (EP-2)', () => {
  it('keeps guide windows on a status-only change and refetches them on a data change', async () => {
    expect(EVENT_INVALIDATION['epg.changed']).toBeUndefined();
    mount();
    const stale = (cmd: 'epg.sources' | 'epg.grid' | 'epg.nowNext') => queryClient.getQueryState(rpcKey(cmd))?.isInvalidated ?? false;
    queryClient.setQueryData(rpcKey('epg.sources'), []);
    queryClient.setQueryData(rpcKey('epg.grid'), {});
    queryClient.setQueryData(rpcKey('epg.nowNext'), {});

    // A refresh starting (or a 304): only the url's status moved.
    emit('epg.changed', { reason: 'status' });
    await vi.waitFor(() => expect(stale('epg.sources')).toBe(true));
    expect(stale('epg.grid')).toBe(false);
    expect(stale('epg.nowNext')).toBe(false);

    emit('epg.changed', {});
    await vi.waitFor(() => expect(stale('epg.grid')).toBe(true));
    expect(stale('epg.nowNext')).toBe(true);
  });
});

describe('offline strip (web, SH-offline-stack)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  function mountWithStrip(): void {
    function StripLayout() {
      useShellEvents();
      return (
        <>
          <ConnectionWatcher />
          <ConnectionBanner />
          <Outlet />
        </>
      );
    }
    renderRoutes([{ path: '/', element: <StripLayout />, children: [{ index: true, element: <div>home</div> }] }], '/');
  }
  const strip = () => document.querySelector<HTMLElement>('[data-testid="connection-banner"]');

  it('shows after 3 s when the page never connected, says "Back online" once it opens, and toasts nothing', () => {
    mountWithStrip();
    setConnection('closed');
    act(() => vi.advanceTimersByTime(OFFLINE_GRACE_MS - 1));
    expect(strip()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(strip()?.dataset['state']).toBe('offline');
    expect(strip()?.getAttribute('role')).toBe('status');
    expect(strip()?.textContent).toContain('Lost connection to the server');
    expect(useConnectionStore.getState().offline).toBe(true);
    // One surface for the outage: no toast stacked on top of it.
    expect(connectionToast()).toBeUndefined();

    setConnection('open');
    expect(strip()?.dataset['state']).toBe('online');
    expect(strip()?.textContent).toContain('Back online');
    expect(useConnectionStore.getState().offline).toBe(false);
    act(() => vi.advanceTimersByTime(BACK_ONLINE_MS));
    expect(strip()).toBeNull();
  });

  it('stays quiet when the socket opens within 3 s', () => {
    mountWithStrip();
    setConnection('closed');
    act(() => vi.advanceTimersByTime(2000));
    setConnection('open');
    act(() => vi.advanceTimersByTime(5000));
    expect(strip()).toBeNull();
    expect(connectionToast()).toBeUndefined();
  });

  it('reconnect attempts during one outage keep one strip up', () => {
    mountWithStrip();
    setConnection('open');
    setConnection('closed');
    act(() => vi.advanceTimersByTime(OFFLINE_GRACE_MS));
    expect(strip()).not.toBeNull();
    setConnection('connecting');
    setConnection('closed');
    act(() => vi.advanceTimersByTime(10_000));
    expect(document.querySelectorAll('[data-testid="connection-banner"]')).toHaveLength(1);
    expect(strip()?.dataset['state']).toBe('offline');
  });
});
