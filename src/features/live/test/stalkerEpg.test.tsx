import { act, cleanup, fireEvent, screen, waitFor, configure } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, ItemRef, Page, PageQuery } from '@/api/types';

import { EpgGridPage } from '../components/EpgGridPage';
import { EpgRibbon } from '../components/EpgRibbon';
import { LivePage } from '../components/LivePage';
import { HOUR, MINUTE } from '../lib/epgTime';
import { installDomStubs, makeChannel, program, renderAt, settings } from './harness';

// Under CPU load (a cargo build alongside) the 1 s findBy/waitFor default and the 5 s test default
// time out before the mocked queries settle; these waits only ever succeed, so give them room.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

// Stalker sources read the portal's own guide (stalker.epg); XMLTV, when one resolves, fills the rest.

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

const TOTAL = 200;
const SOURCE = { id: 'src1', kind: 'stalker', name: 'Demo portal', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } };

function handlers(kind: 'stalker' | 'xtream' = 'stalker') {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  const src = { ...SOURCE, kind };
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings();
  h['settings.update'] = () => settings();
  h['catalog.categories'] = () => [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: TOTAL, position: 0 }];
  h['catalog.channels'] = (a) => {
    const q = (a as { query: PageQuery }).query;
    const items = Array.from({ length: Math.max(0, Math.min(q.limit, TOTAL - q.offset)) }, (_, i) => makeChannel(q.offset + i));
    return { items, total: TOTAL, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['catalog.item'] = (a) => makeChannel(Number((a as { ref: ItemRef }).ref.itemId.slice(1)));
  h['epg.nowNext'] = () => ({});
  h['epg.programs'] = () => [];
  h['epg.grid'] = () => ({});
  h['favorites.contains'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
  const now = Date.now();
  h['stalker.epg'] = (a) => {
    const id = (a as { ref: ItemRef }).ref.itemId;
    return [program(`Portal ${id}`, now - 10 * MINUTE, now + 20 * MINUTE), program(`Portal next ${id}`, now + 20 * MINUTE, now + HOUR)];
  };
}

const stalkerCalls = () => rpcMock.calls.filter((c) => c.cmd === 'stalker.epg');

beforeAll(installDomStubs);
beforeEach(() => {
  handlers();
  fakes.usePlayerStore.setState({ source: undefined, zapContext: undefined });
  fakes.recorded.playItem.length = 0;
  fakes.recorded.playSource.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ribbon = (kind: 'stalker' | 'xtream', watchingLive = true) => (
  <EpgRibbon channel={makeChannel(0)} sourceKind={kind} watchingLive={watchingLive} onPlayLive={() => undefined} onMapEpg={() => undefined} />
);

describe('EpgRibbon on a Stalker source', () => {
  it("shows the portal's own guide when there is no XMLTV", async () => {
    renderAt('/', [{ path: '/', element: ribbon('stalker') }]);
    expect(await screen.findByRole('button', { name: /^Portal c0,.*on now/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Portal next c0,/ })).toBeTruthy();
    expect(screen.queryByText(/No guide data/)).toBeNull();
    expect(stalkerCalls()[0]?.args).toMatchObject({ ref: makeChannel(0).ref, limit: 50 });
  });

  it('asks the portal for the archived past of a catch-up channel and lays it over XMLTV', async () => {
    const now = Date.now();
    rpcMock.handlers['stalker.epg'] = (a) => {
      const { from } = a as { from?: string };
      const upcoming = [program('Portal c0', now - 10 * MINUTE, now + 20 * MINUTE)];
      return from ? [program('Portal morning', now - 2 * HOUR, now - 10 * MINUTE), ...upcoming] : upcoming;
    };
    rpcMock.handlers['epg.programs'] = () => [program('Xml morning', now - 2 * HOUR, now - 10 * MINUTE)];
    renderAt('/', [{ path: '/', element: ribbon('stalker') }]);
    expect(await screen.findByRole('button', { name: /^Portal morning,.*catch-up available/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Xml morning/ })).toBeNull();
    // `from` is the ribbon's start: the 48 h archive window before the floored now.
    const from = Date.parse((stalkerCalls()[0]?.args as { from: string }).from);
    expect(from).toBeLessThanOrEqual(now - 48 * HOUR);
    expect(from).toBeGreaterThan(now - 48 * HOUR - 15 * MINUTE);
  });

  it('does not ask for the past on a channel without an archive', async () => {
    renderAt('/', [{ path: '/', element: <EpgRibbon channel={makeChannel(5)} sourceKind="stalker" watchingLive onPlayLive={() => undefined} onMapEpg={() => undefined} /> }]);
    await screen.findByRole('button', { name: /^Portal c5,/ });
    expect(stalkerCalls()[0]?.args).toEqual({ ref: makeChannel(5).ref, limit: 50 });
  });

  it('offers start-over on the airing programme and plays it through stalker.catchupUrl', async () => {
    rpcMock.handlers['stalker.catchupUrl'] = () => ({ url: 'http://portal/archive.ts', kind: 'direct', title: 'Channel 0', isLive: false, isRadio: false });
    renderAt('/', [{ path: '/', element: ribbon('stalker') }]);
    fireEvent.click(await screen.findByRole('button', { name: /^Portal c0,.*start over available/ }));
    await waitFor(() => expect(fakes.recorded.playSource.length).toBe(1));
    expect(rpcMock.calls.find((c) => c.cmd === 'stalker.catchupUrl')?.args).toMatchObject({ ref: makeChannel(0).ref, durationMinutes: 30 });
    expect(fakes.recorded.playSource[0]).toMatchObject({ url: 'http://portal/archive.ts', subtitle: 'Portal c0', isLive: false });
  });

  it('merges a global XMLTV guide: portal wins on overlap, XMLTV adds the past for catch-up', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.programs'] = () => [
      program('Xml morning', now - 2 * HOUR, now - 10 * MINUTE),
      program('Xml clash', now - 10 * MINUTE, now + 20 * MINUTE),
    ];
    rpcMock.handlers['stalker.catchupUrl'] = () => ({ url: 'http://portal/morning.ts', kind: 'direct', title: 'Channel 0', isLive: false, isRadio: false });
    renderAt('/', [{ path: '/', element: ribbon('stalker') }]);
    const past = await screen.findByRole('button', { name: /^Xml morning,.*catch-up available/ });
    expect(screen.getByRole('button', { name: /^Portal c0,/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Xml clash/ })).toBeNull();
    fireEvent.click(past);
    await waitFor(() => expect(fakes.recorded.playSource.length).toBe(1));
    expect(rpcMock.calls.some((c) => c.cmd === 'stalker.catchupUrl')).toBe(true);
    expect(rpcMock.calls.some((c) => c.cmd === 'xtream.catchupUrl')).toBe(false);
  });

  it('still shows XMLTV when the portal guide fails', async () => {
    const now = Date.now();
    rpcMock.handlers['stalker.epg'] = () => {
      throw new Error('portal down');
    };
    rpcMock.handlers['epg.programs'] = () => [program('Xml now', now - 10 * MINUTE, now + 20 * MINUTE)];
    renderAt('/', [{ path: '/', element: ribbon('stalker') }]);
    expect(await screen.findByRole('button', { name: /^Xml now,.*on now/ })).toBeTruthy();
  });

  it('shows the error with retry when both guides fail or are empty', async () => {
    rpcMock.handlers['stalker.epg'] = () => {
      throw new Error('portal down');
    };
    renderAt('/', [{ path: '/', element: ribbon('stalker') }]);
    expect(await screen.findByText(/portal down/)).toBeTruthy();
  });

  it('never asks the portal for other source kinds', async () => {
    renderAt('/', [{ path: '/', element: ribbon('xtream') }]);
    await screen.findByText(/No guide data/);
    expect(stalkerCalls()).toHaveLength(0);
  });
});

describe('LivePage on a Stalker source', () => {
  it('fills row now/next from the portal for the visible rows only', async () => {
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    await screen.findByText('Channel 0');
    await waitFor(() => expect(screen.getAllByText('Portal c0').length).toBeGreaterThan(0));
    const rowCalls = stalkerCalls().filter((c) => (c.args as { limit: number }).limit === 3);
    expect(rowCalls.length).toBeGreaterThan(0);
    // throttled to the visible window, never the whole 200-channel page
    expect(rowCalls.length).toBeLessThanOrEqual(30);
  });

  it("a tune asks the portal once for the playing channel's now/next and the ribbon (LV-8)", async () => {
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    await screen.findByText('Channel 0');
    const c5 = makeChannel(5);
    act(() => fakes.usePlayerStore.setState({ source: { url: '', kind: 'hls', title: c5.name, ref: c5.ref, isLive: true, isRadio: false } }));
    const c5Calls = () => stalkerCalls().filter((c) => (c.args as { ref: ItemRef }).ref.itemId === 'c5').map((c) => c.args as { limit: number });
    await waitFor(() => expect(c5Calls().some((a) => a.limit === 50)).toBe(true));
    await new Promise((r) => setTimeout(r, 300));
    expect(c5Calls().filter((a) => a.limit === 50)).toHaveLength(1);
    // Besides it, at most the row's own preview (the visible rows' queue).
    expect(c5Calls().length).toBeLessThanOrEqual(2);
  });

  it('does not ask the portal for an Xtream source', async () => {
    handlers('xtream');
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    await screen.findByText('Channel 0');
    expect(stalkerCalls()).toHaveLength(0);
  });
});

describe('page headings and list semantics', () => {
  it.each([
    ['live', '/s/src1/live', '/s/:sourceId/live', <LivePage key="l" />, 'Live TV'],
    ['radio', '/s/src1/radio', '/s/:sourceId/radio', <LivePage key="r" mode="radio" />, 'Radio'],
    ['guide', '/epg?source=src1', '/epg', <EpgGridPage key="g" />, 'TV guide'],
  ])('%s renders exactly one h1 matching the page title', async (_name, url, path, element, title) => {
    renderAt(url, [{ path, element }]);
    await screen.findByRole('heading', { level: 1, name: title });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(fakes.lastHeader()?.title).toBe(title);
  });

  it('the channel list carries set size and position, not aria-rowcount', async () => {
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    await screen.findByText('Channel 0');
    const list = screen.getByRole('list', { name: 'Channels' });
    expect(list.hasAttribute('aria-rowcount')).toBe(false);
    const first = list.querySelector('[role="listitem"]')!;
    expect(first.getAttribute('aria-setsize')).toBe(String(TOTAL));
    expect(first.getAttribute('aria-posinset')).toBe('1');
  });
});
