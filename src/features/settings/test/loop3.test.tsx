/**
 * The player list on Settings > Playback keeps its shape while `player.capabilities` loads
 * (L3-visual-10): no placeholder that pushes the list down and goes away again, and no row that
 * appears or vanishes once the answer arrives.
 */
import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlayerCapabilities } from '@/api/rpc';

import { eagerRoutes, installDomStubs, renderAt, rpcMock, settings } from '../../sources/test/harness';

const flags = vi.hoisted(() => ({ desktop: false }));

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  get isDesktop() {
    return flags.desktop;
  },
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));

const settingsRoutes = await eagerRoutes((await import('../routes')).settingsRoutes);

let answer!: (caps: PlayerCapabilities) => void;

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  flags.desktop = false;
  rpcMock.handlers['settings.get'] = () => settings();
  rpcMock.handlers['player.capabilities'] = () => new Promise<PlayerCapabilities>((r) => (answer = r));
});
afterEach(cleanup);

const radios = () => within(screen.getByRole('radiogroup', { name: 'Player' })).getAllByRole('radio') as HTMLInputElement[];
const values = () => radios().map((r) => r.value);

async function openPlayback() {
  renderAt(settingsRoutes, '/settings/playback');
  await screen.findByTestId('settings-playback');
  await vi.waitFor(() => expect(rpcMock.callsOf('player.capabilities')).toHaveLength(1));
}

describe('Settings > Playback while the player capabilities load (L3-visual-10)', () => {
  // The browser has one player: it is named as the one in use, not offered as a radio with nothing else to pick.
  it('browser: only the built-in player is listed, with no placeholder, and it stays put', async () => {
    await openPlayback();
    const only = screen.getByTestId('player-only');
    expect(only.textContent).toContain('Built-in player');
    expect(only.textContent).toContain('In use');
    expect(screen.queryByRole('radiogroup', { name: 'Player' })).toBeNull();
    expect(screen.getByTestId('settings-playback').querySelector('.animate-pulse')).toBeNull();
    await act(async () => answer({ embeddedMpv: false, vlcPath: 'C:/VLC/vlc.exe', reason: 'desktop app only' }));
    expect(screen.getByTestId('player-only')).toBe(only);
    expect(screen.queryByRole('radiogroup', { name: 'Player' })).toBeNull();
    expect(screen.queryByText(/wasn't found/)).toBeNull();
  });

  it('browser: a saved mpv or VLC (a desktop backup) shows the built-in player as chosen', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ player: 'vlc' });
    await openPlayback();
    await act(async () => answer({ embeddedMpv: false, reason: 'desktop app only' }));
    const only = screen.getByTestId('player-only');
    expect(only.textContent).toContain('Built-in player');
    expect(only.textContent).toContain('In use');
    expect(screen.queryByRole('radiogroup', { name: 'Player' })).toBeNull();
  });

  it('desktop: embedded mpv is listed and usable from the start', async () => {
    flags.desktop = true;
    await openPlayback();
    expect(values()).toEqual(['html5', 'embedded-mpv', 'mpv', 'vlc']);
    expect(screen.getByTestId('player-embedded-mpv')).toHaveProperty('disabled', false);
    await act(async () => answer({ embeddedMpv: true, mpvPath: 'C:/mpv/mpv.exe' }));
    await screen.findByText("VLC wasn't found. Set its path under External players.");
    expect(values()).toEqual(['html5', 'embedded-mpv', 'mpv', 'vlc']);
    expect(screen.getByTestId('player-embedded-mpv')).toHaveProperty('disabled', false);
  });

  it('desktop without mpv: the row stays, disabled, and says why', async () => {
    flags.desktop = true;
    await openPlayback();
    await act(async () => answer({ embeddedMpv: false, reason: 'mpv.exe was not found' }));
    await screen.findByText('mpv.exe was not found');
    expect(values()).toEqual(['html5', 'embedded-mpv', 'mpv', 'vlc']);
    const row = screen.getByTestId('player-embedded-mpv');
    expect(row).toHaveProperty('disabled', true);
    expect(row.closest('label')!.textContent).toContain('mpv.exe was not found');
  });
});
