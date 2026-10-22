import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, ItemRef, Page, PageQuery } from '@/api/types';

import { EpgGridPage, GRID_ROW, stalkerArchiveQuery } from '../components/EpgGridPage';
import { DAY, HOUR, MINUTE } from '../lib/epgTime';
import { StalkerPreviewQueue } from '../lib/stalkerPreviewQueue';
import { installDomStubs, makeChannel, program, renderAt, settings } from './harness';

// The multi-channel guide on a Stalker portal without XMLTV: archive channels get the archived
// past of the grid window from `stalker.epg` (`from`), so earlier rows and catch-up work.

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

const fakes = await import('./fakes');

let TOTAL = 8;
const SOURCE = { id: 'src1', kind: 'stalker', name: 'Demo portal', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } };

interface EpgArgs {
  ref: ItemRef;
  limit: number;
  from?: string;
}

function handlers() {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.list'] = () => [SOURCE];
  h['sources.get'] = () => SOURCE;
  h['settings.get'] = () => settings();
  h['settings.update'] = () => settings();
  h['catalog.categories'] = () => [];
  h['catalog.channels'] = (a) => {
    const q = (a as { query: PageQuery }).query;
    const items = Array.from({ length: Math.max(0, Math.min(q.limit, TOTAL - q.offset)) }, (_, i) => makeChannel(q.offset + i));
    return { items, total: TOTAL, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  // No XMLTV anywhere: the portal is the only guide.
  h['epg.grid'] = () => ({});
  const now = Date.now();
  h['stalker.epg'] = (a) => {
    const { ref, from } = a as EpgArgs;
    const id = ref.itemId;
    const airing = [program(`Now ${id}`, now - 5 * MINUTE, now + 25 * MINUTE), program(`Next ${id}`, now + 25 * MINUTE, now + HOUR)];
    if (!from) return airing;
    // The portal's day tables: everything since `from` that has ended.
    const past = [program(`Morning ${id}`, now - 4 * HOUR, now - 2 * HOUR), program(`Noon ${id}`, now - 2 * HOUR, now - 5 * MINUTE)];
    return [...past.filter((p) => Date.parse(p.end) > Date.parse(from)), ...airing];
  };
  h['stalker.catchupUrl'] = () => ({ url: 'http://portal/archive.ts', kind: 'direct', title: 'Channel 0', isLive: false, isRadio: false });
}

const epgCalls = (itemId: string) =>
  rpcMock.calls.filter((c) => c.cmd === 'stalker.epg' && (c.args as EpgArgs).ref.itemId === itemId).map((c) => c.args as EpgArgs);

beforeAll(installDomStubs);
beforeEach(() => {
  TOTAL = 8;
  handlers();
  fakes.recorded.playSource.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EpgGridPage on a Stalker portal without XMLTV', () => {
  it('asks for the archived past of the window on archive channels and starts catch-up from it', async () => {
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    // The default window starts 30-60 min back, so the programme that ended minutes ago shows.
    expect(await screen.findByRole('button', { name: /^Noon c0,/ })).toBeTruthy();
    const first = epgCalls('c0')[0]!;
    expect(first.from).toBeDefined();
    const start0 = Date.parse(first.from!);
    expect(start0).toBeLessThanOrEqual(Date.now() - 30 * MINUTE);
    // The buffered guide window can exceed six hours, so its request limit scales with it.
    expect(first.limit).toBeGreaterThanOrEqual(12);

    // Moving the window back refetches with the new window start.
    fireEvent.click(screen.getByRole('button', { name: '3 hours earlier' }));
    await waitFor(() => expect(epgCalls('c0').some((c) => !!c.from && Date.parse(c.from) === start0 - 3 * HOUR)).toBe(true));
    const morning = await screen.findByRole('button', { name: /^Morning c0,/ });

    // The past programme offers catch-up, through the portal.
    fireEvent.click(morning);
    fireEvent.click(await screen.findByRole('button', { name: 'Play from catch-up' }));
    await waitFor(() => expect(fakes.recorded.playSource.length).toBe(1));
    expect(rpcMock.calls.find((c) => c.cmd === 'stalker.catchupUrl')?.args).toMatchObject({ ref: makeChannel(0).ref });
    expect(fakes.recorded.playSource[0]).toMatchObject({ url: 'http://portal/archive.ts', isLive: false });
  });

  it('keeps the plain airing-onwards request for channels without an archive', async () => {
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    // makeChannel gives c0..c2 an archive; c5 has none.
    expect(await screen.findByRole('button', { name: /^Now c5,/ })).toBeTruthy();
    expect(epgCalls('c5')[0]).toMatchObject({ ref: makeChannel(5).ref, limit: expect.any(Number) });
    expect(epgCalls('c5')[0]!.limit).toBe(epgCalls('c0')[0]!.limit);
    expect(screen.queryByRole('button', { name: /^Noon c5,/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '3 hours earlier' }));
    await screen.findByRole('button', { name: /^Morning c0,/ });
    expect(epgCalls('c5').every((c) => c.from === undefined)).toBe(true);
  });

  it('asks the portal about the rows a fling stops on, not the rows it passes (LV-4)', async () => {
    TOTAL = 600;
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    // The first screen only sets the fling up. Finding a cell by its name walks every row, and
    // jsdom works out each channel name's dir="auto" on the way, which on a loaded machine ran
    // past the default second; the fling's own checks below keep their timing.
    expect(await screen.findByRole('button', { name: /^Now c5,/ }, { timeout: 5000 })).toBeTruthy();
    const rows = () => rpcMock.calls.filter((c) => c.cmd === 'stalker.epg').map((c) => Number((c.args as EpgArgs).ref.itemId.slice(1)));
    // Let the first screen's queue drain, so its workers are free when the fling starts.
    for (let seen = -1; seen !== rows().length; ) {
      seen = rows().length;
      await new Promise((r) => setTimeout(r, 400));
    }
    const grid = screen.getByTestId('epg-grid');
    rpcMock.calls.length = 0;
    // Rows 100-119 are on the loaded first page; the fling passes them, a few frames apart, and
    // stops near row 400.
    for (const row of [100, 250, 400]) {
      grid.scrollTop = row * GRID_ROW;
      fireEvent.scroll(grid);
      await new Promise((r) => setTimeout(r, 50));
    }
    await waitFor(() => expect(rows().some((r) => r >= 380)).toBe(true), { timeout: 3000 });
    expect(rows().filter((r) => r < 380)).toEqual([]);
  }, 20_000);
});

describe('stalkerArchiveQuery', () => {
  const now = Date.UTC(2026, 9, 11, 12, 0);
  it('passes the window start while the window reaches into the archive', () => {
    expect(stalkerArchiveQuery(now - 30 * MINUTE, now + 330 * MINUTE, now)).toEqual({ from: now - 30 * MINUTE, limit: 12 });
    expect(stalkerArchiveQuery(now - DAY, now - DAY + 6 * HOUR, now)).toEqual({ from: now - DAY, limit: 1 });
  });

  it('drops `from` for future windows and windows older than the 7-day archive', () => {
    expect(stalkerArchiveQuery(now + HOUR, now + 7 * HOUR, now)).toEqual({ from: undefined, limit: 12 });
    expect(stalkerArchiveQuery(now - 8 * DAY, now - 8 * DAY + 6 * HOUR, now)).toEqual({ from: undefined, limit: 1 });
  });
});

describe('StalkerPreviewQueue with archived programmes', () => {
  it('reuses an answer that starts with ended programmes until the airing one ends', async () => {
    const T = Date.UTC(2026, 9, 11, 12, 0);
    let clock = T;
    const fetch = vi.fn(async () => [program('old', T - 3 * HOUR, T - HOUR), program('now', T - HOUR, T + 10 * MINUTE)]);
    const q = new StalkerPreviewQueue(fetch, () => undefined, { delayMs: 0, clock: () => clock });
    const r: ItemRef = { sourceId: 's', contentType: 'live', itemId: 'a' };
    q.sync([r]);
    await vi.waitFor(() => expect(q.get(r)).toHaveLength(2));
    q.sync([r]);
    expect(fetch).toHaveBeenCalledTimes(1);
    clock = T + 11 * MINUTE;
    expect(q.get(r)).toBeUndefined();
  });
});
