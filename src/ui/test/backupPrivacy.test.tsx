/**
 * backup-not-safe-to-share: a backup without secrets still holds playlist and guide URLs, the
 * playlist text and Stalker MACs, which can be logins. Settings > Backup no longer calls the file
 * safe to share, says so on every export (switch off or on), and the switch names what it adds.
 */

import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { eagerRoutes, installDomStubs, renderAt, rpcMock, settings } from '@/features/sources/test/harness';

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

const settingsRoutes = await eagerRoutes((await import('@/features/settings/routes')).settingsRoutes);

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  rpcMock.handlers['settings.get'] = () => settings();
  rpcMock.handlers['player.capabilities'] = () => ({ embeddedMpv: false });
  rpcMock.handlers['downloads.dir'] = () => ({ path: '/data/downloads' });
  rpcMock.handlers['epg.sources'] = () => [];
  rpcMock.handlers['sources.list'] = () => [];
});
afterEach(cleanup);

describe('backup export privacy', () => {
  it('never calls the file safe to share, and says it is private whichever way the switch is', async () => {
    renderAt(settingsRoutes, '/settings/backup');
    const toggle = await screen.findByTestId('toggle-include-secrets');
    const section = screen.getByTestId('settings-backup');

    // The switch says what it adds, and what leaving it off means.
    expect(
      screen.getByRole('switch', {
        name: 'Include Xtream and Stalker passwords and keys',
        description: 'When off, they are left out and must be entered again after an import.',
      }),
    ).toBe(toggle);
    expect(section.textContent).not.toMatch(/safe to share/i);
    const note = () => within(section).getByTestId('backup-privacy-note').textContent;
    expect(note()).toBe('Every backup keeps playlist URLs, guide URLs and Stalker MAC addresses, which can work as logins. Keep backup files private.');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { description: 'Anyone with this file can sign in to your providers. Keep it private.' })).toBe(toggle);
    expect(note()).toMatch(/Keep backup files private/);
    expect(section.textContent).not.toMatch(/safe to share/i);
  });
});
