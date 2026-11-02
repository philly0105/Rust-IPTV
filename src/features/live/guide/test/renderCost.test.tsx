/**
 * The guide page's render costs (P2-GUIDE): grid keys hashed once per chunk and window, a page
 * that measures itself before its rows are in, and rows and the grid's content that keep their
 * layout to themselves.
 */
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { rpcKey } from '@/api/query';
import { itemKey, type Channel, type ItemRef, type Page, type PageQuery } from '@/api/types';
import { usePlayerStore } from '@/features/player';
import { useToastStore } from '@/ui';

import { defaultStart, EpgGridPage, GRID_CHUNK, GRID_ROW, gridArgs } from '../../components/EpgGridPage';
import { ScopePicker } from '../../components/ScopePicker';
import { HOUR } from '../../lib/epgTime';
import { GuidePreview } from '../GuidePreview';
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
// Its calls count how often a ref's key string is built.
vi.mock('@/api/types', async (orig) => {
  const mod = await orig<typeof import('@/api/types')>();
  return { ...mod, itemKey: vi.fn(mod.itemKey) };
});
// Their calls count renders of the preview band and of the toolbar (its two pickers).
vi.mock('../GuidePreview', async (orig) => {
  const mod = await orig<typeof import('../GuidePreview')>();
  return { ...mod, GuidePreview: vi.fn(mod.GuidePreview) };
});
vi.mock('../../components/ScopePicker', async (orig) => {
  const mod = await orig<typeof import('../../components/ScopePicker')>();
  return { ...mod, ScopePicker: vi.fn(mod.ScopePicker) };
});

rpcMock.current = createRpcMock();
const rpc = rpcMock.current;

let channels = Array.from({ length: 6 }, (_, i) => makeChannel(i));
const key = (r: Channel['ref']) => `${r.sourceId}|${r.contentType}|${r.itemId}`;

/** Hour-long programmes from 6 h before `at` to 12 h after it. */
function hourly(at: number) {
  return (a: unknown) =>
    Object.fromEntries(
      (a as { refs: Channel['ref'][] }).refs.map((r) => [key(r), Array.from({ length: 18 }, (_, k) => program(`${r.itemId} P${k - 6}`, at + (k - 6) * HOUR, at + (k - 5) * HOUR))]),
    );
}

// jsdom keeps scroll offsets at 0: record what is written, so scrolls can be driven.
const scrolls = new WeakMap<Element, number>();
const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');

beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 4000 });
  vi.setConfig({ testTimeout: 20_000 });
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return scrolls.get(this) ?? 0;
    },
    set(this: Element, v: number) {
      scrolls.set(this, v);
    },
  });
});
afterAll(() => {
  if (originalScrollTop) Object.defineProperty(Element.prototype, 'scrollTop', originalScrollTop);
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
  h['epg.grid'] = hourly(defaultStart(Date.now()));
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

describe('the page measurement (P2-GUIDE-2)', () => {
  it('measures the page before its rows are in, and renders them before the commit ends', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
    const first = renderGuide({ path: '/epg?source=src1', routes: GRID }, client);
    await screen.findByRole('button', { name: /^c1 P0,/ });
    first.unmount();

    // A return visit: the channels are cached, so the grid mounts with the page.
    const rowsAtMeasure: number[] = [];
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'epg-grid-page') rowsAtMeasure.push(this.querySelectorAll('[role="row"][aria-rowindex]').length);
      return original.call(this);
    });
    renderGuide({ path: '/epg?source=src1', routes: GRID }, client);
    expect(screen.getByTestId('epg-grid')).toBeTruthy();
    expect(rowsAtMeasure).toEqual([0]);
    // In by the end of the render's act: the first paint shows them.
    expect(screen.getAllByRole('row').filter((r) => r.hasAttribute('aria-rowindex'))).toHaveLength(6);
    client.clear();
  });
});

describe('grid keys (P2-GUIDE-6)', () => {
  it('a vertical scroll frame inside the chunks on screen hashes no grid key', async () => {
    channels = Array.from({ length: 3 * GRID_CHUNK }, (_, i) => makeChannel(i));
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await screen.findByRole('button', { name: /^c1 P0,/ });
    // Past the prefetch of the chunk below.
    await new Promise((r) => setTimeout(r, 300));
    const grid = screen.getByTestId('epg-grid');
    const stringify = vi.spyOn(JSON, 'stringify');
    for (const y of [GRID_ROW, 2 * GRID_ROW, 3 * GRID_ROW]) {
      act(() => {
        grid.scrollTop = y;
        fireEvent.scroll(grid);
      });
    }
    const gridKeys = stringify.mock.calls.filter(([v]) => Array.isArray(v) && v[0] === 'epg.grid');
    stringify.mockRestore();
    expect(screen.getByRole('button', { name: /^c4 P0,/ })).toBeTruthy();
    expect(gridKeys).toEqual([]);
  });
});

describe('cached grid answers while a chunk loads (F3-2)', () => {
  it('joins each cached answer\'s refs at most once, and never a described or other-sized chunk\'s', async () => {
    channels = Array.from({ length: 3 * GRID_CHUNK }, (_, i) => makeChannel(i));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
    // A long session's grid answers: chunk-sized answers for other rows, the quick requests' few
    // visible rows, and Sports' 500-channel chunks with descriptions.
    const seed = (tag: string, n: number, size: number, withDescription: boolean) => {
      for (let k = 0; k < n; k++) {
        const refs: ItemRef[] = Array.from({ length: size }, (_, i) => ({ sourceId: 'src1', contentType: 'live', itemId: `${tag}${k}-${i}` }));
        const from = new Date(Date.UTC(2026, 9, 1) + k * HOUR).toISOString();
        const to = new Date(Date.UTC(2026, 9, 2) + k * HOUR).toISOString();
        const args = { ...gridArgs(refs, from, to), withDescription };
        client.setQueryData(rpcKey('epg.grid', args), Object.fromEntries(refs.map((r) => [itemKey(r), []])));
      }
    };
    seed('chunk', 200, GRID_CHUNK, false);
    seed('quick', 50, 15, false);
    seed('sports', 3, 500, true);
    // The chunk on screen never answers, so every render looks through the cache.
    rpc.handlers['epg.grid'] = () => new Promise(() => undefined);
    renderGuide({ path: '/epg?source=src1', routes: GRID }, client);
    const grid = await screen.findByTestId('epg-grid');
    await waitFor(() => expect(grid.querySelector('[data-channel-row="1"]')).toBeTruthy());
    await waitFor(() => expect(rpc.of('epg.grid').length).toBeGreaterThan(0));
    vi.mocked(itemKey).mockClear();
    for (const y of [GRID_ROW, 2 * GRID_ROW, 3 * GRID_ROW, 4 * GRID_ROW]) {
      act(() => {
        grid.scrollTop = y;
        fireEvent.scroll(grid);
      });
    }
    expect(grid.querySelector('[data-channel-row="10"]')).toBeTruthy();
    const keyed = new Map<string, number>();
    for (const [ref] of vi.mocked(itemKey).mock.calls) keyed.set(ref.itemId, (keyed.get(ref.itemId) ?? 0) + 1);
    const seeded = (tag: string) => [...keyed].filter(([id]) => id.startsWith(tag));
    // Before, every render joined every answer's refs: 4 scroll renders made 200 x 40 keys each.
    expect(seeded('chunk').filter(([, n]) => n > 1)).toEqual([]);
    expect(seeded('quick')).toEqual([]);
    expect(seeded('sports')).toEqual([]);
    client.clear();
  });
});

describe('a vertical scroll and the parts above the grid (F3-4)', () => {
  it('a row crossing re-renders neither the preview band nor the toolbar while a channel plays off screen', async () => {
    channels = Array.from({ length: 3 * GRID_CHUNK }, (_, i) => makeChannel(i));
    // A window wide and tall enough for the band, which then starts open.
    vi.spyOn(window, 'matchMedia').mockImplementation(((media: string) => ({
      matches: media.includes('min-width') || media.includes('min-height'),
      media,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    })) as never);
    rpc.handlers['catalog.item'] = (a) => makeChannel(Number((a as { ref: Channel['ref'] }).ref.itemId.slice(1)));
    rpc.handlers['epg.programs'] = () => [];
    usePlayerStore.setState({ source: { url: 'x', kind: 'hls', title: 'Channel 100', ref: makeChannel(100).ref, isLive: true, isRadio: false } } as never);
    try {
      renderGuide({ path: '/epg?source=src1', routes: GRID });
      await screen.findByTestId('guide-preview');
      await screen.findByTestId('guide-go-to-playing');
      await screen.findByRole('button', { name: /^c1 P0,/ });
      // Past the prefetch of the chunk below.
      await new Promise((r) => setTimeout(r, 300));
      vi.mocked(GuidePreview).mockClear();
      vi.mocked(ScopePicker).mockClear();
      const grid = screen.getByTestId('epg-grid');
      for (const y of [GRID_ROW, 2 * GRID_ROW, 3 * GRID_ROW]) {
        act(() => {
          grid.scrollTop = y;
          fireEvent.scroll(grid);
        });
      }
      expect(screen.getByRole('button', { name: /^c4 P0,/ })).toBeTruthy();
      expect(vi.mocked(GuidePreview)).not.toHaveBeenCalled();
      expect(vi.mocked(ScopePicker)).not.toHaveBeenCalled();
      // Still offered, and still the band of the cursor's programme.
      expect(screen.getByTestId('guide-go-to-playing')).toBeTruthy();
      expect(screen.getByTestId('guide-preview-title').textContent).toBe('c0 P0');
    } finally {
      usePlayerStore.setState({ source: undefined } as never);
    }
  });
});

describe('layout containment (P2-GUIDE-3)', () => {
  it('rows and the grid content keep their layout to themselves', async () => {
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    const content = screen.getByTestId('epg-grid').firstElementChild as HTMLElement;
    expect(content.className).toContain('[contain:size_layout]');
    expect(cell.closest('[aria-rowindex]')!.className).toContain('[contain:size_layout]');
  });
});
