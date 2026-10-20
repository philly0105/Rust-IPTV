/**
 * The SaaS settings layout (audit 2026-10-20): the phone's list of sections that opens one at a
 * time (SS-7), the inline save confirmation beside the row that changed (SS-17), the regrouped
 * General and the danger zone (SS-8), and About as a product page with honest update text
 * (SS-12, SR-6).
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
const { PHONE_QUERY } = await import('../SettingsPage');

let current: Settings;
const realMatchMedia = window.matchMedia;

/** Makes the window phone-sized for useMediaQuery (jsdom has no layout). */
function phoneWindow(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query === PHONE_QUERY,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeAll(installDomStubs);
afterAll(() => {
  window.matchMedia = realMatchMedia;
});
beforeEach(() => {
  rpcMock.reset();
  flags.desktop = false;
  phoneWindow(false);
  current = settings();
  rpcMock.handlers['settings.get'] = () => current;
  rpcMock.handlers['settings.update'] = (a) => {
    current = { ...current, ...(a as { patch: Partial<Settings> }).patch };
    return current;
  };
  rpcMock.handlers['player.capabilities'] = () => ({ embeddedMpv: false });
  rpcMock.handlers['downloads.dir'] = () => ({ path: '/data/downloads' });
  rpcMock.handlers['app.info'] = () => ({ version: '0.2.0', dataDir: '/data', platform: 'linux', isDesktop: false, logFile: '/data/logs/iptv-server.log' });
  rpcMock.handlers['images.stats'] = () => ({ bytes: 0, files: 0, maxBytes: 500 * 1024 * 1024 });
});
afterEach(cleanup);

describe('phone layout (SS-7)', () => {
  it('/settings lists the sections in groups, and a section opens with a way back', async () => {
    phoneWindow(true);
    const view = renderAt(settingsRoutes, '/settings');
    const list = await screen.findByTestId('settings-nav-list');
    expect(view.router.state.location.pathname).toBe('/settings');
    expect(within(list).getByRole('list', { name: 'Watching' })).toBeTruthy();
    // Each row says what is in the section.
    const playback = within(list).getByRole('link', { name: /^Playback/ });
    expect(playback.textContent).toContain('Which player opens streams');
    fireEvent.click(playback);
    await screen.findByTestId('settings-playback');
    // No side nav on a phone; Back returns to the list.
    expect(screen.queryByTestId('settings-sidebar')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-back'));
    expect(await screen.findByTestId('settings-nav-list')).toBeTruthy();
    expect(view.router.state.location.pathname).toBe('/settings');
  });

  it('a wider window goes from /settings to General with the side nav', async () => {
    const view = renderAt(settingsRoutes, '/settings');
    await screen.findByTestId('settings-general');
    expect(view.router.state.location.pathname).toBe('/settings/general');
    expect(screen.getByTestId('settings-sidebar')).toBeTruthy();
    expect(screen.queryByTestId('settings-back')).toBeNull();
  });
});

describe('save confirmation (SS-17)', () => {
  it('says Saved beside the row that changed, and nowhere else', async () => {
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    const sw = screen.getByTestId('toggle-showCaptions');
    fireEvent.pointerDown(sw);
    fireEvent.click(sw);
    const row = sw.closest('[data-settings-row]') as HTMLElement;
    await waitFor(() => expect(within(row).getByTestId('settings-saved-mark').dataset['state']).toBe('saved'));
    expect(within(row).getByTestId('settings-saved-mark').textContent).toBe('Saved');
    expect(screen.getAllByTestId('settings-saved-mark')).toHaveLength(1);
    // Screen readers hear it once, from the page's status.
    expect(screen.getByTestId('settings-save-status').textContent).toBe('Saved');
  });

  it('a save from outside a row confirms beside the section title', async () => {
    renderAt(settingsRoutes, '/settings/appearance');
    await screen.findByTestId('settings-appearance');
    fireEvent.click(screen.getByTestId('theme-light'));
    const header = screen.getByRole('heading', { level: 2, name: 'Appearance' }).parentElement!;
    await waitFor(() => expect(within(header).getByTestId('settings-saved-mark').dataset['state']).toBe('saved'));
  });
});

describe('regrouped sections (SS-8)', () => {
  it('General keeps app-wide choices; posters and the home screen are in Appearance', async () => {
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('settings-general');
    expect(screen.queryByRole('radiogroup', { name: 'Poster size' })).toBeNull();
    expect(screen.queryByTestId('toggle-showDashboard')).toBeNull();
    expect(screen.queryByTestId('settings-reset')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Channels and titles' })).toBeTruthy();
    cleanup();
    renderAt(settingsRoutes, '/settings/appearance');
    await screen.findByTestId('settings-appearance');
    expect(screen.getByRole('radiogroup', { name: 'Poster size' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Home screen' })).toBeTruthy();
  });

  it('Backup and storage ends with a danger zone holding Reset settings', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    renderAt(settingsRoutes, '/settings/backup');
    await screen.findByTestId('settings-backup');
    const danger = screen.getByRole('heading', { name: 'Danger zone' }).closest('[data-tone="danger"]') as HTMLElement;
    expect(within(danger).getByTestId('settings-reset')).toBeTruthy();
    expect(danger.querySelector('.border-danger\\/40')).toBeTruthy();
  });
});

describe('About (SS-12, SR-6)', () => {
  it('reads as a product page: name, version, platform by name, and links out', async () => {
    renderAt(settingsRoutes, '/settings/about');
    const product = await screen.findByTestId('about-product');
    expect(product.textContent).toContain('Tsrust IPTV');
    expect(within(product).getByTestId('about-version').textContent).toBe('Version 0.2.0');
    expect(within(product).getByTestId('about-platform').textContent).toBe('Linux · Server, in a browser');
    expect(screen.getByTestId('about-homepage').getAttribute('href')).toBe('https://github.com/philly0105/Rust-IPTV');
    expect(screen.getByTestId('about-issues').getAttribute('href')).toBe('https://github.com/philly0105/Rust-IPTV/issues');
    // The React version is a diagnostic, folded away with Copy diagnostics.
    const diagnostics = screen.getByTestId('about-diagnostics');
    expect(diagnostics.tagName).toBe('DETAILS');
    expect(diagnostics.textContent).toContain('React');
    expect(product.textContent).not.toContain('React');
  });

  it('tells a browser user that the server is updated where it runs, with no build advice', async () => {
    renderAt(settingsRoutes, '/settings/about');
    const panel = await screen.findByTestId('updates-unavailable');
    expect(panel.dataset['mode']).toBe('server');
    expect(panel.textContent).toContain('updates with the server');
    expect(panel.textContent).not.toMatch(/README|build/i);
    expect(within(panel).getByTestId('updates-releases').getAttribute('href')).toBe('https://github.com/philly0105/Rust-IPTV/releases');
  });

  it('points a desktop build without the updater at the releases page', async () => {
    flags.desktop = true;
    rpcMock.handlers['app.info'] = () => ({ version: '0.2.0', dataDir: 'C:/data', platform: 'windows', isDesktop: true, logFile: 'C:/data/log.txt' });
    renderAt(settingsRoutes, '/settings/about');
    const panel = await screen.findByTestId('updates-unavailable');
    expect(panel.dataset['mode']).toBe('manual');
    expect(panel.textContent).not.toMatch(/README|build/i);
    expect(screen.getByTestId('about-platform').textContent).toBe('Windows · Desktop app');
  });
});
