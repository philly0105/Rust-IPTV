/** Settings in server (PWA) mode: hints that speak of the tray belong to the desktop app only. */

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
  rpcMock.handlers['settings.get'] = () => settings();
});
afterEach(cleanup);

describe('tray wording (server mode)', () => {
  it('Refresh sources keeps what it applies to and drops the tray', async () => {
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('select-sourceRefreshIntervalHours');
    expect(screen.getByText('For sources with auto refresh on.')).toBeTruthy();
    expect(screen.queryByText(/tray/)).toBeNull();
  });

  it('Guide reminders say they alert while the app is open, with no tray', async () => {
    renderAt(settingsRoutes, '/settings/recording');
    await screen.findByTestId('reminders-enabled');
    expect(screen.getByText('Alerts you before a programme you picked in the guide, while the app is open.')).toBeTruthy();
    expect(screen.queryByText(/tray/)).toBeNull();
  });
});
