/**
 * Every settings section route renders exactly one h1, in every state, and its
 * text equals the title the page puts in the shell header (C16).
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { eagerRoutes, installDomStubs, pending, renderAt, rpcMock, settings } from '../../sources/test/harness';
import { SECTION_IDS } from '../sections/types';

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

const settingsRoutes = await eagerRoutes((await import('../routes')).settingsRoutes);
const { RpcError } = await import('@/api/transport');
const { useShellStore } = await import('@/shell');

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  useShellStore.setState({ header: null });
  rpcMock.handlers['settings.get'] = () => settings();
  rpcMock.handlers['player.capabilities'] = () => ({ embeddedMpv: false, reason: 'not built' });
  rpcMock.handlers['downloads.dir'] = () => ({ path: 'C:/Users/me/AppData/Roaming/tsrust-iptv/downloads' });
});
afterEach(cleanup);

/** Exactly one h1, and it reads the same as the header title. */
async function expectSingleH1() {
  await waitFor(() => expect(useShellStore.getState().header?.title).toBe('Settings'));
  const h1s = screen.getAllByRole('heading', { level: 1 });
  expect(h1s).toHaveLength(1);
  expect(h1s[0]!.textContent).toBe(useShellStore.getState().header?.title);
}

describe.each(SECTION_IDS)('/settings/%s has one h1', (id) => {
  it('with content', async () => {
    renderAt(settingsRoutes, `/settings/${id}`);
    await screen.findByTestId(`settings-${id}`);
    await expectSingleH1();
  });
});

describe('settings page states have one h1', () => {
  it('while loading', async () => {
    rpcMock.handlers['settings.get'] = pending;
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('settings-loading');
    await expectSingleH1();
  });

  it('on error', async () => {
    rpcMock.handlers['settings.get'] = () => {
      throw new RpcError('io', 'disk unreadable');
    };
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('settings-error');
    await expectSingleH1();
  });

  it('after the /settings redirect', async () => {
    renderAt(settingsRoutes, '/settings');
    await screen.findByTestId('settings-general');
    await expectSingleH1();
  });
});
