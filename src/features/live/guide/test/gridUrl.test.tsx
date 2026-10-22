/**
 * EpgGridPage with the Run 2 C5 guide UI: the window start in the URL (`at`), restored by back
 * and forward; the chevrons, the day buttons and Jump to now writing it; `t` and the window
 * label opening Jump to date and time; a search hit moving the grid (switching to all channels
 * when the group lacks the channel) and highlighting its row; and Record series from the
 * programme popover, whose confirm dialog (a portal) must not close the popover.
 */
import { act, cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { itemKey, type Category, type Channel, type EpgProgram, type GuideSearchHit, type Page, type PageQuery } from '@/api/types';
import { useToastStore } from '@/ui';

import { defaultStart, EpgGridPage, GRID_SLOT_MIN, HIGHLIGHT_MS } from '../../components/EpgGridPage';
import { addLocalDays, floorLocal, formatClockBare, formatDay, HOUR, MINUTE } from '../../lib/epgTime';
import { findChannelIndex, LOCATE_PAGE } from '../search';
import { createRpcMock, installDomStubs, makeChannel, program, renderGuide, router, settings } from './harness';

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

rpcMock.current = createRpcMock();
const rpc = rpcMock.current;
const fakes = await import('../../test/fakes');

const CHANNELS = Array.from({ length: 200 }, (_, i) => ({ ...makeChannel(i), categoryId: i >= 100 && i < 110 ? 'g2' : 'g1' }));
const cat = (id: string, name: string, itemCount: number): Category => ({ id, sourceId: 'src1', contentType: 'live', name, hidden: false, itemCount, position: 0 });

let progs: (ref: Channel['ref']) => EpgProgram[] = () => [];
beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 4000 });
  vi.setConfig({ testTimeout: 20_000 });
});
beforeEach(() => {
  rpc.reset();
  const h = rpc.handlers;
  h['sources.list'] = () => [{ id: 'src1', kind: 'm3u', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [cat('g1', 'News', 190), cat('g2', 'Sport', 10)];
  h['catalog.channels'] = (a) => {
    const { categoryId, query: q } = a as { categoryId?: string; query: PageQuery };
    const list = categoryId ? CHANNELS.filter((c) => c.categoryId === categoryId) : CHANNELS;
    return { items: list.slice(q.offset, q.offset + q.limit), total: list.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['epg.grid'] = (a) => Object.fromEntries((a as { refs: Channel['ref'][] }).refs.map((r) => [`${r.sourceId}|${r.contentType}|${r.itemId}`, progs(r)]));
  h['epg.sources'] = () => [{ url: 'http://x/epg.xml', status: 'ok', programCount: 100, channelCount: 10, enabled: true, origin: 'settings' }];
  h['epg.search'] = () => [];
  h['reminders.list'] = () => [];
  h['recordings.list'] = () => [];
  h['recordings.rules'] = () => [];
  h['recordings.capabilities'] = () => ({ supported: true });
  progs = () => [];
  useToastStore.setState({ toasts: [] });
  fakes.recorded.playItem.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// The guide's search field is in the shell header's search slot.
const GRID = [
  {
    path: '/epg',
    element: (
      <>
        <fakes.HeaderSlot />
        <EpgGridPage />
      </>
    ),
  },
];
const gridFroms = () => rpc.of('epg.grid').map((a) => Date.parse((a as { from: string }).from));
/** The window the toolbar shows starts at `s`. */
// The window's start: its AM/PM is named once, at the range's end, when both ends share it.
const showsWindow = (s: number) => expect(screen.getByTestId('guide-window').textContent).toContain(`${formatDay(s, 'en')} ${formatClockBare(s, 'en')}`);
const atOf = () => {
  const v = new URLSearchParams(router.location!.search).get('at');
  return v === null ? null : Number(v);
};

describe('the window in the URL', () => {
  it('stays three hours earlier when moving back from the live window', async () => {
    const live = defaultStart(Date.now());
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await screen.findByText('Channel 0');
    showsWindow(live);
    const grid = screen.getByTestId('epg-grid');

    fireEvent.click(screen.getByRole('button', { name: '3 hours earlier' }));
    expect(atOf()).toBe(live - 3 * HOUR);
    await waitFor(() => showsWindow(live - 3 * HOUR));
    expect(grid.scrollLeft).toBe(0);
    await waitFor(() => expect(gridFroms()).toContain(live - 3 * HOUR));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    showsWindow(live - 3 * HOUR);
    expect(atOf()).toBe(live - 3 * HOUR);
    expect(grid.scrollLeft).toBe(0);
  });

  it('opens at `at`, and back/forward restore each move of the chevrons and day buttons', async () => {
    const base = defaultStart(Date.now()) + 6 * HOUR;
    renderGuide({ path: `/epg?source=src1&at=${base}`, routes: GRID });
    await screen.findByText('Channel 0');
    await waitFor(() => expect(gridFroms().at(-1)).toBe(base));
    expect(screen.getByTestId('guide-window').textContent).toContain(formatDay(base, 'en'));

    fireEvent.click(screen.getByRole('button', { name: '3 hours later' }));
    expect(atOf()).toBe(base + 3 * HOUR);
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    expect(atOf()).toBe(addLocalDays(base + 3 * HOUR, 1));
    await waitFor(() => expect(gridFroms().at(-1)).toBe(addLocalDays(base + 3 * HOUR, 1)));
    // Other parameters stay.
    expect(new URLSearchParams(router.location!.search).get('source')).toBe('src1');

    act(() => void router.navigate!(-1));
    expect(atOf()).toBe(base + 3 * HOUR);
    await waitFor(() => showsWindow(base + 3 * HOUR));
    act(() => void router.navigate!(-1));
    expect(atOf()).toBe(base);
    await waitFor(() => showsWindow(base));
    act(() => void router.navigate!(1));
    expect(atOf()).toBe(base + 3 * HOUR);
    await waitFor(() => showsWindow(base + 3 * HOUR));
  });

  it('two quick clicks compose (each starts from the previous move, not a stale render)', async () => {
    const base = defaultStart(Date.now());
    renderGuide({ path: `/epg?at=${base}`, routes: GRID });
    await screen.findByText('Channel 0');
    const earlier = screen.getByRole('button', { name: '3 hours earlier' });
    fireEvent.click(earlier);
    fireEvent.click(earlier);
    expect(atOf()).toBe(base - 6 * HOUR);
  });

  it('Jump to now drops `at`, and back returns to the earlier window', async () => {
    const now = Date.now();
    const away = defaultStart(now) + 30 * HOUR;
    renderGuide({ path: `/epg?at=${away}`, routes: GRID });
    await screen.findByText('Channel 0');
    showsWindow(away);
    fireEvent.click(screen.getByRole('button', { name: 'Now' }));
    expect(atOf()).toBeNull();
    await waitFor(() => showsWindow(defaultStart(Date.now())));
    act(() => void router.navigate!(-1));
    expect(atOf()).toBe(away);
    await waitFor(() => showsWindow(away));
  });

  it('an unusable `at` falls back to now', async () => {
    renderGuide({ path: '/epg?at=yesterday', routes: GRID });
    await screen.findByText('Channel 0');
    await waitFor(() => expect(gridFroms().at(-1)).toBe(defaultStart(Date.now())));
  });

  it('`at` off the 30-minute grid is floored to its slot', async () => {
    const t = defaultStart(Date.now()) + 2 * HOUR + 17 * MINUTE;
    renderGuide({ path: `/epg?at=${t}`, routes: GRID });
    await screen.findByText('Channel 0');
    await waitFor(() => expect(gridFroms().at(-1)).toBe(floorLocal(t, GRID_SLOT_MIN)));
  });
});

describe('Jump to date and time', () => {
  it('`t` opens the dialog; a day and time there move the window and add a history entry', async () => {
    const base = defaultStart(Date.now());
    renderGuide({ path: `/epg?at=${base}`, routes: GRID });
    await screen.findByText('Channel 0');
    fireEvent.keyDown(document.body, { key: 't' });
    const dialog = await screen.findByTestId('guide-jump');
    const chips = within(dialog).getAllByTestId('guide-jump-day');
    fireEvent.click(chips[5]!); // three days ahead
    const time = within(dialog).getByRole('combobox', { name: 'Time' }) as HTMLSelectElement;
    const target = [...time.options].map((o) => Number(o.value)).find((v) => new Date(v).getHours() === 21 && new Date(v).getMinutes() === 0)!;
    fireEvent.change(time, { target: { value: String(target) } });
    fireEvent.click(within(dialog).getByTestId('guide-jump-go'));
    expect(screen.queryByTestId('guide-jump')).toBeNull();
    expect(atOf()).toBe(target);
    await waitFor(() => expect(gridFroms().at(-1)).toBe(target));
    act(() => void router.navigate!(-1));
    expect(atOf()).toBe(base);
  });

  it('the window label opens it too, and Now there goes back to now', async () => {
    renderGuide({ path: `/epg?at=${defaultStart(Date.now()) + 50 * HOUR}`, routes: GRID });
    await screen.findByText('Channel 0');
    fireEvent.click(screen.getByTestId('guide-window'));
    fireEvent.click(await screen.findByTestId('guide-jump-now'));
    expect(atOf()).toBeNull();
    await waitFor(() => expect(gridFroms().at(-1)).toBe(defaultStart(Date.now())));
  });

  it('`t` does nothing while typing in the search field', async () => {
    renderGuide({ path: '/epg', routes: GRID });
    await screen.findByText('Channel 0');
    const input = screen.getByRole('searchbox', { name: 'Search the guide' });
    fireEvent.keyDown(input, { key: 't' });
    expect(screen.queryByTestId('guide-jump')).toBeNull();
  });
});

describe('search hits on the grid', () => {
  const searchHit = (i: number, startMs: number, over: Partial<GuideSearchHit> = {}): GuideSearchHit => ({
    ref: CHANNELS[i]!.ref,
    channelName: CHANNELS[i]!.name,
    channelNumber: CHANNELS[i]!.number,
    categoryId: CHANNELS[i]!.categoryId,
    program: program('Evening News', startMs, startMs + HOUR),
    ...over,
  });

  async function searchAndPick(path: string, hits: GuideSearchHit[], name: RegExp) {
    rpc.handlers['epg.search'] = () => hits;
    renderGuide({ path, routes: GRID });
    await screen.findAllByText(/^Channel 10\d$|^Channel 0$/);
    const input = screen.getByRole('searchbox', { name: 'Search the guide' });
    fireEvent.change(input, { target: { value: 'news' } });
    await waitFor(() => expect(screen.getByTestId('guide-search-panel').getAttribute('data-state')).toBe('results'));
    fireEvent.click(screen.getByRole('button', { name }));
  }

  it('`/` focuses the search field', async () => {
    renderGuide({ path: '/epg', routes: GRID });
    await screen.findByText('Channel 0');
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search the guide' }));
  });

  it('moves the window to the hit, switches a group without the channel to all channels, and highlights the row', async () => {
    const start = defaultStart(Date.now()) + 26 * HOUR + 45 * MINUTE;
    progs = (r) => (r.itemId === 'c4' ? [program('Evening News', start, start + HOUR)] : []);
    await searchAndPick('/epg?source=src1&category=g2', [searchHit(4, start)], /^Evening News, Channel 4, /);
    expect(atOf()).toBe(floorLocal(start, GRID_SLOT_MIN));
    expect(new URLSearchParams(router.location!.search).get('category')).toBeNull();
    const row = await waitFor(() => {
      const el = document.querySelector('[data-channel-row="4"]');
      expect(el?.hasAttribute('data-highlighted')).toBe(true);
      return el!;
    });
    expect(row.textContent).toContain('Channel 4');
    // The keyboard cursor lands on the programme once its cell renders.
    await waitFor(() => expect(document.activeElement?.getAttribute('data-start')).toBe(new Date(start).toISOString()));
    expect(screen.queryByTestId('guide-search-panel')).toBeNull();
  });

  it('keeps a group that holds the channel', async () => {
    const start = defaultStart(Date.now()) + 5 * HOUR;
    await searchAndPick('/epg?category=g2', [searchHit(105, start)], /^Evening News, Channel 105, /);
    expect(new URLSearchParams(router.location!.search).get('category')).toBe('g2');
    await waitFor(() => expect(document.querySelector('[data-channel-row="5"]')?.hasAttribute('data-highlighted')).toBe(true));
  });

  it('the highlight fades after a moment', async () => {
    const start = defaultStart(Date.now()) + 3 * HOUR;
    await searchAndPick('/epg', [searchHit(2, start)], /^Evening News, Channel 2, /);
    await waitFor(() => expect(document.querySelector('[data-channel-row="2"]')?.hasAttribute('data-highlighted')).toBe(true));
    await waitFor(() => expect(document.querySelector('[data-channel-row="2"]')?.hasAttribute('data-highlighted')).toBe(false), { timeout: HIGHLIGHT_MS + 2000 });
  });

  it('a channel beyond the loaded pages is found by its number, not by scanning the list (LV-2)', async () => {
    const start = defaultStart(Date.now()) + 3 * HOUR;
    await searchAndPick('/epg', [searchHit(150, start)], /^Evening News, Channel 150, /);
    const reads = () => rpc.of('catalog.channels').map((a) => (a as { query: PageQuery }).query);
    // Number 151 is on the second page of 120: one read finds it.
    await waitFor(() => expect(reads().some((q) => q.offset === 120 && q.limit === 120)).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(reads().some((q) => q.limit === 1000)).toBe(false);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('the page-by-page fallback reads to the end of the list, past 60k rows (LV-2)', async () => {
    const total = 75_000;
    const target = 70_123;
    let reads = 0;
    const index = await findChannelIndex(async (offset, limit) => {
      reads++;
      const items = Array.from({ length: Math.min(limit, total - offset) }, (_, i) => makeChannel(offset + i));
      return { items, total, offset, limit };
    }, itemKey(makeChannel(target).ref));
    expect(index).toBe(target);
    expect(reads).toBe(Math.floor(target / LOCATE_PAGE) + 1);
  });

  it('a hit without a channel number falls back to reading the list page by page', async () => {
    const start = defaultStart(Date.now()) + 3 * HOUR;
    await searchAndPick('/epg', [searchHit(150, start, { channelNumber: undefined })], /^Evening News, Channel 150, /);
    await waitFor(() => expect(rpc.of('catalog.channels').some((a) => (a as { query: PageQuery }).query.limit === 1000)).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("a hit whose row's guide is still loading lands on the programme once it is in, not on the channel cell (L3-guide-library-3)", async () => {
    const start = defaultStart(Date.now()) + 3 * HOUR;
    progs = (r) => (r.itemId === 'c4' ? [program('Evening News', start, start + HOUR)] : []);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const answer = rpc.handlers['epg.grid']!;
    // The hit row's guide answers late, as a large source's does.
    rpc.handlers['epg.grid'] = async (a) => {
      if ((a as { refs: Channel['ref'][] }).refs.some((r) => r.itemId === 'c4')) await gate;
      return answer(a);
    };
    await searchAndPick('/epg', [searchHit(4, start)], /^Evening News, Channel 4, /);
    const channelCell = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-channel-row="4"]');
      expect(el?.hasAttribute('data-highlighted')).toBe(true);
      return el!;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(document.activeElement).not.toBe(channelCell);
    expect(document.activeElement).toBe(screen.getByTestId('epg-grid'));
    release();
    await waitFor(() => expect(document.activeElement?.getAttribute('data-start')).toBe(new Date(start).toISOString()));
  });

  it('a channel that is not in the list says so', async () => {
    const start = defaultStart(Date.now()) + 3 * HOUR;
    const ghost = searchHit(2, start, { ref: { sourceId: 'src1', contentType: 'live', itemId: 'gone' }, channelName: 'Gone TV', categoryId: undefined });
    await searchAndPick('/epg', [ghost], /^Evening News, Gone TV, /);
    await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Gone TV is not in this list'));
  });

  it('Watch on an airing hit plays its channel', async () => {
    rpc.handlers['epg.search'] = () => [searchHit(3, Date.now() - 10 * MINUTE)];
    renderGuide({ path: '/epg', routes: GRID });
    await screen.findByText('Channel 0');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the guide' }), { target: { value: 'news' } });
    await waitFor(() => expect(screen.getByTestId('guide-search-panel').getAttribute('data-state')).toBe('results'));
    fireEvent.click(screen.getByTestId('guide-search-watch'));
    expect(screen.queryByTestId('guide-search-panel')).toBeNull();
    await waitFor(() => expect(fakes.recorded.playItem.map((p) => p.ref.itemId)).toEqual(['c3']));
  });
});

describe('Record series from the programme popover', () => {
  it('confirms in a dialog naming title and channel; pressing inside it keeps the popover', async () => {
    const now = Date.now();
    progs = (r) => (r.itemId === 'c1' ? [program('Evening News', now - 10 * MINUTE, now + 50 * MINUTE)] : []);
    rpc.handlers['recordings.addRule'] = (a) => ({ id: 'r9', ...(a as object), enabled: true, createdAt: new Date().toISOString(), upcoming: 4 });
    renderGuide({ path: '/epg', routes: GRID });
    const cell = await screen.findByRole('button', { name: /^Evening News, / });
    fireEvent.click(cell);
    const popover = await screen.findByTestId('program-popover');
    await waitFor(() => expect(within(popover).getByTestId('program-record-series')).toBeTruthy());
    fireEvent.click(within(popover).getByTestId('program-record-series'));
    const confirm = await screen.findByTestId('series-confirm');
    expect(confirm.textContent).toContain('Evening News');
    expect(confirm.textContent).toContain('Channel 1');
    // A press inside the portal dialog is not "outside" the popover.
    fireEvent.mouseDown(within(confirm).getByText('Evening News'));
    expect(screen.getByTestId('program-popover')).toBeTruthy();
    // Tab inside the dialog stays the dialog's: the popover does not pull focus back.
    const ok = within(confirm).getByTestId('series-confirm-ok');
    expect(document.activeElement).toBe(ok);
    fireEvent.keyDown(ok, { key: 'Tab' });
    expect(confirm.contains(document.activeElement) || document.activeElement === ok).toBe(true);
    fireEvent.click(ok);
    await waitFor(() => expect(rpc.of('recordings.addRule')).toEqual([{ ref: CHANNELS[1]!.ref, channelName: 'Channel 1', title: 'Evening News' }]));
    await waitFor(() => expect(screen.queryByTestId('series-confirm')).toBeNull());
    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Recording every “Evening News”');
  });
});
