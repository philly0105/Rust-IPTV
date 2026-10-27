/**
 * Home's first-run welcome: one privacy line (the onboarding's own), and the shell's import
 * toasts held back while its Add source dialog reports the import itself.
 */

import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { Outlet } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { queryClient, rpcKey } from '@/api/query';
import type { AppEvent, ImportProgressEvent } from '@/api/types';
import { useToastStore } from '@/ui';

import { makeSource, renderRoutes, rpcMock } from '../../test/harness';

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
// The dialog itself (forms, import progress) is the sources feature's; a stand-in that can close.
vi.mock('@/features/sources/components/AddSourceDialog', () => ({
  AddSourceDialog: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div role="dialog" aria-label="Add a source">
        <button type="button" onClick={onClose}>
          Close dialog
        </button>
      </div>
    ) : null,
}));

const { IMPORT_TOAST_HOLD_GRACE_MS, useShellEvents } = await import('../../effects');
const { Welcome } = await import('../Welcome');

function progress(p: ImportProgressEvent): void {
  act(() => {
    for (const h of bus.any) h({ type: 'import.progress', payload: p } as AppEvent);
    for (const h of bus.typed.get('import.progress') ?? []) h(p);
  });
}
const importToast = () => useToastStore.getState().toasts.find((t) => t.id === 'import-s1');

function EventsLayout() {
  useShellEvents();
  return <Outlet />;
}

beforeEach(() => {
  rpcMock.reset();
  useToastStore.getState().clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Home welcome', () => {
  it('says once where the logins stay: the onboarding line, with no second privacy sentence under it', async () => {
    renderRoutes([{ path: '/', element: <Welcome /> }], '/');
    await screen.findByTestId('dashboard-welcome');
    expect(screen.getByText(/only sent to your provider/)).toBeTruthy();
    expect(screen.queryByText(/stay on your Tsrust server|stay on this computer/)).toBeNull();
  });

  it("lays the tiles right under the lead: the Sources page's full-window height and centring are cancelled", async () => {
    renderRoutes([{ path: '/', element: <Welcome /> }], '/');
    const section = await screen.findByTestId('sources-onboarding');
    // The block fills the window and centres itself on the Sources page (an @2xl min-height and
    // justify-center); inside the welcome that left a 250 px band above the tiles.
    const wrapper = section.parentElement!;
    expect(wrapper.className).toContain('[&>section]:min-h-0');
    expect(wrapper.className).toContain('[&>section]:justify-start');
    expect(wrapper.className).toContain('[&>section]:py-0');
  });

  it('holds the shell import toasts while its add dialog is open: no progress over it, no second success', async () => {
    renderRoutes([{ path: '/dashboard', element: <EventsLayout />, children: [{ index: true, element: <Welcome /> }] }], '/dashboard');
    queryClient.setQueryData(rpcKey('sources.list'), [makeSource('s1', { name: 'Night Portal', kind: 'm3u' })]);
    fireEvent.click(await screen.findByTestId('onboard-m3u'));
    const close = await screen.findByRole('button', { name: 'Close dialog' });
    progress({ sourceId: 's1', phase: 'parsing', done: 50, total: 200 });
    progress({ sourceId: 's1', phase: 'done', done: 200 });
    expect(useToastStore.getState().toasts).toHaveLength(0);

    // Closed (Close, keep importing): after the grace the shell reports the import again.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(close);
    act(() => vi.advanceTimersByTime(IMPORT_TOAST_HOLD_GRACE_MS));
    progress({ sourceId: 's1', phase: 'parsing', done: 60, total: 200 });
    expect(importToast()?.title).toBe('Importing Night Portal');
  });
});
