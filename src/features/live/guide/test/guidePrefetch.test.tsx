/**
 * The guide's first data asked ahead (NAV-1): `prefetchScreenData('/epg…')` asks for the first
 * channel page and the first grid chunk, under exactly the keys the page reads, so the page sends
 * none of those requests itself. The chunk's window is as long as the last guide laid out, in an
 * earlier launch too, and 24 h when none was: the first open of a launch is asked ahead as well.
 */
import { cleanup, configure, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prefetchScreenData } from '@/api/bootPrefetch';
import { queryClient } from '@/api/query';
import type { Channel, EpgProgram, ItemRef, Page, PageQuery } from '@/api/types';

import { __resetGuideWindowForTests, defaultStart, EpgGridPage, GRID_DATA_LENGTH, GRID_DATA_STEP, guideDataLength, guideDataStart, storedGuideDataWindow } from '../../components/EpgGridPage';
import { HOUR, MINUTE } from '../../lib/epgTime';
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

rpcMock.current = createRpcMock();
const rpc = rpcMock.current;

const CHANNELS = Array.from({ length: 30 }, (_, i) => makeChannel(i));
const key = (r: ItemRef) => `${r.sourceId}|${r.contentType}|${r.itemId}`;
const GRID = [{ path: '/epg', element: <EpgGridPage /> }];

beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 8000 });
  vi.setConfig({ testTimeout: 20_000 });
});
beforeEach(() => {
  rpc.reset();
  queryClient.clear();
  // Each test starts as a fresh launch with nothing stored.
  localStorage.clear();
  __resetGuideWindowForTests();
  const h = rpc.handlers;
  const at = defaultStart(Date.now());
  h['sources.list'] = () => [{ id: 'src1', kind: 'm3u', name: 'Demo', channelCount: CHANNELS.length, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings({ epgOffsetMinutes: 60 });
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [];
  h['catalog.channels'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    return { items: CHANNELS.slice(q.offset, q.offset + q.limit), total: CHANNELS.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['epg.grid'] = (a) =>
    Object.fromEntries(
      (a as { refs: ItemRef[] }).refs.map((r) => {
        const list: EpgProgram[] = [program(`${r.itemId} now`, at, at + HOUR)];
        return [key(r), list];
      }),
    );
  h['epg.programs'] = () => [];
  h['epg.sources'] = () => [];
  h['epg.search'] = () => [];
  h['lists.list'] = () => [];
  h['reminders.list'] = () => [];
  h['recordings.list'] = () => [];
  h['recordings.rules'] = () => [];
  h['recordings.capabilities'] = () => ({ supported: true });
  h['channels.edits'] = () => [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const grids = () => rpc.of('epg.grid') as { refs: ItemRef[]; from: string; to: string }[];
const span = (a: { from: string; to: string }) => Date.parse(a.to) - Date.parse(a.from);

/** A guide page `width` px wide (jsdom lays nothing out). */
function pageWidth(width: number) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'epg-grid-page') return new DOMRect(0, 0, width, 900);
    return original.call(this);
  });
}

describe('the guide asked for ahead (NAV-1)', () => {
  it('a return to the guide gets its channels and first grid chunk before the page renders, and the page asks for neither', async () => {
    // The first visit's own request: the prefetch must ask with the same arguments.
    const first = renderGuide({ path: '/epg?source=src1', routes: GRID }, queryClient);
    await screen.findByText('c1 now');
    const firstGrid = rpc.of('epg.grid')[0];
    first.unmount();
    queryClient.clear();
    rpc.calls.length = 0;

    prefetchScreenData('/epg?source=src1');
    await waitFor(() => expect(rpc.of('epg.grid')).toHaveLength(1));
    // Under the page's own arguments, the guide offset included.
    expect(rpc.of('epg.grid')[0]).toEqual(firstGrid);
    expect(rpc.of('catalog.channels')).toHaveLength(1);
    expect(rpc.of('catalog.categories')).toEqual([{ sourceId: 'src1', contentType: 'live' }]);

    renderGuide({ path: '/epg?source=src1', routes: GRID }, queryClient);
    await screen.findByText('c1 now');
    await new Promise((r) => setTimeout(r, 200));
    expect(rpc.of('epg.grid')).toHaveLength(1);
    expect(rpc.of('catalog.channels')).toHaveLength(1);
    expect(rpc.of('catalog.categories')).toHaveLength(1);
  });

  it('the first open of a launch gets its first grid chunk ahead too, 24 h long, and the page asks for it no more', async () => {
    prefetchScreenData('/epg?source=src1');
    await waitFor(() => expect(grids()).toHaveLength(1));
    const asked = grids()[0]!;
    expect(span(asked)).toBe(GRID_DATA_LENGTH);
    // The page's window start, moved back by the guide offset (60 min here).
    expect(Date.parse(asked.from)).toBe(guideDataStart(defaultStart(Date.now())) - 60 * MINUTE);
    expect(asked.refs).toEqual(CHANNELS.map((c) => c.ref));

    renderGuide({ path: '/epg?source=src1', routes: GRID }, queryClient);
    await screen.findByText('c1 now');
    await new Promise((r) => setTimeout(r, 200));
    expect(grids()).toHaveLength(1);
    expect(rpc.of('catalog.channels')).toHaveLength(1);
  });

  it('a guide laid out wider keeps its window length for the next launch, which asks for that length ahead', async () => {
    // At the default zoom (5 px a minute) beside the 220 px channel column, 2,400 px show over
    // six hours: a 30 h data window.
    pageWidth(2400);
    const wide = guideDataLength(((2400 - 220) / 5) * MINUTE);
    expect(wide).toBe(30 * HOUR);
    const first = renderGuide({ path: '/epg?source=src1', routes: GRID }, queryClient);
    await screen.findByText('c1 now');
    expect(span(grids()[0]!)).toBe(wide);
    expect(localStorage.getItem('tsrust.guideDataWindow')).toBe(String(wide));
    first.unmount();
    queryClient.clear();
    rpc.calls.length = 0;

    // A new launch reads the stored length.
    __resetGuideWindowForTests();
    prefetchScreenData('/epg?source=src1');
    await waitFor(() => expect(grids()).toHaveLength(1));
    expect(span(grids()[0]!)).toBe(wide);
    renderGuide({ path: '/epg?source=src1', routes: GRID }, queryClient);
    await screen.findByText('c1 now');
    await new Promise((r) => setTimeout(r, 200));
    expect(grids()).toHaveLength(1);
  });

  it('a stored length it cannot use is taken for 24 h', () => {
    for (const bad of ['', 'abc', '-1', String(GRID_DATA_LENGTH - GRID_DATA_STEP), String(25 * HOUR), String(30 * 24 * HOUR)]) {
      localStorage.setItem('tsrust.guideDataWindow', bad);
      expect(storedGuideDataWindow(), bad).toBe(GRID_DATA_LENGTH);
    }
    localStorage.setItem('tsrust.guideDataWindow', String(36 * HOUR));
    expect(storedGuideDataWindow()).toBe(36 * HOUR);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(storedGuideDataWindow()).toBe(GRID_DATA_LENGTH);
  });

  it('a link that opens at a channel (focus) leaves its first chunk to the page', async () => {
    prefetchScreenData('/epg?source=src1&focus=c20');
    await waitFor(() => expect(rpc.of('catalog.channels')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(grids()).toHaveLength(0);
  });
});
