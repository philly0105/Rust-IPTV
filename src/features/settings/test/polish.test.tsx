import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/api/types';

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
const { RpcError } = await import('@/api/transport');
const { useToastStore } = await import('@/ui');
const { SAVED_VISIBLE_MS } = await import('../SettingsPage');

let current: Settings;

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  useToastStore.setState({ toasts: [] });
  current = settings();
  rpcMock.handlers['settings.get'] = () => current;
  rpcMock.handlers['settings.update'] = (a) => {
    current = { ...current, ...(a as { patch: Partial<Settings> }).patch };
    return current;
  };
  rpcMock.handlers['player.capabilities'] = () => ({ embeddedMpv: false });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('Settings save feedback', () => {
  it('says Saving while the update is in flight, then Saved, then fades', async () => {
    let release: (() => void) | undefined;
    rpcMock.handlers['settings.update'] = (a) =>
      new Promise((resolve) => {
        release = () => {
          current = { ...current, ...(a as { patch: Partial<Settings> }).patch };
          resolve(current);
        };
      });
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    const status = screen.getByTestId('settings-save-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.dataset['state']).toBe('idle');
    expect(status.textContent).toBe('');

    fireEvent.click(screen.getByTestId('toggle-showCaptions'));
    await waitFor(() => expect(status.dataset['state']).toBe('saving'));
    expect(status.textContent).toBe('Saving…');

    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => release?.());
    await waitFor(() => expect(status.dataset['state']).toBe('saved'));
    expect(status.textContent).toBe('Saved');

    await act(async () => {
      vi.advanceTimersByTime(SAVED_VISIBLE_MS + 50);
    });
    expect(status.dataset['state']).toBe('idle');
  });

  it('a failed save clears the indicator and leaves the error toast to explain', async () => {
    rpcMock.handlers['settings.update'] = () => {
      throw new RpcError('io', 'read-only');
    };
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    fireEvent.click(screen.getByTestId('toggle-showCaptions'));
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.variant === 'error')).toBe(true));
    expect(screen.getByTestId('settings-save-status').dataset['state']).toBe('idle');
  });
});

describe('Segmented keyboard', () => {
  it('End and Home jump to the last and first option', async () => {
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('settings-general');
    const group = screen.getByRole('radiogroup', { name: 'Poster size' });
    const radios = within(group).getAllByRole('radio');
    const selected = radios.find((r) => r.getAttribute('aria-checked') === 'true')!;
    fireEvent.keyDown(selected, { key: 'End' });
    await waitFor(() => expect(rpcMock.callsOf('settings.update').at(-1)).toEqual({ patch: { coverSize: 'large' } }));
    fireEvent.keyDown(within(group).getByRole('radio', { checked: true }), { key: 'Home' });
    await waitFor(() => expect(rpcMock.callsOf('settings.update').at(-1)).toEqual({ patch: { coverSize: 'small' } }));
  });
});

describe('Shortcuts section matches the ? overlay', () => {
  it('lists documented shortcuts under translated area names', async () => {
    renderAt(settingsRoutes, '/settings/shortcuts');
    const section = await screen.findByTestId('settings-shortcuts');
    const headings = within(section)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual(expect.arrayContaining(['Everywhere', 'Live TV', 'Movies and series', 'Playback', 'Lists and dialogs']));
    expect(headings).not.toContain('Global');
    expect(headings.indexOf('Everywhere')).toBeLessThan(headings.indexOf('Playback'));
    // Bound only on other screens, yet still documented here.
    expect(within(section).getByText('Back 10 seconds')).toBeTruthy();
    expect(within(section).getByText('Exit picture in picture')).toBeTruthy();
    expect(within(section).getByText('Go back (movie and series grids and detail pages)')).toBeTruthy();
    expect(within(section).getByText('In the search box: clear it, then return to the list')).toBeTruthy();
  });
});

describe('Dashboard rails', () => {
  it('explains why the rail switches are disabled while the dashboard is off', async () => {
    current = { ...current, showDashboard: false };
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('settings-general');
    expect(screen.getByText('Turn on the dashboard to use these rows.')).toBeTruthy();
    expect((screen.getByTestId('toggle-rail-hero') as HTMLButtonElement).disabled).toBe(true);
  });
});

const validBackup = JSON.stringify({
  kind: 'iptvnator-playlist-backup',
  version: 1,
  includeSecrets: false,
  playlists: [{ portalType: 'm3u' }],
});

function pick(text: string, name = 'backup.json') {
  // jsdom's File has no text(); the app reads with it, so give this one a body.
  const file = Object.assign(new File([text], name, { type: 'application/json' }), { text: async () => text });
  fireEvent.change(screen.getByTestId('backup-file-input'), { target: { files: [file] } });
}

describe('Backup import errors', () => {
  it('rejects a file that is not JSON inline, before calling the core', async () => {
    renderAt(settingsRoutes, '/settings/backup');
    await screen.findByTestId('settings-backup');
    pick('not json');
    expect(await screen.findByText("This file isn't valid JSON.")).toBeTruthy();
    expect((screen.getByTestId('backup-import') as HTMLButtonElement).disabled).toBe(true);
    expect(rpcMock.callsOf('backup.import')).toHaveLength(0);
  });

  it('rejects a file over 50 MB without reading it', async () => {
    renderAt(settingsRoutes, '/settings/backup');
    await screen.findByTestId('settings-backup');
    const big = new File(['x'], 'huge.json', { type: 'application/json' });
    Object.defineProperty(big, 'size', { value: 60 * 1024 * 1024 });
    const text = vi.fn(async () => '{}');
    fireEvent.change(screen.getByTestId('backup-file-input'), { target: { files: [Object.assign(big, { text })] } });
    expect(await screen.findByText('This file is over 50 MB.')).toBeTruthy();
    expect(text).not.toHaveBeenCalled();
  });

  it('shows a failed import with a retry that sends the same file again', async () => {
    let attempts = 0;
    rpcMock.handlers['backup.import'] = () => {
      attempts += 1;
      if (attempts === 1) throw new RpcError('io', 'disk full');
      return { imported: 1, skipped: 0, warnings: [] };
    };
    renderAt(settingsRoutes, '/settings/backup');
    await screen.findByTestId('settings-backup');
    pick(validBackup);
    await screen.findByTestId('backup-summary');
    fireEvent.click(screen.getByTestId('backup-import'));

    const alert = await screen.findByTestId('backup-import-error');
    expect(alert.textContent).toContain('disk full');
    fireEvent.click(screen.getByTestId('backup-import-retry'));
    await screen.findByTestId('backup-result');
    expect(rpcMock.callsOf('backup.import')).toEqual([
      { json: validBackup, mode: 'merge' },
      { json: validBackup, mode: 'merge' },
    ]);
    expect(screen.queryByTestId('backup-import-error')).toBeNull();
  });
});
