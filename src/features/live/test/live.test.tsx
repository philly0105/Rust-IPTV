import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, Page, PageQuery } from '@/api/types';

import { EpgGridPage } from '../components/EpgGridPage';
import { EpgRibbon } from '../components/EpgRibbon';
import { LivePage } from '../components/LivePage';
import { HOUR, MINUTE } from '../lib/epgTime';
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
vi.mock('../_shim', async () => await import('./fakes'));

const fakes = await import('./fakes');

const TOTAL = 50_000;
const channels = (offset: number, limit: number): Channel[] =>
  Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) }, (_, i) => makeChannel(offset + i));

function baseHandlers() {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => ({ id: 'src1', kind: 'xtream', name: 'Demo portal', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['settings.get'] = () => settings();
  h['settings.update'] = () => settings();
  h['catalog.categories'] = () => [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: TOTAL, position: 0 }];
  h['catalog.channels'] = (a) => {
    const q = (a as { query: PageQuery }).query;
    return { items: channels(q.offset, q.limit), total: TOTAL, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['epg.nowNext'] = () => ({});
  h['epg.programs'] = () => [];
  h['epg.grid'] = () => ({});
  h['favorites.contains'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
  h['catalog.item'] = (a) => makeChannel(Number((a as { ref: { itemId: string } }).ref.itemId.slice(1)));
}

beforeAll(installDomStubs);
beforeEach(() => {
  baseHandlers();
  fakes.usePlayerStore.setState({ source: undefined, zapContext: undefined });
  fakes.recorded.playItem.length = 0;
  fakes.recorded.playSource.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LivePage', () => {
  it('renders a 50k-channel list virtualized and pages it from the core', async () => {
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    await screen.findByText('Channel 0');
    expect(screen.getByText('50,000 channels')).toBeTruthy();

    const rows = document.querySelectorAll('[data-testid="channel-list"] [role="listitem"]');
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.length).toBeLessThan(60);
    // whole page stays small: far below one node per channel
    expect(document.querySelectorAll('*').length).toBeLessThan(2500);

    const pageCalls = rpcMock.calls.filter((c) => c.cmd === 'catalog.channels');
    expect(pageCalls.length).toBeGreaterThan(0);
    for (const c of pageCalls) expect((c.args as { query: PageQuery }).query.limit).toBeLessThanOrEqual(120);
    // the list only ever asked for the first page
    expect(new Set(pageCalls.map((c) => (c.args as { query: PageQuery }).query.offset))).toEqual(new Set([0]));
    // zap context registered for useChannelZap
    expect(fakes.usePlayerStore.getState().zapContext).toEqual({ sourceId: 'src1', categoryId: undefined });
  });

  it('digit entry commits after the pause and zaps through catalog.channelByNumber', async () => {
    rpcMock.handlers['catalog.channelByNumber'] = (a) => makeChannel((a as { number: number }).number - 1);
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    await screen.findByText('Channel 0');

    act(() => {
      fireEvent.keyDown(window, { key: '1' });
      fireEvent.keyDown(window, { key: '2' });
    });
    expect((await screen.findByTestId('digit-osd')).textContent).toContain('12');
    expect(rpcMock.calls.some((c) => c.cmd === 'catalog.channelByNumber')).toBe(false);

    await waitFor(() => expect(rpcMock.calls.find((c) => c.cmd === 'catalog.channelByNumber')).toBeTruthy(), { timeout: 3000 });
    expect(rpcMock.calls.find((c) => c.cmd === 'catalog.channelByNumber')!.args).toEqual({ sourceId: 'src1', number: 12 });
    await waitFor(() => expect(fakes.recorded.playItem.length).toBe(1));
    expect(fakes.recorded.playItem[0]).toMatchObject({ title: 'Channel 11', isLive: true, sourceKind: 'xtream' });
  });

  it('shows the empty state when the source has no channels', async () => {
    rpcMock.handlers['catalog.categories'] = () => [];
    rpcMock.handlers['catalog.channels'] = () => ({ items: [], total: 0, offset: 0, limit: 120 });
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    expect(await screen.findByText('No channels in this source')).toBeTruthy();
  });

  it('offers to unhide groups when every group is hidden', async () => {
    rpcMock.handlers['catalog.categories'] = (a) =>
      (a as { includeHidden?: boolean }).includeHidden
        ? [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: true, itemCount: 4, position: 0 }]
        : [];
    rpcMock.handlers['catalog.channels'] = () => ({ items: [], total: 0, offset: 0, limit: 120 });
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    expect((await screen.findAllByText('Every group is hidden. Show some groups to see their channels.')).length).toBeGreaterThan(0);
  });

  it('renders the radio stage', async () => {
    renderAt('/s/src1/radio', [{ path: '/s/:sourceId/radio', element: <LivePage mode="radio" /> }]);
    await screen.findByText('Channel 0');
    expect(screen.getByTestId('radio-stage')).toBeTruthy();
    const call = rpcMock.calls.find((c) => c.cmd === 'catalog.channels');
    expect(call?.args).toMatchObject({ radio: true });
  });
});

describe('EpgRibbon', () => {
  it('shows what is on now and what comes next', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.programs'] = () => [
      program('Morning News', now - 2 * HOUR, now - 30 * MINUTE),
      program('Midday Report', now - 30 * MINUTE, now + 30 * MINUTE),
      program('Evening Film', now + 30 * MINUTE, now + 2 * HOUR),
    ];
    const ch = makeChannel(0);
    renderAt('/', [{ path: '/', element: <EpgRibbon channel={ch} sourceKind="xtream" watchingLive onPlayLive={() => undefined} onMapEpg={() => undefined} /> }]);

    const ribbon = await screen.findByTestId('epg-ribbon');
    await waitFor(() => expect(ribbon.textContent).toContain('Midday Report'));
    expect(ribbon.textContent).toContain('LIVE');
    expect(screen.getByRole('button', { name: /Evening Film/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Midday Report.*on now/ })).toBeTruthy();
    // archive channel: the ended programme offers catch-up
    expect(screen.getByRole('button', { name: /Morning News.*catch-up available/ })).toBeTruthy();
  });

  it('plays catch-up for an ended programme on an archive channel', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.programs'] = () => [program('Morning News', now - 2 * HOUR, now - 30 * MINUTE), program('Now', now - 30 * MINUTE, now + HOUR)];
    rpcMock.handlers['xtream.catchupUrl'] = () => ({ url: 'http://x/timeshift.ts', kind: 'direct', title: 'Channel 0', isLive: false, isRadio: false });
    renderAt('/', [
      { path: '/', element: <EpgRibbon channel={makeChannel(0)} sourceKind="xtream" watchingLive onPlayLive={() => undefined} onMapEpg={() => undefined} /> },
    ]);
    fireEvent.click(await screen.findByRole('button', { name: /Morning News/ }));
    await waitFor(() => expect(fakes.recorded.playSource.length).toBe(1));
    const args = rpcMock.calls.find((c) => c.cmd === 'xtream.catchupUrl')!.args as { durationMinutes: number };
    expect(args.durationMinutes).toBe(90);
    expect(fakes.recorded.playSource[0]).toMatchObject({ url: 'http://x/timeshift.ts', subtitle: 'Morning News', isLive: false });
  });

  it('list mode follows settings.epgViewMode', async () => {
    const now = Date.now();
    rpcMock.handlers['settings.get'] = () => settings({ epgViewMode: 'list' });
    rpcMock.handlers['epg.programs'] = () => [program('Midday Report', now - 30 * MINUTE, now + 30 * MINUTE), program('Evening Film', now + 30 * MINUTE, now + 2 * HOUR)];
    renderAt('/', [{ path: '/', element: <EpgRibbon channel={makeChannel(5)} sourceKind="m3u" watchingLive onPlayLive={() => undefined} onMapEpg={() => undefined} /> }]);
    expect(await screen.findByRole('list', { name: 'List' })).toBeTruthy();
    expect((await screen.findAllByText('Evening Film')).length).toBeGreaterThan(0);
  });

  it('offers EPG mapping when a channel has no guide data', async () => {
    const onMap = vi.fn();
    renderAt('/', [{ path: '/', element: <EpgRibbon channel={makeChannel(7)} sourceKind="m3u" watchingLive onPlayLive={() => undefined} onMapEpg={onMap} /> }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Match guide channel' }));
    expect(onMap).toHaveBeenCalled();
  });
});

describe('EpgGridPage', () => {
  it('renders virtualized rows and requests the grid in row chunks', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.grid'] = (a) => {
      const refs = (a as { refs: { sourceId: string; contentType: string; itemId: string }[] }).refs;
      return Object.fromEntries(refs.map((r) => [`${r.sourceId}|${r.contentType}|${r.itemId}`, [program(`Show ${r.itemId}`, now - 10 * MINUTE, now + 50 * MINUTE)]]));
    };
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    expect(await screen.findByRole('button', { name: /Show c0/ })).toBeTruthy();
    const rows = document.querySelectorAll('[data-testid="epg-grid"] [role="row"]');
    expect(rows.length).toBeLessThan(60);
    const gridCalls = rpcMock.calls.filter((c) => c.cmd === 'epg.grid');
    for (const c of gridCalls) expect((c.args as { refs: unknown[] }).refs.length).toBeLessThanOrEqual(40);

    // program details popover
    fireEvent.click(screen.getByRole('button', { name: /Show c0/ }));
    expect(await screen.findByTestId('program-popover')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Watch live' })).toBeTruthy();
  });
});
