import { configure, act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FavoriteEntry, ItemRef, RecentEntry } from '@/api/types';

import { installDomStubs, makeSource, Page, playerMock, renderRoutes, rpcMock, settings } from './harness';

// The whole shell renders here, with Home and its lazy overlays (palette, shortcut help): a cold
// first render under a loaded full-suite run can pass the 1 s default.
configure({ asyncUtilTimeout: 4000 });

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
vi.mock('@/features/player', () => ({
  playItem: (...a: unknown[]) => (playerMock.playItem as (...x: unknown[]) => Promise<void>)(...a),
  restorePlayback: async () => false,
  PlayerDock: () => null,
  ExternalPlaybackFooter: () => null,
}));

const { ShellLayout } = await import('../ShellLayout');
const { matchContent, paletteFilter } = await import('../CommandPalette');
const { useShellStore } = await import('../store');

const SEP = '\u001f';
const bbcNews: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '1' };
const bbcEarth: ItemRef = { sourceId: 's1', contentType: 'series', itemId: '7' };

const routes = [
  {
    path: '/',
    element: <ShellLayout />,
    children: [
      { path: 'favorites', element: <Page>favorites page</Page> },
      { path: 's/:sourceId/*', element: <Page>source page</Page> },
    ],
  },
];

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  playerMock.playItem.mockClear();
  useShellStore.setState({ paletteOpen: false, helpOpen: false, panelOpen: false, railCollapsed: false });
  localStorage.clear();
  const h = rpcMock.handlers;
  h['settings.get'] = () => settings();
  h['settings.update'] = (a) => settings((a as { patch: object }).patch);
  // "Backup 1" is the trap: b..b..c across its name and keywords matched "bbc" loosely.
  h['sources.list'] = () => [makeSource('s1', { name: 'Night Portal' }), makeSource('s2', { name: 'Backup 1', position: 1 })];
  h['catalog.search'] = () => ({ live: [], movies: [], series: [] });
  h['epg.search'] = () => [];
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['favorites.list'] = (): FavoriteEntry[] => [
    { ref: bbcNews, addedAt: '2026-10-01T00:00:00Z', position: 0, snapshot: { title: 'BBC News', contentType: 'live' } },
    { ref: bbcEarth, addedAt: '2026-10-01T00:00:00Z', position: 1, snapshot: { title: 'BBC Earth', contentType: 'series' } },
  ];
  // The favourite again (one row only), and an item of a source that is gone (no row).
  h['recent.list'] = (): RecentEntry[] => [
    { ref: bbcNews, viewedAt: '2026-10-11T08:00:00Z', snapshot: { title: 'BBC News', contentType: 'live' } },
    { ref: { sourceId: 'gone', contentType: 'live', itemId: '9' }, viewedAt: '2026-10-10T08:00:00Z', snapshot: { title: 'BBC Gone', contentType: 'live' } },
  ];
});
afterEach(cleanup);

async function openPaletteWith(query: string) {
  const view = renderRoutes(routes, '/favorites');
  await screen.findByText('favorites page');
  // Sources loaded (the rail shows them) before the palette filters.
  await screen.findAllByText('Backup 1');
  act(() => useShellStore.getState().setPaletteOpen(true));
  const palette = await screen.findByTestId('command-palette');
  const input = within(palette).getByPlaceholderText('Type a command or search');
  expect(within(palette).queryByText('Favorites and recent')).toBeNull();
  fireEvent.change(input, { target: { value: query } });
  return { ...view, palette, input };
}

describe('palette ranking (L1-visual-12)', () => {
  it('needs every typed word unbroken: a loose subsequence no longer matches a command', () => {
    expect(paletteFilter(`Settings: Backup and restore${SEP}settings.backup`, 'bbc', ['settings', 'backup'])).toBe(0);
    expect(paletteFilter(`Backup 1: Live TV${SEP}source.s2.live`, 'bbc', ['Backup 1', 'xtream', 'live'])).toBe(0);
    expect(paletteFilter(`BBC News${SEP}content.s1|live|1`, 'bbc')).toBeGreaterThan(0.5);
    // Word prefixes, inner text, keywords and words out of order still match.
    expect(paletteFilter(`Favorites${SEP}nav.favorites`, 'fav')).toBeGreaterThan(0.5);
    expect(paletteFilter(`Settings: Backup and restore${SEP}settings.backup`, 'restore back')).toBeGreaterThan(0.5);
    expect(paletteFilter(`Add source${SEP}nav.addSource`, 'm3u', ['playlist', 'm3u'])).toBeGreaterThan(0);
    expect(paletteFilter(`Add source${SEP}nav.addSource`, 'm3u', ['playlist', 'm3u'])).toBeLessThanOrEqual(0.5);
  });

  it('matchContent keeps one row per item, drops non-matches and caps the list', () => {
    const entry = (itemId: string, title: string) => ({ ref: { sourceId: 's1', contentType: 'live' as const, itemId }, snapshot: { title, contentType: 'live' as const } });
    const many = Array.from({ length: 20 }, (_, i) => entry(String(i), `BBC ${i}`));
    expect(matchContent(many, 'bbc')).toHaveLength(8);
    const hits = matchContent([entry('1', 'BBC News'), entry('1', 'BBC News'), entry('2', 'Sky Sports')], 'bbc');
    expect(hits.map((h) => h.snapshot.title)).toEqual(['BBC News']);
    expect(matchContent(many, '  ')).toEqual([]);
  });
});

describe('settings words (L3-app-8)', () => {
  /** The cmdk items left after typing, in order. */
  const shown = (palette: HTMLElement) => Array.from(palette.querySelectorAll('[cmdk-item]'), (el) => el.textContent ?? '');

  it.each([
    ['language', 'Settings: General'],
    ['arabic', 'Settings: General'],
    ['theme', 'Settings: Appearance'],
    ['dark', 'Settings: Appearance'],
    ['pin', 'Settings: Parental controls'],
    ['xmltv', 'Settings: TV guide'],
    ['hotkeys', 'Settings: Shortcuts'],
    // Words people use for what a section holds, not only its own terms.
    ['subtitles', 'Settings: Playback'],
    ['captions', 'Settings: Playback'],
    ['autoplay', 'Settings: Playback'],
    ['dark mode', 'Settings: Appearance'],
    ['font size', 'Settings: Appearance'],
    ['qr code', 'Settings: Remote control'],
    ['reset settings', 'Settings: Backup'],
    ['time zone', 'Settings: TV guide'],
    ['report a problem', 'Settings: About'],
  ])("'%s' finds %s", async (query, title) => {
    const { palette } = await openPaletteWith(query);
    await waitFor(() => expect(shown(palette).some((s) => s.includes(title))).toBe(true));
  });

  it("'dark mode' also offers the dark theme itself", async () => {
    const { palette } = await openPaletteWith('dark mode');
    await waitFor(() => expect(shown(palette).some((s) => s.includes('Use dark theme'))).toBe(true));
  });

  it('the browser has no External players section to offer', async () => {
    const { palette } = await openPaletteWith('settings');
    await waitFor(() => expect(shown(palette).some((s) => s.includes('Settings: Playback'))).toBe(true));
    expect(shown(palette).some((s) => s.includes('Settings: External players'))).toBe(false);
  });

  it('words a section does not hold still find nothing there', async () => {
    const { palette } = await openPaletteWith('arabic');
    await waitFor(() => expect(shown(palette).some((s) => s.includes('Settings: General'))).toBe(true));
    expect(shown(palette).some((s) => s.includes('Settings: Appearance'))).toBe(false);
  });

  it('in Arabic, both the Arabic and the English words find the section', async () => {
    const { default: i18n, applyLanguage } = await import('@/i18n');
    // The shell keeps the UI in the saved language, so save Arabic too.
    rpcMock.handlers['settings.get'] = () => settings({ language: 'ar' });
    await applyLanguage('ar');
    try {
      const general = i18n.t('shell:settingsSection', { section: i18n.t('shell:settingsGeneral') });
      const appearance = i18n.t('shell:settingsSection', { section: i18n.t('shell:settingsAppearance') });
      expect(general).not.toBe('Settings: General');
      renderRoutes(routes, '/favorites');
      await screen.findByText('favorites page');
      act(() => useShellStore.getState().setPaletteOpen(true));
      const palette = await screen.findByTestId('command-palette');
      const input = palette.querySelector('input')!;
      fireEvent.change(input, { target: { value: 'اللغة' } });
      await waitFor(() => expect(shown(palette).some((s) => s.includes(general))).toBe(true));
      fireEvent.change(input, { target: { value: 'theme' } });
      await waitFor(() => expect(shown(palette).some((s) => s.includes(appearance))).toBe(true));
    } finally {
      await applyLanguage('en');
    }
  });
});

describe('palette favourites and recent (L1-visual-12)', () => {
  it("'bbc' leads with the BBC News favourite, ahead of any command, and Enter plays it", async () => {
    const { palette, input } = await openPaletteWith('bbc');
    await waitFor(() => {
      const first = palette.querySelector('[cmdk-item]');
      expect(first?.textContent).toContain('BBC News');
      expect(first?.getAttribute('data-selected')).toBe('true');
    });
    expect(within(palette).getByText('Favorites and recent')).toBeTruthy();
    // Listed once although it is a favourite and recent; a gone source's item stays out.
    expect(within(palette).getAllByText('BBC News')).toHaveLength(1);
    expect(within(palette).queryByText('BBC Gone')).toBeNull();
    expect(within(palette).queryByText('Settings: Backup and restore')).toBeNull();
    expect(within(palette).queryByText('Backup 1: Live TV')).toBeNull();
    // With two sources, the row names its source.
    expect(within(palette.querySelector('[cmdk-item]') as HTMLElement).getByText('Night Portal')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(playerMock.playItem).toHaveBeenCalledWith(
        expect.objectContaining({ ref: bbcNews, title: 'BBC News', isLive: true, isRadio: false, sourceKind: 'xtream' }),
      ),
    );
    expect(useShellStore.getState().paletteOpen).toBe(false);
  });

  it('a series favourite opens its detail page', async () => {
    const { palette, router } = await openPaletteWith('bbc earth');
    fireEvent.click(await within(palette).findByText('BBC Earth'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/s/s1/series/7'));
    expect(playerMock.playItem).not.toHaveBeenCalled();
  });
});

describe('palette guide programmes (F-SEARCH-PROGRAMMES)', () => {
  it('lists programme hits of every source and opens the guide at one', async () => {
    const start = Date.now() + 2 * 3_600_000;
    rpcMock.handlers['epg.search'] = (a) => {
      const { sourceId, query } = a as { sourceId: string; query: string };
      if (sourceId !== 's1' || query !== 'cafe') return [];
      return [
        {
          ref: { sourceId: 's1', contentType: 'live', itemId: '4' },
          channelName: 'Arte',
          program: { channelId: 'arte', title: 'Café Society', start: new Date(start).toISOString(), end: new Date(start + 3_600_000).toISOString() },
        },
      ];
    };
    const { palette, router } = await openPaletteWith('cafe');
    // The core folds diacritics ("cafe" finds "Café"): the palette keeps its answer.
    const row = await within(palette).findByText('Café Society');
    expect(within(palette).getByText('Guide programmes')).toBeTruthy();
    expect(rpcMock.calls.filter((c) => c.cmd === 'epg.search').map((c) => (c.args as { sourceId: string }).sourceId).sort()).toEqual(['s1', 's2']);
    fireEvent.click(row);
    await waitFor(() => expect(router.state.location.pathname).toBe('/epg'));
    expect(router.state.location.search).toBe(`?source=s1&at=${start}`);
    expect((router.state.location.state as { guideHit: { program: { title: string } } }).guideHit.program.title).toBe('Café Society');
  });
});

describe('palette library matches', () => {
  const fox: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '21' };
  const foxMovie: ItemRef = { sourceId: 's2', contentType: 'movie', itemId: '31' };
  beforeEach(() => {
    rpcMock.handlers['catalog.search'] = (a) => {
      const { query } = a as { query: string };
      if (query !== 'fox' && query !== 'bbc') return { live: [], movies: [], series: [] };
      const channel = (ref: ItemRef, name: string) => ({ ref, name, categoryId: 'c1', categoryName: 'US| SPORTS', isRadio: false });
      return {
        live: query === 'fox' ? [channel(fox, 'US| FOX HD'), ...Array.from({ length: 6 }, (_, i) => channel({ ...fox, itemId: `f${i}` }, `FOX ${i}`))] : [channel(bbcNews, 'BBC News')],
        movies: query === 'fox' ? [{ ref: foxMovie, title: 'The Fox Hunt', year: 2019, categoryId: 'm1' }] : [],
        series: [],
      };
    };
  });

  it("'fox' finds a channel nobody favourited and plays it, with the Search page's own request", async () => {
    const { palette } = await openPaletteWith('fox');
    const row = await within(palette).findByText('US| FOX HD');
    expect(within(palette).getByText('Channels')).toBeTruthy();
    expect(within(palette).getByText('Movies and series')).toBeTruthy();
    expect(within(palette).getByText('The Fox Hunt')).toBeTruthy();
    // A few per type, whatever the core sends; the channel's group names its feed.
    const channels = within(palette).getByText('Channels').closest('[cmdk-group]') as HTMLElement;
    expect(channels.querySelectorAll('[cmdk-item]')).toHaveLength(4);
    expect(within(row.closest('[cmdk-item]') as HTMLElement).getByText('US| SPORTS')).toBeTruthy();
    // The Search page's first page (every source, 60 and the probe row), so "Search for" opens warm.
    expect(rpcMock.calls.filter((c) => c.cmd === 'catalog.search').map((c) => c.args)).toContainEqual({ query: 'fox', limit: 61 });
    fireEvent.click(row);
    await waitFor(() =>
      expect(playerMock.playItem).toHaveBeenCalledWith(expect.objectContaining({ ref: fox, title: 'US| FOX HD', isLive: true, categoryId: 'c1', sourceKind: 'xtream' })),
    );
  });

  it('a library movie opens its detail page', async () => {
    const { palette, router } = await openPaletteWith('fox');
    fireEvent.click(await within(palette).findByText('The Fox Hunt'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/s/s2/movie/31'));
  });

  it('a recent channel leads a library channel that matches better, and Enter plays it', async () => {
    const nbaTv: ItemRef = { sourceId: 's1', contentType: 'live', itemId: '40' };
    rpcMock.handlers['recent.list'] = (): RecentEntry[] => [{ ref: nbaTv, viewedAt: '2026-10-11T08:00:00Z', snapshot: { title: 'US| NBA TV FHD', contentType: 'live' } }];
    rpcMock.handlers['catalog.search'] = (a) => ({
      live:
        (a as { query: string }).query === 'nba'
          ? [{ ref: { sourceId: 's1', contentType: 'live', itemId: '41' }, name: 'NBA 05', categoryId: 'c2', categoryName: 'NBA League Pass', isRadio: false }]
          : [],
      movies: [],
      series: [],
    });
    const { palette, input } = await openPaletteWith('nba');
    // "NBA 05" starts with the query and outscores the recent channel, yet stays under it.
    await within(palette).findByText('NBA 05');
    await waitFor(() => {
      const first = palette.querySelector('[cmdk-item]');
      expect(first?.textContent).toContain('US| NBA TV FHD');
      expect(first?.getAttribute('data-selected')).toBe('true');
    });
    const headings = [...palette.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent);
    expect(headings.indexOf('Favorites and recent')).toBeLessThan(headings.indexOf('Channels'));
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(playerMock.playItem).toHaveBeenCalledWith(expect.objectContaining({ ref: nbaTv, title: 'US| NBA TV FHD' })));
  });

  it('a favourite the library also finds is listed once, under Favorites and recent', async () => {
    const { palette } = await openPaletteWith('bbc');
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'catalog.search' && (c.args as { query: string }).query === 'bbc')).toBe(true));
    // Give the answer a moment to land, then count.
    await new Promise((r) => setTimeout(r, 50));
    expect(within(palette).getAllByText('BBC News')).toHaveLength(1);
    expect(within(palette).queryByText('Channels')).toBeNull();
  });
});

describe('palette selection while answers arrive', () => {
  const programme = (start: number) => ({
    ref: { sourceId: 's1', contentType: 'live', itemId: '4' },
    channelName: 'NBA TV',
    program: { channelId: 'nba', title: 'Inside the NBA', start: new Date(start).toISOString(), end: new Date(start + 3_600_000).toISOString() },
  });

  it('a late answer that ranks above the rows shown takes the selection to the top', async () => {
    const start = Date.now() + 3_600_000;
    rpcMock.handlers['epg.search'] = (a) => ((a as { sourceId: string }).sourceId === 's1' ? [programme(start)] : []);
    const { palette } = await openPaletteWith('nba');
    // "Sports" answers at once (its keywords hold "nba"), the guide after a pause.
    await within(palette).findByText('Sports');
    await within(palette).findByText('Inside the NBA');
    await waitFor(() => {
      const first = palette.querySelector('[cmdk-item]');
      expect(first?.textContent).toContain('Inside the NBA');
      expect(first?.getAttribute('data-selected')).toBe('true');
    });
  });

  it('a row the user moved to keeps the selection when an answer lands', async () => {
    const start = Date.now() + 3_600_000;
    let answer: (hits: unknown[]) => void = () => undefined;
    rpcMock.handlers['epg.search'] = (a) => ((a as { sourceId: string }).sourceId === 's1' ? new Promise((r) => (answer = r)) : []);
    const { palette, input } = await openPaletteWith('nba');
    await within(palette).findByText('Sports');
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'epg.search')).toBe(true));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const picked = palette.querySelector('[cmdk-item][data-selected="true"]')?.textContent;
    expect(picked).toBeTruthy();
    await act(async () => answer([programme(start)]));
    await within(palette).findByText('Inside the NBA');
    await new Promise((r) => setTimeout(r, 50));
    expect(palette.querySelector('[cmdk-item][data-selected="true"]')?.textContent).toBe(picked);
  });
});

describe('palette programmes on several channels', () => {
  it('a show on several channels at once is one row that counts them', async () => {
    const start = Date.now() + 2 * 3_600_000;
    const hit = (itemId: string, channelName: string, title: string, at = start) => ({
      ref: { sourceId: 's1', contentType: 'live', itemId },
      channelName,
      program: { channelId: itemId, title, start: new Date(at).toISOString(), end: new Date(at + 3_600_000).toISOString() },
    });
    rpcMock.handlers['epg.search'] = (a) =>
      (a as { sourceId: string }).sourceId === 's1'
        ? [hit('1', 'HBO', 'Harbor Lights'), hit('2', 'HBO 2', 'Harbor Lights'), hit('3', 'AMC', 'Harbor Lights'), hit('4', 'TCM', 'Harbor Lights', start + 3_600_000)]
        : [];
    const { palette, router } = await openPaletteWith('harbor');
    // The count from 640 px up only: on a phone the title needs the room.
    expect((await within(palette).findByText('3 channels')).className).toContain('max-sm:hidden');
    const rows = within(palette).getAllByText('Harbor Lights');
    expect(rows).toHaveLength(2);
    // The folded row still names the channel Enter opens; the later airing, on one, has no count.
    expect(within(rows[0]!.closest('[cmdk-item]') as HTMLElement).getByText('HBO')).toBeTruthy();
    const later = rows[1]!.closest('[cmdk-item]') as HTMLElement;
    expect(within(later).getByText('TCM')).toBeTruthy();
    expect(within(later).queryByText(/channels/)).toBeNull();
    // The search page's own limit, so its Programmes open from the cache.
    expect(rpcMock.calls.find((c) => c.cmd === 'epg.search')?.args).toMatchObject({ limit: 50 });
    fireEvent.click(rows[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe('/epg'));
    expect((router.state.location.state as { guideHit: { ref: { itemId: string } } }).guideHit.ref.itemId).toBe('1');
  });
});
