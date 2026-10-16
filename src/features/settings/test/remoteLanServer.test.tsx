/** Settings > Remote in server (PWA) mode: LAN pairing is desktop only, so it is explained and never queried. */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { eagerRoutes, installDomStubs, renderAt, rpcMock, settings } from '../../sources/test/harness';

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

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  // Even with the setting on (e.g. from a desktop profile), server mode shows no LAN controls.
  rpcMock.handlers['settings.get'] = () => settings({ remoteLanEnabled: true });
  rpcMock.handlers['remote.status'] = () => ({ running: true, url: 'http://127.0.0.1:7310/', port: 7310 });
});
afterEach(cleanup);

describe('Settings > Remote (server mode)', () => {
  it('explains why LAN pairing is unavailable and calls no pairing RPCs', async () => {
    renderAt(settingsRoutes, '/settings/remote');
    expect((await screen.findByTestId('remote-lan-server')).textContent).toContain('desktop app');
    expect(screen.queryByTestId('toggle-remote-lan')).toBeNull();
    expect(screen.queryByTestId('remote-pairing')).toBeNull();
    expect(rpcMock.callsOf('remote.pairingCode')).toEqual([]);
    expect(rpcMock.callsOf('remote.devices')).toEqual([]);
  });

  it('does not point to the phone panel from the loopback note (R-remote-F8)', async () => {
    renderAt(settingsRoutes, '/settings/remote');
    const note = await screen.findByText(/works only in a browser on this computer/);
    expect(note.textContent).not.toMatch(/Phones on this network/);
  });
});
