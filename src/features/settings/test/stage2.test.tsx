/**
 * Settings, second pass of the SaaS audit: guide status rows led by their source (SS-20), the
 * TMDB rows dimmed while TMDB is off (SS-9), translated text before raw core messages (SS-18),
 * the remote state under its switch, the backup drop zone, one recording padding row, merged
 * shortcut rows, and the parental off card.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { RpcError } from '@/api/transport';
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
const { mergeByDescription } = await import('../sections/ShortcutsSection');
const { SECTION_IDS } = await import('../sections/types');

let current: Settings;

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  current = settings();
  rpcMock.handlers['settings.get'] = () => current;
  rpcMock.handlers['settings.update'] = (a) => {
    current = { ...current, ...(a as { patch: Partial<Settings> }).patch };
    return current;
  };
});
afterEach(cleanup);

describe('Guide status rows (SS-20)', () => {
  it('lead with the source name, then the state as a badge with its counts, then the redacted address', async () => {
    rpcMock.handlers['sources.list'] = () => [{ id: 'x', name: 'Northwind', kind: 'xtream' }];
    rpcMock.handlers['epg.sources'] = () => [
      {
        url: 'http://xt.example.com/xmltv.php?username=a&password=secret',
        status: 'ok',
        programCount: 1200,
        channelCount: 40,
        enabled: true,
        origin: 'source',
        sourceId: 'x',
      },
      { url: 'https://epg.example.com/all.xml', status: 'error', programCount: 0, channelCount: 0, enabled: false, origin: 'settings', error: 'HTTP 404' },
    ];
    renderAt(settingsRoutes, '/settings/epg');
    const [first, second] = await screen.findAllByTestId('epg-status-row');
    expect(within(first!).getByTestId('epg-status-origin').textContent).toBe('Northwind');
    expect(within(first!).getByTestId('epg-status-state').textContent).toBe('Up to date');
    expect(first!.textContent).toContain('1,200 programmes, 40 channels');
    expect(within(first!).getByTestId('epg-status-url').textContent).toBe('http://xt.example.com/xmltv.php?username=***&password=***');
    // The switch is named by the source and described by the state and the address.
    const sw = within(first!).getByRole('switch', { name: 'Northwind' });
    const described = sw.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent ?? '');
    expect(described.join(' ')).toContain('Up to date');
    expect(described.join(' ')).toContain('xmltv.php');
    // Refresh sits on the same line as the switch, as an icon button.
    expect(within(first!).getByTestId('epg-status-refresh').getAttribute('aria-label')).toContain('xmltv.php');
    expect(within(second!).getByTestId('epg-status-origin').textContent).toBe('Added in Settings');
    expect(within(second!).getByTestId('epg-status-state').textContent).toBe('Failed');
    expect((within(second!).getByTestId('epg-status-refresh') as HTMLButtonElement).disabled).toBe(true);
    expect(within(second!).getByRole('alert')).toBeTruthy();
  });
});

describe('TMDB while it is off (SS-9)', () => {
  it('says what turning it on opens and dims the rows it governs', async () => {
    current = settings({ tmdb: { enabled: false } });
    renderAt(settingsRoutes, '/settings/metadata');
    expect((await screen.findByTestId('tmdb-off-note')).textContent).toContain('Turn on TMDB');
    const key = screen.getByTestId('input-tmdb-key') as HTMLInputElement;
    expect(key.disabled).toBe(true);
    expect(key.closest('[data-settings-row]')!.getAttribute('data-dimmed')).toBe('true');
    // The attribution is the group's footer, inside the card.
    expect(screen.getByTestId('tmdb-attribution').closest('.rounded-lg')).toBeTruthy();
    fireEvent.click(screen.getByTestId('toggle-tmdb'));
    await waitFor(() => expect(screen.queryByTestId('tmdb-off-note')).toBeNull());
    expect((screen.getByTestId('input-tmdb-key') as HTMLInputElement).closest('[data-settings-row]')!.hasAttribute('data-dimmed')).toBe(false);
  });

  it('leads a rejected key with the translated sentence and keeps TMDB’s own words under it (SS-18)', async () => {
    current = settings({ tmdb: { enabled: true, apiKey: '0123456789abcdef0123' } });
    rpcMock.handlers['tmdb.testKey'] = () => ({ ok: false, message: 'Invalid API key: You must be granted a valid key.' });
    renderAt(settingsRoutes, '/settings/metadata');
    fireEvent.click(await screen.findByTestId('tmdb-test'));
    const result = await screen.findByTestId('tmdb-test-result');
    expect(result.textContent!.startsWith('TMDB rejected this key.')).toBe(true);
    expect(result.querySelector('[data-error-message]')!.textContent).toBe('Invalid API key: You must be granted a valid key.');
  });
});

describe('Raw core messages follow a translated sentence (SS-18)', () => {
  it('remote status', async () => {
    rpcMock.handlers['remote.status'] = () => {
      throw new RpcError('internal', 'socket closed');
    };
    renderAt(settingsRoutes, '/settings/remote');
    const err = await screen.findByTestId('remote-status-error');
    expect(err.textContent!.startsWith("Couldn't read the remote control status.")).toBe(true);
    expect(err.querySelector('[data-error-message]')!.textContent).toBe('socket closed');
  });

  it('backup import', async () => {
    const body = JSON.stringify({ kind: 'iptvnator-playlist-backup', version: 1, includeSecrets: false, playlists: [{ portalType: 'm3u' }] });
    rpcMock.handlers['backup.import'] = () => {
      throw new RpcError('io', 'disk full');
    };
    renderAt(settingsRoutes, '/settings/backup');
    await screen.findByTestId('settings-backup');
    const file = Object.assign(new File([body], 'b.json', { type: 'application/json' }), { text: async () => body });
    fireEvent.change(screen.getByTestId('backup-file-input'), { target: { files: [file] } });
    fireEvent.click(await screen.findByTestId('backup-import'));
    const alert = await screen.findByTestId('backup-import-error');
    expect(alert.querySelector('[data-error-message]')!.textContent).toBe('disk full');
    expect(alert.textContent!.indexOf('disk full')).toBeGreaterThan(alert.textContent!.indexOf("Couldn't import the backup"));
  });
});

describe('Remote control state (critique)', () => {
  it('sits under the switch as a badge with the address, copy and open', async () => {
    current = settings({ remoteControl: { enabled: true, port: 7310 } });
    rpcMock.handlers['remote.status'] = () => ({ running: true, url: 'http://127.0.0.1:7310/', port: 7310 });
    renderAt(settingsRoutes, '/settings/remote');
    const status = await screen.findByTestId('remote-status');
    await waitFor(() => expect(within(status).getByTestId('remote-state').textContent).toBe('Running'));
    expect(within(status).getByTestId('remote-url').textContent).toBe('http://127.0.0.1:7310/');
    expect(within(status).getByRole('button', { name: 'Copy link' })).toBeTruthy();
    // The same group as the switch: no separate Status group.
    expect(status.parentElement!.contains(screen.getByTestId('toggle-remote'))).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Status' })).toBeNull();
  });
});

describe('Backup import (critique)', () => {
  it('starts as a drop zone with no import button, and a dropped file shows its summary and the button', async () => {
    renderAt(settingsRoutes, '/settings/backup');
    const zone = await screen.findByTestId('backup-dropzone');
    expect(screen.queryByTestId('backup-import')).toBeNull();
    // Export is the group's action, beside its title.
    expect(screen.getByTestId('backup-export').textContent).toBe('Export backup');
    const body = JSON.stringify({ kind: 'iptvnator-playlist-backup', version: 1, includeSecrets: false, playlists: [{ portalType: 'm3u' }] });
    const file = Object.assign(new File([body], 'dropped.json', { type: 'application/json' }), { text: async () => body });
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ['Files'] } });
    expect((await screen.findByTestId('backup-summary')).textContent).toContain('dropped.json');
    expect(screen.getByTestId('backup-import')).toBeTruthy();
    expect(screen.queryByTestId('backup-dropzone')).toBeNull();
  });
});

describe('Recording padding (critique)', () => {
  it('is one row whose two selects are named by the row and their own label', async () => {
    renderAt(settingsRoutes, '/settings/recording');
    await screen.findByTestId('settings-recording');
    expect(screen.getByRole('combobox', { name: 'Recording padding Before' })).toBe(screen.getByTestId('recording-padding-before'));
    expect(screen.getByRole('combobox', { name: 'Recording padding After' })).toBe(screen.getByTestId('recording-padding-after'));
    fireEvent.change(screen.getByTestId('recording-padding-after'), { target: { value: '10' } });
    await waitFor(() => expect(current.recordingPaddingAfterMinutes).toBe(10));
  });
});

describe('Shortcut rows (critique)', () => {
  it('merge keys that do the same thing into one row, in order', () => {
    expect(
      mergeByDescription([
        { combo: 'shift+f10', description: 'Open the menu', area: 'live' },
        { combo: 'enter', description: 'Play', area: 'live' },
        { combo: 'contextmenu', description: 'Open the menu', area: 'live' },
        { combo: 'shift+f10', description: 'Open the menu', area: 'live' },
      ]),
    ).toEqual([
      { description: 'Open the menu', combos: ['shift+f10', 'contextmenu'] },
      { description: 'Play', combos: ['enter'] },
    ]);
  });

  it('show both keys with "or" between them', async () => {
    renderAt(settingsRoutes, '/settings/shortcuts');
    const list = await screen.findByTestId('shortcuts-list');
    const merged = [...list.querySelectorAll('[data-combos]')].find((el) => el.getAttribute('data-combos')!.includes(' '));
    expect(merged).toBeTruthy();
    expect(merged!.textContent).toContain('or');
  });

  it('flow down two columns on a wide column, each area kept whole, with the page widened for it', async () => {
    renderAt(settingsRoutes, '/settings/shortcuts');
    const list = await screen.findByTestId('shortcuts-list');
    expect(list.className).toContain('@min-[52rem]:columns-2');
    const areas = within(list).getAllByTestId('shortcut-area');
    expect(areas.length).toBeGreaterThan(1);
    // An area never splits across the two columns; each still holds its own titled group.
    for (const a of areas) {
      expect(a.className).toContain('break-inside-avoid');
      expect(a.querySelector('h3')).toBeTruthy();
    }
    // Only this reference takes the width beside the nav; other sections keep 46rem.
    expect(list.closest('.\\@container')!.className).toContain('max-w-[72rem]');
    cleanup();
    renderAt(settingsRoutes, '/settings/general');
    const general = await screen.findByTestId('settings-general');
    expect(general.closest('.\\@container')!.className).toContain('max-w-[46rem]');
  });
});

describe('Settings controls come from the kit (SS-9)', () => {
  it.each(SECTION_IDS.filter((id) => id !== 'players'))('%s: every text field and select wears the kit field look, every switch is the kit Switch', async (id) => {
    rpcMock.handlers['remote.status'] = () => ({ running: false, port: 7310 });
    rpcMock.handlers['app.info'] = () => ({ version: '0.2.0', dataDir: '/data', platform: 'linux', isDesktop: false, logFile: '/data/log' });
    renderAt(settingsRoutes, `/settings/${id}`);
    const page = await screen.findByTestId('settings-page');
    await waitFor(() => expect(page.querySelector('[data-testid="settings-loading"]')).toBeNull());
    const fields = page.querySelectorAll<HTMLElement>('input:not([type=range]):not([type=file]):not([type=radio]):not([type=checkbox]), select, textarea');
    for (const f of fields) {
      // fieldClass / Input / Select / SecretInput all carry the shared border, hover and focus border.
      expect(f.className, `${id}: ${f.outerHTML.slice(0, 120)}`).toMatch(/\bborder-border\b/);
      expect(f.className, `${id}: ${f.outerHTML.slice(0, 120)}`).toContain('focus-visible:border-focus');
    }
    for (const sw of page.querySelectorAll('[role="switch"]')) expect(sw.querySelector('[data-switch-knob]'), id).toBeTruthy();
  });
});
