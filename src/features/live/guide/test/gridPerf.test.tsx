/**
 * Guide performance fixes: clipped cell text with a local transform and width cap (no
 * padding, no inherited scroll variable), memoised rows that a cursor move, a scroll frame or a
 * window move leaves alone, window moves that show at once and reach the URL once they pause,
 * wheel distance kept across window moves, chunk fetches that wait for a fast scroll to settle, no
 * wasted guide request before the page is measured, and the now line under the sticky channel
 * column and the cells' text.
 */
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildScheduleIndex } from '@/features/recording/lib/schedule';

import type { Channel, EpgProgram, Page, PageQuery } from '@/api/types';
import { useToastStore } from '@/ui';

import { defaultStart, EpgGridPage, GRID_CHUNK, GRID_DATA_LENGTH, GRID_DATA_STEP, GRID_HORIZONTAL_IDLE_MS, GRID_ROW, guideDataLength, guideDataStart } from '../../components/EpgGridPage';
import { HOUR, MINUTE, layoutBlocks } from '../../lib/epgTime';
import * as guideClock from '../../hooks/useNow';
import { cellTextPadPx, createStickyTitleManager, GRID_NOW_VAR, GuideRow, type GuideRowProps } from '../GuideRow';
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

/** Sum the native positioned boxes, including the chunk's containment padding. */
function cellTrackLeft(cell: HTMLElement): number {
  let left = 0;
  for (let node: HTMLElement | null = cell; node; node = node.parentElement) {
    left += Number.parseFloat(node.style.left || node.style.insetInlineStart || node.style.inset || '0');
    if (node.dataset.testid === 'cell-layer') return left;
  }
  throw new Error('Programme cell has no native track layer');
}

describe('cell text of a clipped cell (L2-guide-library-2, L3-perf-ui-4)', () => {
  it('cellTextPadPx pushes the text of a clipped cell past the edge, keeping room for it', () => {
    expect(cellTextPadPx(0, 0, 300)).toBe(0);
    expect(cellTextPadPx(100, 0, 300)).toBe(98);
    expect(cellTextPadPx(400, 0, 300)).toBe(300 - 20 - 48); // the cell's end pushes it out
    expect(cellTextPadPx(100, 300, 300)).toBe(0); // not clipped
  });

  it('primes only the titles at and beside the viewport edge while scrolling in either direction', () => {
    const row = document.createElement('div');
    row.innerHTML = '<span data-pad-left="0" data-pad-width="600"></span><span data-pad-left="600" data-pad-width="300"></span><span data-pad-left="900" data-pad-width="300"></span><span data-pad-left="1200" data-pad-width="300"></span>';
    const [a, b, c, d] = row.querySelectorAll<HTMLElement>('span');
    const query = vi.spyOn(row, 'querySelectorAll');
    const fitter = createStickyTitleManager();
    const unregister = fitter.register(row, 0);
    expect(query).toHaveBeenCalledTimes(1);
    expect([a!.classList.contains('sticky'), b!.classList.contains('sticky'), c!.classList.contains('sticky'), d!.classList.contains('sticky')]).toEqual([true, true, false, false]);
    fitter.update(750);
    expect([a!.classList.contains('sticky'), b!.classList.contains('sticky'), c!.classList.contains('sticky'), d!.classList.contains('sticky')]).toEqual([true, true, true, false]);
    fitter.update(1050);
    expect([a!.classList.contains('sticky'), b!.classList.contains('sticky'), c!.classList.contains('sticky'), d!.classList.contains('sticky')]).toEqual([false, true, true, true]);
    fitter.update(0);
    expect([a!.classList.contains('sticky'), b!.classList.contains('sticky'), c!.classList.contains('sticky'), d!.classList.contains('sticky')]).toEqual([true, true, false, false]);
    expect(query).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('keeps the current title sticky through a gesture and primes newly mounted rows', () => {
    const row = document.createElement('div');
    row.innerHTML = '<span data-pad-left="0" data-pad-width="600"></span>';
    const text = row.firstElementChild as HTMLElement;
    const fitter = createStickyTitleManager();
    fitter.register(row, 200);
    expect(text.classList.contains('sticky')).toBe(true);
    fitter.update(250);
    fitter.update(350);
    expect(text.classList.contains('sticky')).toBe(true);
    expect(text.style.transform).toBe('');
    fitter.update(300);
    const newRow = document.createElement('div');
    newRow.innerHTML = '<span data-pad-left="0" data-pad-width="600"></span>';
    fitter.register(newRow, 300);
    expect(text.classList.contains('sticky')).toBe(true);
    expect((newRow.firstElementChild as HTMLElement).classList.contains('sticky')).toBe(true);
  });

  it('a horizontal scroll keeps the boundary title sticky without moving it in JavaScript', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    expect(textOf(/^c1 P1,/).classList.contains('sticky')).toBe(true);
    act(() => { grid.scrollLeft += 400; fireEvent.scroll(grid); });
    expect(textOf(/^c1 P1,/).classList.contains('sticky')).toBe(true);
    expect(textOf(/^c1 P1,/).style.transform).toBe('');
    expect(grid.style.getPropertyValue('--grid-scroll')).toBe('');
    act(() => { grid.scrollLeft -= 400; fireEvent.scroll(grid); });
    await waitFor(() => expect(textOf(/^c1 P0,/).classList.contains('sticky')).toBe(true));
  });

  it('a cell keeps its full title as a tooltip (L3-visual-12)', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    expect((await screen.findByRole('button', { name: /^c1 P0,/ })).title).toBe('c1 P0');
  });
});

describe('memoised rows (L2-perf-ui-1)', () => {
  it('reads each native horizontal offset once before writes and reuses the latest delivered position in the frame', async () => {
    const at = Date.UTC(2026, 9, 23, 12, 30);
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    const title = textOf(/^c1 P0,/);
    let left = grid.scrollLeft;
    const readsDuringGesture: boolean[] = [];
    Object.defineProperty(grid, 'scrollLeft', {
      configurable: true,
      get() {
        readsDuringGesture.push(grid.hasAttribute('data-guide-scrolling'));
        return left;
      },
      set(value: number) { left = value; },
    });
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return 100_000 + frames.length;
    });

    act(() => {
      left += 120;
      fireEvent.scroll(grid);
      left += 120;
      fireEvent.scroll(grid);
    });
    // The first native read must precede the gesture attribute and clipped-title writes.
    // Reading again afterwards can synchronously lay out newly mounted offscreen chunks.
    expect(readsDuringGesture).toEqual([false, true]);
    expect(frames).not.toHaveLength(0);
    act(() => {
      for (const callback of frames.splice(0)) callback(performance.now());
    });
    expect(readsDuringGesture).toEqual([false, true]);
    expect(Number(grid.dataset.viewAt)).toBe(at + 48 * MINUTE);
    expect(grid.hasAttribute('data-guide-scrolling')).toBe(true);
    expect(title.classList.contains('sticky')).toBe(true);
    expect(title.style.transform).toBe('');
  });

  it('moves a time-navigation click synchronously before replenishing the surrounding programme buffer', async () => {
    const at = Date.UTC(2026, 9, 23, 12, 30);
    rpc.handlers['epg.grid'] = hourlyWindow(at - 30 * MINUTE);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P-3,/ });
    const grid = screen.getByTestId('epg-grid');
    const earlier = screen.getByRole('button', { name: '3 hours earlier' });
    const initial = grid.scrollLeft;
    vi.mocked(layoutBlocks).mockClear();
    rpc.calls.length = 0;
    // Assertions inside the event's task: React has not committed its batched updates yet.
    act(() => {
      earlier.click();
      expect(grid.scrollLeft).toBe(initial - 900);
      expect(Number(grid.dataset.viewAt)).toBe(at - 3 * HOUR);
      expect(grid.hasAttribute('data-guide-scrolling')).toBe(false);
      expect(cell.querySelector<HTMLElement>('[data-testid="cell-text"]')!.classList.contains('sticky')).toBe(true);
      expect(layoutBlocks).not.toHaveBeenCalled();
      expect(rpc.of('epg.grid')).toHaveLength(0);
    });
    expect(screen.getByRole('button', { name: /^c1 P-3,/ })).toBe(cell);
    // A wheel gesture immediately after the jump still enables the continuous-scroll treatment.
    fireEvent.wheel(grid, { deltaX: 8 });
    expect(grid.hasAttribute('data-guide-scrolling')).toBe(true);
    expect(cell.querySelector<HTMLElement>('[data-testid="cell-text"]')!.classList.contains('sticky')).toBe(true);
    // Prepare the next six hours while retaining the programme that was already visible.
    const nextFrom = new Date(guideDataStart(at - 3 * HOUR)).toISOString();
    await waitFor(() => expect((rpc.of('epg.grid') as { from: string }[]).some((a) => a.from === nextFrom)).toBe(true));
  });

  it('keeps a covering previous answer instead of swapping through a distant cached slice', async () => {
    const at = Date.UTC(2026, 9, 23, 12, 30);
    const answer = hourlyWindow(at);
    rpc.handlers['epg.grid'] = answer;
    const { client } = renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    const originalArgs = rpc.of('epg.grid')[0] as { refs: Channel['ref'][]; from: string; to: string; withDescription: false };
    const args = {
      ...originalArgs,
      from: new Date(guideDataStart(at) - 12 * HOUR).toISOString(),
      to: new Date(guideDataStart(at) + 12 * HOUR).toISOString(),
    };
    act(() => { client.setQueryData(['epg.grid', args], answer(args)); });
    rpc.handlers['epg.grid'] = () => new Promise(() => undefined);
    rpc.calls.length = 0;
    vi.mocked(layoutBlocks).mockClear();
    fireEvent.click(screen.getByRole('button', { name: '3 hours earlier' }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, GRID_HORIZONTAL_IDLE_MS + 80)));
    expect(screen.getByRole('button', { name: /^c1 P0,/ })).toBe(cell);
    // Only the keyboard cursor's row may change readiness while the new query is pending.
    expect(vi.mocked(layoutBlocks).mock.calls.length).toBeLessThanOrEqual(1);
    // The already-covered viewport needs no additional quick request.
    expect((rpc.of('epg.grid') as { from: string; to: string }[]).every((a) => Date.parse(a.to) - Date.parse(a.from) >= GRID_DATA_LENGTH)).toBe(true);
  });

  it('prepares the next six hours during a gesture while retaining visible tiles and the native position', async () => {
    const at = Date.UTC(2026, 9, 23, 12, 30);
    rpc.handlers['epg.grid'] = hourlyWindow(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    const initialLeft = grid.scrollLeft;
    const initialCellLeft = cellTrackLeft(cell);
    const track = grid.firstElementChild as HTMLElement;
    const width = track.style.width;
    const retained = [...grid.querySelectorAll<HTMLElement>('button[data-start]')].filter((tile) => {
      const start = Date.parse(tile.dataset.start!);
      return start >= at && start < at + 3 * HOUR;
    });
    const nextFrom = new Date(guideDataStart(at - 96 * MINUTE)).toISOString();
    let requestedDuringGesture = false;
    const answer = hourlyWindow(at);
    rpc.handlers['epg.grid'] = (args) => {
      if ((args as { from: string }).from === nextFrom) requestedDuringGesture ||= grid.hasAttribute('data-guide-scrolling');
      return answer(args);
    };
    rpc.calls.length = 0;
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        grid.scrollLeft = initialLeft - (i + 1) * 60;
        fireEvent.scroll(grid);
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(grid.scrollLeft).toBe(initialLeft - (i + 1) * 60);
      expect(retained.every((tile) => tile.isConnected)).toBe(true);
      expect(cellTrackLeft(cell)).toBe(initialCellLeft);
    }
    const requested = () => (rpc.of('epg.grid') as { from: string }[]).some((a) => a.from === nextFrom);
    expect(requested()).toBe(true);
    expect(requestedDuringGesture).toBe(true);
    expect(track.style.width).toBe(width);
    expect(screen.getByRole('button', { name: /^c1 P0,/ })).toBe(cell);
    await act(async () => new Promise((resolve) => setTimeout(resolve, GRID_HORIZONTAL_IDLE_MS + 30)));
    expect(grid.scrollLeft).toBe(initialLeft - 480);
    expect(retained.every((tile) => tile.isConnected)).toBe(true);
    expect(screen.getByRole('button', { name: /^c1 P0,/ })).toBe(cell);
  });

  it('keeps loaded visible tiles while a small request changes time buckets', async () => {
    const at = Date.UTC(2026, 9, 23, 17, 55);
    const answer = hourlyWindow(at);
    let quickAnswered = false;
    rpc.handlers['epg.grid'] = (args) => {
      const { from, to } = args as { from: string; to: string };
      if (Date.parse(to) - Date.parse(from) >= GRID_DATA_LENGTH || quickAnswered) return new Promise(() => undefined);
      quickAnswered = true;
      return answer(args);
    };
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    const initial = Number(grid.dataset.viewAt);
    act(() => { grid.scrollLeft += 150; fireEvent.scroll(grid); });
    await waitFor(() => expect(Number(grid.dataset.viewAt)).toBe(initial + 30 * MINUTE));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 180)));
    expect(screen.getByRole('button', { name: /^c1 P0,/ })).toBe(cell);
  });

  it('keeps loaded rows while a vertical move requests another visible row set', async () => {
    channels = Array.from({ length: 120 }, (_, i) => makeChannel(i));
    const at = defaultStart(Date.now());
    const answer = hourlyWindow(at);
    let quickAnswered = false;
    rpc.handlers['epg.grid'] = (args) => {
      const { from, to } = args as { from: string; to: string };
      if (Date.parse(to) - Date.parse(from) >= GRID_DATA_LENGTH || quickAnswered) return new Promise(() => undefined);
      quickAnswered = true;
      return answer(args);
    };
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c2 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    act(() => { grid.scrollTop = GRID_ROW; fireEvent.scroll(grid); });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 180)));
    expect(screen.getByRole('button', { name: /^c2 P0,/ })).toBe(cell);
  });

  it('draws visible programmes from a small request while the full guide slice is pending', async () => {
    const at = defaultStart(Date.now());
    const answer = hourlyWindow(at);
    rpc.handlers['epg.grid'] = (args) => {
      const { from, to } = args as { from: string; to: string };
      if (Date.parse(to) - Date.parse(from) >= GRID_DATA_LENGTH) return new Promise(() => undefined);
      return answer(args);
    };
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    expect((rpc.of('epg.grid') as { from: string; to: string }[]).some(({ from, to }) => Date.parse(to) - Date.parse(from) >= GRID_DATA_LENGTH)).toBe(true);
    expect((rpc.of('epg.grid') as { from: string; to: string }[]).some(({ from, to }) => Date.parse(to) - Date.parse(from) < GRID_DATA_LENGTH)).toBe(true);
    expect(within(cell.closest<HTMLElement>('[role="row"]')!).queryByTestId('row-guide-pending')).toBeNull();
  });

  it('loads the visible channel rows after a vertical jump without waiting for the full chunk', async () => {
    channels = Array.from({ length: 120 }, (_, i) => makeChannel(i));
    const at = defaultStart(Date.now());
    const answer = hourlyWindow(at);
    rpc.handlers['epg.grid'] = (args) => {
      const { from, to } = args as { from: string; to: string };
      if (Date.parse(to) - Date.parse(from) >= GRID_DATA_LENGTH) return new Promise(() => undefined);
      return answer(args);
    };
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    act(() => { grid.scrollTop = 36 * GRID_ROW; fireEvent.scroll(grid); });
    await screen.findByRole('button', { name: /^c36 P0,/ });
    expect((rpc.of('epg.grid') as { refs: Channel['ref'][]; from: string; to: string }[]).some(({ refs, from, to }) =>
      refs.some((ref) => ref.itemId === 'c36') && Date.parse(to) - Date.parse(from) < GRID_DATA_LENGTH)).toBe(true);
  });

  it('loads an earlier visible time while its new full slice is pending', async () => {
    const at = defaultStart(Date.now());
    const answer = (args: unknown) => {
      const { refs, from, to } = args as { refs: Channel['ref'][]; from: string; to: string };
      const f = Date.parse(from);
      const t = Date.parse(to);
      return Object.fromEntries(refs.map((ref) => [key(ref), Array.from({ length: 60 }, (_, i) => {
        const start = at + (i - 30) * HOUR;
        return program(`${ref.itemId} P${i - 30}`, start, start + HOUR);
      }).filter((p) => Date.parse(p.end) > f && Date.parse(p.start) < t)]));
    };
    rpc.handlers['epg.grid'] = answer;
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    rpc.handlers['epg.grid'] = (args) => {
      const { from, to } = args as { from: string; to: string };
      if (Date.parse(to) - Date.parse(from) >= GRID_DATA_LENGTH) return new Promise(() => undefined);
      return answer(args);
    };
    const grid = screen.getByTestId('epg-grid');
    act(() => { grid.scrollLeft -= 15 * HOUR / MINUTE * 5; fireEvent.scroll(grid); });
    await screen.findByRole('button', { name: /^c1 P-15,/ });
    expect((rpc.of('epg.grid') as { from: string; to: string }[]).some(({ from, to }) =>
      Date.parse(to) - Date.parse(from) < GRID_DATA_LENGTH && Date.parse(from) <= at - 15 * HOUR)).toBe(true);
  });

  it('caches wide outer programme slices before a native scroll reaches them', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourlyWindow(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P1,/ });
    const grid = screen.getByTestId('epg-grid');
    const currentStart = guideDataStart(at);
    const outerShift = GRID_DATA_LENGTH - GRID_DATA_STEP;
    const earlier = new Date(currentStart - outerShift).toISOString();
    const later = new Date(currentStart + outerShift).toISOString();
    const callsFor = (from: string) => (rpc.of('epg.grid') as { from: string }[]).filter((a) => a.from === from).length;
    await waitFor(() => {
      expect(callsFor(earlier)).toBe(1);
      expect(callsFor(later)).toBe(1);
    });

    act(() => { grid.scrollLeft += 6 * HOUR / MINUTE * 5; fireEvent.scroll(grid); });
    await waitFor(() => expect(Number(grid.dataset.viewAt)).toBe(at + 6 * HOUR));
    await waitFor(() => expect(screen.getByRole('button', { name: /^c1 P1,/ })).toBe(cell));
    expect(callsFor(later)).toBe(1);
    expect(screen.queryByTestId('row-guide-pending')).toBeNull();
  });

  it('shows an outer cached answer immediately when a fast move outruns the exact slice', async () => {
    const at = defaultStart(Date.now());
    const answer = (a: unknown) => {
      const { refs, from, to } = a as { refs: Channel['ref'][]; from: string; to: string };
      const f = Date.parse(from);
      const t = Date.parse(to);
      return Object.fromEntries(refs.map((ref) => [key(ref), Array.from({ length: 60 }, (_, i) => {
        const start = at + (i - 30) * HOUR;
        return program(`${ref.itemId} P${i - 30}`, start, start + HOUR);
      }).filter((p) => Date.parse(p.end) > f && Date.parse(p.start) < t)]));
    };
    rpc.handlers['epg.grid'] = answer;
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const outerFrom = new Date(guideDataStart(at) - (GRID_DATA_LENGTH - GRID_DATA_STEP)).toISOString();
    await waitFor(() => expect((rpc.of('epg.grid') as { from: string }[]).some((a) => a.from === outerFrom)).toBe(true));
    // Let the outer answer land in the query cache, then hold all new exact-window requests.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    rpc.handlers['epg.grid'] = () => new Promise(() => undefined);
    const grid = screen.getByTestId('epg-grid');
    act(() => { grid.scrollLeft -= 15 * HOUR / MINUTE * 5; fireEvent.scroll(grid); });
    await waitFor(() => expect(Number(grid.dataset.viewAt)).toBe(at - 15 * HOUR));
    await screen.findByRole('button', { name: /^c1 P-15,/ });
    expect(screen.queryByTestId('row-guide-pending')).toBeNull();
  });

  it('keeps cached Xtream programmes in place across a rolling data request', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['sources.list'] = () => [{ id: 'src1', kind: 'xtream', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
    rpc.handlers['settings.get'] = () => settings({ epgShortFallback: false });
    rpc.handlers['catchup.table'] = (a) => {
      const ref = (a as { ref: Channel['ref'] }).ref;
      return Array.from({ length: 30 }, (_, k) => program(`${ref.itemId} P${k - 12}`, at + (k - 12) * HOUR, at + (k - 11) * HOUR));
    };
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c2 P0,/ });
    await waitFor(() => expect(rpc.of('catchup.table').length).toBeGreaterThanOrEqual(6));
    const grid = screen.getByTestId('epg-grid');
    Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 800 });
    const position = () => cellTrackLeft(cell) - grid.scrollLeft;
    const before = position();
    act(() => { grid.scrollLeft -= 300; fireEvent.scroll(grid); });
    expect(screen.getByRole('button', { name: /^c2 P0,/ })).toBe(cell);
    expect(position()).toBe(before + 300);
  });

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
    fireEvent.wheel(grid, { deltaX: 120 });
    fireEvent.wheel(grid, { deltaX: 120 });
    expect(vi.mocked(layoutBlocks)).not.toHaveBeenCalled();
  });

  it('loading the next data slice keeps existing cells mounted and the track width still', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c2 P1,/ });
    const grid = screen.getByTestId('epg-grid');
    const content = grid.firstElementChild as HTMLElement;
    const left = cellTrackLeft(cell);
    const width = content.style.width;
    Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 800 });
    // The next window's guide is held back: the move itself renders without it.
    rpc.handlers['epg.grid'] = () => new Promise(() => undefined);

    const initial = grid.scrollLeft;
    act(() => { grid.scrollLeft += 900; fireEvent.scroll(grid); });
    expect(grid.scrollLeft).toBe(initial + 900);
    expect(content.style.width).toBe(width);
    expect(screen.getByRole('button', { name: /^c2 P1,/ })).toBe(cell);
    expect(cellTrackLeft(cell)).toBe(left);
  });

  it('does not return to a focused live programme when an earlier data slice replaces it', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourlyWindow(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const live = await screen.findByRole('button', { name: /^c1 P0,/ });
    act(() => live.focus());
    const grid = screen.getByTestId('epg-grid');
    const target = grid.scrollLeft - 6300;
    act(() => { grid.scrollLeft = target; fireEvent.scroll(grid); });
    await waitFor(() => expect(screen.queryByRole('button', { name: /^c1 P0,/ })).toBeNull());
    await screen.findByRole('button', { name: /^c1 P-10,/ });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(grid.scrollLeft).toBe(target);
    expect(Number(grid.dataset.viewAt)).toBe(at - 21 * HOUR);
    expect(document.activeElement).toBe(grid);
  }, 20_000);
});

describe('clock ticks (LV-8)', () => {
  it('updates only airing markers on a clock tick while retaining the programme DOM and row layout', async () => {
    const at = Date.UTC(2026, 9, 25, 12);
    let setNow: (value: number) => void = () => undefined;
    vi.spyOn(guideClock, 'useNow').mockImplementation(() => {
      const [now, set] = useState(at + 10 * MINUTE);
      setNow = set;
      return now;
    });
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    const cells = [...grid.querySelectorAll<HTMLElement>('button[data-start]')];
    const markers = [...grid.querySelectorAll<HTMLElement>('[data-guide-clock]')];
    expect(markers.length).toBeGreaterThan(0);
    const previous = markers[0]!.style.getPropertyValue(GRID_NOW_VAR);
    expect(Number.parseFloat(previous)).toBeGreaterThan(0);
    vi.mocked(layoutBlocks).mockClear();

    act(() => setNow(at + 10 * MINUTE + 30_000));

    expect(layoutBlocks).not.toHaveBeenCalled();
    expect([...grid.querySelectorAll('button[data-start]')]).toEqual(cells);
    expect(cells.every((cell) => cell.isConnected)).toBe(true);
    const current = markers[0]!.style.getPropertyValue(GRID_NOW_VAR);
    expect(Number.parseFloat(current)).toBeGreaterThan(Number.parseFloat(previous));
    expect(markers.every((marker) => marker.isConnected && marker.style.getPropertyValue(GRID_NOW_VAR) === current)).toBe(true);
    // The clock value belongs to the two empty marker spans, never to an ancestor of tiles.
    const clockOwners = [...grid.querySelectorAll<HTMLElement>('*')].filter((el) => el.style.getPropertyValue(GRID_NOW_VAR));
    expect(clockOwners).toEqual(markers);
    expect(grid.style.getPropertyValue(GRID_NOW_VAR)).toBe('');
  });

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
      compact: false,
      rtl: false,
      kind: 'm3u',
      highlighted: false,
      playing: false,
      genreFilter: null,
      genreNames: { movie: 'Movies', sports: 'Sports', news: 'News', kids: 'Kids', series: 'Series & shows' },
      labels: { onNow: 'On now', archive: 'Archive', playingNow: 'Playing now', noGuideShort: 'No guide', playChannel: (name) => `Play ${name}` },
      cursorStart: null,
      lang: 'en',
      stripCountryPrefix: false,
      schedule: buildScheduleIndex(),
      handlers: { play: vi.fn(), open: vi.fn(), focusCell: vi.fn(), menu: vi.fn(), trackTitles: vi.fn(), press: vi.fn(), hover: vi.fn() },
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
  it('a key past the visible range moves to the next programme without changing the URL', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: 'End' });
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P5,/));

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P6,/));
    expect(atParam()).toBe(at);
  });

  it('an arrow into the overlap of a loading data slice skips no programme (L3-guide-library-1)', async () => {
    const at = defaultStart(Date.now());
    const answer = hourlyWindow(at);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let firstTo: string | undefined;
    // Only the window the page opened on answers at once; the extended one waits.
    rpc.handlers['epg.grid'] = async (a) => {
      const to = (a as { to: string }).to;
      if (firstTo && to !== firstTo) await gate;
      firstTo ??= to;
      return answer(a);
    };
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    act(() => cell.focus());
    fireEvent.keyDown(cell, { key: 'End' });
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P5,/));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P6,/));
    release();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    await waitFor(() => expect(focusedLabel()).toMatch(/^c1 P7,/));
  });

  it('keeps fetching data as keyboard focus moves beyond the loaded slice', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourlyWindow(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 800 });
    act(() => cell.focus());
    for (let i = 1; i <= 12; i++) {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
      await waitFor(() => expect(focusedLabel()).toMatch(new RegExp(`^c1 P${i},`)));
    }
    const froms = new Set((rpc.of('epg.grid') as { from: string }[]).map((a) => a.from));
    expect(froms.size).toBeGreaterThan(1);
  });

  it('two wheel steps compose before the URL settles', async () => {
    const at = defaultStart(Date.now());
    rpc.handlers['epg.grid'] = hourly(at);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    const grid = screen.getByTestId('epg-grid');
    Object.defineProperty(grid, 'clientWidth', { configurable: true, value: 800 });
    act(() => { grid.scrollLeft += 900; fireEvent.scroll(grid); });
    act(() => { grid.scrollLeft += 900; fireEvent.scroll(grid); });
    expect(Number(grid.dataset.viewAt)).toBe(at + 6 * HOUR);
    expect(grid.scrollLeft).toBeGreaterThan(1800);
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
    fireEvent.click(screen.getByRole('button', { name: '3 hours later' }));
    await screen.findByRole('button', { name: /^c1 P6,/ });
    await new Promise((r) => setTimeout(r, 300));
    rpc.calls.length = 0;

    for (let c = 1; c < 9; c++) {
      grid.scrollTop = c * GRID_CHUNK * GRID_ROW;
      fireEvent.scroll(grid);
    }
    await screen.findByRole('button', { name: new RegExp(`^c${8 * GRID_CHUNK} P6,`) });
    await new Promise((r) => setTimeout(r, 300));
    const firstRows = (rpc.of('epg.grid') as { refs: Channel['ref'][] }[]).map((a) => Number(a.refs[0]!.itemId.slice(1)));
    // Eight chunks passed. Asked for: the first one scrolled into (shown at once), the one it stopped
    // on and the one before it, fetched ahead; a slow test run may add one in passing.
    expect(firstRows.length, JSON.stringify(firstRows)).toBeLessThan(6);
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
    const span = guideDataLength((1600 - 220) / 5 * MINUTE);
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
  // It used to sit over the cells (z-[5]) and strike through the airing title and time; later it
  // showed through a see-through airing cell, in every glyph gap. It is drawn first, with no
  // z-index: under the sticky channel column (z-10) and under the cells, which are opaque, so it
  // shows only in the gutters. The airing cell carries its stub at the foot.
  it('passes under the sticky channel column and the opaque cells, with a stub at the airing cell foot', async () => {
    rpc.handlers['epg.grid'] = hourly(defaultStart(Date.now()));
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const line = await screen.findByTestId('epg-now-line');
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    expect(line.className).not.toMatch(/(^|\s)z-/);
    expect(line.compareDocumentPosition(cell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('[role="rowheader"]')!.className).toContain('z-10');
    // An opaque fill: the raised cell (white in light, the raised fill in dark), no state layer.
    expect(cell.className.split(/\s+/)).toEqual(expect.arrayContaining(['bg-surface', 'dark:bg-raised', 'shadow-2']));
    expect(cell.className).not.toMatch(/(^|\s)bg-(active|hover|selected)(\s|$)/);
    expect(cell.className).not.toMatch(/(^|\s)(dark:)?bg-[\w-]+\/\d+(\s|$)/);
    const tick = within(cell).getByTestId('cell-now-tick');
    expect(tick.className.split(/\s+/)).toContain('bg-live');
    // Future cells are opaque too, and so is a cell another genre filter steps back.
    const later = await screen.findByRole('button', { name: /^c1 P1,/ });
    expect(later.className).not.toMatch(/(^|\s)(dark:)?bg-[\w-]+\/\d+(\s|$)/);
    expect(within(later).queryByTestId('cell-now-tick')).toBeNull();
  });

  // Round 4: the airing column is a band. Later cells sit one surface step under the airing
  // cell in both themes (they shared the white in light), its title is semibold, and every
  // time line is the quiet tone: the airing times used to be the loud ones. Later and ended
  // cells take surface-2 in dark too: dark:bg-surface is the page's own black under OLED, and
  // an ended cell with no fill left catch-up hours as loose text.
  it('sets the airing cells apart from later ones as a band', async () => {
    rpc.handlers['epg.grid'] = hourly(defaultStart(Date.now()));
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    const later = await screen.findByRole('button', { name: /^c1 P1,/ });
    const ended = await screen.findByRole('button', { name: /^c1 P-1,/ });
    const fill = ['bg-surface-2', 'hover:bg-surface-3', 'dark:bg-surface-2', 'dark:hover:bg-surface-3'];
    expect(later.className.split(/\s+/)).toEqual(expect.arrayContaining(fill));
    expect(later.className.split(/\s+/)).not.toContain('shadow-2');
    // An ended cell keeps the later cells' block and steps back by its text tone only.
    expect(ended.className.split(/\s+/)).toEqual(expect.arrayContaining([...fill, 'text-fg-subtle']));
    expect(ended.className.split(/\s+/)).not.toContain('bg-bg');
    const [title, time] = within(cell).getByTestId('cell-text').children as unknown as HTMLElement[];
    expect(title!.className).toContain('font-semibold');
    expect(time!.className).toContain('text-fg-muted');
    const [laterTitle, laterTime] = within(later).getByTestId('cell-text').children as unknown as HTMLElement[];
    expect(laterTitle!.className).toContain('font-medium');
    expect(laterTitle!.className).not.toContain('font-semibold');
    expect(laterTime!.className).toContain('text-fg-muted');
  });
});
