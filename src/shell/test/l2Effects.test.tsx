import { act, cleanup } from '@testing-library/react';
import { Outlet } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient, rpcKey } from '@/api/query';
import type { AppEvent, ImportProgressEvent } from '@/api/types';
import { useToastStore } from '@/ui';

import { makeSource, renderRoutes, rpcMock, settings } from './harness';

/** Dispatches like api/events: every onAnyAppEvent handler first, then the typed ones. */
const bus = vi.hoisted(() => ({
  any: new Set<(e: AppEvent) => void>(),
  typed: new Map<string, Set<(p: unknown) => void>>(),
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
  onConnectionState: (h: (s: string) => void) => {
    h('open');
    return () => undefined;
  },
}));

const { IMPORT_TOAST_HOLD_GRACE_MS, holdImportToasts, importProgressText, useLastRoutePersistence, useShellEvents } = await import('../effects');

function progress(p: ImportProgressEvent): void {
  act(() => {
    for (const h of bus.any) h({ type: 'import.progress', payload: p } as AppEvent);
    for (const h of bus.typed.get('import.progress') ?? []) h(p);
  });
}

const importToast = (id = 's1') => useToastStore.getState().toasts.find((t) => t.id === `import-${id}`);

function EventsLayout() {
  useShellEvents();
  return <Outlet />;
}

/** Mounts the shell events on `/` with `s1` (an M3U source named Night Portal) in the sources cache. */
function mountEvents(): void {
  renderRoutes([{ path: '/', element: <EventsLayout />, children: [{ index: true, element: <div>home</div> }] }], '/');
  queryClient.setQueryData(rpcKey('sources.list'), [
    makeSource('s1', { name: 'Night Portal', kind: 'm3u' }),
    makeSource('x1', { name: 'Panel', kind: 'xtream' }),
  ]);
}

beforeEach(() => {
  rpcMock.reset();
  useToastStore.getState().clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('import toasts during a backup import', () => {
  it('holds every per-source toast back, and toasts again once the hold and its grace end', () => {
    mountEvents();
    // A refresh started before the backup: its progress toast goes with the next event.
    progress({ sourceId: 's1', phase: 'parsing', done: 50, total: 200 });
    expect(importToast()?.title).toBe('Importing Night Portal');

    const release = holdImportToasts();
    progress({ sourceId: 's1', phase: 'saving', done: 150, total: 200 });
    expect(importToast()).toBeUndefined();
    progress({ sourceId: 's1', phase: 'done', done: 200 });
    progress({ sourceId: 's2', phase: 'connecting', done: 0 });
    progress({ sourceId: 's2', phase: 'error', done: 0, message: 'HTTP 503' });
    progress({ sourceId: 's3', phase: 'cancelled', done: 0 });
    expect(useToastStore.getState().toasts).toHaveLength(0);

    // The backup RPC answered: events that trail its reply are still folded into the section's result.
    release();
    release(); // a second call is a no-op
    act(() => vi.advanceTimersByTime(IMPORT_TOAST_HOLD_GRACE_MS - 1));
    progress({ sourceId: 's1', phase: 'done', done: 200 });
    expect(importToast()).toBeUndefined();

    act(() => vi.advanceTimersByTime(1));
    progress({ sourceId: 's1', phase: 'done', done: 200 });
    expect(importToast()?.title).toBe('Night Portal is ready');
  });

  it('two overlapping holds keep toasts back until both end', () => {
    mountEvents();
    const a = holdImportToasts();
    const b = holdImportToasts();
    a();
    act(() => vi.advanceTimersByTime(IMPORT_TOAST_HOLD_GRACE_MS));
    progress({ sourceId: 's1', phase: 'done', done: 1 });
    expect(importToast()).toBeUndefined();
    b();
    act(() => vi.advanceTimersByTime(IMPORT_TOAST_HOLD_GRACE_MS));
    progress({ sourceId: 's1', phase: 'done', done: 1 });
    expect(importToast()).toBeDefined();
  });
});

describe('import progress line', () => {
  it('shows an M3U download as a size, not a raw byte count', () => {
    mountEvents();
    progress({ sourceId: 's1', phase: 'fetching', done: 1_050_283 });
    expect(importToast()?.description).toBe('Downloading: 1 MB');
    progress({ sourceId: 's1', phase: 'fetching', done: 1_050_283, total: 5 * 1024 * 1024 });
    expect(importToast()?.description).toBe('Downloading: 1 MB of 5 MB');
  });

  it('groups item counts in the user number format', () => {
    mountEvents();
    progress({ sourceId: 's1', phase: 'parsing', done: 12_345, total: 50_000 });
    expect(importToast()?.description).toBe('Reading the playlist: 12,345 of 50,000');
    progress({ sourceId: 's1', phase: 'saving', done: 1_234_567 });
    expect(importToast()?.description).toBe('Saving: 1,234,567');
  });

  it('counts, not bytes, for what Xtream and Stalker fetch; an uncached source fetching silently is a download', () => {
    const t = (key: string, o: Record<string, string>) => `${key}|${o.done}|${o.total ?? ''}`;
    expect(importProgressText({ sourceId: 'x', phase: 'fetching', done: 1500, message: 'Loading channels' }, 'stalker', 'P', 'en', t)).toBe(
      'importProgressCount|1,500|',
    );
    expect(importProgressText({ sourceId: 'x', phase: 'fetching', done: 0, message: 'account' }, 'xtream', 'P', 'en', t)).toBe('P');
    expect(importProgressText({ sourceId: 'x', phase: 'fetching', done: 3 * 1024 * 1024 }, undefined, 'P', 'en', t)).toBe('importProgressCount|3 MB|');
    expect(importProgressText({ sourceId: 'x', phase: 'fetching', done: 2048, message: 'Loading radio' }, undefined, 'P', 'en', t)).toBe(
      'importProgressCount|2,048|',
    );
    // Locale grouping (German uses dots).
    expect(importProgressText({ sourceId: 'x', phase: 'parsing', done: 12_345, total: 50_000 }, 'm3u', 'P', 'de', t)).toBe(
      'importProgressOf|12.345|50.000',
    );
  });
});

describe('lastRoute persistence', () => {
  function RouteLayout() {
    useLastRoutePersistence(true, undefined);
    return <Outlet />;
  }

  const routeWrites = () =>
    rpcMock.calls.filter((c) => c.cmd === 'settings.update').map((c) => (c.args as { patch: { lastRoute: string } }).patch.lastRoute);

  it('does not write while only the query changes (typing a search); saves it when the window hides', async () => {
    rpcMock.handlers['settings.update'] = (a) => settings({ lastRoute: (a as { patch: { lastRoute: string } }).patch.lastRoute });
    const { router } = renderRoutes(
      [{ path: '/', element: <RouteLayout />, children: [{ path: 'search', element: <div>search</div> }, { path: 'live', element: <div>live</div> }] }],
      '/search',
    );
    act(() => vi.advanceTimersByTime(1200));
    expect(routeWrites()).toEqual(['/search']);

    for (const q of ['d', 'du', 'dun', 'dune']) {
      await act(() => router.navigate(`/search?q=${q}`));
      act(() => vi.advanceTimersByTime(1500));
    }
    expect(routeWrites()).toEqual(['/search']);

    // Closing or hiding the window keeps the exact page, query included.
    act(() => void window.dispatchEvent(new Event('pagehide')));
    expect(routeWrites()).toEqual(['/search', '/search?q=dune']);

    // A new screen is saved on the debounce as before.
    await act(() => router.navigate('/live?group=news'));
    act(() => vi.advanceTimersByTime(1200));
    expect(routeWrites()).toEqual(['/search', '/search?q=dune', '/live?group=news']);
  });

  it('a screen change within the debounce saves only the newest path, query included', async () => {
    rpcMock.handlers['settings.update'] = (a) => settings({ lastRoute: (a as { patch: { lastRoute: string } }).patch.lastRoute });
    const { router } = renderRoutes(
      [{ path: '/', element: <RouteLayout />, children: [{ path: 'search', element: <div>search</div> }, { path: 'live', element: <div>live</div> }] }],
      '/live',
    );
    act(() => vi.advanceTimersByTime(1200));
    await act(() => router.navigate('/search'));
    act(() => vi.advanceTimersByTime(300));
    await act(() => router.navigate('/search?q=dune'));
    act(() => vi.advanceTimersByTime(1200));
    expect(routeWrites()).toEqual(['/live', '/search?q=dune']);
  });
});
