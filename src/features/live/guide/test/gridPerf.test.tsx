/**
 * Loop 2 guide performance fixes: cell text padding written per clipped cell (no inherited
 * scroll variable), memoised rows that a cursor move or a scroll frame leaves alone, window
 * moves that show at once and reach the URL once they pause, wheel distance kept across window
 * moves, chunk fetches that wait for a fast scroll to settle, no wasted guide request before the
 * page is measured, and the now line under the sticky channel column.
 */
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, EpgProgram, Page, PageQuery } from '@/api/types';
import { useToastStore } from '@/ui';

import { defaultStart, EpgGridPage, GRID_CHUNK, GRID_ROW, GRID_SCROLL_ROOM_PX, gridWindowFor } from '../../components/EpgGridPage';
import { HOUR, layoutBlocks } from '../../lib/epgTime';
import { cellTextPadPx, padCellText } from '../GuideRow';
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

describe('cell text padding (L2-guide-library-2)', () => {
  it('cellTextPadPx pushes the text of a clipped cell past the edge, keeping room for it', () => {
    expect(cellTextPadPx(0, 0, 300)).toBe(0);
    expect(cellTextPadPx(100, 0, 300)).toBe(98);
    expect(cellTextPadPx(400, 0, 300)).toBe(300 - 20 - 48); // the cell's end pushes it out
    expect(cellTextPadPx(100, 300, 300)).toBe(0); // not clipped
  });

  it('padCellText writes only the cells that need padding, straight to their style', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span data-pad-left="0" data-pad-width="600"></span><span data-pad-left="600" data-pad-width="300"></span>';
    const [a, b] = root.querySelectorAll<HTMLElement>('span');
    padCellText(root, 300);
    expect(a!.style.paddingInlineStart).toBe('298px');
    expect(b!.style.paddingInlineStart).toBe('');
    padCellText(root, 0);
    expect(a!.style.paddingInlineStart).toBe('');
  });

  it('a horizontal scroll pads the clipped cells and publishes no inherited variable', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    grid.scrollLeft = 400;
    fireEvent.scroll(grid);
    expect(textOf(/^c1 P0,/).style.paddingInlineStart).toBe(`${300 - 20 - 48}px`);
    expect(textOf(/^c1 P1,/).style.paddingInlineStart).toBe('98px');
    expect(textOf(/^c1 P2,/).style.paddingInlineStart).toBe('');
    expect(grid.style.getPropertyValue('--grid-scroll')).toBe('');
    // RTL scrollers count scrollLeft down from 0: the padding follows the distance from the inline start.
    grid.scrollLeft = -400;
    fireEvent.scroll(grid);
    expect(textOf(/^c1 P1,/).style.paddingInlineStart).toBe('98px');
    grid.scrollLeft = 0;
    fireEvent.scroll(grid);
    expect(textOf(/^c1 P0,/).style.paddingInlineStart).toBe('');
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

describe('the now line (L2-guide-library-6)', () => {
  it('passes under the sticky channel column', async () => {
    rpc.handlers['epg.grid'] = hourly(defaultStart(Date.now()));
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const line = await screen.findByTestId('epg-now-line');
    expect(line.className).toContain('z-[5]');
    expect(line.className).not.toContain('z-10');
    expect(document.querySelector('[role="rowheader"]')!.className).toContain('z-10');
  });
});
