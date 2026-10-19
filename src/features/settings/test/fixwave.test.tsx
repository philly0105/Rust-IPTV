import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/api/types';

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
const { useToastStore } = await import('@/ui');

let current: Settings;
const patches = () => rpcMock.callsOf('settings.update').map((a) => (a as { patch: Record<string, unknown> }).patch);

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  flags.desktop = false;
  useToastStore.setState({ toasts: [] });
  current = settings();
  rpcMock.handlers['settings.get'] = () => current;
  rpcMock.handlers['settings.update'] = (a) => {
    current = { ...current, ...(a as { patch: Partial<Settings> }).patch };
    return current;
  };
  rpcMock.handlers['player.capabilities'] = () => ({ embeddedMpv: false });
  rpcMock.handlers['downloads.dir'] = () => ({ path: 'C:\\Users\\me\\Downloads\\tsrust' });
  rpcMock.handlers['epg.sources'] = () => [];
  rpcMock.handlers['sources.list'] = () => [];
  rpcMock.handlers['app.info'] = () => ({ version: '0.1.0', dataDir: 'C:/data', platform: 'windows', isDesktop: false, logFile: 'C:/data/log.txt' });
});
afterEach(cleanup);

describe('Section nav below the shell panel breakpoint', () => {
  it('lists every section inline, hidden only from 1440 px (the shell inline-panel width)', async () => {
    const view = renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('settings-general');
    const wrap = screen.getByTestId('settings-nav-inline-wrap');
    expect(wrap.className).toContain('min-[1440px]:hidden');
    expect(wrap.className).not.toMatch(/(^|\s)lg:hidden/);
    const nav = within(wrap).getByTestId('settings-nav-inline');
    // Browser: no External players section (the desktop app lists all 12).
    expect(within(nav).getAllByRole('link')).toHaveLength(11);
    expect(within(nav).queryByRole('link', { name: 'External players' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'General' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(within(nav).getByRole('link', { name: 'About' }));
    await screen.findByTestId('settings-about');
    expect(view.router.state.location.pathname).toBe('/settings/about');
  });

  it('desktop lists External players; the browser sends its address to General', async () => {
    const view = renderAt(settingsRoutes, '/settings/players');
    await screen.findByTestId('settings-general');
    expect(view.router.state.location.pathname).toBe('/settings/general');
    cleanup();
    flags.desktop = true;
    renderAt(settingsRoutes, '/settings/players');
    await screen.findByTestId('settings-players');
    const nav = within(screen.getByTestId('settings-nav-inline-wrap')).getByTestId('settings-nav-inline');
    expect(within(nav).getAllByRole('link')).toHaveLength(12);
  });
});

describe('About: updates', () => {
  it('says updates are not configured when the build has no updater', async () => {
    renderAt(settingsRoutes, '/settings/about');
    expect(await screen.findByTestId('updates-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('updates-check')).toBeNull();
  });
});

describe('Parity settings', () => {
  it('Interface: hide country tags', async () => {
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('settings-general');
    const sw = screen.getByTestId('toggle-stripCountryPrefix');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => expect(patches()).toEqual([{ stripCountryPrefix: true }]));
  });

  it('Interface: English only', async () => {
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('settings-general');
    const sw = screen.getByTestId('toggle-englishOnly');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => expect(patches()).toEqual([{ englishOnly: true }]));
  });

  it('VOD: minimum rating saves on release, clamped to half steps', async () => {
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('settings-general');
    const slider = screen.getByTestId('input-vodMinRating');
    fireEvent.change(slider, { target: { value: '6.5' } });
    expect(patches()).toEqual([]);
    expect(screen.getByTestId('vodMinRating-value').textContent).toBe('6.5');
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(patches()).toEqual([{ vodMinRating: 6.5 }]));
  });

  it('Downloads: the recordings folder defaults inside downloads and is read-only in the browser', async () => {
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('settings-general');
    const shown = await screen.findByTestId('recordings-dir-path');
    await waitFor(() => expect(shown.textContent).toBe('C:\\Users\\me\\Downloads\\tsrust\\recordings'));
    expect(screen.getByText('Live recordings are saved to this folder on the server. Only the desktop app can change it.')).toBeTruthy();
    expect(screen.queryByTestId('input-recordingsDir')).toBeNull();
    cleanup();
    // A folder set in the desktop app (a shared data folder) is named as it is, with no reset.
    current = settings({ recordingsDir: 'D:\\Rec' });
    renderAt(settingsRoutes, '/settings/general');
    await waitFor(() => expect(screen.getByTestId('recordings-dir-path').textContent).toBe('D:\\Rec'));
    expect(screen.queryByTestId('recordings-dir-reset')).toBeNull();
    expect(patches()).toEqual([]);
  });

  it('Downloads: the desktop app resets a custom recordings folder', async () => {
    flags.desktop = true;
    current = settings({ recordingsDir: 'D:\\Rec' });
    renderAt(settingsRoutes, '/settings/general');
    fireEvent.click(await screen.findByTestId('recordings-dir-reset'));
    await waitFor(() => expect(patches()).toEqual([{ recordingsDir: null }]));
  });

  it('Players: reuse instance and external bar (desktop)', async () => {
    flags.desktop = true;
    renderAt(settingsRoutes, '/settings/players');
    await screen.findByTestId('settings-players');
    expect(screen.getByTestId('toggle-playerReuseInstance').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('toggle-showExternalBar').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('toggle-playerReuseInstance'));
    fireEvent.click(screen.getByTestId('toggle-showExternalBar'));
    await waitFor(() => expect(patches()).toEqual([{ playerReuseInstance: false }, { showExternalBar: false }]));
  });

  it('Guide: time shift validates and saves whole minutes', async () => {
    renderAt(settingsRoutes, '/settings/epg');
    await screen.findByTestId('settings-epg');
    const input = screen.getByTestId('input-epgOffsetMinutes') as HTMLInputElement;
    expect(input.value).toBe('0');
    fireEvent.change(input, { target: { value: '1000' } });
    fireEvent.blur(input);
    expect(await screen.findByText('Use a shift between -720 and 720 minutes (12 hours).')).toBeTruthy();
    // The field itself is marked, not only the message under it; its keypad has a minus sign.
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('inputmode')).toBe('text');
    fireEvent.change(input, { target: { value: '-30' } });
    fireEvent.blur(input);
    await waitFor(() => expect(patches()).toEqual([{ epgOffsetMinutes: -30 }]));
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBeNull());
  });

  it('Guide: clear all guide data asks first, then calls epg.clearAll', async () => {
    rpcMock.handlers['epg.clearAll'] = () => null;
    renderAt(settingsRoutes, '/settings/epg');
    await screen.findByTestId('settings-epg');
    fireEvent.click(screen.getByTestId('epg-clear-all'));
    expect(screen.getByRole('dialog').textContent).toContain('Clear all guide data?');
    expect(rpcMock.callsOf('epg.clearAll')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('epg-clear-confirm'));
    await waitFor(() => expect(rpcMock.callsOf('epg.clearAll')).toHaveLength(1));
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.title === 'Guide data cleared')).toBe(true));
  });
});

describe('Backup export (web)', () => {
  it('downloads through the browser', async () => {
    const created: string[] = [];
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = () => {
      created.push('blob');
      return 'blob:x';
    };
    URL.revokeObjectURL ??= () => undefined;
    rpcMock.handlers['backup.export'] = () => ({ json: '{}', fileName: 'b.json' });
    renderAt(settingsRoutes, '/settings/backup');
    fireEvent.click(await screen.findByTestId('backup-export'));
    await waitFor(() => expect(rpcMock.callsOf('backup.export')).toEqual([{ includeSecrets: false }]));
    await waitFor(() => expect(created).toHaveLength(1));
    URL.createObjectURL = origCreate;
  });
});
