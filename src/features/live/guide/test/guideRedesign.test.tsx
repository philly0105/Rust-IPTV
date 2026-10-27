/**
 * The guide redesign (stage 1): genre buckets from XMLTV categories with stripes and a filter
 * (CB-GUIDE-GENRE), the playing channel's row marked and the guide opening at it (LG-01), the now
 * pill in the ruler (LG-18), the preview band (CB-GUIDE-PREVIEW), AM/PM on the hour only in the
 * ruler, and no guide for a source without live channels (LG-11). Stage 2: channel numbers move
 * the cursor (LG-01), slot labels stick past the channel column, and the row menu is Live's.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, EpgProgram, Page, PageQuery } from '@/api/types';
import { useToastStore } from '@/ui';

import { defaultStart, EpgGridPage, PREVIEW_HOVER_MS, slotLabels } from '../../components/EpgGridPage';
import { preloadScopePickerList } from '../../components/ScopePicker';
import { formatClock, HOUR, MINUTE } from '../../lib/epgTime';
import { genreOf } from '../genre';
import { __resetGuideSourceForTests } from '../lastSource';
import { createRpcMock, i18n, installDomStubs, makeChannel, newClient, program, renderGuide, router, settings } from './harness';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./harness')['createRpcMock']> }));
vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<object>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: true,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => await import('../../test/fakes'));
vi.mock('@/features/player', async () => await import('../../test/fakes'));
vi.mock('@/features/player/remote', async () => await import('../../test/fakes'));

const fakes = await import('../../test/fakes');
rpcMock.current = createRpcMock();
const rpc = rpcMock.current;

const CHANNELS = Array.from({ length: 30 }, (_, i) => makeChannel(i));
const key = (r: Channel['ref']) => `${r.sourceId}|${r.contentType}|${r.itemId}`;
const CATEGORIES = ['Movie / Drama', 'Sports', 'News', "Children's / Youth programs", 'Documentary'];

/** Hour-long programmes whose category follows the channel: c0 movies, c1 sports, c2 news, c3 kids, c4 none. */
function hourly(at: number) {
  return (a: unknown) =>
    Object.fromEntries(
      (a as { refs: Channel['ref'][] }).refs.map((r) => {
        const n = Number(r.itemId.slice(1));
        const list: EpgProgram[] = [];
        for (let k = -6; k < 12; k++) list.push({ ...program(`${r.itemId} P${k}`, at + k * HOUR, at + (k + 1) * HOUR), category: CATEGORIES[n % 5] });
        return [key(r), list];
      }),
    );
}

const media = (q: string) => ({
  matches: q.includes('min-width') || q.includes('min-height'),
  media: q,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});

// The first guide a file renders pays for the module graph: slower than the default 5 s here.
vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  installDomStubs();
  configure({ asyncUtilTimeout: 4000 });
  // The pickers' popover list is its own chunk (SH-10): in before the tests open one.
  await preloadScopePickerList();
});
beforeEach(() => {
  rpc.reset();
  __resetGuideSourceForTests();
  localStorage.clear();
  const h = rpc.handlers;
  h['sources.list'] = () => [{ id: 'src1', kind: 'm3u', name: 'Demo', channelCount: CHANNELS.length, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [];
  h['catalog.channels'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    return { items: CHANNELS.slice(q.offset, q.offset + q.limit), total: CHANNELS.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['catalog.item'] = (a) => makeChannel(Number((a as { ref: { itemId: string } }).ref.itemId.slice(1)));
  h['catalog.items'] = (a) => (a as { refs: Channel['ref'][] }).refs.map((r) => ({ item: makeChannel(Number(r.itemId.slice(1))) }));
  h['epg.grid'] = hourly(defaultStart(Date.now()));
  h['epg.programs'] = () => [];
  h['epg.sources'] = () => [{ url: 'http://x/epg.xml', status: 'ok', programCount: 100, channelCount: 10, enabled: true, origin: 'settings' }];
  h['epg.search'] = () => [];
  h['reminders.list'] = () => [];
  h['recordings.list'] = () => [];
  h['recordings.rules'] = () => [];
  h['recordings.capabilities'] = () => ({ supported: true });
  h['channels.edits'] = () => [];
  h['lists.list'] = () => [];
  useToastStore.setState({ toasts: [] });
  fakes.usePlayerStore.setState({ source: undefined } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const GRID = [{ path: '/epg', element: <EpgGridPage /> }];

describe('genre buckets (CB-GUIDE-GENRE)', () => {
  it('reads English, DVB wording and common translations, and leaves the rest alone', () => {
    expect(genreOf('Movie / Drama')).toBe('movie');
    expect(genreOf('Spielfilm')).toBe('movie');
    expect(genreOf('Películas')).toBe('movie');
    expect(genreOf('Sports')).toBe('sports');
    expect(genreOf('Fußball')).toBe('sports');
    expect(genreOf('News / Current affairs')).toBe('news');
    expect(genreOf('Новости')).toBe('news');
    expect(genreOf("Children's / Youth programs")).toBe('kids');
    expect(genreOf("Children's movie")).toBe('kids');
    expect(genreOf('Show / Game show')).toBe('series');
    expect(genreOf('ドラマ')).toBe('series');
    expect(genreOf('Documentary')).toBeNull();
    expect(genreOf('Newsletter tips')).toBeNull();
    expect(genreOf(undefined)).toBeNull();
  });

  it('stripes the cells by genre, and a filter chip leaves the others plain', async () => {
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const movie = await screen.findByRole('button', { name: /^c0 P0,/ });
    const sports = screen.getByRole('button', { name: /^c1 P0,/ });
    expect(movie.dataset.genre).toBe('movie');
    expect(within(movie).getByTestId('cell-genre').style.background).toBe('var(--color-genre-movie)');
    expect(within(screen.getByRole('button', { name: /^c4 P0,/ })).queryByTestId('cell-genre')).toBeNull();

    const chips = screen.getByRole('group', { name: 'Filter by genre' });
    fireEvent.click(within(chips).getByRole('button', { name: 'Sports' }));
    expect(within(chips).getByRole('button', { name: 'Sports' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(within(movie).queryByTestId('cell-genre')).toBeNull());
    expect(movie.className).toContain('text-fg-subtle');
    expect(within(sports).getByTestId('cell-genre')).toBeTruthy();
    // Remembered for the next visit; pressing the chosen chip again shows everything.
    expect(localStorage.getItem('guide.genreFilter')).toBe('sports');
    fireEvent.click(within(chips).getByRole('button', { name: 'Sports' }));
    await waitFor(() => expect(within(movie).getByTestId('cell-genre')).toBeTruthy());
    expect(localStorage.getItem('guide.genreFilter')).toBeNull();
  });

  it('names each cell’s genre and says what a filter did, for screen readers (review round 2)', async () => {
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const sports = await screen.findByRole('button', { name: /^c1 P0,/ });
    // The dimming is visual only: the names carry the genre, so a filtered guide reads as it looks.
    expect(sports.getAttribute('aria-label')).toMatch(/, Sports$/);
    expect(screen.getByRole('button', { name: /^c0 P0,/ }).getAttribute('aria-label')).toMatch(/, Movies$/);
    expect(screen.getByRole('button', { name: /^c4 P0,/ }).getAttribute('aria-label')).not.toMatch(/, (Movies|Sports|News|Kids|Series & shows)$/);
    const note = screen.getByTestId('guide-genre-note');
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toBe('');

    const chips = screen.getByRole('group', { name: 'Filter by genre' });
    fireEvent.click(within(chips).getByRole('button', { name: 'Sports' }));
    await waitFor(() => expect(note.textContent).toMatch(/^Filtered to Sports\. Matching programmes: \d+$/));
    // c1, c6, c11 … carry sports: one programme an hour in the 6 h window, for every row whose guide is in.
    const matching = Number(/\d+$/.exec(note.textContent!)![0]);
    expect(matching).toBeGreaterThanOrEqual(6);
    expect(matching % 6).toBe(0);
    fireEvent.click(within(chips).getByRole('button', { name: 'Sports' }));
    await waitFor(() => expect(note.textContent).toBe('Genre filter off'));
  });
});

describe('what is playing (LG-01)', () => {
  it("marks the playing channel's row", async () => {
    fakes.usePlayerStore.setState({ source: { url: 'x', kind: 'hls', title: 'Channel 2', ref: makeChannel(2).ref, isLive: true, isRadio: false } } as never);
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await screen.findByRole('button', { name: /^c2 P0,/ });
    const playing = document.querySelector<HTMLElement>('[data-channel-row="2"]')!;
    expect(playing.getAttribute('aria-current')).toBe('true');
    expect(within(playing).getByTestId('guide-playing-mark')).toBeTruthy();
    expect(playing.closest('[role="rowheader"]')!.className).toContain('tuning-tick');
    expect(document.querySelector('[data-channel-row="1"]')!.hasAttribute('aria-current')).toBe(false);
  });

  it('opens at the channel the link names, with the cursor on now', async () => {
    renderGuide({ path: '/epg?source=src1&focus=c7', routes: GRID });
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toMatch(/^c7 P0,/));
    expect(rpc.of('catalog.item')).toContainEqual({ ref: makeChannel(7).ref });
  });

  // Review round 3: the link counted as handled before its lookup answered, so a lookup cut short
  // was never made again, and a second link to the same channel never opened there.
  it('opens at the linked channel under StrictMode, whose second effect run cuts the first lookup short', async () => {
    render(
      <StrictMode>
        <QueryClientProvider client={newClient()}>
          <I18nextProvider i18n={i18n}>
            <MemoryRouter initialEntries={['/epg?source=src1&focus=c7']}>
              <Routes>
                <Route path="/epg" element={<EpgGridPage />} />
              </Routes>
            </MemoryRouter>
          </I18nextProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toMatch(/^c7 P0,/));
  });

  it('a later link to the same channel opens there again', async () => {
    const cell = () => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? '';
    renderGuide({ path: '/epg?source=src1&focus=c7', routes: GRID });
    await waitFor(() => expect(cell()).toMatch(/^c7 P0,/));
    act(() => void router.navigate!('/epg?source=src1'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(cell()).toMatch(/^c8 P0,/));
    act(() => void router.navigate!('/epg?source=src1&focus=c7'));
    await waitFor(() => expect(cell()).toMatch(/^c7 P0,/));
    expect(rpc.of('catalog.item').filter((a) => (a as { ref: { itemId: string } }).ref.itemId === 'c7')).toHaveLength(2);
  });
});

describe('the ruler', () => {
  it('names AM/PM on the hour only', () => {
    const at = new Date(2026, 9, 20, 13, 0).getTime();
    expect(slotLabels([at, at + 30 * MINUTE, at + HOUR], 'en')).toEqual(['1:00 PM', '1:30', '2:00 PM']);
  });

  it('puts the current time on the now line (LG-18)', async () => {
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const pill = await screen.findByTestId('epg-now-pill');
    expect(pill.textContent).toBe(formatClock(Date.now(), 'en'));
    expect(pill.closest('[role="row"]')).toBeTruthy();
  });
});

describe('programme cells', () => {
  it('set the title at the dense-row size and the times at caption size, not 11 px', async () => {
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c0 P0,/ });
    const [title, times] = Array.from(within(cell).getByTestId('cell-text').children) as HTMLElement[];
    expect(title!.className).toContain('text-body-sm');
    expect(title!.className).not.toContain('text-xs');
    expect(times!.className).toContain('text-caption');
    expect(times!.className).not.toContain('11rem');
  });
});

describe('the preview band (CB-GUIDE-PREVIEW)', () => {
  it('is hidden on short or narrow windows', async () => {
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await screen.findByRole('button', { name: /^c0 P0,/ });
    expect(screen.queryByTestId('guide-preview')).toBeNull();
    expect(screen.queryByTestId('guide-preview-toggle')).toBeNull();
  });

  it('describes the cursor programme, follows the pointer after a rest, and can be hidden', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(media as never);
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const band = await screen.findByTestId('guide-preview');
    expect(within(band).getByTestId('player-stage')).toBeTruthy();
    await waitFor(() => expect(within(band).getByTestId('guide-preview-title').textContent).toBe('c0 P0'));
    expect(within(band).getByRole('button', { name: 'Watch live' })).toBeTruthy();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.mouseEnter(screen.getByRole('button', { name: /^c3 P1,/ }));
    act(() => vi.advanceTimersByTime(PREVIEW_HOVER_MS + 10));
    expect(within(band).getByTestId('guide-preview-title').textContent).toBe('c3 P1');
    vi.useRealTimers();

    // The toggle's name says what a press does, with no pressed or expanded state beside it.
    const toggle = screen.getByTestId('guide-preview-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Hide preview');
    expect(toggle.hasAttribute('aria-pressed')).toBe(false);
    expect(toggle.hasAttribute('aria-expanded')).toBe(false);
    fireEvent.click(toggle);
    expect(screen.queryByTestId('guide-preview')).toBeNull();
    expect(localStorage.getItem('guide.preview')).toBe('0');
    expect(screen.getByTestId('guide-preview-toggle').getAttribute('aria-label')).toBe('Show preview');
  });

  it('starts hidden on a window under 1000 px tall until the user opens it (review round 2)', async () => {
    // Wide and 700 px or more, so the band fits; not 1000 px.
    vi.spyOn(window, 'matchMedia').mockImplementation(((q: string) => ({ ...media(q), matches: media(q).matches && !q.includes('1000px') })) as never);
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await screen.findByRole('button', { name: /^c0 P0,/ });
    expect(screen.queryByTestId('guide-preview')).toBeNull();
    fireEvent.click(screen.getByTestId('guide-preview-toggle'));
    expect(await screen.findByTestId('guide-preview')).toBeTruthy();
    expect(localStorage.getItem('guide.preview')).toBe('1');
  });
});

describe('sources without live channels (LG-11)', () => {
  it('opens on a source with live channels, and says so when the address names one without', async () => {
    rpc.handlers['sources.list'] = () => [
      { id: 'vod', kind: 'xtream', name: 'Films only', channelCount: 0, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } },
      { id: 'src1', kind: 'm3u', name: 'Demo', channelCount: CHANNELS.length, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } },
    ];
    renderGuide({ path: '/epg', routes: GRID });
    await screen.findByRole('button', { name: /^c0 P0,/ });
    // Films only is not offered: Demo is the one source with channels, so there is nothing to
    // pick and no Source picker at all (the header names the source).
    expect(screen.queryByRole('combobox', { name: 'Source' })).toBeNull();
    expect(screen.queryByText('Films only')).toBeNull();
    cleanup();

    rpc.handlers['catalog.channels'] = () => ({ items: [], total: 0, offset: 0, limit: 120 });
    renderGuide({ path: '/epg?source=vod', routes: GRID });
    expect(await screen.findByText('This source has no live channels')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Demo' })).toBeTruthy();
    // On a source without channels the picker is back, so Demo is one choice away there too.
    const picker = screen.getByRole('combobox', { name: 'Source' });
    expect(picker.textContent).toBe('Films only');
    fireEvent.click(picker);
    expect(screen.getByRole('option', { name: /^Demo/ })).toBeTruthy();
  });
});

describe('touch (LG-04)', () => {
  it("a long press on a channel cell opens the channel's menu", async () => {
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const cell = document.querySelector<HTMLElement>('[data-channel-row="1"]')!.closest<HTMLElement>('[role="rowheader"]')!;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.pointerDown(cell, { pointerType: 'touch', isPrimary: true, clientX: 30, clientY: 200 });
    act(() => vi.advanceTimersByTime(500));
    vi.useRealTimers();
    expect(await screen.findByRole('menu', { name: 'Channel 1' })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Stage 2

describe('channel numbers in the guide (LG-01)', () => {
  it('a typed number moves the cursor to that channel, at the cursor’s time', async () => {
    rpc.handlers['catalog.channelByNumber'] = (a) => {
      const n = (a as { number: number }).number;
      return n >= 1 && n <= CHANNELS.length ? CHANNELS[n - 1]! : null;
    };
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await screen.findByRole('button', { name: /^c0 P0,/ });
    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyDown(window, { key: '3' });
    expect((await screen.findByTestId('digit-osd')).textContent).toContain('13');
    // c12 holds number 13.
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toMatch(/^c12 P0,/), { timeout: 6000 });
    expect(rpc.of('catalog.channelByNumber')).toContainEqual({ sourceId: 'src1', number: 13, contentType: 'live' });
  });

  it('a number no channel has says so', async () => {
    rpc.handlers['catalog.channelByNumber'] = () => null;
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await screen.findByRole('button', { name: /^c0 P0,/ });
    fireEvent.keyDown(window, { key: '9' });
    fireEvent.keyDown(window, { key: '9' });
    await waitFor(() => expect(screen.getByTestId('digit-osd').textContent).toContain('No channel 99'), { timeout: 6000 });
  });
});

describe('the ruler and the row menu (stage 2)', () => {
  it('slot labels stick past the channel column, so the window’s first slot keeps its time', async () => {
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await screen.findByRole('button', { name: /^c0 P0,/ });
    const labels = screen.getAllByTestId('ruler-label');
    expect(labels.length).toBeGreaterThan(2);
    for (const l of labels) {
      expect(l.className).toContain('sticky');
      expect(Number.parseFloat(l.style.insetInlineStart)).toBeGreaterThan(0);
    }
  });

  it('the channel menu is headed by the channel and what is on, with Live’s entries', async () => {
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const cell = document.querySelector<HTMLElement>('[data-channel-row="1"]')!.closest<HTMLElement>('[role="rowheader"]')!;
    fireEvent.contextMenu(cell, { clientX: 30, clientY: 200 });
    const menu = await screen.findByRole('menu', { name: 'Channel 1' });
    const header = within(menu).getByTestId('context-menu-header');
    expect(header.textContent).toContain('Channel 1');
    expect(header.textContent).toContain('c1 P0');
    expect(within(menu).getByRole('menuitem', { name: 'Play' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Match guide channel' })).toBeTruthy();
    // The desktop app offers the external players here too, as on Live.
    expect(within(menu).getByRole('menuitem', { name: 'Play in MPV' })).toBeTruthy();
    expect(within(menu).getAllByRole('separator').length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Review fixes

describe('focus links, Go to playing and views (LG-01)', () => {
  const groups = [
    { id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: 30, position: 0 },
    { id: 'g2', sourceId: 'src1', contentType: 'live', name: 'Sports', hidden: false, itemCount: 30, position: 1 },
  ];

  it('a group picked after a focus link starts at its top and does not go back to the linked channel', async () => {
    rpc.handlers['catalog.categories'] = () => groups;
    renderGuide({ path: '/epg?source=src1&category=g1&focus=c7', routes: GRID });
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toMatch(/^c7 P0,/));
    expect(rpc.of('catalog.item')).toHaveLength(1);
    fireEvent.click(screen.getByRole('combobox', { name: 'Group' }));
    fireEvent.click(screen.getByRole('option', { name: /^Sports/ }));
    await waitFor(() => expect(router.location?.search).toContain('category=g2'));
    expect(router.location?.search).not.toContain('focus=');
    await screen.findByRole('button', { name: /^c0 P0,/ });
    await new Promise((r) => setTimeout(r, 200));
    // No second lookup of c7 (nor a scan of Sports for it).
    expect(rpc.of('catalog.item')).toHaveLength(1);
  });

  it('offers Go to playing only for a channel of the group on screen', async () => {
    rpc.handlers['catalog.categories'] = () => groups;
    fakes.usePlayerStore.setState({ source: { url: 'x', kind: 'hls', title: 'Channel 25', ref: makeChannel(25).ref, isLive: true, isRadio: false } } as never);
    // Channel 25 is in News (g1); the rows below come from the same pages whatever the group.
    renderGuide({ path: '/epg?source=src1&category=g2', routes: GRID });
    await screen.findByRole('button', { name: /^c0 P0,/ });
    await waitFor(() => expect(rpc.of('catalog.item')).toContainEqual({ ref: makeChannel(25).ref }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('guide-go-to-playing')).toBeNull();

    cleanup();
    renderGuide({ path: '/epg?source=src1&category=g1', routes: GRID });
    expect(await screen.findByTestId('guide-go-to-playing')).toBeTruthy();
  });

  it('the Favorites view finds a favorite far down its list: a focus link opens there, a typed number stays in the view', async () => {
    const many = Array.from({ length: 60 }, (_, i) => makeChannel(i));
    rpc.handlers['favorites.list'] = () => many.map((c, i) => ({ ref: c.ref, position: i, addedAt: '', snapshot: { title: c.name, contentType: 'live' } }));
    rpc.handlers['catalog.channelByNumber'] = (a) => many[(a as { number: number }).number - 1] ?? null;
    const scrolls = vi.spyOn(Element.prototype, 'scrollTo');
    // jsdom has no layout: give the grid room to scroll, or every scroll is clamped to the top.
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(100_000);
    renderGuide({ path: '/epg?source=src1&view=favorites&focus=c55', routes: GRID });
    await screen.findByRole('button', { name: /^c0 P0,/ });
    // Only the favorites near the top are fetched, yet row 55 is scrolled to.
    const scrolledFar = () => scrolls.mock.calls.some(([o]) => typeof o === 'object' && ((o as ScrollToOptions).top ?? 0) > 40 * 56);
    await waitFor(() => expect(scrolledFar()).toBe(true));
    fireEvent.keyDown(window, { key: '5' });
    fireEvent.keyDown(window, { key: '1' });
    await waitFor(() => expect(rpc.of('catalog.channelByNumber')).toContainEqual({ sourceId: 'src1', number: 51, contentType: 'live' }), { timeout: 6000 });
    await new Promise((r) => setTimeout(r, 100));
    // Favorite #51 is in the view: it does not open All channels.
    expect(router.location?.search).toContain('view=favorites');
  });
});

describe('the preview band and the pointer (LG-06)', () => {
  it('keeps the hovered programme while the pointer is on the band, for its buttons', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(media as never);
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const band = await screen.findByTestId('guide-preview');
    const title = () => within(band).getByTestId('guide-preview-title').textContent;
    await waitFor(() => expect(title()).toBe('c0 P0'));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const cell = screen.getByRole('button', { name: /^c3 P1,/ });
    fireEvent.mouseEnter(cell);
    act(() => vi.advanceTimersByTime(PREVIEW_HOVER_MS + 10));
    expect(title()).toBe('c3 P1');
    // On its way up to Record the pointer leaves the grid, then reaches the band.
    fireEvent.mouseLeave(cell);
    fireEvent.pointerEnter(band);
    act(() => vi.advanceTimersByTime(PREVIEW_HOVER_MS * 3));
    expect(title()).toBe('c3 P1');
    fireEvent.pointerLeave(band);
    act(() => vi.advanceTimersByTime(PREVIEW_HOVER_MS + 10));
    expect(title()).toBe('c0 P0');
    vi.useRealTimers();
  });

  it('keeps its height: the description has two lines and gives way before the title', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(media as never);
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const band = await screen.findByTestId('guide-preview');
    // A third shorter than it was (13.5rem): the actions sit at the end of the title's line.
    expect(band.className).toContain('h-[10.5rem]');
    const row = await within(band).findByTestId('guide-preview-title-row');
    expect(row.className).toContain('shrink-0');
    expect(row.contains(within(band).getByTestId('guide-preview-title'))).toBe(true);
    const actions = within(band).getByTestId('guide-preview-actions');
    expect(row.contains(actions)).toBe(true);
    expect(actions.className).toContain('shrink-0');
  });

  it('has one Watch button: the picture is the press target, out of the tab order, and says what comes next', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(media as never);
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const band = await screen.findByTestId('guide-preview');
    await waitFor(() => expect(within(band).getByTestId('guide-preview-title').textContent).toBe('c0 P0'));
    // The details' Watch live is the band's only Watch button in the tab order.
    const tabbable = within(band)
      .getAllByRole('button')
      .filter((b) => b.tabIndex >= 0 && /watch/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
    expect(tabbable.map((b) => b.textContent)).toEqual(['Watch live']);
    const picture = within(band).getByTestId('guide-preview-picture');
    expect(picture.tabIndex).toBe(-1);
    expect(picture.getAttribute('aria-label')).toBe('Watch Channel 0');
    expect(within(band).getByTestId('guide-preview-next').textContent).toContain('c0 P1');
  });
});
