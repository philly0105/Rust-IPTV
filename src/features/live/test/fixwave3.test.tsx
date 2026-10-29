import { cleanup, fireEvent, screen, waitFor, within, configure } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, ItemRef, Page, PageQuery, Settings, SourceKind } from '@/api/types';

import { EpgGridPage, GRID_DATA_LENGTH, guideDataStart } from '../components/EpgGridPage';
import { LivePage } from '../components/LivePage';
import { HOUR, MINUTE, floorTo, ms } from '../lib/epgTime';
import { StalkerPreviewQueue, resetStalkerPreviewSources } from '../lib/stalkerPreviewQueue';
import { installDomStubs, makeChannel, program, renderAt, settings } from './harness';

// Under CPU load (a cargo build alongside) the 1 s findBy/waitFor default and the 5 s test default
// time out before the mocked queries settle; these waits only ever succeed, so give them room.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

// Fix wave 3: the /epg grid asks for the guide window moved back by the EPG offset, the Stalker
// preview backoff and answers are per source (they survive a grid window move), and favourite
// toasts use the display name.

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

const TOTAL = 20;
const WAIT = { timeout: 10_000 };

function portalTimeout(): Error {
  return Object.assign(new Error('The portal did not answer within 40 s.'), { code: 'timeout', retryable: true });
}

function handlers(kind: SourceKind, s: Partial<Settings> = {}, name = (i: number) => `Channel ${i}`) {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  const src = { id: 'src1', kind, name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } };
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings(s);
  h['settings.update'] = () => settings(s);
  h['catalog.categories'] = () => [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: TOTAL, position: 0 }];
  const channel = (i: number): Channel => ({ ...makeChannel(i), name: name(i) });
  h['catalog.channels'] = (a) => {
    const q = (a as { query: PageQuery }).query;
    const items = Array.from({ length: Math.max(0, Math.min(q.limit, TOTAL - q.offset)) }, (_, i) => channel(q.offset + i));
    return { items, total: TOTAL, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['catalog.item'] = (a) => channel(Number((a as { ref: ItemRef }).ref.itemId.slice(1)));
  h['epg.nowNext'] = () => ({});
  h['epg.programs'] = () => [];
  h['epg.grid'] = () => ({});
  h['stalker.epg'] = () => [];
  h['favorites.contains'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
}

const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);
/** The grid's first window: one 30-minute slot before the current slot. */
const gridStart = (now: number) => floorTo(now, 30 * MINUTE) - 30 * MINUTE;

beforeAll(installDomStubs);
beforeEach(() => handlers('xtream'));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('/epg grid under an EPG offset (R1 F1)', () => {
  it.each([120, -90])('asks epg.grid for the window moved back by %i min and shows the airing programme', async (offset) => {
    handlers('xtream', { epgOffsetMinutes: offset } as Partial<Settings>);
    // A guide answers only for what it is asked: programmes inside the requested window.
    rpcMock.handlers['epg.grid'] = (a) => {
      const { refs, from, to } = a as { refs: ItemRef[]; from: string; to: string };
      const now = Date.now();
      const rawStart = now - offset * MINUTE - 10 * MINUTE;
      const rawEnd = rawStart + HOUR;
      if (rawEnd <= ms(from) || rawStart >= ms(to)) return {};
      return Object.fromEntries(refs.map((r) => [`${r.sourceId}|${r.contentType}|${r.itemId}`, [program(`Airing ${r.itemId}`, rawStart, rawEnd)]]));
    };
    const now = Date.now();
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    const start = guideDataStart(gridStart(now));
    const want = { from: new Date(start - offset * MINUTE).toISOString(), to: new Date(start + GRID_DATA_LENGTH - offset * MINUTE).toISOString() };
    await waitFor(() => {
      const calls = callsOf('epg.grid').map((c) => c.args as { from: string; to: string });
      expect(calls.some((a) => a.from === want.from && a.to === want.to)).toBe(true);
    }, WAIT);
    // Shifted for display, the programme airing now is in the window (it was blank before the fix).
    expect(await screen.findByRole('button', { name: /Airing c0/ }, WAIT)).toBeTruthy();
  });

  it('asks the Stalker archive rows for the window start moved back by the offset', async () => {
    handlers('stalker', { epgOffsetMinutes: 120 } as Partial<Settings>);
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    // Channels c0..c2 have an archive: their requests carry `from`.
    await waitFor(() => {
      // Live positioning can cross a bucket after initial layout; check the actual viewport.
      const at = Number(screen.getByTestId('epg-grid').dataset.viewAt);
      const want = new Date(guideDataStart(at) - 120 * MINUTE).toISOString();
      const froms = callsOf('stalker.epg').map((c) => (c.args as { from?: string }).from).filter(Boolean);
      expect(froms).toContain(want);
    }, WAIT);
  });
});

describe('Stalker preview backoff and answers per source (R3 F3)', () => {
  const ref = (i: number): ItemRef => ({ sourceId: 'src1', contentType: 'live', itemId: `c${i}` });
  beforeEach(resetStalkerPreviewSources);

  it('a new queue of the same source keeps the pause, and retry() ends it for every queue', async () => {
    vi.useFakeTimers();
    let clock = 1_000_000;
    let failing = true;
    const fetch = vi.fn(async (r: ItemRef) => {
      if (failing) throw portalTimeout();
      return [program(`Back ${r.itemId}`, clock - MINUTE, clock + HOUR)];
    });
    const opts = { delayMs: 0, concurrency: 1, clock: () => clock, backoffMs: 30_000, sourceId: 'src1' };
    const onA = vi.fn();
    const a = new StalkerPreviewQueue(fetch, onA, { ...opts, scope: '12|t0' });
    a.sync([ref(0), ref(1)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a.unavailable).toBe(true);

    // The window moves: the old queue is reset, a new one (new `from`) syncs. It asks nothing.
    a.reset();
    const onB = vi.fn();
    const b = new StalkerPreviewQueue(fetch, onB, { ...opts, scope: '12|t1' });
    expect(b.unavailable).toBe(true);
    expect(b.retryAt).toBe(clock + 30_000);
    b.sync([ref(0), ref(1)]);
    // The live page's queue of the same source waits as well.
    const live = new StalkerPreviewQueue(fetch, () => undefined, { ...opts, scope: '3|' });
    live.sync([ref(5)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Try again on one page asks again for both queues' rows; the outage clears everywhere.
    failing = false;
    b.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.mock.calls.map(([r]) => r.itemId).sort()).toEqual(['c0', 'c0', 'c1', 'c5']);
    expect(b.unavailable).toBe(false);
    expect(live.unavailable).toBe(false);
    expect(live.get(ref(5))?.[0]?.title).toBe('Back c5');
    expect(onB).toHaveBeenCalled();
    b.destroy();
    live.destroy();
  });

  it('caches answers by scope, so a window moved back reuses them', async () => {
    const fetch = vi.fn(async (r: ItemRef) => [program(`Show ${r.itemId}`, Date.now() - MINUTE, Date.now() + HOUR)]);
    const opts = { delayMs: 0, sourceId: 'src1' };
    const first = new StalkerPreviewQueue(fetch, () => undefined, { ...opts, scope: '12|t0' });
    first.sync([ref(0)]);
    await vi.waitFor(() => expect(first.get(ref(0))).toHaveLength(1));
    first.reset();

    // Another window start: not the same answer.
    const other = new StalkerPreviewQueue(fetch, () => undefined, { ...opts, scope: '12|t1' });
    expect(other.get(ref(0))).toBeUndefined();
    other.reset();

    // Back to the first window: answered from the cache, no request.
    const back = new StalkerPreviewQueue(fetch, () => undefined, { ...opts, scope: '12|t0' });
    expect(back.get(ref(0))?.[0]?.title).toBe('Show c0');
    back.sync([ref(0)]);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
    back.destroy();
  });

  it('moving the /epg window during a backoff keeps the notice and sends nothing new', async () => {
    handlers('stalker');
    rpcMock.handlers['stalker.epg'] = () => {
      throw portalTimeout();
    };
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    const notice = await screen.findByTestId('guide-unavailable', undefined, WAIT);
    expect(within(notice).getByRole('button', { name: 'Try again' })).toBeTruthy();
    // Let the in-flight requests of the first window settle.
    await new Promise((r) => setTimeout(r, 50));
    const before = callsOf('stalker.epg').length;

    fireEvent.click(screen.getByRole('button', { name: '3 hours earlier' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }));
    fireEvent.click(screen.getByRole('button', { name: '3 hours later' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('guide-unavailable')).toBeTruthy();
    expect(callsOf('stalker.epg').length).toBe(before);
  });
});

describe('display names outside the rows (R1 F3, live part)', () => {
  it('favourite toasts use the name without the country prefix', async () => {
    handlers('xtream', { stripCountryPrefix: true } as Partial<Settings>, (i) => `UK | Alpha ${i}`);
    rpcMock.handlers['favorites.toggle'] = () => ({ isFavorite: true });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    await screen.findByText('Alpha 0', undefined, WAIT);
    fireEvent.click(screen.getAllByRole('button', { name: 'Favorite', pressed: false })[0]!);
    await waitFor(() => expect(info).toHaveBeenCalledWith('[toast]', 'Added Alpha 0 to favorites', ''), WAIT);
  });
});

describe('counts follow the UI language, not the browser locale', () => {
  it('formats category counts with i18n.language', async () => {
    const { i18n } = await import('./harness');
    handlers('xtream');
    rpcMock.handlers['catalog.categories'] = () => [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: 12345, position: 0 }];
    await i18n.changeLanguage('de');
    try {
      renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
      expect((await screen.findAllByText('12.345', undefined, WAIT)).length).toBeGreaterThan(0);
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
