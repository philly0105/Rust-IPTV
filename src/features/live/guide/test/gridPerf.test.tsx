/**
 * Guide performance fixes: sticky cell text with a width cap written per clipped cell (no
 * padding, no inherited scroll variable), memoised rows that a cursor move, a scroll frame or a
 * window move leaves alone, window moves that show at once and reach the URL once they pause,
 * wheel distance kept across window moves, chunk fetches that wait for a fast scroll to settle, no
 * wasted guide request before the page is measured, and the now line under the sticky channel
 * column and the cells' text.
 */
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildScheduleIndex } from '@/features/recording/lib/schedule';

import type { Channel, EpgProgram, Page, PageQuery } from '@/api/types';
import { useToastStore } from '@/ui';

import { defaultStart, EpgGridPage, GRID_CHUNK, GRID_ROW, GRID_SCROLL_ROOM_PX, gridWindowFor } from '../../components/EpgGridPage';
import { HOUR, MINUTE, layoutBlocks } from '../../lib/epgTime';
import { cellTextPadPx, fitCellText, GuideRow, type GuideRowProps } from '../GuideRow';
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
// Rows lay their cells out with layoutBlocks: its calls count row renders.
vi.mock('../../lib/epgTime', async (orig) => {
  const mod = await orig<typeof import('../../lib/epgTime')>();
  return { ...mod, layoutBlocks: vi.fn(mod.layoutBlocks) };
});

rpcMock.current = createRpcMock();
const rpc = rpcMock.current;

let channels = Array.from({ length: 6 }, (_, i) => makeChannel(i));
const key = (r: Channel['ref']) => `${r.sourceId}|${r.contentType}|${r.itemId}`;

/** Like {@link hourly}, cut to the window asked for, as the core answers. */
function hourlyWindow(at: number) {
  const all = hourly(at);
  return (a: unknown) => {
    const { from, to } = a as { from: string; to: string };
    const [f, t] = [Date.parse(from), Date.parse(to)];
    return Object.fromEntries(Object.entries(all(a)).map(([k, list]) => [k, list.filter((p) => Date.parse(p.end) > f && Date.parse(p.start) < t)]));
  };
}

/** Hour-long programmes `<item> P<k>` from 12 h before `at` to 18 h after it. */
function hourly(at: number) {
  return (a: unknown) =>
    Object.fromEntries(
      (a as { refs: Channel['ref'][] }).refs.map((r) => {
        const list: EpgProgram[] = [];
        for (let k = -12; k < 18; k++) list.push(program(`${r.itemId} P${k}`, at + k * HOUR, at + (k + 1) * HOUR));
        return [key(r), list];
      }),
    );
}

// jsdom keeps scroll offsets at 0: record what is written, so scrolls can be driven and read.
const scrolls = { left: new WeakMap<Element, number>(), top: new WeakMap<Element, number>() };
const originals = {
  scrollLeft: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft'),
  scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'),
};

beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 4000 });
  vi.setConfig({ testTimeout: 20_000 });
  for (const [prop, map] of [
    ['scrollLeft', scrolls.left],
    ['scrollTop', scrolls.top],
  ] as const) {
    Object.defineProperty(Element.prototype, prop, {
      configurable: true,
      get(this: Element) {
        return map.get(this) ?? 0;
      },
      set(this: Element, v: number) {
        map.set(this, v);
      },
    });
  }
});
afterAll(() => {
  if (originals.scrollLeft) Object.defineProperty(Element.prototype, 'scrollLeft', originals.scrollLeft);
  if (originals.scrollTop) Object.defineProperty(Element.prototype, 'scrollTop', originals.scrollTop);
});
beforeEach(() => {
  channels = Array.from({ length: 6 }, (_, i) => makeChannel(i));
  rpc.reset();
  const h = rpc.handlers;
  h['sources.list'] = () => [{ id: 'src1', kind: 'm3u', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [];
  h['catalog.channels'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    return { items: channels.slice(q.offset, q.offset + q.limit), total: channels.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['epg.grid'] = (a) => Object.fromEntries((a as { refs: Channel['ref'][] }).refs.map((r) => [key(r), []]));
  h['epg.sources'] = () => [];
  h['epg.search'] = () => [];
  h['reminders.list'] = () => [];
  h['recordings.list'] = () => [];
  h['recordings.rules'] = () => [];
  h['recordings.capabilities'] = () => ({ supported: true });
  h['channels.edits'] = () => [];
  useToastStore.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(layoutBlocks).mockClear();
});

const GRID = [{ path: '/epg', element: <EpgGridPage /> }];
const focusedLabel = () => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? '';
const atParam = () => Number(new URLSearchParams(router.location?.search).get('at'));
const textOf = (name: RegExp) => screen.getByRole('button', { name }).querySelector<HTMLElement>('[data-testid="cell-text"]')!;

describe('cell text of a clipped cell (L2-guide-library-2, L3-perf-ui-4)', () => {
  it('cellTextPadPx pushes the text of a clipped cell past the edge, keeping room for it', () => {
    expect(cellTextPadPx(0, 0, 300)).toBe(0);
    expect(cellTextPadPx(100, 0, 300)).toBe(98);
    expect(cellTextPadPx(400, 0, 300)).toBe(300 - 20 - 48); // the cell's end pushes it out
    expect(cellTextPadPx(100, 300, 300)).toBe(0); // not clipped
  });

  // The text sticks by itself now (position: sticky moves it in the compositor, so it is no
  // layout shift); script only narrows the text of a clipped cell, so a long title ends in an
  // ellipsis inside the cell. Padding it, as before, shifted every cell on every scroll frame.
  it('fitCellText caps only the clipped cells, straight to their style, from the shifted origin', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span data-pad-left="0" data-pad-width="600"></span><span data-pad-left="600" data-pad-width="300"></span>';
    const [a, b] = root.querySelectorAll<HTMLElement>('span');
    fitCellText(root, 300);
    expect(a!.style.maxWidth).toBe(`${600 - 20 - 298}px`);
    expect(b!.style.maxWidth).toBe('');
    fitCellText(root, 0);
    expect(a!.style.maxWidth).toBe('');
    // Cells moved 600 px back with the window: the second one now starts at the edge.
    fitCellText(root, 0, -600);
    expect(a!.style.maxWidth).toBe('48px');
    expect(b!.style.maxWidth).toBe('');
    expect(a!.style.paddingInlineStart).toBe('');
  });

  it('a horizontal scroll caps the clipped cells, and pads nothing or publishes an inherited variable', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    expect(textOf(/^c1 P0,/).className).toContain('sticky');
    grid.scrollLeft = 400;
    fireEvent.scroll(grid);
    expect(textOf(/^c1 P0,/).style.maxWidth).toBe('48px');
    expect(textOf(/^c1 P1,/).style.maxWidth).toBe(`${300 - 20 - 98}px`);
    expect(textOf(/^c1 P2,/).style.maxWidth).toBe('');
    expect(textOf(/^c1 P1,/).style.paddingInlineStart).toBe('');
    expect(grid.style.getPropertyValue('--grid-scroll')).toBe('');
    // RTL scrollers count scrollLeft down from 0: the cap follows the distance from the inline start.
    grid.scrollLeft = -400;
    fireEvent.scroll(grid);
    expect(textOf(/^c1 P1,/).style.maxWidth).toBe('182px');
    grid.scrollLeft = 0;
    fireEvent.scroll(grid);
    expect(textOf(/^c1 P0,/).style.maxWidth).toBe('');
  });

  it('a cell keeps its full title as a tooltip (L3-visual-12)', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    expect((await screen.findByRole('button', { name: /^c1 P0,/ })).title).toBe('c1 P0');
  });
});

describe('memoised rows (L2-perf-ui-1)', () => {
  it('a cursor move re-renders the two rows it leaves and enters; a scroll frame re-renders none', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    act(() => cell.focus());
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P0,/));

    vi.mocked(layoutBlocks).mockClear();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(focusedLabel()).toMatch(/^c2 P0,/));
    expect(vi.mocked(layoutBlocks).mock.calls.length).toBeLessThanOrEqual(2);

    vi.mocked(layoutBlocks).mockClear();
    const grid = screen.getByTestId('epg-grid');
    grid.scrollLeft = 120;
    fireEvent.scroll(grid);
    grid.scrollLeft = 240;
    fireEvent.scroll(grid);
    expect(vi.mocked(layoutBlocks)).not.toHaveBeenCalled();
  });

  it('a window move at the edge of a sideways scroll re-renders no row: one variable moves every cell (L3-perf-ui-4)', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c2 P1,/ });
    const grid = screen.getByTestId('epg-grid');
    Object.defineProperty(grid, 'scrollWidth', { configurable: true, value: 2000 });
    Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 800 });
    const content = grid.firstElementChild as HTMLElement;
    const left = cell.style.left;
    expect(content.style.getPropertyValue('--grid-shift')).toBe('0px');
    // The next window's guide is held back: the move itself renders without it.
    rpc.handlers['epg.grid'] = () => new Promise(() => undefined);

    vi.mocked(layoutBlocks).mockClear();
    grid.scrollLeft = 1100;
    fireEvent.scroll(grid);
    expect(grid.scrollLeft).toBe(200);
    expect(content.style.getPropertyValue('--grid-shift')).toBe(`${-3 * 300}px`);
    // The rows keep their props: no cell was laid out again, and each keeps its own position. Only
    // the keyboard cursor's row (row 0, its tab stop left the window) renders.
    const rendered = vi.mocked(layoutBlocks).mock.calls.map((c) => c[0][0]!.title.split(' ')[0]);
    expect(rendered.filter((r) => r !== 'c0')).toEqual([]);
    expect(screen.getByRole('button', { name: /^c2 P1,/ })).toBe(cell);
    expect(cell.style.left).toBe(left);
  });
});

describe('clock ticks (LV-8)', () => {
  it('a tick re-renders a row only when it moves a programme between past, now and future', () => {
    const at = defaultStart(Date.now());
    const props: GuideRowProps = {
      index: 0,
      top: 0,
      height: GRID_ROW,
      channel: makeChannel(5),
      programs: [program('c5 P0', at, at + HOUR), program('c5 P1', at + HOUR, at + 2 * HOUR)],
      origin: at,
      now: at + 10 * MINUTE,
      pxPerMin: 4,
      channelCol: 200,
      trackWidth: 2000,
      compact: false,
      rtl: false,
      kind: 'm3u',
      highlighted: false,
      playing: false,
      genreFilter: null,
      cursorStart: null,
      lang: 'en',
      stripCountryPrefix: false,
      schedule: buildScheduleIndex(),
      handlers: { play: vi.fn(), open: vi.fn(), focusCell: vi.fn(), menu: vi.fn(), fitText: vi.fn(), press: vi.fn(), hover: vi.fn() },
    };
    let setNow: (n: number) => void = () => undefined;
    function Host() {
      const [now, set] = useState(props.now);
      setNow = set;
      return <GuideRow {...props} now={now} />;
    }
    renderGuide(<Host />);
    vi.mocked(layoutBlocks).mockClear();
    act(() => setNow(at + 10 * MINUTE + 30_000));
    act(() => setNow(at + 40 * MINUTE));
    expect(layoutBlocks).not.toHaveBeenCalled();
    // P0 ends: the row lays its cells out again.
    act(() => setNow(at + HOUR + 30_000));
    expect(layoutBlocks).toHaveBeenCalledTimes(1);
  });
});

describe('window moves (L2-perf-ui-4, L2-guide-library-5)', () => {
  it('a key past the window edge moves the window at once; the URL follows once moves pause', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: 'End' });
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P5,/));

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P6,/));
    expect(atParam()).toBe(at); // no router navigation per move
    await waitFor(() => expect(atParam()).toBe(at + 3 * HOUR));
  });

  it('an arrow past the window edge while its guide loads leaves the old cell and skips nothing (L3-guide-library-1)', async () => {
    const at = defaultStart(Date.now());
    const answer = hourlyWindow(at);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const first = new Date(at).toISOString();
    // Only the window the page opened on answers at once; the next one (prefetched or asked) waits.
    rpc.handlers['epg.grid'] = async (a) => {
      if ((a as { from: string }).from !== first) await gate;
      return answer(a);
    };
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: 'End' });
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P5,/));
    const grid = screen.getByTestId('epg-grid');

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    // The window moved; its guide is not in: the grid holds focus, not the cell just left.
    await waitFor(() => expect(document.activeElement).toBe(grid));
    await new Promise((r) => setTimeout(r, 100));
    expect(document.activeElement).toBe(grid);
    // A second press before it arrives does not step past the programme the first one is on.
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    release();
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P6,/));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P7,/));
  });

  it('two wheel steps into the window edge move the window twice, the second without waiting for the first', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    Object.defineProperty(grid, 'scrollWidth', { configurable: true, value: 2000 });
    Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 800 });

    grid.scrollLeft = 1100;
    fireEvent.scroll(grid);
    expect(grid.scrollLeft).toBe(1100 - 900); // moved and held still before the next event
    grid.scrollLeft = 1100;
    fireEvent.scroll(grid);
    expect(grid.scrollLeft).toBe(200);
    await waitFor(() => expect(atParam()).toBe(at + 6 * HOUR));
  });
});

describe('guide requests', () => {
  it('a fast vertical scroll asks for the chunk it stops on, not every chunk it passes (L2-perf-desktop-6)', async () => {
    channels = Array.from({ length: 9 * GRID_CHUNK }, (_, i) => makeChannel(i));
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    // Load every channel page first, slowly.
    for (const row of [100, 200, 300, 9 * GRID_CHUNK - 10]) {
      grid.scrollTop = row * GRID_ROW;
      fireEvent.scroll(grid);
      await screen.findByRole('button', { name: new RegExp(`^c${row} P0,`) });
    }
    grid.scrollTop = 0;
    fireEvent.scroll(grid);
    await screen.findByRole('button', { name: /^c1 P0,/ });
    // A window nothing is cached for.
    fireEvent.click(screen.getByRole('button', { name: '3 hours later' }));
    await screen.findByRole('button', { name: /^c1 P3,/ });
    await new Promise((r) => setTimeout(r, 300));
    rpc.calls.length = 0;

    for (let c = 1; c < 9; c++) {
      grid.scrollTop = c * GRID_CHUNK * GRID_ROW;
      fireEvent.scroll(grid);
    }
    await screen.findByRole('button', { name: new RegExp(`^c${8 * GRID_CHUNK} P3,`) });
    await new Promise((r) => setTimeout(r, 300));
    const firstRows = (rpc.of('epg.grid') as { refs: Channel['ref'][] }[]).map((a) => Number(a.refs[0]!.itemId.slice(1)));
    // Eight chunks passed. Asked for: the first one scrolled into (shown at once), the one it stopped
    // on and the one before it, fetched ahead; a slow test run may add one in passing.
    expect(firstRows.length).toBeLessThan(6);
    expect(firstRows).toContain(8 * GRID_CHUNK);
  }, 30_000);

  it('a later visit asks for no window the page is not going to show (L2-perf-desktop-12)', async () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'epg-grid-page') return new DOMRect(0, 0, 1600, 900);
      return original.call(this);
    });
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
    const first = renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID }, client);
    await screen.findByRole('button', { name: /^c1 P0,/ });
    first.unmount();
    rpc.calls.length = 0;

    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID }, client);
    await screen.findByRole('button', { name: /^c1 P0,/ });
    await new Promise((r) => setTimeout(r, 100));
    const span = gridWindowFor(1600 + GRID_SCROLL_ROOM_PX, 220);
    for (const a of rpc.of('epg.grid') as { from: string; to: string }[]) {
      expect(Date.parse(a.to) - Date.parse(a.from)).toBe(span);
    }
    client.clear();
  });

  it('reminders, recordings, rules and recording support load with the page (L2-guide-library-15, L2-perf-ui-6)', async () => {
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await waitFor(() => {
      for (const cmd of ['reminders.list', 'recordings.list', 'recordings.rules', 'recordings.capabilities']) expect(rpc.of(cmd).length).toBeGreaterThan(0);
    });
  });
});

describe('the now line (L2-guide-library-6, L3-visual-3)', () => {
  // It used to sit over the cells (z-[5]) and strike through the airing title and time. It is
  // drawn first now, with no z-index: under the sticky channel column (z-10), and under the cells'
  // text, showing through the airing cell's tint. The tint has to stay see-through: an 85 %
  // selected fill turned the red line grey in every airing cell.
  it('passes under the sticky channel column and the cells, over the translucent airing cell', async () => {
    rpc.handlers['epg.grid'] = hourly(defaultStart(Date.now()));
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const line = await screen.findByTestId('epg-now-line');
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    expect(line.className).not.toMatch(/(^|\s)z-/);
    expect(line.compareDocumentPosition(cell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('[role="rowheader"]')!.className).toContain('z-10');
    // The see-through active layer (about 10 % alpha), not an opaque or mostly opaque fill.
    expect(cell.className.split(/\s+/)).toContain('bg-active');
    expect(cell.className).not.toMatch(/(^|\s)bg-(selected|surface[\w-]*)(\/\d+)?(\s|$)/);
  });
});
