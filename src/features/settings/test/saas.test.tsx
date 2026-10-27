/**
 * The SaaS settings layout (audit 2026-10-20): the phone's list of sections that opens one at a
 * time (SS-7), the inline save confirmation beside the row that changed (SS-17), the regrouped
 * General and the danger zone (SS-8), and About as a product page with honest update text
 * (SS-12, SR-6).
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
const { PHONE_QUERY, TOUCH_ONLY_QUERY } = await import('../SettingsPage');
const { BUTTON_VARIANTS } = await import('@/ui/Button');
const { useShellStore } = await import('@/shell');

/** The header's Back on a phone section (the shell draws it; these tests render the page alone). */
async function headerBack() {
  await waitFor(() => expect(useShellStore.getState().header?.back).toBeTruthy());
  return useShellStore.getState().header!.back!;
}
async function pressBack() {
  const back = await headerBack();
  act(() => back.onClick());
}

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
    await pressBack();
    expect(await screen.findByTestId('settings-nav-list')).toBeTruthy();
    expect(view.router.state.location.pathname).toBe('/settings');
  });

  it('Back from a section opened from the list goes back in history, not to a new copy of the list', async () => {
    phoneWindow(true);
    const view = renderAt(settingsRoutes, '/settings');
    await screen.findByTestId('settings-nav-list');
    const listKey = view.router.state.location.key;
    // Two round trips: list, General, back, Playback, back.
    for (const [name, testId] of [
      [/^General/, 'settings-general'],
      [/^Playback/, 'settings-playback'],
    ] as const) {
      fireEvent.click(within(screen.getByTestId('settings-nav-list')).getByRole('link', { name }));
      await screen.findByTestId(testId);
      expect(view.router.state.historyAction).toBe('PUSH');
      await pressBack();
      await screen.findByTestId('settings-nav-list');
      expect(view.router.state.historyAction).toBe('POP');
      // The very entry the list had: history is one list entry, not a list per visit.
      expect(view.router.state.location.key).toBe(listKey);
    }
  });

  it('Back from a section reached by a deep link replaces it with the list', async () => {
    phoneWindow(true);
    const view = renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    await pressBack();
    await screen.findByTestId('settings-nav-list');
    expect(view.router.state.historyAction).toBe('REPLACE');
    expect(view.router.state.location.pathname).toBe('/settings');
  });

  it("the list's rows keep their focus ring and give each lead two lines", async () => {
    phoneWindow(true);
    renderAt(settingsRoutes, '/settings');
    const list = await screen.findByTestId('settings-nav-list');
    for (const ul of within(list).getAllByRole('list')) {
      // A clipping group cut the 2 px focus outline down to a line under the row.
      expect(ul.className).not.toContain('overflow-hidden');
      const links = within(ul).getAllByRole('link');
      for (const a of links) expect(a.className).toContain('focus-visible:outline-offset-[-2px]');
      // The first and last rows round themselves instead, so the hover fill keeps to the corners.
      expect(links[0]!.className).toContain('rounded-t-');
      expect(links[links.length - 1]!.className).toContain('rounded-b-');
    }
    const lead = within(list).getByText('Which player opens streams', { exact: false });
    expect(lead.className).toContain('line-clamp-2');
    expect(lead.className).not.toContain('truncate');
  });

  it('leaves Keyboard shortcuts out of the list on a touch-only phone, and still opens it by link', async () => {
    window.matchMedia = ((query: string) => ({
      matches: query === PHONE_QUERY || query === TOUCH_ONLY_QUERY,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    renderAt(settingsRoutes, '/settings');
    const list = await screen.findByTestId('settings-nav-list');
    // A phone has no keyboard for the list of keys; the rest of App is still there.
    expect(within(list).queryByRole('link', { name: /^Keyboard shortcuts/ })).toBeNull();
    expect(within(list).getByRole('link', { name: /^Appearance/ })).toBeTruthy();
    cleanup();
    // The section is still reachable (the command palette, a link, a phone with a keyboard).
    renderAt(settingsRoutes, '/settings/shortcuts');
    expect(await screen.findByTestId('settings-shortcuts')).toBeTruthy();
  });

  it('keeps Keyboard shortcuts in the list on a phone-width window with a mouse', async () => {
    phoneWindow(true);
    renderAt(settingsRoutes, '/settings');
    const list = await screen.findByTestId('settings-nav-list');
    expect(within(list).getByRole('link', { name: /^Keyboard shortcuts/ })).toBeTruthy();
  });

  it('a wider window goes from /settings to General with the side nav', async () => {
    const view = renderAt(settingsRoutes, '/settings');
    await screen.findByTestId('settings-general');
    expect(view.router.state.location.pathname).toBe('/settings/general');
    expect(screen.getByTestId('settings-sidebar')).toBeTruthy();
    // The header names Settings and has no Back; the section's heading names the section.
    expect(useShellStore.getState().header).toEqual({ title: 'Settings' });
    expect(screen.getByRole('heading', { level: 2, name: 'General' }).className).toContain('max-md:sr-only');
  });

  it('a phone section names itself once, in the header, with the way back there too', async () => {
    phoneWindow(true);
    renderAt(settingsRoutes, '/settings/general');
    await screen.findByTestId('settings-general');
    const header = useShellStore.getState().header!;
    // Not "Settings" over "← Settings" over "General": the header is the section's title bar.
    expect(header.title).toBe('General');
    expect(header.back?.label).toBe('Settings');
    // The window keeps the app's name for the page.
    expect(header.documentTitle).toBe('Settings');
    // No Back of its own in the page, and the page's h1 says what the header says (C16).
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['General']);
    // The section's h2 stays for screen readers, out of sight below md.
    expect(screen.getByRole('heading', { level: 2, name: 'General' }).className).toContain('max-md:sr-only');
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
    // Every row has a mark (kept mounted so the row's layout never changes); only this one shows.
    const shown = screen.getAllByTestId('settings-saved-mark').filter((m) => m.dataset['state'] !== 'idle');
    expect(shown).toEqual([within(row).getByTestId('settings-saved-mark')]);
    for (const m of screen.getAllByTestId('settings-saved-mark')) if (m.dataset['state'] === 'idle') expect(m.textContent).toBe('');
    // Screen readers hear it once, from the page's status.
    expect(screen.getByTestId('settings-save-status').textContent).toBe('Saved');
  });

  it("keeps the row's layout: the mark is always there, out of flow, and only its state changes", async () => {
    renderAt(settingsRoutes, '/settings/playback');
    await screen.findByTestId('settings-playback');
    const sw = screen.getByTestId('toggle-showCaptions');
    const row = sw.closest('[data-settings-row]') as HTMLElement;
    const children = Array.from(row.children);
    const mark = within(row).getByTestId('settings-saved-mark');
    expect(mark.dataset['state']).toBe('idle');
    // Positioned in the row's corner, so showing it cannot add a line to the row (it wrapped onto
    // one of its own at phone width, and the switch moved under the finger).
    expect(row.className).toContain('relative');
    expect(mark.className).toContain('absolute');
    expect(mark.className).toContain('pointer-events-none');
    fireEvent.pointerDown(sw);
    fireEvent.click(sw);
    await waitFor(() => expect(mark.dataset['state']).toBe('saved'));
    expect(within(row).getByTestId('settings-saved-mark')).toBe(mark);
    expect(Array.from(row.children)).toEqual(children);
    // The label column holds only the label and its help text.
    const label = row.querySelector('label')!;
    expect(label.parentElement!.contains(mark)).toBe(false);
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

describe('theme cards (review)', () => {
  it('hide their radio in a wrapper that takes no space in the card', async () => {
    renderAt(settingsRoutes, '/settings/appearance');
    await screen.findByTestId('settings-appearance');
    for (const value of ['dark', 'light', 'system']) {
      const radio = screen.getByTestId(`theme-${value}`);
      const card = radio.closest('label')!;
      // sr-only on the kit radio's own wrapper lost to its `relative size-4.5`, which left a blank
      // band under every preview; a wrapper of its own hides it for real.
      const hidden = Array.from(card.children).find((c) => c.contains(radio))!;
      expect(hidden.className).toBe('sr-only');
      expect(radio.getAttribute('type')).toBe('radio');
      expect(within(screen.getByRole('radiogroup', { name: 'Theme' })).getAllByRole('radio')).toHaveLength(3);
    }
  });
});

describe('Backup (review)', () => {
  const body = JSON.stringify({ kind: 'iptvnator-playlist-backup', version: 1, includeSecrets: false, playlists: [{ portalType: 'm3u' }] });
  const pick = (text: string, name = 'backup.json') => {
    const file = Object.assign(new File([text], name, { type: 'application/json' }), { text: async () => text });
    fireEvent.change(screen.getByTestId('backup-file-input'), { target: { files: [file] } });
  };
  const primaries = () => screen.getAllByRole('button').filter((b) => b.className.includes(BUTTON_VARIANTS.primary.split(' ')[0]!));

  it('has one primary once a file is chosen: Import, with the file it imports', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    renderAt(settingsRoutes, '/settings/backup');
    await screen.findByTestId('backup-dropzone');
    expect(primaries()).toEqual([]);
    pick(body);
    const summary = await screen.findByTestId('backup-summary');
    expect(primaries()).toEqual([screen.getByTestId('backup-import')]);
    expect(summary.contains(screen.getByTestId('backup-import'))).toBe(true);
    // The mode it imports with comes before it.
    const mode = screen.getByRole('radiogroup', { name: 'Import mode' });
    expect(mode.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The button says what is in the file to a screen reader.
    const described = document.getElementById(screen.getByTestId('backup-import').getAttribute('aria-describedby')!)!;
    expect(described.textContent).toContain('1 source');
  });

  it('keeps focus on a choose button when a pick swaps the drop zone and the summary', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    renderAt(settingsRoutes, '/settings/backup');
    const zone = await screen.findByTestId('backup-dropzone');
    const chooseFile = within(zone).getByRole('button', { name: 'Choose backup file' });
    chooseFile.focus();
    fireEvent.click(chooseFile);
    pick(body);
    await screen.findByTestId('backup-summary');
    // The drop zone's button is gone; focus went on to the summary's, not to <body>.
    expect(document.activeElement).toBe(screen.getByTestId('backup-choose-another'));

    // Another file that cannot be read brings the drop zone back, with focus on its button.
    fireEvent.click(screen.getByTestId('backup-choose-another'));
    pick('not json');
    await screen.findByRole('alert');
    expect(document.activeElement).toBe(within(screen.getByTestId('backup-dropzone')).getByRole('button', { name: 'Choose backup file' }));
  });

  it('moves focus to the result after an import, not to <body> with the Import button that went', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    rpcMock.handlers['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
    rpcMock.handlers['backup.import'] = () => ({ imported: 1, skipped: 0, warnings: [] });
    renderAt(settingsRoutes, '/settings/backup');
    await screen.findByTestId('backup-dropzone');
    pick(body);
    const importButton = await screen.findByTestId('backup-import');
    importButton.focus();
    fireEvent.click(importButton);
    const result = await screen.findByTestId('backup-result');
    expect(screen.queryByTestId('backup-import')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(result));
  });

  it('leaves focus alone for a file dropped with the pointer', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    renderAt(settingsRoutes, '/settings/backup');
    const zone = await screen.findByTestId('backup-dropzone');
    const export_ = screen.getByTestId('backup-export');
    export_.focus();
    const file = Object.assign(new File([body], 'dropped.json', { type: 'application/json' }), { text: async () => body });
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ['Files'] } });
    await screen.findByTestId('backup-summary');
    expect(document.activeElement).toBe(export_);
  });
});
