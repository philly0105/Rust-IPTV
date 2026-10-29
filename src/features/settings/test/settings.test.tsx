import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/api/types';

import { eagerRoutes, installDomStubs, makeSource, pending, renderAt, rpcMock, settings } from '../../sources/test/harness';

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

  it('shows the section nav beside the section, not in the shell context panel (SS-7)', async () => {
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    const nav = screen.getByTestId('settings-nav');
    expect(screen.getByTestId('settings-sidebar').contains(nav)).toBe(true);
    expect(within(nav).getByRole('link', { name: 'Playback' }).getAttribute('aria-current')).toBe('page');
    // Grouped under headings: each group is a list named by its heading.
    expect(within(nav).getByRole('list', { name: 'Watching' })).toBeTruthy();
    expect(useShellStore.getState().contextPanel).toBeNull();
    // The header names the page only; the section's h2 names the section.
    expect(useShellStore.getState().header?.subtitle).toBeUndefined();
  });
});

describe('Settings patch shape', () => {
  it('saves a catch-up player without changing the live or VOD choices', async () => {
    current = settings({ player: 'embedded-mpv' });
    rpcMock.handlers['player.capabilities'] = () => ({ embeddedMpv: true });
    renderAt(settingsRoutes, '/settings/playback');
    const catchup = await screen.findByTestId('select-catchupPlayer') as HTMLSelectElement;
    expect((screen.getByTestId('select-livePlayer') as HTMLSelectElement).value).toBe('embedded-mpv');
    expect((screen.getByTestId('select-vodPlayer') as HTMLSelectElement).value).toBe('embedded-mpv');
    fireEvent.change(catchup, { target: { value: 'html5' } });
    await waitFor(() => expect(rpcMock.callsOf('settings.update')).toEqual([{ patch: { catchupPlayer: 'html5' } }]));
    expect((screen.getByTestId('select-livePlayer') as HTMLSelectElement).value).toBe('embedded-mpv');
    expect((screen.getByTestId('select-vodPlayer') as HTMLSelectElement).value).toBe('embedded-mpv');
  });

  it('a boolean toggle sends just that key', async () => {
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    fireEvent.click(screen.getByTestId('toggle-showCaptions'));
    await waitFor(() => expect(rpcMock.callsOf('settings.update')).toEqual([{ patch: { showCaptions: true } }]));
  });

  it('a dashboard rail sends the whole dashboardRails object', async () => {
    renderAt(settingsRoutes, '/settings/appearance');
    await screen.findByTestId('settings-appearance');
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
    expect(screen.queryByTestId('select-livePlayer')).toBeNull();
    cleanup();
    rpcMock.handlers['player.capabilities'] = () => ({ embeddedMpv: true });
    renderAt(settingsRoutes, '/settings/playback');
    const select = await screen.findByTestId('select-livePlayer') as HTMLSelectElement;
    expect(select.querySelector('option[value="embedded-mpv"]')).toBeTruthy();
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
    // The first switch loads the locale chunks lazily; a loaded suite can take over 1 s.
    await waitFor(() => expect(i18n.language).toBe('be'), { timeout: 5_000 });
    expect(document.documentElement.lang).toBe('be');
    fireEvent.change(select, { target: { value: 'zhtw' } });
    await waitFor(() => expect(rpcMock.callsOf('settings.update')[1]).toEqual({ patch: { language: 'zhtw' } }));
    await waitFor(() => expect(i18n.language).toBe('zh-TW'), { timeout: 5_000 });
    const { applyLanguage } = await import('@/i18n');
    await applyLanguage('en');
  });
});

describe('Downloads folder (web build)', () => {
  it('names the fixed server folder, read-only: nothing to type, pick or reset', async () => {
    current = settings({ downloadsDir: 'D:\\Videos' });
    renderAt(settingsRoutes, '/settings/general');
    const shown = await screen.findByTestId('downloads-dir-path');
    await waitFor(() => expect(shown.textContent).toBe('C:/Users/me/AppData/Roaming/tsrust-iptv/downloads'));
    expect(shown.tagName).toBe('OUTPUT');
    expect(screen.getByText('Downloads are saved to this folder on the server. To move it, start the server with a different IPTV_DATA_DIR.')).toBeTruthy();
    expect(screen.queryByTestId('input-downloadsDir')).toBeNull();
    expect(screen.queryByTestId('downloads-dir-choose')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use default' })).toBeNull();
    expect(rpcMock.callsOf('downloads.setDir')).toHaveLength(0);
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
    await waitFor(() => expect(screen.getByTestId('downloads-dir-path').textContent).toBe('E:/dl'));
  });
});

describe('Connections per download', () => {
  it('offers 1 or Auto for each source and saves the sources set to 1', async () => {
    rpcMock.handlers['sources.list'] = () => [makeSource('a', { name: 'Northwind' }), makeSource('b', { name: 'Harbor' })];
    current = settings({ downloadSingleConnection: ['b'] });
    renderAt(settingsRoutes, '/settings/general');
    const northwind = await screen.findByRole('radiogroup', { name: 'Connections per download from Northwind' });
    const harbor = screen.getByRole('radiogroup', { name: 'Connections per download from Harbor' });
    expect(within(northwind).getByRole('radio', { name: 'Auto' }).getAttribute('aria-checked')).toBe('true');
    expect(within(harbor).getByRole('radio', { name: '1' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(northwind).getByRole('radio', { name: '1' }));
    await waitFor(() => expect(rpcMock.callsOf('settings.update').at(-1)).toEqual({ patch: { downloadSingleConnection: ['b', 'a'] } }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Connections per download from Harbor' })).getByRole('radio', { name: 'Auto' }));
    await waitFor(() => expect(rpcMock.callsOf('settings.update').at(-1)).toEqual({ patch: { downloadSingleConnection: ['a'] } }));
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
    expect(within(row).getByTestId('epg-status-url').textContent).toBe('http://xt.example.com/xmltv.php?username=***&password=***');
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
    expect((await screen.findByTestId('select-livePlayer') as HTMLSelectElement).querySelector('option[value="embedded-mpv"]')).toBeTruthy();
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

describe('Run 3 wiring', () => {
  it('Backup and storage shows the image cache row', async () => {
    rpcMock.handlers['images.stats'] = () => ({ bytes: 3 * 1024 * 1024, files: 12, maxBytes: 500 * 1024 * 1024 });
    renderAt(settingsRoutes, '/settings/backup');
    const row = await screen.findByTestId('image-cache-row');
    expect(await within(row).findByTestId('image-cache-size')).toBeTruthy();
  });

  it("About opens What's new and the tour", async () => {
    const { resetOnboardingStore, useOnboardingStore } = await import('@/features/onboarding/store');
    resetOnboardingStore();
    rpcMock.handlers['app.info'] = () => ({ version: '0.1.0', dataDir: 'C:/data', platform: 'windows', isDesktop: false, logFile: 'C:/data/log.txt' });
    renderAt(settingsRoutes, '/settings/about');
    fireEvent.click(await screen.findByTestId('about-whats-new'));
    expect(useOnboardingStore.getState().overlay).toEqual({ kind: 'whatsNew', since: null, auto: false });
    resetOnboardingStore();
    fireEvent.click(screen.getByTestId('about-tour'));
    expect(useOnboardingStore.getState().overlay).toEqual({ kind: 'tour', auto: false });
    resetOnboardingStore();
  });
});
