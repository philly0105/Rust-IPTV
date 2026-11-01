/**
 * Loop 2 search fixes. L1-vod-3: the field takes focus on entry, ArrowDown reaches the results,
 * Back lands on the opened title. L2-perf-ui-5: a new query keeps the previous results on screen.
 * L2-perf-desktop-11: one catalog.search per query. L2-visual-8: chips and badges truncate.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, SeriesItem, Source, VodItem } from '@/api/types';
import { useShellStore } from '@/shell/store';

import { SearchPage } from '../pages/SearchPage';
import { forgetSpots } from '../hooks/useScrollMemory';
import { i18n, installDomStubs, makeSource, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, calls, call };
});

vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  return {
    ...actual,
    rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  };
});
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
}));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);
/** Channel names drawn: one per channel result render. */
const channelNames = vi.hoisted(() => ({ renders: 0 }));
vi.mock('@/features/live/components/ChannelLogo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/live/components/ChannelLogo')>();
  return {
    ...actual,
    ChannelName: (props: Parameters<typeof actual.ChannelName>[0]) => {
      channelNames.renders += 1;
      return actual.ChannelName(props);
    },
  };
});

const movie = (i: number, sourceId = 'src1'): VodItem => ({
  ref: { sourceId, contentType: 'movie', itemId: `m${i}` },
  title: `Alpha Movie ${i}`,
  categoryId: 'c1',
});
const channel = (i: number, sourceId: string): Channel =>
  ({ ref: { sourceId, contentType: 'live', itemId: `c${i}` }, name: `News ${i}`, categoryId: 'g', isRadio: false }) as Channel;
const portalShow: SeriesItem = { ref: { sourceId: 'src2', contentType: 'series', itemId: 'p1' }, title: 'Portal Show', categoryId: 'x' };
const never = () => new Promise<never>(() => undefined);

let sources: Source[] = [];

beforeAll(installDomStubs);
beforeEach(() => {
  forgetSpots();
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  sources = [makeSource('src1', 'xtream', 'Alpha IPTV'), makeSource('src2', 'm3u', 'Zed M3U with a very long provider name')];
  h['sources.list'] = () => sources;
  h['sources.get'] = () => sources[1];
  h['settings.get'] = () => settings();
  h['stalker.search'] = () => ({ items: [], total: 0, offset: 0, limit: 14 });
  h['catalog.search'] = () => ({ live: [], movies: [movie(0), movie(1), movie(2)], series: [] });
});
afterEach(() => cleanup());

const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);

/** The shell header's search field, fed by the page's usePageHeader (the real Header renders a SearchInput). */
function FakeHeader() {
  const search = useShellStore((s) => s.header?.search);
  if (!search) return null;
  return (
    <input
      data-shell-search=""
      aria-label="Header search"
      value={search.value}
      onChange={(e) => search.onChange(e.target.value)}
      onKeyDown={search.onKeyDown}
    />
  );
}

function BackStub() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      Back
    </button>
  );
}

function GuideStub() {
  const location = useLocation();
  const title = (location.state as { guideHit?: { program: { title: string } } } | null)?.guideHit?.program.title;
  return <p>{`guide ${location.search} ${title ?? ''}`}</p>;
}

/**
 * The app frame: header field, a rail link that stays mounted, and the routes. Unused answers are
 * dropped at once unless `gcTime` keeps them, as the app's cache does.
 */
function renderApp(path: string, { gcTime = 0 }: { gcTime?: number } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <FakeHeader />
          <nav>
            <Link to="/search?q=movie">Rail search</Link>
          </nav>
          <Routes>
            <Route path="/start" element={<p>start</p>} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/s/:sourceId/search" element={<SearchPage scoped />} />
            <Route path="/s/:sourceId/movie/:itemId" element={<BackStub />} />
            <Route path="/epg" element={<GuideStub />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...utils, client };
}

const field = () => screen.getByLabelText('Header search');
const focusedIndex = () => document.activeElement?.getAttribute('data-grid-index');

/**
 * Fakes the timers the page's pauses run on, so a test types at an exact pace: real sleeps under
 * load can outlast a pause and send a search the test says is never sent.
 */
const fakePauses = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
const PASS_STEP_MS = 25;
/**
 * Moves the faked clock on in short steps. React renders what a timer changed when its act ends,
 * so each step lets the page render, and start the next pause, before the clock goes on.
 */
async function pass(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= PASS_STEP_MS) await act(() => vi.advanceTimersByTimeAsync(Math.min(PASS_STEP_MS, left)));
}

describe('L1-vod-3: search focus and keyboard', () => {
  it('opened from a link, the header field takes focus even from the rail link that opened it', async () => {
    renderApp('/start');
    const rail = screen.getByRole('link', { name: 'Rail search' });
    rail.focus();
    fireEvent.click(rail);
    await waitFor(() => expect(document.activeElement).toBe(field()));
  });

  it('a page opened without a link (start-up, reload) leaves focus alone', async () => {
    renderApp('/search?q=movie');
    await screen.findByTestId('vod-search-movies');
    await new Promise((r) => setTimeout(r, 120));
    expect(document.activeElement).toBe(document.body);
  });

  it('ArrowDown in the field moves to the first result; ArrowUp on the first row returns', async () => {
    renderApp('/start');
    fireEvent.click(screen.getByRole('link', { name: 'Rail search' }));
    await screen.findByTestId('vod-search-movies');
    await waitFor(() => expect(document.activeElement).toBe(field()));

    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(focusedIndex()).toBe('0');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(field());
  });

  it('ArrowDown does nothing while there are no results', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    renderApp('/start');
    fireEvent.click(screen.getByRole('link', { name: 'Rail search' }));
    await screen.findByText('No results for "movie"');
    await waitFor(() => expect(document.activeElement).toBe(field()));
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    field().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(field());
  });

  it('Back from a title puts focus on the result that was opened', async () => {
    renderApp('/start');
    fireEvent.click(screen.getByRole('link', { name: 'Rail search' }));
    const grid = await screen.findByTestId('vod-search-movies');
    fireEvent.click(grid.querySelector('[data-grid-index="2"]')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
    await screen.findByTestId('vod-search-movies');
    await waitFor(() => expect(focusedIndex()).toBe('2'));
    expect(document.activeElement?.getAttribute('href')).toBe('/s/src1/movie/m2');
  });
});

describe('L2-perf-ui-5: a new query never blanks the results', () => {
  it('keeps the previous results on screen, without the skeleton, while the next query runs', async () => {
    rpcMock.handlers['catalog.search'] = (a) => ((a as { query: string }).query === 'movie' ? { live: [], movies: [movie(1)], series: [] } : never());
    renderApp('/start');
    fireEvent.click(screen.getByRole('link', { name: 'Rail search' }));
    await screen.findByText('Alpha Movie 1');
    fireEvent.change(field(), { target: { value: 'movies' } });
    await waitFor(() => expect(callsOf('catalog.search').some((c) => (c.args as { query: string }).query === 'movies')).toBe(true));
    expect(screen.getByText('Alpha Movie 1')).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('keeps a portal\'s results while the portal answers the next query', async () => {
    sources = [makeSource('src2', 'stalker', 'Beta Portal')];
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    rpcMock.handlers['stalker.search'] = (a) => {
      const { query, contentType } = a as { query: string; contentType: string };
      if (query !== 'show') return never();
      return { items: contentType === 'series' ? [portalShow] : [], total: 1, offset: 0, limit: 14 };
    };
    renderApp('/s/src2/search?q=show');
    await screen.findByText('Portal Show');
    fireEvent.change(field(), { target: { value: 'shows' } });
    await waitFor(() => expect(callsOf('stalker.search').some((c) => (c.args as { query: string }).query === 'shows')).toBe(true));
    expect(screen.getByText('Portal Show')).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

describe('VD-6: portal searches wait for a pause and three characters', () => {
  const field = () => screen.getByLabelText('Header search') as HTMLInputElement;
  const portalQueries = () => [...new Set(callsOf('stalker.search').map((c) => (c.args as { query: string }).query))];
  afterEach(() => vi.useRealTimers());

  it('sends one portal search for the word typed, not one per keystroke', async () => {
    sources = [makeSource('src2', 'stalker', 'Beta Portal')];
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    renderApp('/s/src2/search?q=d');
    await screen.findByLabelText('Header search');
    fakePauses();
    // Typed letter by letter, faster than the portal pause (450 ms).
    for (const q of ['du', 'dun', 'dune', 'dune ', 'dune p', 'dune pa']) {
      fireEvent.change(field(), { target: { value: q } });
      await pass(120);
    }
    expect(portalQueries()).toEqual([]);
    await pass(500);
    expect(portalQueries()).toEqual(['dune pa']);
    // The library search still follows the field at its own pace.
    expect(callsOf('catalog.search').length).toBeGreaterThan(1);
  });

  it('opens a link with a long enough query at once, and keeps short ones off the portal', async () => {
    sources = [makeSource('src2', 'stalker', 'Beta Portal')];
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    renderApp('/s/src2/search?q=ab');
    await screen.findByText('No results for "ab"');
    expect(callsOf('stalker.search')).toHaveLength(0);
    cleanup();
    renderApp('/s/src2/search?q=dune');
    await waitFor(() => expect(portalQueries()).toEqual(['dune']));
  });
});

describe('L2-perf-desktop-11: one catalog.search per query', () => {
  it('a capped query sends exactly one catalog.search, and its chips read "N+"', async () => {
    // 61 rows for a 60 cap, alternating sources: each holds 30 of the shown rows, a lower bound.
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: Array.from({ length: 61 }, (_, i) => movie(i, i % 2 ? 'src2' : 'src1')), series: [] });
    renderApp('/search?q=movie');
    const chips = await screen.findByRole('group', { name: 'Filter by source' });
    expect(within(chips).getByRole('button', { name: /Alpha IPTV\s*30\+/ })).toBeTruthy();
    expect(within(chips).getByRole('button', { name: /Zed M3U with a very long provider name\s*30\+/ })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(callsOf('catalog.search').map((c) => c.args)).toEqual([{ query: 'movie', limit: 61 }]);
  });
});

describe('L2-visual-8: long source names truncate with an ellipsis and a tooltip', () => {
  it('chips keep one line with the full name in the title', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [movie(1), movie(2, 'src2')], series: [] });
    renderApp('/search?q=movie');
    const chips = await screen.findByRole('group', { name: 'Filter by source' });
    const chip = within(chips).getByRole('button', { name: /Zed M3U/ });
    expect(chip.getAttribute('title')).toBe('Zed M3U with a very long provider name');
    expect(chip.className).toContain('max-w-[min(100%,16rem)]');
    const label = within(chip).getByText('Zed M3U with a very long provider name');
    expect(label.className).toContain('truncate');
    expect(label.className).toContain('min-w-0');
  });

  it('poster badges truncate inside the badge and never outgrow the poster', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 140 });
    try {
      rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [movie(1, 'src2')], series: [] });
      renderApp('/search?q=movie');
      const grid = await screen.findByTestId('vod-search-movies');
      // One 140px column: the badge keeps 12px clear of the poster's edges and to its own 120px cap.
      await waitFor(() => expect((grid.querySelector('[title="Zed M3U with a very long provider name"]') as HTMLElement | null)?.style.maxWidth).toBe('120px'));
      const badge = grid.querySelector<HTMLElement>('[title="Zed M3U with a very long provider name"]')!;
      expect(badge.querySelector('span')?.className).toContain('truncate');
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original);
    }
  });

  it('on a phone-narrow poster the source moves into the caption instead of a clipped badge', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 110 });
    try {
      rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [movie(1, 'src2')], series: [] });
      renderApp('/search?q=movie');
      const grid = await screen.findByTestId('vod-search-movies');
      // 110px collapsed the name to "Z…" beside the rating (the harness's phone shot): no badge on the art there.
      await waitFor(() => expect(within(grid).getByText(/Zed M3U with a very long provider name/)).toBeTruthy());
      expect(grid.querySelector('[title="Zed M3U with a very long provider name"]')).toBeNull();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original);
    }
  });

  it('channel source names truncate with the full name in the title', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [channel(1, 'src2'), channel(2, 'src1')], movies: [], series: [] });
    renderApp('/search?q=news');
    const grid = await screen.findByTestId('vod-search-channels');
    // The source is quiet text in the channel's second line now (no outlined chip); it still gives way first.
    const name = grid.querySelector<HTMLElement>('[title="Zed M3U with a very long provider name"]')!;
    expect(name.className).toContain('truncate');
    expect(name.className).toContain('min-w-0');
  });
});

describe('VD-1: poster results scroll without re-rendering every card', () => {
  it('the cards share one My List subscription, not two per card', async () => {
    rpcMock.handlers['watchlist.list'] = () => [];
    rpcMock.handlers['positions.watchedContains'] = () => [];
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: Array.from({ length: 40 }, (_, i) => movie(i)), series: [] });
    const { client } = renderApp('/search?q=movie');
    const grid = await screen.findByTestId('vod-search-movies');
    await waitFor(() => expect(within(grid).getAllByTestId('mylist-button').length).toBeGreaterThan(4));
    await waitFor(() => expect(within(grid).getAllByTestId('mylist-button')[0]!.dataset['state']).toBe('ready'));
    const observers = client
      .getQueryCache()
      .findAll({ predicate: (q) => q.queryKey[0] === 'watchlist.list' })
      .reduce((n, q) => n + q.getObserversCount(), 0);
    expect(observers).toBeLessThanOrEqual(2);
  });
});

describe('channel results scroll without re-rendering every channel', () => {
  it('a scroll step that mounts no new row draws none of the mounted channels again', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: Array.from({ length: 60 }, (_, i) => channel(i, 'src1')), movies: [], series: [] });
    renderApp('/search?q=news');
    const grid = await screen.findByTestId('vod-search-channels');
    await waitFor(() => expect(within(grid).getAllByRole('button').length).toBeGreaterThan(8));
    await new Promise((r) => setTimeout(r, 50));
    channelNames.renders = 0;
    // The page scrolls and stops: the grid renders as scrolling starts and again as it ends.
    fireEvent.scroll(screen.getByTestId('vod-search'));
    await new Promise((r) => setTimeout(r, 300));
    expect(channelNames.renders).toBe(0);
  });
});

describe('L3-vod-5: the results narrow to the typed query within a frame of the key', () => {
  const titled = (i: number, title: string): VodItem => ({ ...movie(i), title });

  it('filters the answered results at once while the longer query loads, then shows its answer', async () => {
    let answerShort = true;
    let release: (() => void) | undefined;
    rpcMock.handlers['catalog.search'] = (a) => {
      const q = (a as { query: string }).query;
      if (q === 'black') return { live: [], movies: [titled(0, 'Black Harbor'), titled(1, 'Black Coast'), titled(2, 'Blackout')], series: [] };
      answerShort = false;
      return new Promise((r) => (release = () => r({ live: [], movies: [titled(0, 'Black Harbor'), titled(3, 'Black Hills')], series: [] })));
    };
    renderApp('/search?q=black');
    await screen.findByText('Black Coast');
    fireEvent.change(field(), { target: { value: 'black h' } });
    // Same frame as the key: no debounce, no answer yet.
    const grid = screen.getByTestId('vod-search-movies');
    expect(within(grid).getByText('Black Harbor')).toBeTruthy();
    expect(within(grid).queryByText('Black Coast')).toBeNull();
    expect(within(grid).queryByText('Blackout')).toBeNull();
    await waitFor(() => expect(answerShort).toBe(false));
    release!();
    await screen.findByText('Black Hills');
    expect(screen.getByText('Black Harbor')).toBeTruthy();
  });

  it('keeps the old results when none of them match, and never says "No results" before the answer', async () => {
    rpcMock.handlers['catalog.search'] = (a) =>
      (a as { query: string }).query === 'black' ? { live: [], movies: [titled(0, 'Black Harbor')], series: [] } : never();
    renderApp('/search?q=black');
    await screen.findByText('Black Harbor');
    fireEvent.change(field(), { target: { value: 'black z' } });
    expect(screen.getByText('Black Harbor')).toBeTruthy();
    expect(screen.queryByText(/No results/)).toBeNull();
  });
});

describe('guide programmes in search (F-SEARCH-PROGRAMMES)', () => {
  const start = Date.now() + 3_600_000;
  const programmeHit = (sourceId: string, title: string, at: number) => ({
    ref: { sourceId, contentType: 'live', itemId: 'c1' },
    channelName: `News ${sourceId}`,
    program: { channelId: 'n', title, start: new Date(at).toISOString(), end: new Date(at + 1_800_000).toISOString() },
  });
  beforeEach(() => {
    rpcMock.handlers['epg.search'] = (a) => {
      const { sourceId } = a as { sourceId: string };
      return sourceId === 'src1' ? [programmeHit('src1', 'Alpha Report', start + 600_000)] : [programmeHit('src2', 'Alpha Hour', start)];
    };
  });

  it('a Programmes tab lists every source’s hits by start, and one opens the guide at it', async () => {
    renderApp('/search?q=alpha');
    const tab = await screen.findByRole('tab', { name: /Programmes/ });
    expect(tab.textContent).toContain('2');
    expect(callsOf('epg.search').map((c) => (c.args as { sourceId: string }).sourceId).sort()).toEqual(['src1', 'src2']);
    fireEvent.click(tab);
    const list = await screen.findByTestId('search-programmes');
    const rows = within(list).getAllByRole('button');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Alpha Hour'), expect.stringContaining('Alpha Report')]);
    // Two sources: each row names its source.
    expect(rows[1]!.textContent).toContain('Alpha IPTV');
    fireEvent.click(rows[1]!);
    expect(await screen.findByText(`guide ?source=src1&at=${start + 600_000} Alpha Report`)).toBeTruthy();
  });

  it('with nothing else matching, the programmes show at once', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    renderApp('/search?q=alpha');
    expect(await screen.findByTestId('search-programmes')).toBeTruthy();
    expect(screen.queryByText(/No results/)).toBeNull();
  });

  const programmeQueries = () => callsOf('epg.search').map((c) => (c.args as { query: string }).query);
  afterEach(() => vi.useRealTimers());

  it('asks every source for a query the page opens with, without waiting for a pause', async () => {
    fakePauses();
    renderApp('/search?q=alpha');
    // Well inside the programme search's pause (300 ms): the opening query is not held back.
    await pass(50);
    expect(programmeQueries()).toEqual(['alpha', 'alpha']);
  });

  it('searches the guide for the word typed once it rests, not for every prefix on the way', async () => {
    renderApp('/search?q=b');
    await screen.findByLabelText('Header search');
    fakePauses();
    // Typed letter by letter, faster than the programme pause (300 ms) but slower than the library's.
    for (const q of ['br', 'bre', 'brea', 'break', 'breaki', 'breakin', 'breaking']) {
      fireEvent.change(field(), { target: { value: q } });
      await pass(150);
    }
    expect(programmeQueries()).toEqual([]);
    await pass(350);
    expect(programmeQueries()).toEqual(['breaking', 'breaking']);
    // The library search follows the field at its own pace.
    expect(callsOf('catalog.search').length).toBeGreaterThan(2);
  });

  it('shows a cached answer at once when Backspace returns to its query, and asks nothing', async () => {
    rpcMock.handlers['epg.search'] = (a) => {
      const { sourceId, query } = a as { sourceId: string; query: string };
      if (sourceId === 'src1') return [programmeHit('src1', 'Alpha Report', start + 600_000)];
      return query === 'alpha' ? [programmeHit('src2', 'Alpha Hour', start)] : [];
    };
    // The app keeps unused answers for minutes (the query client's default), not for no time at all.
    renderApp('/search?q=alpha&type=programmes', { gcTime: 600_000 });
    const list = await screen.findByTestId('search-programmes');
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(2));
    fakePauses();
    fireEvent.change(field(), { target: { value: 'alpha r' } });
    await pass(500);
    expect(programmeQueries()).toEqual(['alpha', 'alpha', 'alpha r', 'alpha r']);
    expect(screen.queryByText('Alpha Hour')).toBeNull();
    fireEvent.change(field(), { target: { value: 'alpha' } });
    // The field's 100 ms pause has passed, the programme search's 300 ms has not.
    await pass(150);
    expect(screen.getByText('Alpha Hour')).toBeTruthy();
    expect(screen.getByText('Alpha Report')).toBeTruthy();
    await pass(500);
    expect(programmeQueries()).toHaveLength(4);
  });

  it('keeps the answered programmes, narrowed to the typed text, while the longer query waits', async () => {
    rpcMock.handlers['epg.search'] = (a) => {
      const { sourceId, query } = a as { sourceId: string; query: string };
      if (query !== 'alpha') return never();
      return sourceId === 'src1' ? [programmeHit('src1', 'Alpha Report', start + 600_000)] : [programmeHit('src2', 'Alpha Hour', start)];
    };
    renderApp('/search?q=alpha&type=programmes');
    const list = await screen.findByTestId('search-programmes');
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(2));
    fireEvent.change(field(), { target: { value: 'alpha r' } });
    // "Alpha Hour" cannot match the longer text; "Alpha Report" stays rather than flashing away.
    await waitFor(() => expect(screen.queryByText('Alpha Hour')).toBeNull());
    expect(screen.getByText('Alpha Report')).toBeTruthy();
    await waitFor(() => expect(programmeQueries()).toContain('alpha r'), { timeout: 2000 });
    expect(screen.getByText('Alpha Report')).toBeTruthy();
  });
});
