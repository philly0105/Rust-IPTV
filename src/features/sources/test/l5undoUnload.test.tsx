/**
 * Loop 5 (L4-settings-6): closing the add dialog after a failed first add schedules an undoable
 * removal of the source it left behind. If the page goes away inside the undo window, the removal
 * is sent at once with keepalive; a removal the user undid is not sent.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmDiscard, eagerRoutes, installDomStubs, renderAt, rpcMock } from './harness';

/** Every rpcRaw call with its options, to see which went out with keepalive. */
const raw = vi.hoisted(() => [] as { cmd: string; args: unknown; opts: unknown }[]);

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown, opts?: unknown) => {
    raw.push({ cmd, args, opts });
    return rpcMock.call(cmd, args);
  },
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));

const sourcesRoutes = await eagerRoutes((await import('../routes')).sourcesRoutes);
const { RpcError } = await import('@/api/transport');
const { useToastStore } = await import('@/ui');
const { resetProgressForTests } = await import('../lib/progress');
const { isRemovalPending, resetPendingRemovalsForTests } = await import('../lib/pendingRemoval');

const routes = () => [...sourcesRoutes, { path: 's/:id/live', element: <div>live page</div> }];
const dialog = () => screen.getByRole('dialog');
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(within(dialog()).getByLabelText(label, { selector: 'input,textarea' }), { target: { value } });

beforeAll(installDomStubs);
beforeEach(() => {
  resetPendingRemovalsForTests();
  rpcMock.reset();
  raw.length = 0;
  localStorage.clear();
  useToastStore.getState().clear();
  resetProgressForTests();
});
afterEach(cleanup);

/** A first add that fails and leaves source `new1` behind, then the dialog closed. */
async function failAddAndClose() {
  rpcMock.handlers['sources.list'] = () => [];
  rpcMock.handlers['sources.add'] = () => {
    throw new RpcError('not_found', 'HTTP 404 Not Found', false, { sourceId: 'new1' });
  };
  rpcMock.handlers['sources.remove'] = () => null;
  rpcMock.handlers['sources.restore'] = () => null;
  renderAt(routes(), '/sources?add=1&kind=m3u');
  await screen.findByRole('dialog');
  type(/^Name/, 'list');
  type(/^Playlist URL/, 'lists.example.com/missing.m3u');
  fireEvent.click(screen.getByTestId('add-source-submit'));
  await screen.findByTestId('add-source-retry-note');
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
  // Typed details: Cancel asks before dropping them (SS-1).
  confirmDiscard();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  // Waiting behind the undo window, nothing sent yet.
  expect(isRemovalPending('new1')).toBe(true);
  expect(rpcMock.callsOf('sources.remove')).toEqual([]);
}

describe('a failed add discarded just before the page goes away (L4-settings-6)', () => {
  it('sends the pending removal, once and with keepalive, when pagehide fires', async () => {
    await failAddAndClose();
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(rpcMock.callsOf('sources.remove')).toEqual([{ id: 'new1' }]));
    expect(raw.filter((c) => c.cmd === 'sources.remove')).toEqual([{ cmd: 'sources.remove', args: { id: 'new1' }, opts: { keepalive: true } }]);
    expect(isRemovalPending('new1')).toBe(false);
  });

  it('does not send a removal the user undid', async () => {
    await failAddAndClose();
    const undo = useToastStore.getState().toasts.find((t) => t.action)?.action;
    expect(undo).toBeDefined();
    act(() => undo!.onClick());
    expect(isRemovalPending('new1')).toBe(false);
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
      window.dispatchEvent(new Event('pagehide'));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(rpcMock.callsOf('sources.remove')).toEqual([]);
  });
});
