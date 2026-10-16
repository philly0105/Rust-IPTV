import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, ItemRef, Page, PageQuery } from '@/api/types';

import { EpgGridPage } from '../components/EpgGridPage';
import { EpgRibbon } from '../components/EpgRibbon';
import { LivePage } from '../components/LivePage';
import { HOUR, MINUTE } from '../lib/epgTime';
import { installDomStubs, makeChannel, program, renderAt, settings } from './harness';

// Guide slice: the Xtream short-EPG fallback in the ribbon, the channel rows and the guide grid,
// and the "Browse archive" entry points of the live context menu and the programme dialog.

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

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
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

const fakes = await import('./fakes');

const TOTAL = 200;
const SOURCE = { id: 'src1', kind: 'xtream', name: 'Panel', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } };

function handlers(fallback = true) {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => SOURCE;
  h['sources.list'] = () => [SOURCE];
  h['settings.get'] = () => settings({ epgShortFallback: fallback });
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
  h['epg.grid'] = (a) => Object.fromEntries((a as { refs: ItemRef[] }).refs.map((r) => [`${r.sourceId}|${r.contentType}|${r.itemId}`, []]));
  h['favorites.contains'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
  const now = Date.now();
  h['epg.shortEpg'] = (a) => {
    const id = (a as { ref: ItemRef }).ref.itemId;
    return [program(`Provider ${id}`, now - 10 * MINUTE, now + 20 * MINUTE), program(`Provider next ${id}`, now + 20 * MINUTE, now + HOUR)];
  };
}

const shortCalls = () => rpcMock.calls.filter((c) => c.cmd === 'epg.shortEpg');

beforeAll(installDomStubs);
beforeEach(() => {
  handlers();
  fakes.usePlayerStore.setState({ source: undefined, zapContext: undefined });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ribbon = (channel = makeChannel(0)) => (
  <EpgRibbon channel={channel} sourceKind="xtream" watchingLive onPlayLive={() => undefined} onMapEpg={() => undefined} />
);

describe('EpgRibbon short-EPG fallback', () => {
  it("shows the provider's now and next when XMLTV has nothing airing, and says where it came from", async () => {
    renderAt('/', [{ path: '/', element: ribbon() }]);
    expect(await screen.findByRole('button', { name: /^Provider c0,.*on now/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Provider next c0,/ })).toBeTruthy();
    expect(screen.getByTestId('ribbon-from-provider').textContent).toBe("From the provider's guide");
    expect(shortCalls()[0]?.args).toEqual({ ref: makeChannel(0).ref, limit: 6 });
  });

  it('keeps XMLTV and never asks the provider when XMLTV has the airing programme', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.programs'] = () => [program('Xml now', now - 10 * MINUTE, now + 20 * MINUTE)];
    renderAt('/', [{ path: '/', element: ribbon() }]);
    expect(await screen.findByRole('button', { name: /^Xml now,/ })).toBeTruthy();
    expect(shortCalls()).toHaveLength(0);
    expect(screen.queryByTestId('ribbon-from-provider')).toBeNull();
  });

  it('stays off when the setting is off', async () => {
    handlers(false);
    renderAt('/', [{ path: '/', element: ribbon() }]);
    await screen.findByText(/No guide data/);
    expect(shortCalls()).toHaveLength(0);
  });
});

describe('LivePage short-EPG fallback and archive entry', () => {
  const LIVE = [
    { path: '/s/:sourceId/live', element: <LivePage /> },
    { path: '/live/archive/:sourceId/:channelId', element: <p>archive route</p> },
  ];

  it('fills row now lines from the provider for the visible rows only', async () => {
    renderAt('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');
    await waitFor(() => expect(screen.getAllByText(/Provider c0/).length).toBeGreaterThan(0));
    expect(shortCalls().length).toBeGreaterThan(0);
    expect(shortCalls().length).toBeLessThanOrEqual(30);
  });

  it('asks nothing when the setting is off', async () => {
    handlers(false);
    renderAt('/s/src1/live', LIVE);
    await screen.findByText('Channel 0');
    await new Promise((r) => setTimeout(r, 50));
    expect(shortCalls()).toHaveLength(0);
  });

  it('offers "Browse archive" only on archive channels and opens the archive route', async () => {
    renderAt('/s/src1/live', LIVE);
    await screen.findByText('Channel 5');
    const row = (i: number) => document.querySelector<HTMLElement>(`[data-testid="channel-list"] [data-row-index="${i}"]`)!.parentElement!;
    fireEvent.contextMenu(row(5), { clientX: 40, clientY: 40 });
    expect(within(await screen.findByRole('menu')).queryByRole('menuitem', { name: 'Browse archive' })).toBeNull();
    fireEvent.keyDown(within(screen.getByRole('menu')).getAllByRole('menuitem')[0]!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    fireEvent.contextMenu(row(0), { clientX: 40, clientY: 40 });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Browse archive' }));
    expect(await screen.findByText('archive route')).toBeTruthy();
  });
});

describe('EpgGridPage short-EPG fallback', () => {
  it('fills empty rows from the provider and marks them in the programme dialog', async () => {
    renderAt('/epg?source=src1', [
      { path: '/epg', element: <EpgGridPage /> },
      { path: '/live/archive/:sourceId/:channelId', element: <p>archive route</p> },
    ]);
    const cell = await screen.findByRole('button', { name: /^Provider c0,/ });
    // Rows with programmes are no longer "no guide data anywhere".
    expect(screen.queryByText(/No guide data for these channels yet/)).toBeNull();
    fireEvent.click(cell);
    const pop = await screen.findByTestId('program-popover');
    expect(within(pop).getByTestId('program-from-provider').textContent).toBe("From the provider's guide");
    // K6: one archive action in the dialog.
    expect(within(pop).getAllByTestId('program-browse-archive')).toHaveLength(1);
    fireEvent.click(within(pop).getByTestId('program-browse-archive'));
    expect(await screen.findByText('archive route')).toBeTruthy();
  });

  it('keeps the no-guide notice and asks nothing when the setting is off', async () => {
    handlers(false);
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    expect(await screen.findByText(/No guide data for these channels yet/)).toBeTruthy();
    expect(shortCalls()).toHaveLength(0);
  });
});
