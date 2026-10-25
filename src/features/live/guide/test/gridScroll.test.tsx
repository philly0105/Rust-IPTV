/**
 * Loop 1 guide fixes: the keyboard cursor waits for the window a move asked for (Home and
 * crossing the window edge), horizontal scrolling runs on past the window, the phone layout
 * (compact channel column, now line a quarter in, programme sheet), the popover follows its cell
 * and closes once the cell scrolls away, the sticky "No guide data" label, and the no-guide
 * notice that neither blinks nor moves the grid while the next window loads.
 */
import { act, cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, EpgProgram, Page, PageQuery } from '@/api/types';
import { useToastStore } from '@/ui';

import { defaultStart, EpgGridPage, GRID_DATA_BEFORE, GRID_DATA_STEP, GRID_SLOT_PX, GRID_TRACK_BEFORE, guideDataLength, guideDataStart, nowScroll, rulerLabelCovered, visibleGuideTime } from '../../components/EpgGridPage';
import { HOUR, MINUTE } from '../../lib/epgTime';
import { __resetGuideSourceForTests, rememberGuideSource } from '../lastSource';
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

const CHANNELS = Array.from({ length: 6 }, (_, i) => makeChannel(i));
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

// jsdom keeps scrollLeft at 0: record what is written, so scroll moves can be driven and read.
const scrollLefts = new WeakMap<Element, number>();
const originalScrollLeft = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft');

beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 4000 });
  vi.setConfig({ testTimeout: 20_000 });
  Object.defineProperty(Element.prototype, 'scrollLeft', {
    configurable: true,
    get(this: Element) {
      return scrollLefts.get(this) ?? 0;
    },
    set(this: Element, v: number) {
      scrollLefts.set(this, v);
    },
  });
});
afterAll(() => {
  if (originalScrollLeft) Object.defineProperty(Element.prototype, 'scrollLeft', originalScrollLeft);
});
beforeEach(() => {
  rpc.reset();
  const h = rpc.handlers;
  h['sources.list'] = () => [{ id: 'src1', kind: 'm3u', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [];
  h['catalog.channels'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    return { items: CHANNELS.slice(q.offset, q.offset + q.limit), total: CHANNELS.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
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
});

const GRID = [{ path: '/epg', element: <EpgGridPage /> }];
const focusedLabel = () => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '';
const atParam = () => Number(new URLSearchParams(router.location?.search).get('at'));

/** Includes both the stable time group and its containment padding. */
function cellTrackLeft(cell: HTMLElement): number {
  let left = 0;
  for (let node: HTMLElement | null = cell; node; node = node.parentElement) {
    left += Number.parseFloat(node.style.left || node.style.insetInlineStart || node.style.inset || '0');
    if (node.dataset.testid === 'cell-layer') return left;
  }
  throw new Error('Programme cell has no native track layer');
}

describe('helpers', () => {
  it('keeps six hours of programmes around the visible range through a daylight-saving change', () => {
    const dayBeforeUkClockChange = Date.parse('2026-10-24T18:00:00Z');
    for (const viewWidth of [2.5, 3.5, 6, 9, 15]) {
      const viewportMs = viewWidth * HOUR;
      for (let hours = 0; hours < 36; hours += 0.5) {
        const viewAt = dayBeforeUkClockChange + hours * HOUR;
        const start = guideDataStart(viewAt);
        const end = start + guideDataLength(viewportMs);
        expect(viewAt - start).toBeGreaterThanOrEqual(GRID_DATA_BEFORE);
        expect(end - viewAt - viewportMs).toBeGreaterThanOrEqual(GRID_DATA_BEFORE);
      }
    }
    const boundary = dayBeforeUkClockChange + GRID_DATA_STEP;
    expect(guideDataStart(boundary - MINUTE)).toBe(guideDataStart(dayBeforeUkClockChange));
    expect(guideDataStart(boundary)).toBe(guideDataStart(dayBeforeUkClockChange) + GRID_DATA_STEP);
  });

  it('labels the viewport rather than the buffered guide window', () => {
    const start = new Date(2026, 9, 22, 8).getTime();
    const end = start + 6 * HOUR;
    expect(visibleGuideTime(start, 0, 820, 220, 5, end)).toEqual([start, start + 2 * HOUR]);
    expect(visibleGuideTime(start, 127, 820, 220, 5, end)).toEqual([start + 25 * MINUTE, start + 2 * HOUR + 30 * MINUTE]);
    expect(visibleGuideTime(start, 0, 0, 220, 5, end)).toEqual([start, end]);
  });

  it('nowScroll starts the visible track on the half hour now is in, so rows open on whole cells', () => {
    const px = GRID_SLOT_PX / 30;
    const slot = new Date(2026, 9, 20, 17, 30).getTime();
    const start = slot - 30 * MINUTE; // defaultStart: half an hour before the slot
    // 5:46 PM: the track starts at 5:30, one slot in, and now sits 16 minutes into it.
    expect(nowScroll(slot + 16 * MINUTE, start, px, 812)).toBe(GRID_SLOT_PX);
    expect(nowScroll(slot + 16 * MINUTE, start, px, 0)).toBe(GRID_SLOT_PX); // not measured yet
    // Just past the slot line the now pill would be cut by the channel column (":02 PM"): the
    // track starts on the half hour before, and the pill sits a slot and two minutes in.
    expect(nowScroll(slot + 2 * MINUTE, start, px, 812)).toBe(0);
    expect(nowScroll(slot, start, px, 318)).toBe(0); // on the line itself
    expect(nowScroll(slot + 8 * MINUTE, start, px, 318)).toBe(GRID_SLOT_PX); // 40 px in: room for the pill
    // A track too narrow for the slot: a quarter of it before now instead, so now stays in view.
    expect(nowScroll(slot + 29 * MINUTE, start, px, 160)).toBe(Math.round(GRID_SLOT_PX + 29 * px - 40));
    // Before the window: never a negative scroll.
    expect(nowScroll(start - HOUR, start, px, 812)).toBe(0);
  });

  it('rulerLabelCovered hides a label only where the now pill lands on it', () => {
    // The 5:46 pill 80 px into the 5:30 slot leaves the short "5:30" whole.
    expect(rulerLabelCovered(80, '5:46 PM', 0, '5:30')).toBe(false);
    // On the slot line, or a few px in, it covers the label.
    expect(rulerLabelCovered(4, '5:31 PM', 0, '5:30')).toBe(true);
    // A long label reaches further.
    expect(rulerLabelCovered(60, '12:42 PM', 0, '12:30 PM')).toBe(true);
    // Just before the next slot's label, the pill does not touch it.
    expect(rulerLabelCovered(115, '7:53 PM', 150, '8:00 PM')).toBe(false);
    expect(rulerLabelCovered(140, '7:58 PM', 150, '8:00 PM')).toBe(true);
  });


});

describe('the keyboard cursor and window moves (L1-guide-library-1)', () => {
  it('ArrowRight past the window end lands on the next programme, then the one after; Home lands on what is on now', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    act(() => cell.focus());

    // The window is 6 h: End is its last programme, P5.
    fireEvent.keyDown(cell, { key: 'End' });
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P5,/));
    // The cursor follows the next programme without moving the physical timeline.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P6,/));
    expect(atParam()).toBe(at);
    // ...and the next press goes to P7, without skipping a programme.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P7,/));

    // Home: back to now, on the programme airing now (P0), not the first of the old window.
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    await waitFor(() => expect(router.location?.search).not.toContain('at='));
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P0,/));
  });
});

describe('native horizontal scrolling', () => {
  it('reads fast left movement from the native scroll position without shifting the canvas', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    const initial = Number(grid.dataset.viewAt);
    const content = grid.firstElementChild as HTMLElement;
    const width = content.style.width;
    act(() => { for (let i = 0; i < 12; i++) { grid.scrollLeft -= 350; fireEvent.scroll(grid); } });
    expect(Number(grid.dataset.viewAt)).toBe(initial - 4200 / 5 * MINUTE);
    expect(grid.scrollLeft).toBeGreaterThan(0);
    expect(content.style.width).toBe(width);
  });

  it('converts Shift mouse-wheel lines and pages into time movement', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 800 });
    // jsdom has no native scrolling; complete the requested browser animation immediately.
    grid.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      if (typeof options === 'object') grid.scrollLeft = options.left ?? grid.scrollLeft;
    });
    const initial = Number(grid.dataset.viewAt);
    act(() => {
      grid.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, shiftKey: true, deltaY: -3, deltaMode: WheelEvent.DOM_DELTA_LINE }));
      grid.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, shiftKey: true, deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_PAGE }));
    });
    expect(grid.scrollLeft).toBeGreaterThan(0);
    expect(grid.scrollLeft).toBe(GRID_TRACK_BEFORE / MINUTE * 5 - 920);
    expect(grid.scrollTo).toHaveBeenLastCalledWith({ left: grid.scrollLeft, behavior: 'smooth' });
    act(() => fireEvent.scroll(grid));
    expect(Number(grid.dataset.viewAt)).toBe(initial - 920 / 5 * MINUTE);
  });

  it('leaves horizontal wheel input uncancelled for browser scrolling', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    const initial = grid.scrollLeft;
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 300 });
    act(() => grid.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(grid.scrollLeft).toBe(initial); // jsdom has no native wheel default action
  });

  it('keeps the ruler and programmes aligned while a new data slice loads', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    const content = grid.firstElementChild as HTMLElement;
    const left = cellTrackLeft(cell);
    rpc.handlers['epg.grid'] = () => new Promise(() => undefined);
    const width = content.style.width;
    act(() => { for (let i = 0; i < 8; i++) { grid.scrollLeft -= 300; fireEvent.scroll(grid); } });
    expect(Number(grid.dataset.viewAt)).toBe(at - 2400 / 5 * MINUTE);
    expect(content.style.width).toBe(width);
    expect(screen.getByRole('button', { name: /^c1 P0,/ })).toBe(cell);
    expect(cellTrackLeft(cell)).toBe(left);
    expect(grid.querySelector('[data-slot]')).toBeTruthy();
  });
});

describe('phone layout (L1-guide-library-5, L1-guide-library-10)', () => {
  function phone() {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as unknown as MediaQueryList,
    );
  }

  it('the channel column shows the logo and number, with the name for screen readers and as a tooltip', async () => {
    phone();
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c0 P0,/ });
    const channel = document.querySelector<HTMLElement>('[data-channel-row="0"]')!;
    expect(channel.dataset.compact).toBe('');
    expect(channel.title).toBe('Play Channel 0');
    expect(screen.getByText('Channel 0').className).toContain('sr-only');
    expect((channel.closest('[role="rowheader"]') as HTMLElement).style.width).toBe('72px');
  });

  it('a programme opens as a bottom sheet over a scrim; pressing the scrim closes it', async () => {
    phone();
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c0 P0,/ });
    fireEvent.click(cell);
    const sheet = await screen.findByTestId('program-popover');
    expect(sheet.dataset.sheet).toBe('');
    expect(sheet.className).toContain('bottom-0');
    const scrim = sheet.previousElementSibling as HTMLElement;
    expect(scrim.className).toContain('bg-scrim');
    // In the overlay layer, not the page: in the page the mini player (later in the DOM, at the
    // same z-index) covered the sheet and stayed bright over its scrim (review round 2).
    expect(screen.getByTestId('epg-grid-page').contains(sheet)).toBe(false);
    expect(sheet.closest('[data-portal-host]')).toBeTruthy();
    expect(scrim.className).toContain('z-50');
    fireEvent.mouseDown(scrim);
    await waitFor(() => expect(screen.queryByTestId('program-popover')).toBeNull());
  });
});

describe('the programme popover while the grid scrolls (L1-guide-library-10)', () => {
  it('follows its cell, and closes once the cell leaves the visible track', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c2 P1,/ });
    let cellRect = new DOMRect(400, 200, 300, 48);
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === cell) return cellRect;
      if (this.dataset.testid === 'epg-grid') return new DOMRect(0, 100, 1000, 600);
      return original.call(this);
    });
    fireEvent.click(cell);
    const pop = await screen.findByTestId('program-popover');
    expect(pop.style.top).toBe('254px'); // under the cell: 200 + 48 + 6

    const grid = screen.getByTestId('epg-grid');
    cellRect = new DOMRect(300, 150, 300, 48);
    fireEvent.scroll(grid);
    expect(pop.style.top).toBe('204px');
    expect(pop.style.left).toBe('300px');

    // Scrolled under the sticky channel column (220 px): the popover closes, focus back on the cell.
    cellRect = new DOMRect(-200, 150, 300, 48);
    fireEvent.scroll(grid);
    await waitFor(() => expect(screen.queryByTestId('program-popover')).toBeNull());
    expect(document.activeElement).toBe(cell);
  });
});

describe('rows and windows without guide data (L1-guide-library-14, L1-perf-1)', () => {
  it('the row label sticks just past the channel column', async () => {
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const label = (await screen.findAllByTestId('no-guide-label'))[0]!;
    expect(label.textContent).toBe('No guide data');
    expect(label.className).toContain('sticky');
    expect(label.style.insetInlineStart).toBe('220px');
    // The band under it is opaque, so the now line drawn before the rows does not cross the label.
    const band = screen.getAllByTestId('no-guide-band')[0]!;
    expect(band.contains(label)).toBe(true);
    expect(band.className).not.toMatch(/(^|\s)(dark:)?bg-[\w-]+\/\d+(\s|$)/);
  });

  it('the no-guide notice floats over the grid and hides while a new window is unknown', async () => {
    const at = defaultStart(Date.now());
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const notice = await screen.findByTestId('guide-no-data');
    // Over the grid, not above it: it never pushes the grid down.
    expect(notice.parentElement?.className).toContain('absolute');
    expect(notice.parentElement?.parentElement?.contains(screen.getByTestId('epg-grid'))).toBe(true);

    // An empty previous window cannot prove the new one is empty while its answer is pending.
    rpc.handlers['epg.grid'] = () => new Promise(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: '3 hours later' }));
    fireEvent.click(screen.getByRole('button', { name: '3 hours later' }));
    const laterFrom = new Date(guideDataStart(at + 6 * HOUR)).toISOString();
    await waitFor(() => expect((rpc.of('epg.grid') as { from: string }[]).some((a) => a.from === laterFrom)).toBe(true));
    await waitFor(() => expect(atParam()).toBe(at + 6 * HOUR));
    expect(screen.queryByTestId('guide-no-data')).toBeNull();
  });

  it('an empty window away from now says the guide has nothing then, and offers Back to now (L4-live-1)', async () => {
    const at = defaultStart(Date.now()) + 48 * HOUR;
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const notice = await screen.findByTestId('guide-no-data');
    expect(notice.textContent).toContain('Nothing in the guide for this time.');
    expect(notice.textContent).not.toContain('Add an XMLTV address');
    fireEvent.click(within(notice).getByRole('button', { name: 'Back to now' }));
    // Back at now with no guide at all: the empty state over the rows, with the way to add one (LG-10).
    await waitFor(() => expect(screen.getByTestId('guide-no-data').textContent).toContain('No guide data for these channels yet.'));
    expect(within(screen.getByTestId('guide-no-data')).getByRole('heading', { name: "Add a TV guide to see what's on" })).toBeTruthy();
    expect(within(screen.getByTestId('guide-no-data')).getByRole('link', { name: 'Add guide' }).getAttribute('href')).toBe('/settings/epg');
  });
});

describe('rows waiting for guide data (L4-live-3)', () => {
  it('show a cell-shaped skeleton past the channel column, not a blank band', async () => {
    rpc.handlers['epg.grid'] = () => new Promise(() => undefined);
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const pending = await screen.findAllByTestId('row-guide-pending');
    expect(pending.length).toBe(CHANNELS.length);
    const lines = pending[0]!.firstElementChild as HTMLElement;
    expect(lines.className).toContain('sticky');
    expect(lines.style.insetInlineStart).toBe('220px');
    expect(lines.querySelectorAll('.skeleton-surface').length).toBe(2);
    expect(screen.queryByTestId('no-guide-label')).toBeNull();
  });
});

describe('time ruler (L4-live-4)', () => {
  it('keeps a bounded set of labels on the fixed track while the browser scrolls', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    const trackWidth = (grid.firstElementChild as HTMLElement).style.width;
    const count = grid.querySelectorAll('[data-slot]').length;
    act(() => { grid.scrollLeft -= 900; fireEvent.scroll(grid); });
    expect((grid.firstElementChild as HTMLElement).style.width).toBe(trackWidth);
    expect(grid.querySelectorAll('[data-slot]').length).toBeLessThan(60);
    expect(count).toBeGreaterThan(20);
    expect(count).toBeLessThan(60);
  });
});

describe('the source the guide opens on (L4-live-2)', () => {
  afterEach(() => __resetGuideSourceForTests());
  const two = () => [
    { id: 'src1', kind: 'm3u', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } },
    { id: 'src2', kind: 'm3u', name: 'Big', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } },
  ];
  const askedSources = () => (rpc.of('catalog.channels') as { sourceId: string }[]).map((a) => a.sourceId);

  it('without ?source, opens on the source last browsed on the Live page', async () => {
    rpc.handlers['sources.list'] = two;
    rememberGuideSource('src2');
    renderGuide({ path: '/epg', routes: GRID });
    await waitFor(() => expect(askedSources()).toContain('src2'));
    expect(askedSources()).not.toContain('src1');
  });

  it('falls back to the first source once the remembered one is gone', async () => {
    rpc.handlers['sources.list'] = two;
    rememberGuideSource('gone');
    renderGuide({ path: '/epg', routes: GRID });
    await waitFor(() => expect(askedSources()).toContain('src1'));
  });
});
