import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/api/types';

import { eagerRoutes, installDomStubs, renderAt, rpcMock, settings } from '../../sources/test/harness';

const tauri = vi.hoisted(() => ({
  save: vi.fn<(opts: unknown) => Promise<string | null>>(),
  check: vi.fn<(opts?: unknown) => Promise<unknown>>(),
}));

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: true,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: tauri.save, open: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: tauri.check }));

const settingsRoutes = await eagerRoutes((await import('../routes')).settingsRoutes);
const { useToastStore } = await import('@/ui');

let current: Settings;
const info = (updaterAvailable?: boolean) => ({
  version: '0.1.0',
  dataDir: 'C:/data',
  platform: 'windows',
  isDesktop: true,
  logFile: 'C:/data/log.txt',
  ...(updaterAvailable === undefined ? {} : { updaterAvailable }),
});

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  tauri.save.mockReset();
  tauri.check.mockReset();
  useToastStore.setState({ toasts: [] });
  current = settings();
  rpcMock.handlers['settings.get'] = () => current;
  rpcMock.handlers['app.info'] = () => info(true);
});
afterEach(cleanup);

describe('About: updates (desktop)', () => {
  it('without updaterAvailable it says updates are not configured and never calls check()', async () => {
    rpcMock.handlers['app.info'] = () => info();
    renderAt(settingsRoutes, '/settings/about');
    expect(await screen.findByTestId('updates-unavailable')).toBeTruthy();
    expect(tauri.check).not.toHaveBeenCalled();
  });

  it('reports the latest version when check() finds nothing', async () => {
    tauri.check.mockResolvedValue(null);
    renderAt(settingsRoutes, '/settings/about');
    fireEvent.click(await screen.findByTestId('updates-check'));
    expect(await screen.findByTestId('updates-current')).toBeTruthy();
  });

  it('shows version and notes, then downloads and installs with progress', async () => {
    let finish: () => void = () => undefined;
    const downloadAndInstall = vi.fn((onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 40 } });
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    tauri.check.mockResolvedValue({ version: '0.2.0', currentVersion: '0.1.0', body: 'Faster guide loading', downloadAndInstall });
    renderAt(settingsRoutes, '/settings/about');
    fireEvent.click(await screen.findByTestId('updates-check'));
    const available = await screen.findByTestId('updates-available');
    expect(available.textContent).toContain('Version 0.2.0 is available');
    expect(screen.getByTestId('updates-notes').textContent).toBe('Faster guide loading');
    fireEvent.click(screen.getByTestId('updates-install'));
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40'));
    finish();
    expect(await screen.findByTestId('updates-installed')).toBeTruthy();
    expect(screen.getByTestId('updates-installed').textContent).toContain('restarts');
  });

  it('shows a check failure', async () => {
    tauri.check.mockRejectedValue(new Error('endpoint unreachable'));
    renderAt(settingsRoutes, '/settings/about');
    fireEvent.click(await screen.findByTestId('updates-check'));
    expect((await screen.findByTestId('updates-error')).textContent).toContain('endpoint unreachable');
  });
});

describe('Backup export (desktop)', () => {
  it('asks for a path with the native save dialog and lets the core write the file', async () => {
    tauri.save.mockResolvedValue('D:\\Backups\\mine.json');
    rpcMock.handlers['backup.export'] = () => ({ json: '', fileName: 'D:\\Backups\\mine.json' });
    renderAt(settingsRoutes, '/settings/backup');
    fireEvent.click(await screen.findByTestId('backup-export'));
    await waitFor(() => expect(rpcMock.callsOf('backup.export')).toEqual([{ includeSecrets: false, path: 'D:\\Backups\\mine.json' }]));
    expect(tauri.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: expect.stringMatching(/^tsrust-iptv-backup-.*\.json$/) }));
    await waitFor(() => expect(useToastStore.getState().toasts[0]?.description).toBe('D:\\Backups\\mine.json'));
  });

  it('does nothing when the dialog is canceled', async () => {
    tauri.save.mockResolvedValue(null);
    renderAt(settingsRoutes, '/settings/backup');
    fireEvent.click(await screen.findByTestId('backup-export'));
    await waitFor(() => expect(tauri.save).toHaveBeenCalled());
    expect(rpcMock.callsOf('backup.export')).toHaveLength(0);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('falls back to a browser download when the core returns the JSON instead of writing', async () => {
    const origCreate = URL.createObjectURL;
    const created: string[] = [];
    URL.createObjectURL = () => {
      created.push('blob');
      return 'blob:x';
    };
    URL.revokeObjectURL ??= () => undefined;
    tauri.save.mockResolvedValue('D:\\Backups\\mine.json');
    rpcMock.handlers['backup.export'] = () => ({ json: '{"kind":"iptvnator-playlist-backup"}', fileName: 'b.json' });
    renderAt(settingsRoutes, '/settings/backup');
    fireEvent.click(await screen.findByTestId('backup-export'));
    await waitFor(() => expect(created).toHaveLength(1));
    URL.createObjectURL = origCreate;
  });
});

describe('tray wording (desktop)', () => {
  it('Refresh sources and guide reminders say they keep working from the tray', async () => {
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('select-sourceRefreshIntervalHours');
    expect(screen.getByText('For sources with auto refresh on. Keeps running while the app is in the tray.')).toBeTruthy();
    cleanup();
    renderAt(settingsRoutes, '/settings/recording');
    await screen.findByTestId('reminders-enabled');
    expect(screen.getByText('Alerts you before a programme you picked in the guide, while the app is open or in the tray.')).toBeTruthy();
  });
});

describe('Stream format (desktop)', () => {
  it('says Auto uses MPEG-TS in the built-in player and HLS in mpv and VLC', async () => {
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    expect(
      screen.getByText(
        'Xtream live channels. Auto uses MPEG-TS in the built-in player, which starts faster, and HLS in mpv and VLC. Choose HLS if channels freeze or you need subtitles.',
      ),
    ).toBeTruthy();
  });
});

describe('Window at startup (desktop)', () => {
  it('offers normal, maximized and fullscreen and saves the choice', async () => {
    rpcMock.handlers['settings.update'] = (a) => {
      current = { ...current, ...(a as { patch: Partial<Settings> }).patch };
      return current;
    };
    rpcMock.handlers['downloads.dir'] = () => ({ path: 'C:/data/downloads' });
    renderAt(settingsRoutes, '/settings/general');
    const fullscreen = await screen.findByRole('radio', { name: 'Fullscreen' });
    expect(screen.getByRole('radio', { name: 'As I left it' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(fullscreen);
    await waitFor(() => expect(rpcMock.callsOf('settings.update')).toContainEqual({ patch: { windowStart: 'fullscreen' } }));
  });
});
