/** B6 settings fixes: reset with undo, ordered saves, backup checks, stale player paths, EPG URL undo. */

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/api/types';

import { eagerRoutes, installDomStubs, renderAt, rpcMock, settings } from '../../sources/test/harness';
import { inspectBackup } from '../lib/backup';
import { applyPatch, diffSettings, playerPathStatus, tmdbPatch } from '../lib/patch';

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
const { useToastStore } = await import('@/ui');
const { queryClient, rpcKey } = await import('@/api/query');
const { useUpdateSettings } = await import('../lib/useUpdateSettings');

let current: Settings;
const patches = () => rpcMock.callsOf('settings.update').map((a) => (a as { patch: Record<string, unknown> }).patch);
function lastToast() {
  const toasts = useToastStore.getState().toasts;
  return toasts[toasts.length - 1];
}

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
  rpcMock.handlers['downloads.dir'] = () => ({ path: 'C:\\Users\\me\\Downloads\\tsrust' });
  rpcMock.handlers['epg.sources'] = () => [];
  rpcMock.handlers['sources.list'] = () => [];
});
afterEach(cleanup);

describe('Reset settings (D9)', () => {
  it('confirms, resets, and Undo sends back only what changed', async () => {
    current = settings({ coverSize: 'large', showDashboard: false });
    rpcMock.handlers['settings.reset'] = () => {
      current = settings();
      return current;
    };
    renderAt(settingsRoutes, '/settings/general');
    fireEvent.click(await screen.findByTestId('settings-reset'));
    const dialog = await screen.findByRole('dialog', { name: 'Reset all settings?' });
    expect(rpcMock.callsOf('settings.reset')).toEqual([]);
    fireEvent.click(within(dialog).getByTestId('settings-reset-confirm'));

    await waitFor(() => expect(lastToast()?.title).toBe('Settings reset to defaults'));
    expect(rpcMock.callsOf('settings.reset')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();

    lastToast()!.action!.onClick();
    await waitFor(() => expect(patches()).toEqual([{ coverSize: 'large', showDashboard: false }]));
  });

  it('a failed reset says so and changes nothing', async () => {
    rpcMock.handlers['settings.reset'] = () => {
      throw new Error('disk full');
    };
    renderAt(settingsRoutes, '/settings/general');
    fireEvent.click(await screen.findByTestId('settings-reset'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByTestId('settings-reset-confirm'));
    await waitFor(() => expect(lastToast()?.title).toBe("Couldn't reset settings"));
    expect(lastToast()?.description).toContain('disk full');
  });

  it('diffSettings clears an optional path the target never had', () => {
    const a = settings({ mpvPath: 'C:/mpv/mpv.exe', theme: 'light' });
    const b = settings({ theme: 'dark' });
    expect(diffSettings(a, b)).toEqual({ mpvPath: '', theme: 'dark' });
  });
});

describe('Saves apply in the order they were made (D11)', () => {
  it('an older answer arriving late does not undo a newer edit', async () => {
    const answers: ((s: Settings) => void)[] = [];
    rpcMock.handlers['settings.update'] = () => new Promise<Settings>((r) => answers.push(r));
    queryClient.clear();
    queryClient.setQueryData(rpcKey('settings.get'), settings({ coverSize: 'medium' }));
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useUpdateSettings(), { wrapper });

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current({ coverSize: 'small' });
      second = result.current({ coverSize: 'large' });
    });
    await act(async () => {
      answers[1]!(settings({ coverSize: 'large' }));
      await second;
      answers[0]!(settings({ coverSize: 'small' }));
      await first;
    });
    expect(queryClient.getQueryData<Settings>(rpcKey('settings.get'))?.coverSize).toBe('large');
  });
});

describe('Backup file checks match the core (D10)', () => {
  const ok = { kind: 'iptvnator-playlist-backup', version: 1, playlists: [{ portalType: 'm3u' }] };

  it('accepts a leading BOM and a numeric-string version', () => {
    expect(inspectBackup('\uFEFF' + JSON.stringify(ok)).ok).toBe(true);
    expect(inspectBackup(JSON.stringify({ ...ok, version: '1' })).ok).toBe(true);
  });

  it('names empty files and old array exports', () => {
    expect(inspectBackup('  \n')).toEqual({ ok: false, error: 'backupEmptyFile' });
    expect(inspectBackup('[{"title":"x"}]')).toEqual({ ok: false, error: 'backupLegacyArray' });
    expect(inspectBackup(JSON.stringify({ ...ok, version: '2' }))).toEqual({ ok: false, error: 'backupWrongVersion' });
  });

  it('counts entries the import will skip and says so before importing', async () => {
    const r = inspectBackup(JSON.stringify({ ...ok, playlists: [{ portalType: 'm3u' }, 'junk', { portalType: 'webdav' }] }));
    expect(r.ok && r.summary.skipped).toBe(2);

    renderAt(settingsRoutes, '/settings/backup');
    const input = (await screen.findByTestId('backup-file-input')) as HTMLInputElement;
    const body = JSON.stringify({ ...ok, playlists: ['junk'] });
    // jsdom's File has no text(); the app reads with it.
    const file = Object.assign(new File([body], 'b.json', { type: 'application/json' }), { text: async () => body });
    fireEvent.change(input, { target: { files: [file] } });
    expect((await screen.findByTestId('backup-skipped')).textContent).toBe(
      'No playlists in this file. Only its guide URLs and settings will be imported.',
    );
  });
});

describe('A saved player path that stopped working is flagged (D20)', () => {
  it('playerPathStatus compares the configured and resolved paths', () => {
    expect(playerPathStatus(undefined, undefined)).toEqual({ kind: 'ok' });
    expect(playerPathStatus('C:/mpv/mpv.exe', 'C:\\mpv\\mpv.exe')).toEqual({ kind: 'ok' });
    expect(playerPathStatus('"C:\\mpv\\"', 'C:\\mpv\\mpv.exe')).toEqual({ kind: 'ok' });
    expect(playerPathStatus('C:\\gone\\mpv.exe', 'C:\\scoop\\mpv.exe')).toEqual({ kind: 'fallback', path: 'C:\\scoop\\mpv.exe' });
    expect(playerPathStatus('C:\\gone\\mpv.exe', undefined)).toEqual({ kind: 'missing' });
  });

  it('shows the fallback next to the field', async () => {
    current = settings({ mpvPath: 'C:\\gone\\mpv.exe' });
    rpcMock.handlers['player.capabilities'] = () => ({ embeddedMpv: false, mpvPath: 'C:\\scoop\\mpv.exe' });
    renderAt(settingsRoutes, '/settings/players');
    expect(await screen.findByText('Nothing at this path any more. Using mpv at C:\\scoop\\mpv.exe instead.')).toBeTruthy();
  });
});

describe('Theme preview colours follow the tokens (D22)', () => {
  it('matches --color-bg, surface, divider, fg and accent for each theme', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { PREVIEW_PALETTE } = await import('../sections/AppearanceSection');
    const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');
    for (const theme of ['dark', 'light'] as const) {
      const block = css.split(`:root[data-theme='${theme}']`)[1]!.split('}')[0]!;
      const token = (name: string) => new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(block)?.[1]?.toLowerCase();
      const p = PREVIEW_PALETTE[theme];
      expect({ bg: p.bg, surface: p.surface, line: p.line, fg: p.fg, accent: p.accent }).toEqual({
        bg: token('bg'),
        surface: token('surface'),
        line: token('divider'),
        fg: token('fg'),
        accent: token('accent'),
      });
    }
  });
});

describe('The shortcut list can be scrolled from the keyboard (R1-3)', () => {
  it('is a named, focusable region', async () => {
    renderAt(settingsRoutes, '/settings/shortcuts');
    const list = await screen.findByRole('region', { name: 'Shortcut list' });
    expect(list.getAttribute('tabindex')).toBe('0');
    expect(list.querySelectorAll('[data-testid="shortcut-group"]').length).toBeGreaterThan(0);
    act(() => list.focus());
    expect(document.activeElement).toBe(list);
  });
});

describe('TMDB key: clearing and the server-mode mask (D27)', () => {
  const MASK = '••••abcd';

  it('clearing the field sends apiKey: null so the core drops the stored key', async () => {
    current = settings({ tmdb: { enabled: true, apiKey: '0123456789abcdef0123' } });
    renderAt(settingsRoutes, '/settings/metadata');
    const input = await screen.findByTestId('input-tmdb-key');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    await waitFor(() => expect(patches()).toEqual([{ tmdb: { enabled: true, apiKey: null } }]));
  });

  it('choosing automatic language sends language: null', () => {
    const s = settings({ tmdb: { enabled: true, language: 'de-DE' } });
    expect(tmdbPatch(s, { language: '' })).toEqual({ tmdb: { enabled: true, language: null } });
  });

  it('shows the mask without treating it as an edit, and Test key sends it for the stored key', async () => {
    current = settings({ tmdb: { enabled: true, apiKey: MASK } });
    rpcMock.handlers['tmdb.testKey'] = () => ({ ok: true });
    renderAt(settingsRoutes, '/settings/metadata');
    const input = (await screen.findByTestId('input-tmdb-key')) as HTMLInputElement;
    expect(input.value).toBe(MASK);
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByText(/key|Key/, { selector: '[role="alert"]' })).toBeNull();

    fireEvent.click(screen.getByTestId('tmdb-test'));
    await waitFor(() => expect(rpcMock.callsOf('tmdb.testKey')).toEqual([{ apiKey: MASK }]));
    await screen.findByTestId('tmdb-test-result');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(patches()).toEqual([]);
  });

  it('a toggle in server mode resends the untouched mask, which the core ignores', () => {
    const s = settings({ tmdb: { enabled: true, apiKey: MASK } });
    expect(tmdbPatch(s, { enabled: false })).toEqual({ tmdb: { enabled: false, apiKey: MASK } });
  });

  it('the optimistic cache drops a cleared key', () => {
    const s = settings({ tmdb: { enabled: true, apiKey: 'k'.repeat(20), language: 'fr-FR' } });
    expect(applyPatch(s, tmdbPatch(s, { apiKey: '' })).tmdb).toEqual({ enabled: true, language: 'fr-FR' });
  });
});

describe('Removing a guide URL can be undone (D13)', () => {
  it('keeps focus in the list and Undo puts the URL back in its place', async () => {
    current = settings({ epgUrls: ['https://a.example/g.xml', 'https://b.example/g.xml', 'https://c.example/g.xml'] });
    renderAt(settingsRoutes, '/settings/epg');
    const remove = await screen.findByRole('button', { name: 'Remove https://b.example/g.xml' });
    act(() => remove.focus());
    fireEvent.click(remove);

    await waitFor(() => expect(lastToast()?.title).toBe('Removed https://b.example/g.xml'));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove https://c.example/g.xml');
    expect(current.epgUrls).toEqual(['https://a.example/g.xml', 'https://c.example/g.xml']);

    lastToast()!.action!.onClick();
    await waitFor(() => expect(current.epgUrls).toEqual(['https://a.example/g.xml', 'https://b.example/g.xml', 'https://c.example/g.xml']));
  });
});

describe('Round 3', () => {
  const status = (error: string) => ({
    url: 'http://guide.test/epg.xml',
    status: 'ok' as const,
    programCount: 10,
    channelCount: 2,
    enabled: true,
    origin: 'settings' as const,
    error,
  });

  it('shows the C15 unreadable-guide code as a translated sentence (D35)', async () => {
    rpcMock.handlers['epg.sources'] = () => [status('epg_unreadable:1200:1500')];
    renderAt(settingsRoutes, '/settings/epg');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      "Part of this guide couldn't be read: 1,200 of 1,500 programs have a time in a format the app doesn't recognize. Check the URL or ask your provider.",
    );
  });

  it('shows any other guide error as before, and only an exact code is translated (D35)', async () => {
    rpcMock.handlers['epg.sources'] = () => [status('epg_unreadable:12:x then a 404')];
    renderAt(settingsRoutes, '/settings/epg');
    expect((await screen.findByRole('alert')).textContent).toBe('epg_unreadable:12:x then a 404');
  });

  it('the Replace copy says the old sources go only after the backup loads (D34)', async () => {
    const en = (await import('@/i18n/en/settings.json')).default as Record<string, string>;
    expect(en.backupReplaceHint).toMatch(/first, then removes your current sources once/);
    expect(en.backupReplaceConfirmBody).toMatch(/If none load, nothing changes\.$/);
    expect(en.backupReplaceConfirmBody).not.toMatch(/before the backup is imported/);
  });
});
