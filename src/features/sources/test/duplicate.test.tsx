/**
 * Adding a source whose address is already a source (L1-sources-home-4): the core refuses it with
 * `conflict` and `details.existingSourceId`. The dialog says so and offers to open or refresh the
 * existing source, never treats it as a failed add of its own, and adds again once a removal of
 * that source the user can still undo has gone through.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RpcError } from '@/api/transport';

import { duplicateSourceId } from '../lib/errors';
import { eagerRoutes, installDomStubs, makeSource, renderAt, rpcMock } from './harness';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));

const sourcesRoutes = await eagerRoutes((await import('../routes')).sourcesRoutes);
const { useToastStore } = await import('@/ui');
const { resetProgressForTests } = await import('../lib/progress');
const { resetPendingRemovalsForTests, scheduleRemoval, isRemovalPending } = await import('../lib/pendingRemoval');

const routes = () => [...sourcesRoutes, { path: 's/:id/live', element: <div>live page</div> }];
const dialog = () => screen.getByRole('dialog');
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(within(dialog()).getByLabelText(label, { selector: 'input,textarea' }), { target: { value } });

const duplicate = () => new RpcError('conflict', 'A source with this address already exists.', false, { existingSourceId: 'old' });

beforeAll(installDomStubs);
beforeEach(() => {
  resetPendingRemovalsForTests();
  rpcMock.reset();
  localStorage.clear();
  useToastStore.getState().clear();
  resetProgressForTests();
  rpcMock.handlers['sources.list'] = () => [makeSource('old', { name: 'Sample' })];
});
afterEach(cleanup);

async function addDuplicate() {
  const view = renderAt(routes(), '/sources?add=1');
  await screen.findByRole('dialog');
  type(/^Name/, 'Sample again');
  type(/^Playlist URL/, 'lists.example.com/tv.m3u');
  fireEvent.click(screen.getByTestId('add-source-submit'));
  await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(1));
  return view;
}

describe('duplicateSourceId', () => {
  it('reads the existing source only from a conflict that is not a cancelled run', () => {
    expect(duplicateSourceId(duplicate())).toBe('old');
    expect(duplicateSourceId(new RpcError('conflict', 'stopped', false, { existingSourceId: 'old', cancelled: true }))).toBeNull();
    expect(duplicateSourceId(new RpcError('conflict', 'stopped', false, { sourceId: 'new1' }))).toBeNull();
    expect(duplicateSourceId(new RpcError('network', 'down', false, { existingSourceId: 'old' }))).toBeNull();
  });
});

describe('adding a source that already exists (L1-sources-home-4)', () => {
  beforeEach(() => {
    rpcMock.handlers['sources.add'] = () => {
      throw duplicate();
    };
  });

  it('says it exists and offers Open and Refresh instead of a retry, leaving the existing source alone', async () => {
    await addDuplicate();
    const alert = await screen.findByTestId('add-source-error');
    // L3-app-7: it names the source it duplicates, once, with Open and Refresh before the technical details.
    expect(alert.textContent).toContain('Already added as "Sample"');
    expect(alert.textContent).not.toContain('This source already exists.');
    expect(alert.textContent).not.toContain('A source with these details already exists.');
    const open = within(alert).getByTestId('add-source-open-existing');
    const details = alert.querySelector('details')!;
    expect(open.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(alert).queryByTestId('add-source-retry')).toBeNull();
    expect(within(alert).queryByTestId('add-source-retry-note')).toBeNull();
    // Not a failed add: the footer still adds, and nothing is scheduled for removal.
    expect(screen.getByTestId('add-source-submit').textContent).toBe('Add source');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(isRemovalPending('old')).toBe(false);
    expect(rpcMock.callsOf('sources.remove')).toEqual([]);
  });

  it('Open goes to the existing source', async () => {
    const { router } = await addDuplicate();
    fireEvent.click(await screen.findByTestId('add-source-open-existing'));
    expect(await screen.findByText('live page')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/s/old/live');
  });

  it('Refresh refreshes the existing source and closes', async () => {
    rpcMock.handlers['sources.refresh'] = () => makeSource('old', { name: 'Sample' });
    const { router } = await addDuplicate();
    fireEvent.click(await screen.findByTestId('add-source-refresh-existing'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rpcMock.callsOf('sources.refresh')).toEqual([{ id: 'old' }]);
    expect(router.state.location.pathname).toBe('/sources');
  });

  it('adds again once a pending removal of the existing source went through', async () => {
    let removed = false;
    rpcMock.handlers['sources.remove'] = () => {
      removed = true;
    };
    rpcMock.handlers['sources.add'] = () => {
      if (!removed) throw duplicate();
      return makeSource('new', { name: 'Sample again' });
    };
    scheduleRemoval({ id: 'old', toast: { title: 'Removed Sample' }, undoLabel: 'Undo', remove: async () => {
        await rpcMock.call('sources.remove', { id: 'old' });
      },
    });
    await addDuplicate();
    await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rpcMock.callsOf('sources.remove')).toEqual([{ id: 'old' }]);
    expect(screen.queryByTestId('add-source-error')).toBeNull();
  });
});
