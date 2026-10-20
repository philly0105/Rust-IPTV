import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, Page, PageQuery } from '@/api/types';

import { EpgGridPage, GRID_SLOT_MIN, GRID_SLOT_PX } from '../components/EpgGridPage';
import { EpgRibbon } from '../components/EpgRibbon';
import { floorLocal, HOUR, MINUTE } from '../lib/epgTime';
import { inlineStart, scrollLeftFor, scrollStart, timeStep } from '../lib/rtl';
import { installDomStubs, makeChannel, program, renderAt, settings } from './harness';

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

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
}));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

const CHANNELS = 5;
const CHANNEL_COL = 220; // the harness matchMedia reports every min-width query as matching
const GRID_PX_PER_MIN = GRID_SLOT_PX / GRID_SLOT_MIN;

/** Programmes for every grid row: an airing show, then two more, then a gap to the window end. */
function gridHandler(now: number) {
  return (a: unknown) => {
    const refs = (a as { refs: { sourceId: string; contentType: string; itemId: string }[] }).refs;
    return Object.fromEntries(
      refs.map((r) => [
        `${r.sourceId}|${r.contentType}|${r.itemId}`,
        [
          program(`Now ${r.itemId}`, now - 10 * MINUTE, now + 20 * MINUTE),
          program(`Next ${r.itemId}`, now + 20 * MINUTE, now + 50 * MINUTE),
          program(`Late ${r.itemId}`, now + 50 * MINUTE, now + 2 * HOUR),
        ],
      ]),
    );
  };
}

function baseHandlers() {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => ({ id: 'src1', kind: 'xtream', name: 'Demo portal', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['settings.get'] = () => settings();
  h['settings.update'] = () => settings();
  h['catalog.categories'] = () => [];
  h['catalog.channels'] = (a) => {
    const q = (a as { query: PageQuery }).query;
    const items: Channel[] = Array.from({ length: Math.max(0, Math.min(q.limit, CHANNELS - q.offset)) }, (_, i) => makeChannel(q.offset + i));
    return { items, total: CHANNELS, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['epg.programs'] = () => [];
  h['epg.grid'] = () => ({});
}

// jsdom keeps scrollLeft at 0; record what the components write so the RTL sign is observable.
const scrollLefts = new WeakMap<Element, number>();
const scrollToCalls: { el: Element; left: number | undefined }[] = [];
const originalScrollLeft = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft');
const originalScrollTo = Element.prototype.scrollTo;

beforeAll(() => {
  installDomStubs();
  Object.defineProperty(Element.prototype, 'scrollLeft', {
    configurable: true,
    get(this: Element) {
      return scrollLefts.get(this) ?? 0;
    },
    set(this: Element, v: number) {
      scrollLefts.set(this, v);
    },
  });
  Element.prototype.scrollTo = function scrollTo(this: Element, arg?: ScrollToOptions | number) {
    const left = typeof arg === 'object' ? arg.left : arg;
    scrollToCalls.push({ el: this, left });
    if (left !== undefined) scrollLefts.set(this, left);
  } as typeof Element.prototype.scrollTo;
});
afterAll(() => {
  if (originalScrollLeft) Object.defineProperty(Element.prototype, 'scrollLeft', originalScrollLeft);
  Element.prototype.scrollTo = originalScrollTo;
});
beforeEach(() => {
  baseHandlers();
  scrollToCalls.length = 0;
});
afterEach(() => {
  cleanup();
  document.documentElement.dir = '';
  vi.restoreAllMocks();
});

const px = (v: string) => Number.parseFloat(v);

/**
 * Runs the clock 15 minutes into a local half hour (it keeps ticking): the guide then rests one
 * slot into its window, whatever the time of the run. Just past a half hour it rests a slot
 * earlier, at 0, where the scroll's sign says nothing.
 */
function midSlotClock(): number {
  const real = Date.now.bind(Date);
  const shift = floorLocal(real(), 30) + 15 * MINUTE - real();
  vi.spyOn(Date, 'now').mockImplementation(() => real() + shift);
  return Date.now();
}

describe('rtl helpers', () => {
  it('map inline-start offsets, scrollLeft and arrow keys to the reading direction', () => {
    expect(inlineStart(40, false)).toEqual({ left: 40 });
    expect(inlineStart(40, true)).toEqual({ right: 40 });
    expect(scrollLeftFor(300, false)).toBe(300);
    expect(scrollLeftFor(300, true)).toBe(-300);
    const el = document.createElement('div');
    el.scrollLeft = -120;
    expect(scrollStart(el)).toBe(120);
    expect(timeStep('ArrowRight', false)).toBe(1);
    expect(timeStep('ArrowLeft', false)).toBe(-1);
    expect(timeStep('ArrowRight', true)).toBe(-1);
    expect(timeStep('ArrowLeft', true)).toBe(1);
    expect(timeStep('Home', true)).toBe(0);
  });
});

describe('EpgGridPage RTL (F2)', () => {
  it('positions blocks and the now-line from the right and scrolls with a negative scrollLeft', async () => {
    document.documentElement.dir = 'rtl';
    const now = midSlotClock();
    rpcMock.handlers['epg.grid'] = gridHandler(now);
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);

    const cell = await screen.findByRole('button', { name: /Now c0/ });
    expect(cell.style.left).toBe('');
    expect(px(cell.style.right)).toBeGreaterThanOrEqual(1);

    const line = screen.getByTestId('epg-now-line');
    expect(line.style.left).toBe('');
    const grid = screen.getByTestId('epg-grid');
    // now sits 30-60 min into the window: right = channel column + now offset - 1
    const right = px(line.style.right);
    expect(right).toBeGreaterThan(CHANNEL_COL + 30 * GRID_PX_PER_MIN - 2);
    expect(right).toBeLessThan(CHANNEL_COL + 60 * GRID_PX_PER_MIN);

    // The initial scroll to the half hour now is in (one slot into the window, now 15 minutes
    // past it) runs once the grid mounts, counted down from 0 in RTL.
    await waitFor(() => expect(grid.scrollLeft).toBeLessThan(0));
    expect(-grid.scrollLeft).toBe(GRID_SLOT_PX);
  });

  it('keeps physical left offsets and a positive scrollLeft in LTR', async () => {
    const now = midSlotClock();
    rpcMock.handlers['epg.grid'] = gridHandler(now);
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    const cell = await screen.findByRole('button', { name: /Now c0/ });
    expect(cell.style.right).toBe('');
    expect(px(cell.style.left)).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('epg-now-line').style.right).toBe('');
    await waitFor(() => expect(screen.getByTestId('epg-grid').scrollLeft).toBeGreaterThan(0));
  });

  it('moves later in time with ArrowLeft in RTL', async () => {
    document.documentElement.dir = 'rtl';
    const now = Date.now();
    rpcMock.handlers['epg.grid'] = gridHandler(now);
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    const cell = await screen.findByRole('button', { name: /Now c1/ });
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: 'ArrowLeft' });
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toMatch(/^Next c1/));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toMatch(/^Now c1/));
  });
});

describe('EpgGridPage End key (F4)', () => {
  it('End focuses the last programme of the row and keeps focus in the grid', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.grid'] = gridHandler(now);
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    const cell = await screen.findByRole('button', { name: /Now c2/ });
    act(() => cell.focus());
    const ev = fireEvent.keyDown(cell, { key: 'End' });
    expect(ev).toBe(false); // default prevented: the browser must not scroll the grid to the bottom
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toMatch(/^Late c2/));

    // Home goes back to what is on now
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toMatch(/^Now c2/));
  });

  it('Ctrl+End goes to the last channel, Ctrl+Home to the first', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.grid'] = gridHandler(now);
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    const cell = await screen.findByRole('button', { name: /Now c1/ });
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: 'End', ctrlKey: true });
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toMatch(new RegExp(`^Late c${CHANNELS - 1}`)));
    fireEvent.keyDown(document.activeElement!, { key: 'Home', ctrlKey: true });
    await waitFor(() => expect((document.activeElement as HTMLElement | null)?.getAttribute('aria-label')).toMatch(/^Now c0/));
  });

  it('End on a row without guide data stays on the channel button', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.grid'] = (a) => {
      const all = gridHandler(now)(a) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, k.endsWith('|c0') ? [] : v]));
    };
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    await screen.findByRole('button', { name: /Now c1/ });
    const channelBtn = document.querySelector<HTMLElement>('[data-channel-row="0"]')!;
    act(() => channelBtn.focus());
    fireEvent.keyDown(channelBtn, { key: 'End' });
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-channel-row="0"]')));
  });
});

describe('EpgGridPage programme popover focus (F6)', () => {
  async function openPopover() {
    const now = Date.now();
    rpcMock.handlers['epg.grid'] = gridHandler(now);
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    const cell = await screen.findByRole('button', { name: /Now c0/ });
    act(() => cell.focus());
    fireEvent.click(cell);
    const pop = await screen.findByTestId('program-popover');
    await waitFor(() => expect(pop.contains(document.activeElement)).toBe(true));
    return { cell, pop };
  }

  it('Escape closes the popover and returns focus to the invoking cell', async () => {
    const { cell, pop } = await openPopover();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('program-popover')).toBeNull());
    expect(pop.isConnected).toBe(false);
    expect(document.activeElement).toBe(cell);
  });

  it('the Close button returns focus to the invoking cell', async () => {
    const { cell } = await openPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('program-popover')).toBeNull());
    expect(document.activeElement).toBe(cell);
  });

  it('Tab and Shift+Tab cycle inside the popover', async () => {
    const { pop } = await openPopover();
    const buttons = [...pop.querySelectorAll<HTMLElement>('button')];
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    expect(buttons.length).toBeGreaterThan(1);

    act(() => last.focus());
    const tab = fireEvent.keyDown(last, { key: 'Tab' });
    expect(tab).toBe(false);
    expect(document.activeElement).toBe(first);

    const back = fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(back).toBe(false);
    expect(document.activeElement).toBe(last);

    // Tab between middle items is left to the browser
    act(() => first.focus());
    expect(fireEvent.keyDown(first, { key: 'Tab' })).toBe(true);
    expect(pop.getAttribute('aria-modal')).toBe('true');
  });
});

describe('EpgRibbon RTL (F3) and header layout (F15)', () => {
  function renderRibbon(now: number) {
    rpcMock.handlers['epg.programs'] = () => [
      { ...program('Morning News', now - 2 * HOUR, now - 30 * MINUTE), category: 'News' },
      { ...program('Midday Report', now - 30 * MINUTE, now + 30 * MINUTE), category: 'News' },
      { ...program('Evening Film', now + 30 * MINUTE, now + 2 * HOUR), category: 'Film' },
    ];
    renderAt('/', [
      { path: '/', element: <EpgRibbon channel={makeChannel(0)} sourceKind="xtream" watchingLive onPlayLive={() => undefined} onMapEpg={() => undefined} /> },
    ]);
  }

  it('positions blocks, ticks and the now marker from the right and scrolls negative in RTL', async () => {
    document.documentElement.dir = 'rtl';
    const now = Date.now();
    renderRibbon(now);
    const block = await screen.findByRole('button', { name: /Midday Report.*on now/ });
    expect(block.style.left).toBe('');
    expect(px(block.style.right)).toBeGreaterThan(0);
    const line = screen.getByTestId('ribbon-now-line');
    expect(line.style.left).toBe('');
    expect(px(line.style.right)).toBeGreaterThan(0);
    // the progress fill of the airing block grows from the inline start
    expect(block.querySelector('span[aria-hidden]')?.className).toContain('start-0');

    // scrolled to now: scrollTo got a negative left, and the block window is computed from |scrollLeft|
    const scroller = screen.getByRole('group', { name: 'Timeline' });
    const call = scrollToCalls.filter((c) => c.el === scroller).at(-1);
    expect(call?.left).toBeLessThan(0);
    const blockRight = px(block.style.right);
    expect(-call!.left!).toBeLessThan(blockRight + px(block.style.width));
    // Every programme stays in the DOM after a scroll event reports the negative position.
    fireEvent.scroll(scroller);
    expect(screen.getByRole('button', { name: /Evening Film/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Morning News/ })).toBeTruthy();
    // tick labels hang off the inline start of their line
    const tick = scroller.querySelector<HTMLElement>('div.absolute.top-0.bottom-0');
    expect(tick?.style.left).toBe('');
    expect(px(tick!.style.right)).toBeGreaterThan(0);
    // the Jump-to-now chip (if shown) sits at the inline end
    expect(scroller.parentElement?.querySelector('.right-3')).toBeNull();
  });

  it('uses the same offsets on the left in LTR', async () => {
    const now = Date.now();
    renderRibbon(now);
    const block = await screen.findByRole('button', { name: /Midday Report.*on now/ });
    expect(block.style.right).toBe('');
    expect(px(screen.getByTestId('ribbon-now-line').style.left)).toBeGreaterThan(0);
    const scroller = screen.getByRole('group', { name: 'Timeline' });
    expect(scrollToCalls.filter((c) => c.el === scroller).at(-1)?.left).toBeGreaterThan(0);
  });

  it('keeps the time range and remaining time on one line, whole, and drops the category in a narrow pane', async () => {
    renderRibbon(Date.now());
    const time = await screen.findByTestId('ribbon-time');
    expect(time.className).toContain('whitespace-nowrap');
    const remaining = screen.getByTestId('ribbon-remaining');
    expect(remaining.className.split(' ')).toEqual(expect.arrayContaining(['whitespace-nowrap', 'shrink-0']));
    // A narrow pane gets the short form ("27m"), a wide one the words: never a cut number.
    expect(remaining.children).toHaveLength(2);
    expect(remaining.children[0]!.className).toContain('@[22rem]/ribbon:hidden');
    const category = screen.getByTestId('ribbon-category');
    expect(category.className.split(' ')).toEqual(expect.arrayContaining(['hidden', '@[30rem]/ribbon:block', 'truncate']));
  });
});
