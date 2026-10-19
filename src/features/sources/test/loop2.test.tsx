/**
 * Loop 2 fixes (2026-10-16): the add toast counts radio and formats the total, a first add
 * started from Home goes back there, and Edit checks new Xtream or Stalker details before saving.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
const { resetPendingRemovalsForTests } = await import('../lib/pendingRemoval');

const routes = () => [...sourcesRoutes, { path: '/', element: <div>home page</div> }, { path: 's/:id/live', element: <div>live page</div> }];
const dialog = () => screen.getByRole('dialog');
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(within(dialog()).getByLabelText(label, { selector: 'input,textarea' }), { target: { value } });
const lastToast = () => useToastStore.getState().toasts.at(-1);

const xtream = (id: string, over = {}) =>
  makeSource(id, {
    kind: 'xtream',
    name: 'Big provider',
    m3u: undefined,
    xtream: { serverUrl: 'http://xt.example.com:8080', username: 'alice', password: 'pw-secret' },
    ...over,
  });

beforeAll(installDomStubs);
beforeEach(() => {
  resetPendingRemovalsForTests();
  rpcMock.reset();
  localStorage.clear();
  useToastStore.getState().clear();
  resetProgressForTests();
});
afterEach(cleanup);

async function addSample(path: string) {
  rpcMock.handlers['sources.list'] = () => [];
  const view = renderAt(routes(), path);
  await screen.findByRole('dialog');
  type(/^Name/, 'Sample');
  type(/^Playlist URL/, 'lists.example.com/tv.m3u');
  fireEvent.click(screen.getByTestId('add-source-submit'));
  await waitFor(() => expect(rpcMock.callsOf('sources.add')).toHaveLength(1));
  return view;
}

describe('add toast total (L2-sources-home-6)', () => {
  it('counts radio and formats the number, so it matches the progress bar', async () => {
    rpcMock.handlers['sources.add'] = () =>
      makeSource('new', { name: 'Sample', channelCount: 19_500, radioCount: 500, movieCount: 60_000, seriesCount: 8_000 });
    await addSample('/sources?add=1');
    await waitFor(() => expect(lastToast()?.title).toBe('Added Sample'));
    expect(lastToast()?.description).toBe('88,000 items imported');
  });
});

describe('add toast for a source without live channels (F-VOD-ONLY-SOURCE)', () => {
  it('opens the source on its movies', async () => {
    rpcMock.handlers['sources.add'] = () => makeSource('vod', { name: 'Sample', channelCount: 0, radioCount: 0, movieCount: 1_200, seriesCount: 40 });
    const { router } = await addSample('/sources?add=1');
    await waitFor(() => expect(lastToast()?.title).toBe('Added Sample'));
    lastToast()?.action?.onClick();
    await waitFor(() => expect(router.state.location.pathname).toBe('/s/vod/movies'));
  });
});

describe('return after a first add (L2-sources-home-12)', () => {
  beforeEach(() => {
    rpcMock.handlers['sources.add'] = () => makeSource('new', { name: 'Sample' });
  });

  it('goes back to the page that opened Add', async () => {
    const { router } = await addSample('/sources?add=1&from=%2F');
    expect(await screen.findByText('home page')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
  });

  it('stays on Sources when Add closes without adding', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    const { router } = renderAt(routes(), '/sources?add=1&from=%2F');
    await screen.findByRole('dialog');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/sources');
    expect(router.state.location.search).toBe('');
  });

  it('ignores a return target that leaves the app', async () => {
    const { router } = await addSample('/sources?add=1&from=%2F%2Fevil.example.com');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/sources');
    expect(screen.queryByText('home page')).toBeNull();
  });
});

describe('edit checks new login details before saving (L2-sources-home-13)', () => {
  async function editPassword(password: string) {
    rpcMock.handlers['sources.list'] = () => [xtream('x')];
    rpcMock.handlers['sources.update'] = () => xtream('x');
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    type(/^Password/, password);
    fireEvent.click(screen.getByTestId('edit-source-save'));
  }

  it('keeps a refused password out of the source, and says why', async () => {
    rpcMock.handlers['xtream.test'] = () => ({ ok: false, message: 'HTTP 401 Unauthorized' });
    await editPassword('nope');
    const alert = await screen.findByTestId('edit-source-check-failed');
    expect(alert.textContent).toContain("These details didn't connect");
    expect(alert.textContent).toContain("The server didn't accept the login.");
    expect(rpcMock.callsOf('xtream.test')).toEqual([{ config: { serverUrl: 'http://xt.example.com:8080', username: 'alice', password: 'nope' } }]);
    expect(rpcMock.callsOf('sources.update')).toEqual([]);
    expect(screen.getByRole('dialog')).toBeTruthy();
    // The field that is wrong says so too.
    expect(within(dialog()).getByLabelText(/^Password/, { selector: 'input' }).getAttribute('aria-invalid')).toBe('true');
  });

  it('saves anyway on request, without a second check', async () => {
    rpcMock.handlers['xtream.test'] = () => ({ ok: false, message: 'HTTP 401 Unauthorized' });
    await editPassword('nope');
    fireEvent.click(await screen.findByTestId('edit-source-save-anyway'));
    await waitFor(() => expect(rpcMock.callsOf('sources.update')).toHaveLength(1));
    expect(rpcMock.callsOf('xtream.test')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('saves straight after a passing check', async () => {
    rpcMock.handlers['xtream.test'] = () => ({ ok: true, name: 'xt.example.com' });
    await editPassword('better');
    await waitFor(() => expect(rpcMock.callsOf('sources.update')).toHaveLength(1));
    expect(rpcMock.callsOf('xtream.test')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not check a change that leaves the login alone', async () => {
    rpcMock.handlers['sources.list'] = () => [xtream('x')];
    rpcMock.handlers['sources.update'] = () => xtream('x', { name: 'Renamed' });
    renderAt(routes(), '/sources');
    fireEvent.click(await screen.findByTestId('source-edit'));
    type(/^Name/, 'Renamed');
    fireEvent.click(screen.getByTestId('edit-source-save'));
    await waitFor(() => expect(rpcMock.callsOf('sources.update')).toHaveLength(1));
    expect(rpcMock.callsOf('xtream.test')).toEqual([]);
  });
});
