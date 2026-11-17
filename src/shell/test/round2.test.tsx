/**
 * The shell's second review round: the header's Back and the detail title that waits for its h1
 * to scroll away, the rail's current mark beside a source's own paths, the sources' accordion and
 * sticky group labels, the phone tab bar (the Live TV tab's source, More's current state and the
 * focus after a sheet link, RTL names), the palette (its fade, title posters, the series queue),
 * the shortcut reference's merged rows and order, and the header search slot.
 */

import { act, cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
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

/** A page with its own search field in the page, as Live TV's channel search. */
function PageSearchPage() {
  const [v, setV] = useState('');
  return (
    <Page>
      own search page
      <input aria-label="Search channels" data-page-search="" value={v} onChange={(e) => setV(e.target.value)} />
    </Page>
  );
}

/** The Search page: its field is the global search, so no palette button sits beside it. */
function GlobalSearchPage() {
  const shell = useShell();
  useEffect(() => {
    shell.setHeader({ title: 'Search', search: { value: '', onChange: () => undefined, placeholder: 'Search everything', hidePalette: true } });
  }, [shell]);
  return <Page>search page</Page>;
}

/** A page whose results hang under the header's field (the guide's search panel). */
const guideField = { current: null as HTMLInputElement | null };
const onGuideFocus = vi.fn();
function GuideLikePage() {
  const shell = useShell();
  useEffect(() => {
    shell.setHeader({
      title: 'TV guide',
      search: { value: 'news', onChange: () => undefined, placeholder: 'Search guide', label: 'Search the guide', inputRef: guideField, onFocus: onGuideFocus, controls: 'guide-results' },
    });
  }, [shell]);
  return <Page>guide page</Page>;
}

/** A page that asks the header to step aside while `aside` is set (Multi-view on a short window). */
function AsidePage() {
  const [aside, setAside] = useState(true);
  const shell = useShell();
  useEffect(() => {
    shell.setHeader({ title: 'Multi-view', stepAside: aside });
  }, [shell, aside]);
  return (
    <Page>
      aside page
      <button type="button" onClick={() => setAside(false)}>
        back in
      </button>
    </Page>
  );
}

/** A page-level error whose Try again swaps itself for a skeleton (the round-2 focus follow-up). */
function RetryPage() {
  const [failed, setFailed] = useState(true);
  const shell = useShell();
  useEffect(() => {
    shell.setHeader({ title: 'Live TV', subtitle: 'A very long source name · Sports · 30,132 channels', subtitleEnd: '30,132 channels' });
  }, [shell]);
  return (
    <Page>
      {failed ? (
        <button type="button" onClick={() => setFailed(false)}>
          Try again
        </button>
      ) : (
        <p>loading</p>
      )}
    </Page>
  );
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
        { path: 'guide-like', element: <GuideLikePage /> },
        { path: 'global-search', element: <GlobalSearchPage /> },
        { path: 'page-search', element: <PageSearchPage /> },
        { path: 'search', element: <Page>search page</Page> },
        { path: 'detail', element: <DetailPage onBack={onBack} /> },
        { path: 'aside', element: <AsidePage /> },
        { path: 'retry', element: <RetryPage /> },
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
const PHONE = ['(max-width: 639px)', '(max-width: 1099px)'];

beforeAll(() => {
  installDomStubs();
  matchMedia = window.matchMedia;
});
beforeEach(() => {
  handlers();
  localStorage.clear();
  playerMock.playItem.mockClear();
  onBack.mockClear();
  onGuideFocus.mockClear();
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

  it('on a phone the header is a plain Back while the h1 is on screen, then Back and the title', async () => {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    media(...PHONE);
    renderRoutes(routes(), '/detail');
    const header = await screen.findByTestId('shell-header');
    await screen.findByRole('heading', { level: 1, name: 'The Copper Meridian' });
    // Back goes back in history, so it is named Back, not after the section it may not return to.
    const back = within(header).getByRole('button', { name: 'Back' });
    expect(back).toBe(screen.getByTestId('header-back'));
    expect(back.textContent).toBe('Back');
    // No title-sized section line beside it: the page's own h1 is the largest type.
    expect(screen.queryByTestId('page-title')).toBeNull();
    expect(header.textContent).not.toContain('Movies');
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(document.title).toBe('The Copper Meridian · Tsrust IPTV');

    // Scrolled away: the title comes in after Back, which is still just Back.
    report(false, -20);
    expect(screen.getByTestId('page-title').textContent).toBe('The Copper Meridian');
    expect(within(header).getByRole('button', { name: 'Back' })).toBe(screen.getByTestId('header-back'));
    report(true, 300);
    expect(screen.queryByTestId('page-title')).toBeNull();
  });

  it('without IntersectionObserver the header keeps the section', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    renderRoutes(routes(), '/detail');
    await screen.findByRole('heading', { level: 1, name: 'The Copper Meridian' });
    expect(screen.getByTestId('page-title').textContent).toBe('Movies');
  });
});

describe('a page can ask the header to step aside', () => {
  it('draws no header bar while the page asks, keeps the window title, and comes back after', async () => {
    renderRoutes(routes(), '/aside');
    await screen.findByText('aside page');
    expect(screen.queryByTestId('shell-header')).toBeNull();
    expect(document.title).toBe('Multi-view · Tsrust IPTV');
    fireEvent.click(screen.getByRole('button', { name: 'back in' }));
    expect(await screen.findByTestId('shell-header')).toBeTruthy();
  });

  it('stays while the rail is hidden, whose Show button is in the header', async () => {
    media('(max-width: 1099px)');
    useShellStore.setState({ railHidden: true });
    renderRoutes(routes(), '/aside');
    await screen.findByText('aside page');
    expect(within(screen.getByTestId('shell-header')).getByTestId('rail-show')).toBeTruthy();
  });

  it('takes the docked icon rail with it, leaving a floating Expand sidebar that opens it and gets focus back (v-player-07)', async () => {
    media('(max-width: 1099px)');
    useShellStore.setState({ railPeek: false });
    renderRoutes(routes(), '/aside');
    await screen.findByText('aside page');
    expect(screen.queryByTestId('shell-rail')).toBeNull();
    const expand = screen.getByTestId('rail-aside');
    expect(expand.getAttribute('aria-label')).toBe('Expand sidebar');
    fireEvent.click(expand);
    const rail = await screen.findByTestId('shell-rail');
    expect(rail.hasAttribute('data-peek')).toBe(true);
    // The opener went with the rail's arrival: focus is on the rail's own toggle.
    expect(rail.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('shell-rail')).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId('rail-aside'));
    // Back in, the docked rail returns.
    fireEvent.click(screen.getByRole('button', { name: 'back in' }));
    expect(await screen.findByTestId('shell-rail')).toBeTruthy();
    expect(screen.queryByTestId('rail-aside')).toBeNull();
  });
});

describe('the page under the header', () => {
  it('the subtitle keeps the end the page names whole, and only the text before it truncates (v-live-15)', async () => {
    renderRoutes(routes(), '/retry');
    const sub = await screen.findByTestId('page-subtitle');
    expect(sub.getAttribute('title')).toBe('A very long source name · Sports · 30,132 channels');
    const [head, end] = [...sub.children] as HTMLElement[];
    expect(head!.className).toContain('truncate');
    expect(head!.textContent).toBe('A very long source name · Sports · ');
    expect(end!.className).toContain('shrink-0');
    expect(end!.textContent).toBe('30,132 channels');
  });

  it('when Try again goes away under focus, focus moves to the main region, not <body>', async () => {
    renderRoutes(routes(), '/retry');
    const retry = await screen.findByRole('button', { name: 'Try again' });
    retry.focus();
    fireEvent.click(retry);
    await screen.findByText('loading');
    await waitFor(() => expect(document.activeElement?.id).toBe('main'));
  });

  it('the header pads the top safe area, which is 0 in a browser tab', async () => {
    renderRoutes(routes(), '/dashboard');
    const header = await screen.findByTestId('shell-header');
    expect(header.className).toContain('pt-[env(safe-area-inset-top,0px)]');
    expect(header.className).toContain('h-[calc(var(--header-height)+env(safe-area-inset-top,0px))]');
  });

  it('on a phone the global search field stays a whole box without focus, a page field folds (v-shell-home-10)', async () => {
    media(...PHONE);
    renderRoutes(routes(), '/global-search');
    await screen.findByText('search page');
    const box = screen.getByRole('searchbox', { name: 'Search everything' }).parentElement!;
    expect(box.className).not.toContain('max-sm:w-8');
    expect(box.className).toContain('max-sm:flex-[2]');
    cleanup();
    renderRoutes(routes(), '/guide-like');
    await screen.findByText('guide page');
    expect(screen.getByRole('searchbox', { name: 'Search the guide' }).parentElement!.className).toContain('max-sm:w-8');
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
    // The palette button comes before the field, so the slot keeps its place. It stands in for
    // the "Search everything" box (the rail has no Search row), so it carries that name.
    // From lg it is the worded chip with its Ctrl K hint; below, an icon whose glyph is not the
    // field's magnifier (v-guide-05, v-vod-09). CSS shows one of the two.
    const chip = screen.getByTestId('header-palette-chip');
    const palette = screen.getByTestId('header-palette');
    expect(chip.textContent).toContain('Search everything');
    expect(chip.textContent).toContain('Ctrl');
    expect(chip.className).toContain('lg:flex');
    expect(palette.className).toContain('lg:hidden');
    expect(palette.getAttribute('aria-label')).toBe('Search everything');
    expect(palette.querySelector('svg')?.getAttribute('class')).not.toMatch(/\blucide-search\b/);
    expect(chip.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(palette.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(chip);
    expect(useShellStore.getState().paletteOpen).toBe(true);
    useShellStore.getState().setPaletteOpen(false);
    fireEvent.click(palette);
    expect(useShellStore.getState().paletteOpen).toBe(true);
  });

  it('leaves the palette button out beside the global search field, which keeps its Ctrl F hint', async () => {
    renderRoutes(routes(), '/global-search');
    await screen.findByText('search page');
    const field = screen.getByRole('searchbox', { name: 'Search everything' });
    expect(field.parentElement!.parentElement!.textContent).toContain('Ctrl');
    expect(screen.queryByTestId('header-palette')).toBeNull();
    expect(screen.queryByTestId('open-palette')).toBeNull();
  });

  it('"/" and Ctrl+F focus the page\'s own search field, and open the Search page where there is none', async () => {
    const { router } = renderRoutes(routes(), '/page-search');
    await screen.findByText('own search page');
    const field = screen.getByRole('textbox', { name: 'Search channels' });
    fireEvent.keyDown(document.body, { key: '/', code: 'Slash' });
    expect(document.activeElement).toBe(field);
    // Typed in a field, "/" is text: nothing moves.
    fireEvent.keyDown(field, { key: '/', code: 'Slash' });
    expect(router.state.location.pathname).toBe('/page-search');
    field.blur();
    fireEvent.keyDown(document.body, { key: 'f', code: 'KeyF', ctrlKey: true });
    expect(document.activeElement).toBe(field);
    await act(() => router.navigate('/favorites'));
    await screen.findByText('favorites page');
    fireEvent.keyDown(document.body, { key: '/', code: 'Slash' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/search'));
  });

    it("hands a page its field: the ref, focus, a name beyond the placeholder and the results it controls", async () => {
    renderRoutes(routes(), '/guide-like');
    await screen.findByText('guide page');
    const field = screen.getByRole('searchbox', { name: 'Search the guide' });
    expect(field.getAttribute('placeholder')).toBe('Search guide');
    expect(guideField.current).toBe(field);
    expect(field.getAttribute('aria-controls')).toBe('guide-results');
    fireEvent.focus(field);
    expect(onGuideFocus).toHaveBeenCalledTimes(1);
  });

  it('the palette trigger has the field look too: the fill and the control border', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    const trigger = screen.getByTestId('open-palette');
    expect(trigger.className).toContain('bg-surface-2');
    expect(trigger.className).toContain('border-border');
    expect(screen.queryByTestId('header-palette')).toBeNull();
  });

  it('wears the compact key caps, so they sit inside the 30 px field with room around them', async () => {
    renderRoutes(routes(), '/favorites');
    await screen.findByText('favorites page');
    const caps = [...screen.getByTestId('open-palette').querySelectorAll('kbd')];
    expect(caps.map((k) => k.textContent)).toEqual(['Ctrl', 'K']);
    for (const k of caps) expect(k.className.split(' ')).toEqual(expect.arrayContaining(['h-5', 'text-2xs']));
    cleanup();
    renderRoutes(routes(), '/searching');
    await screen.findByText('movies page');
    const slot = screen.getByRole('searchbox', { name: 'Search movies' }).parentElement!.parentElement!;
    const hint = [...slot.querySelectorAll('kbd')];
    expect(hint.map((k) => k.textContent)).toEqual(['Ctrl', 'F']);
    for (const k of hint) expect(k.className.split(' ')).toEqual(expect.arrayContaining(['h-5', 'text-2xs']));
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

  it('marks the TV guide, not Live TV, on the catch-up archive the guide opened', async () => {
    const { router } = renderRoutes(routes(), '/dashboard');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    await act(() => router.navigate('/live/archive/s1/ch1', { state: { from: '/epg?at=2026-11-16T20:00' } }));
    const links = (name: string) => within(nav).getAllByRole('link', { name });
    await waitFor(() => expect(links('Live TV')).toHaveLength(2));
    for (const link of links('Live TV')) expect(link.getAttribute('aria-current')).toBeNull();
    expect(within(nav).getByRole('link', { name: 'TV guide' }).getAttribute('aria-current')).toBe('page');
    // The phone's tab bar says the same.
    cleanup();
    media(...PHONE);
    const phone = renderRoutes(routes(), '/dashboard');
    await act(() => phone.router.navigate('/live/archive/s1/ch1', { state: { from: '/epg' } }));
    const bar = await screen.findByTestId('tab-bar');
    expect(within(bar).getByRole('link', { name: 'TV guide' }).getAttribute('aria-current')).toBe('page');
    expect(within(bar).getByRole('link', { name: 'Live TV' }).getAttribute('aria-current')).toBeNull();
    // Opened from Live TV (or a link), the archive is Live TV's.
    await act(() => phone.router.navigate('/live/archive/s1/ch1', { state: { from: '/s/s1/live' } }));
    await waitFor(() => expect(within(bar).getByRole('link', { name: 'Live TV' }).getAttribute('aria-current')).toBe('page'));
    expect(within(bar).getByRole('link', { name: 'TV guide' }).getAttribute('aria-current')).toBeNull();
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

  it("group labels stay in view while their links scroll, and Library's More is a whole row", async () => {
    renderRoutes(routes(), '/dashboard');
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    // The labels name their groups; they are not headings, which would come before the page's h1.
    expect(within(nav).queryAllByRole('heading')).toEqual([]);
    for (const name of ['Library', 'Sources']) {
      const label = document.getElementById(within(nav).getByRole('group', { name }).getAttribute('aria-labelledby')!)!.parentElement!;
      expect(label.className, name).toMatch(/\bsticky\b/);
      expect(label.className, name).toContain('bg-surface');
    }
    // The Library label folds nothing now; its More row is as tall as a link.
    expect(within(nav).queryByRole('button', { name: 'Library' })).toBeNull();
    expect(within(nav).getByRole('button', { name: 'More' }).className).toContain('h-(--rail-item-height)');
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
