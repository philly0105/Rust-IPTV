/**
 * The guide redesign (stage 1): genre buckets from XMLTV categories with stripes and a filter
 * (CB-GUIDE-GENRE), the playing channel's row marked and the guide opening at it (LG-01), the now
 * pill in the ruler (LG-18), the preview band (CB-GUIDE-PREVIEW), AM/PM on the hour only in the
 * ruler, and no guide for a source without live channels (LG-11). Stage 2: channel numbers move
 * the cursor (LG-01), slot labels stick past the channel column, and the row menu is Live's.
 */
import { act, cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, EpgProgram, Page, PageQuery } from '@/api/types';
import { useToastStore } from '@/ui';

import { defaultStart, EpgGridPage, PREVIEW_HOVER_MS, slotLabels } from '../../components/EpgGridPage';
import { formatClock, HOUR, MINUTE } from '../../lib/epgTime';
import { genreOf } from '../genre';
import { __resetGuideSourceForTests } from '../lastSource';
import { createRpcMock, installDomStubs, makeChannel, program, renderGuide, settings } from './harness';

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
beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 4000 });
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

    fireEvent.click(screen.getByTestId('guide-preview-toggle'));
    expect(screen.queryByTestId('guide-preview')).toBeNull();
    expect(localStorage.getItem('guide.preview')).toBe('0');
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
    const picker = screen.getByRole('combobox', { name: 'Source' });
    expect(picker.textContent).toBe('Demo');
    fireEvent.click(picker);
    expect(screen.getByRole('option', { name: /^Demo/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Films only/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole('option', { name: /^Demo/ }), { key: 'Escape' });
    cleanup();

    rpc.handlers['catalog.channels'] = () => ({ items: [], total: 0, offset: 0, limit: 120 });
    renderGuide({ path: '/epg?source=vod', routes: GRID });
    expect(await screen.findByText('This source has no live channels')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Demo' })).toBeTruthy();
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
