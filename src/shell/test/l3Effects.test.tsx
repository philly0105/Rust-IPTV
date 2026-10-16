/**
 * Loop 3 shell effects: the import toast names the two long saving steps (L3-import-ui-2), and a
 * sticky "didn't import" toast leaves once its source is gone (L3-desktop-9).
 */
import { act, cleanup } from '@testing-library/react';
import { Outlet } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClient, rpcKey } from '@/api/query';
import type { AppEvent, ImportProgressEvent } from '@/api/types';
import { useToastStore } from '@/ui';

import { makeSource, renderRoutes, rpcMock } from './harness';

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

const { importPhaseLabel, useShellEvents } = await import('../effects');

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

const s1 = makeSource('s1', { name: 'Night Portal', kind: 'm3u' });
const x1 = makeSource('x1', { name: 'Panel', kind: 'xtream' });

function mountEvents(): void {
  renderRoutes([{ path: '/', element: <EventsLayout />, children: [{ index: true, element: <div>home</div> }] }], '/');
  queryClient.setQueryData(rpcKey('sources.list'), [s1, x1]);
}

beforeEach(() => {
  rpcMock.reset();
  useToastStore.getState().clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.useRealTimers();
});

describe('import toast saving steps', () => {
  it('names each step with no count and an indeterminate bar', () => {
    mountEvents();
    progress({ sourceId: 's1', phase: 'saving', step: 'replacing', done: 0 });
    expect(importToast()?.description).toBe('Replacing the old catalog');
    expect(importToast()?.progress).toEqual({});
    progress({ sourceId: 's1', phase: 'saving', step: 'indexing', done: 88_000, total: 88_000 });
    expect(importToast()?.description).toBe('Building the search index');
    expect(importToast()?.progress).toEqual({});
  });

  it('looks as before when the core sends no step', () => {
    mountEvents();
    progress({ sourceId: 's1', phase: 'saving', done: 88_000, total: 88_000 });
    expect(importToast()?.description).toBe('Saving: 88,000 of 88,000');
    expect(importToast()?.progress).toEqual({ value: 88_000, max: 88_000 });
  });

  it('an unknown phase or step reads as a translated Saving, never a raw key', () => {
    const t = (key: string, o?: Record<string, string>) => (key === 'importPhase_saving' ? 'Saving' : (o?.defaultValue ?? key));
    expect(importPhaseLabel({ sourceId: 'x', phase: 'saving', step: 'vacuuming' as never, done: 0 }, t)).toBe('Saving');
    expect(importPhaseLabel({ sourceId: 'x', phase: 'compacting' as never, done: 0 }, t)).toBe('Saving');
    // A step only counts under the saving phase.
    expect(importPhaseLabel({ sourceId: 'x', phase: 'parsing', step: 'indexing', done: 0 }, (k) => k)).toBe('importPhase_parsing');
  });
});

describe('sticky import-error toasts', () => {
  it('leave once their source is removed, and only theirs', () => {
    mountEvents();
    progress({ sourceId: 's1', phase: 'error', done: 0, message: 'HTTP 404' });
    progress({ sourceId: 'x1', phase: 'error', done: 0, message: 'HTTP 404' });
    expect(importToast('s1')?.variant).toBe('error');
    act(() => void vi.advanceTimersByTime(60_000));
    expect(importToast('s1')).toBeDefined();
    // The source list refetched after sources.changed: s1 is gone, x1 still fails.
    act(() => void queryClient.setQueryData(rpcKey('sources.list'), [x1]));
    expect(importToast('s1')).toBeUndefined();
    expect(importToast('x1')?.variant).toBe('error');
  });

  it('a later import of the same source replaces it', () => {
    mountEvents();
    progress({ sourceId: 's1', phase: 'error', done: 0, message: 'HTTP 404' });
    progress({ sourceId: 's1', phase: 'fetching', done: 10 });
    expect(importToast()?.variant).toBe('info');
    progress({ sourceId: 's1', phase: 'done', done: 24 });
    expect(importToast()?.variant).toBe('success');
    // Removing the source later no longer reaches for the replaced toast.
    act(() => void queryClient.setQueryData(rpcKey('sources.list'), [x1]));
    expect(importToast()?.variant).toBe('success');
  });
});
