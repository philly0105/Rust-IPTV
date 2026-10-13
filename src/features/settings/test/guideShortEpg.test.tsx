import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/api/types';

import { eagerRoutes, installDomStubs, renderAt, rpcMock, settings } from '../../sources/test/harness';

// Guide slice: the `epgShortFallback` switch in Settings > Guide.

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

let current: Settings;
const patches = () => rpcMock.callsOf('settings.update').map((a) => (a as { patch: Record<string, unknown> }).patch);

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  current = settings();
  rpcMock.handlers['settings.get'] = () => current;
  rpcMock.handlers['settings.update'] = (a) => {
    current = { ...current, ...(a as { patch: Partial<Settings> }).patch };
    return current;
  };
  rpcMock.handlers['epg.sources'] = () => [];
  rpcMock.handlers['sources.list'] = () => [];
});
afterEach(cleanup);

describe('short guide fallback setting', () => {
  it('is on by default and saves when switched off and on again', async () => {
    renderAt(settingsRoutes, '/settings/epg');
    await screen.findByTestId('settings-epg');
    const sw = screen.getByTestId('toggle-epgShortFallback');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() => expect(patches()).toEqual([{ epgShortFallback: false }]));
    await waitFor(() => expect(screen.getByTestId('toggle-epgShortFallback').getAttribute('aria-checked')).toBe('false'));
    fireEvent.click(screen.getByTestId('toggle-epgShortFallback'));
    await waitFor(() => expect(patches()).toEqual([{ epgShortFallback: false }, { epgShortFallback: true }]));
  });
});
