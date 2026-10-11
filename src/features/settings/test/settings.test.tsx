import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/api/types';

import { eagerRoutes, installDomStubs, pending, renderAt, rpcMock, settings } from '../../sources/test/harness';

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
const { useShellStore } = await import('@/shell');

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
  rpcMock.handlers['player.capabilities'] = () => ({ embeddedMpv: false, reason: 'not built' });
  rpcMock.handlers['downloads.dir'] = () => ({ path: 'C:/Users/me/AppData/Roaming/tsrust-iptv/downloads' });
});
afterEach(cleanup);

describe('Settings page states', () => {
  it('loading', () => {
    rpcMock.handlers['settings.get'] = pending;
    renderAt(settingsRoutes, '/settings/general');
    expect(screen.getByTestId('settings-loading')).toBeTruthy();
  });

  it('error with retry', async () => {
    let fail = true;
    rpcMock.handlers['settings.get'] = () => {
      if (fail) throw new RpcError('io', 'disk unreadable');
      return current;
    };
    renderAt(settingsRoutes, '/settings/general');
    const err = await screen.findByTestId('settings-error');
    fail = false;
    fireEvent.click(within(err).getByRole('button'));
    expect(await screen.findByTestId('settings-general')).toBeTruthy();
  });

  it('redirects /settings and unknown sections to general', async () => {
    const a = renderAt(settingsRoutes, '/settings');
    await screen.findByTestId('settings-general');
    expect(a.router.state.location.pathname).toBe('/settings/general');
    cleanup();
    const b = renderAt(settingsRoutes, '/settings/nope');
    await screen.findByTestId('settings-general');
    expect(b.router.state.location.pathname).toBe('/settings/general');
  });

  it('puts the section nav in the context panel', async () => {
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    await waitFor(() => expect(useShellStore.getState().contextPanel).toBeTruthy());
  });
});

describe('Settings patch shape', () => {
  it('a boolean toggle sends just that key', async () => {
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    fireEvent.click(screen.getByTestId('toggle-showCaptions'));
    await waitFor(() => expect(rpcMock.callsOf('settings.update')).toEqual([{ patch: { showCaptions: true } }]));
  });

  it('a dashboard rail sends the whole dashboardRails object', async () => {
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('settings-general');
    fireEvent.click(screen.getByTestId('toggle-rail-hero'));
    await waitFor(() => expect(rpcMock.callsOf('settings.update')).toHaveLength(1));
    expect(rpcMock.callsOf('settings.update')[0]).toEqual({
      patch: { dashboardRails: { ...settings().dashboardRails, hero: !settings().dashboardRails.hero } },
    });
  });

  it('reverts optimistically applied values and toasts on failure', async () => {
    rpcMock.handlers['settings.update'] = () => {
      throw new RpcError('io', 'read-only');
    };
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    const sw = screen.getByTestId('toggle-showCaptions');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.variant === 'error')).toBe(true));
    expect(screen.getByTestId('toggle-showCaptions').getAttribute('aria-checked')).toBe('false');
  });

  it('hides embedded mpv unless the capability is present', async () => {
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    await waitFor(() => expect(rpcMock.callsOf('player.capabilities')).toHaveLength(1));
    expect(screen.queryByTestId('player-embedded-mpv')).toBeNull();
    cleanup();
    rpcMock.handlers['player.capabilities'] = () => ({ embeddedMpv: true });
    renderAt(settingsRoutes, '/settings/playback');
    expect(await screen.findByTestId('player-embedded-mpv')).toBeTruthy();
  });

  it('rejects an out-of-range remote port inline without saving', async () => {
    rpcMock.handlers['remote.status'] = () => ({ running: false });
    renderAt(settingsRoutes, '/settings/remote');
    await screen.findByTestId('settings-remote');
    const port = screen.getByLabelText(/^Port/, { selector: 'input' });
    fireEvent.change(port, { target: { value: '80' } });
    fireEvent.blur(port);
    expect(await screen.findByText('Use a port between 1024 and 65535.')).toBeTruthy();
    expect(rpcMock.callsOf('settings.update')).toHaveLength(0);
  });
});

describe('Language picker', () => {
  it('lists all 19 languages and stores the folder code', async () => {
    const { LANGUAGES, i18n } = await import('@/i18n');
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('settings-general');
    const select = screen.getByLabelText('Language', { selector: 'select' }) as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).toHaveLength(19);
    expect(values).toEqual(LANGUAGES.map((l) => l.code));
    for (const code of ['ar', 'ary', 'by', 'de', 'el', 'en', 'es', 'fr', 'hu', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'tr', 'zh', 'zhtw']) {
      expect(values).toContain(code);
    }
    fireEvent.change(select, { target: { value: 'by' } });
    await waitFor(() => expect(rpcMock.callsOf('settings.update')).toEqual([{ patch: { language: 'by' } }]));
    // i18next runs on the BCP 47 tag, never on the folder name.
    await waitFor(() => expect(i18n.language).toBe('be'));
    expect(document.documentElement.lang).toBe('be');
    fireEvent.change(select, { target: { value: 'zhtw' } });
    await waitFor(() => expect(rpcMock.callsOf('settings.update')[1]).toEqual({ patch: { language: 'zhtw' } }));
    await waitFor(() => expect(i18n.language).toBe('zh-TW'));
    const { applyLanguage } = await import('@/i18n');
    await applyLanguage('en');
  });
});

describe('Downloads folder (web build)', () => {
  it('saves a typed path with downloads.setDir', async () => {
    rpcMock.handlers['downloads.setDir'] = () => undefined;
    renderAt(settingsRoutes, '/settings/general');
    const input = (await screen.findByTestId('input-downloadsDir')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('C:/Users/me/AppData/Roaming/tsrust-iptv/downloads'));
    fireEvent.change(input, { target: { value: '  "D:\Videos"  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(rpcMock.callsOf('downloads.setDir')).toEqual([{ path: 'D:\Videos' }]));
  });

  it('shows the core error inline when the path is rejected', async () => {
    rpcMock.handlers['downloads.setDir'] = () => {
      throw new RpcError('invalid', 'Choose a full folder path (for example C:\Videos).');
    };
    renderAt(settingsRoutes, '/settings/general');
    const input = (await screen.findByTestId('input-downloadsDir')) as HTMLInputElement;
    await waitFor(() => expect(input.value).not.toBe(''));
    fireEvent.change(input, { target: { value: 'relative/dir' } });
    fireEvent.blur(input);
    expect(await screen.findByText(/Couldn't use this folder: Choose a full folder path/)).toBeTruthy();
    expect(input.value).toBe('relative/dir');
    expect(input.getAttribute('aria-describedby') ?? '').toMatch(/-err/);
  });

  it('rejects an empty path without calling the core, and resets to default on request', async () => {
    rpcMock.handlers['downloads.setDir'] = () => undefined;
    current = settings({ downloadsDir: 'D:\Videos' });
    renderAt(settingsRoutes, '/settings/general');
    const input = (await screen.findByTestId('input-downloadsDir')) as HTMLInputElement;
    await waitFor(() => expect(input.value).not.toBe(''));
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(await screen.findByText('Required.')).toBeTruthy();
    expect(rpcMock.callsOf('downloads.setDir')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }));
    await waitFor(() => expect(rpcMock.callsOf('downloads.setDir')).toEqual([{ path: '' }]));
  });

  it('shows a retryable error when the folder cannot be read', async () => {
    let fail = true;
    rpcMock.handlers['downloads.dir'] = () => {
      if (fail) throw new RpcError('io', 'disk gone');
      return { path: 'E:/dl' };
    };
    renderAt(settingsRoutes, '/settings/general');
    const err = await screen.findByTestId('downloads-dir-error');
    fail = false;
    fireEvent.click(within(err).getByRole('button', { name: 'Retry' }));
    const input = (await screen.findByTestId('input-downloadsDir')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('E:/dl'));
  });
});

describe('Guide settings never show an Xtream password', () => {
  it('redacts xmltv.php links in the status list and global URLs', async () => {
    const xmltv = 'http://xt.example.com/xmltv.php?username=alice&password=pw-secret';
    current = settings({ epgUrls: ['https://bob:hunter2@epg.example.com/g.xml'] });
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['epg.sources'] = () => [
      { url: xmltv, status: 'error', programCount: 0, channelCount: 0, enabled: true, origin: 'source', sourceId: 'x', error: `GET ${xmltv}: 401` },
    ];
    renderAt(settingsRoutes, '/settings/epg');
    const row = await screen.findByTestId('epg-status-row');
    expect(within(row).getByTestId('epg-status-url').textContent).toBe('http://xt.example.com/xmltv.php?username=alice&password=***');
    const page = screen.getByTestId('settings-epg');
    expect(page.textContent).not.toContain('pw-secret');
    expect(page.textContent).not.toContain('hunter2');
    expect(screen.getByTestId('epg-global-url').textContent).toBe('https://***@epg.example.com/g.xml');
    for (const el of page.querySelectorAll('[title],[aria-label]')) {
      expect(`${el.getAttribute('title') ?? ''}${el.getAttribute('aria-label') ?? ''}`).not.toMatch(/pw-secret|hunter2/);
    }
  });
});

describe('Section-level error states', () => {
  it('player capabilities failure shows a retry', async () => {
    let fail = true;
    rpcMock.handlers['player.capabilities'] = () => {
      if (fail) throw new RpcError('internal', 'boom');
      return { embeddedMpv: true };
    };
    renderAt(settingsRoutes, '/settings/playback');
    const err = await screen.findByTestId('player-caps-error');
    fail = false;
    fireEvent.click(within(err).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('player-embedded-mpv')).toBeTruthy();
  });

  it('remote status failure shows a retry', async () => {
    let fail = true;
    rpcMock.handlers['remote.status'] = () => {
      if (fail) throw new RpcError('internal', 'boom');
      return { running: false, port: 7208 };
    };
    renderAt(settingsRoutes, '/settings/remote');
    const err = await screen.findByTestId('remote-status-error');
    fail = false;
    fireEvent.click(within(err).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('remote-status-error')).toBeNull());
  });
});
