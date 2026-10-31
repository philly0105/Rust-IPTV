/**
 * The guide page's render costs (P2-GUIDE): grid keys hashed once per chunk and window, a page
 * that measures itself before its rows are in, rows and the grid's content that keep their
 * layout to themselves, a toolbar and preview band that a scroll frame leaves alone, and rows
 * outside the observed channel pages read without hashing their page's key each time.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, configure, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { channelPageArgs } from '@/api/bootPrefetch';
import { rpcKey } from '@/api/query';
import type { Channel, Page, PageQuery } from '@/api/types';
import { PlayerStage } from '@/features/player';
import { useToastStore } from '@/ui';

import { defaultStart, EpgGridPage, GRID_CHUNK, GRID_ROW } from '../../components/EpgGridPage';
import { ScopePicker } from '../../components/ScopePicker';
import { usePagedChannels } from '../../hooks/usePagedChannels';
import { HOUR } from '../../lib/epgTime';
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
vi.mock('@/features/player', async () => {
  const fakes = await import('../../test/fakes');
  // The preview band's player: its calls count the band's renders.
  return { ...fakes, PlayerStage: vi.fn(fakes.PlayerStage) };
});
vi.mock('@/features/player/remote', async () => await import('../../test/fakes'));
// The toolbar's group picker: its calls count the toolbar's renders.
vi.mock('../../components/ScopePicker', async (orig) => {
  const mod = await orig<typeof import('../../components/ScopePicker')>();
  return { ...mod, ScopePicker: vi.fn(mod.ScopePicker) };
});

const fakes = await import('../../test/fakes');
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

// jsdom keeps scroll offsets at 0: record what is written, so scrolls can be driven (and the
// page's own horizontal placement reads back, so a vertical scroll does not look horizontal).
const scrolls = { left: new WeakMap<Element, number>(), top: new WeakMap<Element, number>() };
const originals = {
  scrollLeft: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft'),
  scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'),
};

// Set here, not in beforeAll, where it comes too late for the tests' own timeout: the first guide
// a file renders pays for the module graph, slower than the default 5 s on a busy machine.
vi.setConfig({ testTimeout: 20_000 });
beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 4000 });
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
  h['epg.grid'] = hourly(defaultStart(Date.now()));
  h['epg.sources'] = () => [];
  h['epg.search'] = () => [];
  h['reminders.list'] = () => [];
  h['recordings.list'] = () => [];
  h['recordings.rules'] = () => [];
  h['recordings.capabilities'] = () => ({ supported: true });
  h['channels.edits'] = () => [];
  h['catalog.item'] = (a) => makeChannel(Number((a as { ref: Channel['ref'] }).ref.itemId.slice(1)));
  useToastStore.setState({ toasts: [] });
  fakes.usePlayerStore.setState({ source: undefined } as never);
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

describe('layout containment (P2-GUIDE-3)', () => {
  it('rows and the grid content keep their layout to themselves', async () => {
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const cell = await screen.findByRole('button', { name: /^c1 P0,/ });
    const content = screen.getByTestId('epg-grid').firstElementChild as HTMLElement;
    expect(content.className).toContain('[contain:size_layout]');
    expect(cell.closest('[aria-rowindex]')!.className).toContain('[contain:size_layout]');
  });
});

describe('the toolbar and the preview band', () => {
  it('a scroll frame re-renders neither while the playing channel is off screen; a new subject re-renders the band', async () => {
    channels = Array.from({ length: 3 * GRID_CHUNK }, (_, i) => makeChannel(i));
    fakes.usePlayerStore.setState({ source: { url: 'x', kind: 'hls', title: 'Channel 100', ref: makeChannel(100).ref, isLive: true, isRadio: false } } as never);
    // A window wide and tall enough for the band, which is open from 1000 px tall.
    vi.spyOn(window, 'matchMedia').mockImplementation(((q: string) => ({
      matches: q.includes('min-width') || q.includes('min-height'),
      media: q,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    })) as never);
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await screen.findByTestId('guide-go-to-playing');
    const band = await screen.findByTestId('guide-preview');
    await waitFor(() => expect(within(band).getByTestId('guide-preview-title').textContent).toBe('c0 P0'));
    await new Promise((r) => setTimeout(r, 300));
    const mountedRows = () => [...document.querySelectorAll('[aria-rowindex]')].map((r) => r.getAttribute('aria-rowindex'));
    const firstRows = mountedRows();

    vi.mocked(ScopePicker).mockClear();
    vi.mocked(PlayerStage).mockClear();
    const grid = screen.getByTestId('epg-grid');
    for (const y of [2 * GRID_ROW, 4 * GRID_ROW, 6 * GRID_ROW]) {
      act(() => {
        grid.scrollTop = y;
        fireEvent.scroll(grid);
      });
    }
    // The rows moved (rows below the first screen and its overscan mounted), and the playing row
    // is still off screen.
    expect(mountedRows()).not.toEqual(firstRows);
    expect(screen.getByTestId('guide-go-to-playing')).toBeTruthy();
    expect(vi.mocked(ScopePicker)).not.toHaveBeenCalled();
    expect(vi.mocked(PlayerStage)).not.toHaveBeenCalled();

    // The cursor on another programme: the band follows it.
    act(() => screen.getByRole('button', { name: /^c7 P0,/ }).focus());
    await waitFor(() => expect(within(band).getByTestId('guide-preview-title').textContent).toBe('c7 P0'));
    expect(vi.mocked(PlayerStage)).toHaveBeenCalled();
    expect(vi.mocked(ScopePicker)).not.toHaveBeenCalled();
  });
});

describe('rows outside the observed channel pages (usePagedChannels)', () => {
  it("hash their page's key once per page, and still see a page that lands later", async () => {
    channels = Array.from({ length: 5 * 120 }, (_, i) => makeChannel(i));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => usePagedChannels({ sourceId: 'src1', withExtras: false }), { wrapper });
    await waitFor(() => expect(result.current.total).toBe(600));
    const pageAt = (n: number): Page<Channel> => ({ items: channels.slice(n * 120, (n + 1) * 120), total: 600, offset: n * 120, limit: 120 });
    // A page read ahead (or seen before) that the list does not observe.
    client.setQueryData(rpcKey('catalog.channels', channelPageArgs({ sourceId: 'src1' }, 3)), pageAt(3));

    const stringify = vi.spyOn(JSON, 'stringify');
    const pageKeys = () => stringify.mock.calls.filter(([v]) => Array.isArray(v) && v[0] === 'catalog.channels').length;
    // Every row of the page, twice (the Live list reads a row again for its favourite flag).
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 360; i < 480; i++) expect(result.current.getChannel(i)).toEqual(channels[i]);
    }
    expect(pageKeys()).toBe(1);
    // A page not in the cache yet reads as nothing, then as its rows once it lands.
    expect(result.current.getChannel(480)).toBeUndefined();
    stringify.mockRestore();
    client.setQueryData(rpcKey('catalog.channels', channelPageArgs({ sourceId: 'src1' }, 4)), pageAt(4));
    expect(result.current.getChannel(480)).toEqual(channels[480]);
    client.clear();
  });
});
