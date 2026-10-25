/**
 * The shell's second review round: the header's Back and the detail title that waits for its h1
 * to scroll away, the rail's current mark beside a source's own paths, the sources' accordion and
 * sticky group labels, the phone tab bar (the Live TV tab's source, More's current state and the
 * focus after a sheet link, RTL names), the palette (its fade, title posters, the series queue),
 * the shortcut reference's merged rows and order, and the header search slot.
 */

import { act, cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackPosition, RecentEntry } from '@/api/types';

import { installDomStubs, makeSource, Page, playerMock, renderRoutes, rpcMock, settings } from './harness';

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
const queue = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('@/features/vod/lib/episodeQueue', () => ({
  queueSeriesFrom: async (args: unknown) => {
    queue.calls.push(args);
  },
}));

const { ShellLayout } = await import('../ShellLayout');
const { useHeaderTitleAnchor, useShell, useShellStore } = await import('../store');
const { railLinkCurrent, railLinks } = await import('../railLinks');
const { defaultOpenSource } = await import('../Rail');
const { mergeShortcutRows } = await import('../ShortcutOverlay');

/** A fake IntersectionObserver that reports what a test tells it to. */
const io = { callback: null as IntersectionObserverCallback | null, observed: [] as Element[], disconnected: 0 };
class FakeObserver {
  constructor(cb: IntersectionObserverCallback) {
    io.callback = cb;
  }
  observe(el: Element) {
    io.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    io.disconnected += 1;
  }
  takeRecords() {
    return [];
  }
}
function report(isIntersecting: boolean, bottom: number) {
  act(() =>
    io.callback?.(
      [{ isIntersecting, boundingClientRect: { bottom } as DOMRect, rootBounds: { height: 900 } as DOMRect } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
}

/** A detail page as the VOD pages publish it: Back, the section, and the title's own h1. */
function DetailPage({ onBack }: { onBack: () => void }) {
  const shell = useShell();
  useEffect(() => {
    shell.setHeader({ title: 'The Copper Meridian', subtitle: 'Northwind Premium', section: 'Movies', back: { onClick: onBack } });
  }, [shell, onBack]);
  const anchor = useHeaderTitleAnchor();
  return <h1 ref={anchor}>The Copper Meridian</h1>;
}

/** A page with its own search field in the header slot. */
function SearchingPage() {
  const shell = useShell();
  useEffect(() => {
    shell.setHeader({ title: 'Movies', search: { value: '', onChange: () => undefined, placeholder: 'Search movies' } });
  }, [shell]);
  return <Page>movies page</Page>;
}

const onBack = vi.fn();

function routes() {
  return [
    {
      path: '/',
      element: <ShellLayout />,
      children: [
        { path: 'dashboard', element: <Page>home page</Page> },
        { path: 'favorites', element: <Page>favorites page</Page> },
        { path: 'my-list', element: <Page>my list page</Page> },
        { path: 'searching', element: <SearchingPage /> },
        { path: 'detail', element: <DetailPage onBack={onBack} /> },
        { path: 's/:sourceId/*', element: <Page>source page</Page> },
        { path: 'live/archive/:sourceId/:channel', element: <Page>archive page</Page> },
      ],
    },
  ];
}

function handlers(sources = [makeSource('s1', { name: 'Night Portal' }), makeSource('s2', { name: 'Backup', position: 1 })]) {
  rpcMock.reset();
  const h = rpcMock.handlers;
  h['settings.get'] = () => settings();
  h['settings.update'] = (a) => settings((a as { patch: object }).patch);
  h['sources.list'] = () => sources;
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['recent.list'] = (): RecentEntry[] => [];
  h['positions.continueWatching'] = (): PlaybackPosition[] => [];
  h['favorites.list'] = () => [];
  h['catalog.channels'] = () => ({ items: [], total: 0 });
}

let matchMedia: typeof window.matchMedia;
function media(...queries: string[]) {
  window.matchMedia = ((query: string) => ({ ...matchMedia(query), matches: queries.includes(query) })) as typeof window.matchMedia;
}
const PHONE = ['(max-width: 639px)', '(max-width: 1023px)'];

beforeAll(() => {
  installDomStubs();
  matchMedia = window.matchMedia;
});
beforeEach(() => {
  handlers();
  localStorage.clear();
  playerMock.playItem.mockClear();
  onBack.mockClear();
  queue.calls.length = 0;
  io.callback = null;
  io.observed = [];
  io.disconnected = 0;
  window.matchMedia = matchMedia;
  useShellStore.setState({ paletteOpen: false, helpOpen: false, panelOpen: false, railCollapsed: false, railHidden: false, titleScrolledAway: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('detail pages: Back in the header, the title once its h1 scrolls away', () => {
  it('leads with Back and names the section, then fades the title in and out with the h1', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    renderRoutes(routes(), '/detail');
    const header = await screen.findByTestId('shell-header');
    await screen.findByRole('heading', { level: 1, name: 'The Copper Meridian' });
    expect(io.observed.map((el) => el.textContent)).toEqual(['The Copper Meridian']);
    // The section, not the title the hero shows large right below; the window keeps the title.
    expect(screen.getByTestId('page-title').textContent).toBe('Movies');
    expect(screen.getByTestId('page-subtitle').textContent).toBe('Northwind Premium');
    expect(document.title).toBe('The Copper Meridian · Tsrust IPTV');
    // Back sits before the title and runs the page's own back.
    const back = within(header).getByRole('button', { name: 'Back' });
    expect(back.compareDocumentPosition(screen.getByTestId('page-title')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);

    // Still below the fold (not scrolled to): the section stays.
    report(false, 1200);
    expect(screen.getByTestId('page-title').textContent).toBe('Movies');
    // Scrolled away above: the title takes the header.
    report(false, -20);
    expect(screen.getByTestId('page-title').textContent).toBe('The Copper Meridian');
    expect(screen.getByTestId('page-title').className).toContain('motion-safe:animate-fade-in');
    report(true, 300);
    expect(screen.getByTestId('page-title').textContent).toBe('Movies');
    report(false, -20);
    expect(useShellStore.getState().titleScrolledAway).toBe(true);
  });

  it('a page without a section shows its title, and leaving a detail page resets the reveal', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const { router } = renderRoutes(routes(), '/detail');
    await screen.findByRole('heading', { level: 1, name: 'The Copper Meridian' });
    report(false, -20);
    expect(useShellStore.getState().titleScrolledAway).toBe(true);
    await act(() => router.navigate('/searching'));
    await screen.findByText('movies page');
    expect(io.disconnected).toBeGreaterThan(0);
    expect(useShellStore.getState().titleScrolledAway).toBe(false);
    expect(screen.getByTestId('page-title').textContent).toBe('Movies');
    expect(screen.queryByTestId('header-back')).toBeNull();
  });

  it('without IntersectionObserver the header keeps the section', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    renderRoutes(routes(), '/detail');
    await screen.findByRole('heading', { level: 1, name: 'The Copper Meridian' });
    expect(screen.getByTestId('page-title').textContent).toBe('Movies');
  });
});

describe('the header search slot', () => {
  it("a page's own field wears the trigger's fill and a Ctrl F hint, and the palette keeps a button", async () => {
    renderRoutes(routes(), '/searching');
    await screen.findByText('movies page');
    const field = screen.getByRole('searchbox', { name: 'Search movies' });
    // The control border stays (fieldBase); the fill is the palette trigger's.
    expect(field.parentElement!.className).toContain('[&>input]:bg-surface-2');
    const slot = field.parentElement!.parentElement!;
    expect(slot.textContent).toContain('Ctrl');
    expect(screen.queryByTestId('open-palette')).toBeNull();
    // The palette button comes before the field, so the slot keeps its place.
    const palette = screen.getByTestId('header-palette');
    expect(palette.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(palette);
    expect(useShellStore.getState().paletteOpen).toBe(true);
  });

  it('the palette trigger has the field look too: the fill and the control border', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    const trigger = screen.getByTestId('open-palette');
    expect(trigger.className).toContain('bg-surface-2');
    expect(trigger.className).toContain('border-border');
    expect(screen.queryByTestId('header-palette')).toBeNull();
  });
});

describe('the rail', () => {
  it("marks Movies on a movie's page and player, and Live TV on the catch-up archive", async () => {
    const { router } = renderRoutes(routes(), '/s/s1/movie/m1');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    // The Watch group's link and the open source's own (two sources: the page opened its source).
    const links = (name: string) => within(nav).getAllByRole('link', { name });
    await waitFor(() => expect(links('Movies')).toHaveLength(2));
    for (const link of links('Movies')) {
      expect(link.getAttribute('aria-current')).toBe('page');
      expect(link.className).toContain('tuning-tick');
    }
    await act(() => router.navigate('/live/archive/s1/ch1'));
    await waitFor(() => expect(links('Live TV').map((l) => l.getAttribute('aria-current'))).toEqual(['page', 'page']));
    for (const link of links('Movies')) expect(link.getAttribute('aria-current')).toBeNull();
  });

  it('railLinkCurrent counts the paths beside a link, never another source or section', () => {
    const [live, , movies, series] = railLinks(makeSource('a b'));
    expect(movies!.to).toBe('/s/a%20b/movies');
    expect(railLinkCurrent(movies!, '/s/a%20b/movies/c/7')).toBe(true);
    expect(railLinkCurrent(movies!, '/s/a%20b/movie/9')).toBe(true);
    expect(railLinkCurrent(movies!, '/s/other/movie/9')).toBe(false);
    expect(railLinkCurrent(series!, '/s/a%20b/series/4')).toBe(true);
    expect(railLinkCurrent(series!, '/s/a%20b/movie/9')).toBe(false);
    expect(railLinkCurrent(live!, '/live/archive/a%20b/ch1')).toBe(true);
    expect(railLinkCurrent(live!, '/live/archive/other/ch1')).toBe(false);
    expect(railLinkCurrent(live!, '/s/a%20b/live/12')).toBe(true);
  });

  it('opens one source at a time and remembers only the open one', async () => {
    renderRoutes(routes(), '/dashboard');
    const night = await screen.findByRole('button', { name: /^Night Portal/ });
    const backup = screen.getByRole('button', { name: /^Backup/ });
    fireEvent.click(night);
    expect(night.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(backup);
    expect(backup.getAttribute('aria-expanded')).toBe('true');
    expect(night.getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem('tsrust.railSource')).toBe('s2');
    fireEvent.click(backup);
    expect(backup.getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem('tsrust.railSource')).toBe('');
  });

  it("a source's page opens it and closes the one that was open", async () => {
    const { router } = renderRoutes(routes(), '/dashboard');
    fireEvent.click(await screen.findByRole('button', { name: /^Night Portal/ }));
    await act(() => router.navigate('/s/s2/live'));
    expect(screen.getByRole('button', { name: /^Backup/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /^Night Portal/ }).getAttribute('aria-expanded')).toBe('false');
    // Opened by its page, not by a press: the remembered one stays the user's own.
    expect(localStorage.getItem('tsrust.railSource')).toBe('s1');
  });

  it('defaultOpenSource: the remembered one while it exists, never a closed one, and not the only source by itself', () => {
    const one = [makeSource('a')];
    const two = [makeSource('a'), makeSource('b')];
    expect(defaultOpenSource(two, 'b')).toBe('b');
    expect(defaultOpenSource(two, 'gone')).toBeNull();
    expect(defaultOpenSource(one, 'a')).toBe('a');
    // Its Live TV, Movies and Series are in the Watch group: the only source waits for a press.
    expect(defaultOpenSource(one, 'gone')).toBeNull();
    expect(defaultOpenSource(one, null)).toBeNull();
    expect(defaultOpenSource(one, '')).toBeNull();
    expect(defaultOpenSource(two, null)).toBeNull();
  });

  it('group labels stay in view while their links scroll, and the Library toggle is a 24 px target', async () => {
    renderRoutes(routes(), '/dashboard');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    for (const name of ['Library', 'Sources']) {
      const label = within(nav).getByRole('heading', { name }).parentElement!;
      expect(label.className, name).toMatch(/\bsticky\b/);
      expect(label.className, name).toContain('bg-surface');
    }
    expect(within(nav).getByRole('button', { name: 'Library' }).className).toContain('h-[max(1.5rem,24px)]');
    // The sources block fades a row's height at its foot, and has no top fade over the sticky label.
    const scroll = screen.getByTestId('rail-scroll');
    expect(scroll.style.maskImage ?? '').not.toContain('transparent, #000');
  });

  it('every leading glyph sits in one 20 px box, so source names line up with the links', async () => {
    renderRoutes(routes(), '/dashboard');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    const home = within(nav).getByRole('link', { name: 'Home' });
    expect(home.firstElementChild!.className).toContain('size-5');
    const monogram = (await within(nav).findByRole('button', { name: /^Night Portal/ })).firstElementChild!;
    expect(monogram.className).toContain('size-5');
  });
});

describe('phone tab bar', () => {
  it('the Live TV tab follows the source on show at once, not one navigation later', async () => {
    media(...PHONE);
    localStorage.setItem('tsrust.lastSource', 's1');
    const { router } = renderRoutes(routes(), '/dashboard');
    const bar = await screen.findByTestId('tab-bar');
    await waitFor(() => expect(within(bar).getByRole('link', { name: 'Live TV' }).getAttribute('href')).toBe('/s/s1/live'));
    await act(() => router.navigate('/s/s2/live'));
    expect(within(bar).getByRole('link', { name: 'Live TV' }).getAttribute('href')).toBe('/s/s2/live');
  });

  it("More says it is current for a page in the sheet, and a sheet link leaves focus on the new page", async () => {
    media(...PHONE);
    const { router } = renderRoutes(routes(), '/dashboard');
    const bar = await screen.findByTestId('tab-bar');
    const more = within(bar).getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-current')).toBeNull();
    fireEvent.click(more);
    const sheet = await screen.findByRole('dialog', { name: 'More' });
    // A Latin name in an RTL layout stays beside its monogram.
    expect(within(sheet).getByText('Backup').className).toContain('text-match-parent');
    fireEvent.click(within(sheet).getByRole('link', { name: 'My List' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/my-list'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('main')));
    expect(more.getAttribute('aria-current')).toBe('true');
  });
});

describe('palette', () => {
  const series = { sourceId: 's1', contentType: 'series' as const, itemId: 'v1' };

  it('shows the poster of a title to resume, and resuming a series starts its queue', async () => {
    rpcMock.handlers['positions.continueWatching'] = (): PlaybackPosition[] => [
      {
        ref: series,
        episodeId: 'e4',
        positionSeconds: 10,
        durationSeconds: 100,
        updatedAt: '2026-10-11T08:00:00Z',
        watched: false,
        snapshot: { title: 'Harbor Nine', subtitle: 'S2 E4 · Calm Before', posterUrl: 'https://img.test/harbor.jpg', contentType: 'series' },
      },
    ];
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    act(() => useShellStore.getState().setPaletteOpen(true));
    const palette = await screen.findByTestId('command-palette');
    const option = await within(palette).findByRole('option', { name: /Harbor Nine/ });
    expect(option.querySelector('img')?.getAttribute('src') ?? option.innerHTML).toContain(encodeURIComponent('https://img.test/harbor.jpg'));
    fireEvent.click(option);
    await waitFor(() => expect(queue.calls).toHaveLength(1));
    expect(playerMock.playItem).toHaveBeenCalledWith(expect.objectContaining({ ref: series, episodeId: 'e4' }));
    expect(queue.calls[0]).toMatchObject({ ref: series, episodeId: 'e4', sourceKind: 'xtream', title: 'Harbor Nine' });
  });

  it('fades the list out at its foot while more of it is below', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    act(() => useShellStore.getState().setPaletteOpen(true));
    const palette = await screen.findByTestId('command-palette');
    const list = palette.querySelector<HTMLElement>('[cmdk-list]')!;
    expect(list.className).toContain('max-h-[min(64vh,32rem)]');
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
    fireEvent.scroll(list);
    expect(list.getAttribute('data-fade-bottom')).toBe('true');
    expect(list.style.maskImage).toContain('transparent');
    list.scrollTop = 500;
    fireEvent.scroll(list);
    expect(list.getAttribute('data-fade-bottom')).toBeNull();
  });
});

describe('shortcut reference', () => {
  it('one row per action, "or" between its keys, Playback right after Everywhere, sentence-case labels', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    act(() => useShellStore.getState().setHelpOpen(true));
    const overlay = await screen.findByTestId('shortcut-overlay');
    const rows = within(overlay).getAllByText('In the search box: move to the list');
    expect(rows).toHaveLength(1);
    const row = rows[0]!.closest('[data-combos]')!;
    expect(row.getAttribute('data-combos')).toBe('enter arrowdown');
    expect(row.textContent).toContain('or');
    const headings = within(overlay).getAllByRole('heading', { level: 3 });
    expect(headings.slice(0, 3).map((h) => h.textContent)).toEqual(['Everywhere', 'Playback', 'Seek bar (when focused)']);
    expect(headings.at(-2)!.textContent).toBe('Parental controls');
    for (const h of headings) expect(h.className).not.toContain('uppercase');
  });

  it('mergeShortcutRows keeps the order and each key once', () => {
    expect(
      mergeShortcutRows([
        { combo: 'enter', description: 'To the list', area: 'Live' },
        { combo: 'shift+f10', description: 'Menu', area: 'Live' },
        { combo: 'arrowdown', description: 'To the list', area: 'Live' },
        { combo: 'enter', description: 'To the list', area: 'Live' },
      ]),
    ).toEqual([
      { description: 'To the list', combos: ['enter', 'arrowdown'] },
      { description: 'Menu', combos: ['shift+f10'] },
    ]);
  });
});
