/**
 * Campaign loop 1 (live area): a ribbon whose height never changes (L1-live-3, L1-sources-home-12),
 * one player on the radio page (L1-live-6), the number readout leaving the channel name to the
 * zap banner (L1-live-12), Ask-mode lock marks with programme titles kept back (L1-live-13,
 * L1-settings-4), focus back on the row after a round trip (L1-live-18) and the archive scrolling
 * its list alone (L1-live-11, L1-visual-5).
 */
import { act, cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, Page, PageQuery, ParentalLock } from '@/api/types';

import { resetChannelListMemory } from '../components/ChannelList';
import { EpgRibbon } from '../components/EpgRibbon';
import { LivePage } from '../components/LivePage';
import { MINUTE } from '../lib/epgTime';
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
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

const fakes = await import('./fakes');

const ROUTE = [{ path: '/s/:sourceId/live', element: <LivePage /> }];

function serve(all: Channel[]) {
  return (a: unknown) => {
    const q = (a as { query: PageQuery }).query;
    return { items: all.slice(q.offset, q.offset + q.limit), total: all.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
}

function baseHandlers(total = 40) {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => ({ id: 'src1', kind: 'xtream', name: 'Demo portal', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['settings.get'] = () => settings();
  h['settings.update'] = () => settings();
  h['catalog.categories'] = () => [
    { id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: total, position: 0 },
    { id: 'g2', sourceId: 'src1', contentType: 'live', name: 'Sports', hidden: false, itemCount: 0, position: 1 },
  ];
  h['catalog.channels'] = serve(Array.from({ length: total }, (_, i) => makeChannel(i)));
  h['epg.nowNext'] = () => ({});
  h['epg.programs'] = () => [];
  h['favorites.contains'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
  h['catalog.item'] = (a) => makeChannel(Number((a as { ref: { itemId: string } }).ref.itemId.slice(1)));
}

const askMode = (locks: ParentalLock[]) => {
  rpcMock.handlers['parental.status'] = () => ({ enabled: true, mode: 'ask', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  rpcMock.handlers['parental.locks'] = () => locks;
};
const lock = (kind: 'item' | 'category', targetId: string): ParentalLock => ({
  sourceId: 'src1',
  contentType: 'live',
  kind,
  targetId,
  name: targetId,
  createdAt: '2026-10-15T00:00:00Z',
});

beforeAll(() => {
  configure({ asyncUtilTimeout: 3000 });
  installDomStubs();
});
beforeEach(() => {
  baseHandlers();
  resetChannelListMemory();
  fakes.usePlayerStore.setState({ source: undefined, zapContext: undefined });
  fakes.recorded.playItem.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ribbon = (channel?: Channel) => (
  <EpgRibbon channel={channel} sourceKind="xtream" watchingLive={false} onPlayLive={() => undefined} onMapEpg={() => undefined} />
);

describe('guide ribbon keeps one height (L1-live-3, L1-sources-home-12)', () => {
  it('uses the same body height with a guide, without one, while loading and with no channel', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.programs'] = (a) =>
      (a as { ref: { itemId: string } }).ref.itemId === 'c1' ? [program('Morning Show', now - 30 * MINUTE, now + 30 * MINUTE)] : [];
    const heights: string[] = [];
    const body = () => screen.getByTestId('ribbon-body').className;

    const view = renderAt('/', [{ path: '/', element: ribbon(undefined) }]);
    heights.push(body());

    cleanup();
    renderAt('/', [{ path: '/', element: ribbon(makeChannel(1)) }]);
    await screen.findAllByText('Morning Show');
    heights.push(body());

    cleanup();
    renderAt('/', [{ path: '/', element: ribbon(makeChannel(2)) }]);
    const note = await screen.findByTestId('ribbon-no-guide');
    heights.push(body());
    // One compact line with the fix inline; the name is the heading above it, not repeated.
    expect(note.textContent).toContain('No guide data');
    expect(note.textContent).not.toContain('Channel 2');
    expect(within(note).getByRole('button', { name: 'Match guide channel' })).toBeTruthy();
    expect(screen.getByTestId('ribbon-channel-name').textContent).toBe('Channel 2');

    cleanup();
    rpcMock.handlers['epg.programs'] = () => new Promise(() => undefined);
    renderAt('/', [{ path: '/', element: ribbon(makeChannel(3)) }]);
    await screen.findByLabelText('Loading guide');
    heights.push(body());

    expect(new Set(heights)).toEqual(new Set(['h-[104px] overflow-hidden']));
    void view;
  });
});

describe('parental Ask mode marks what is locked (L1-live-13, L1-settings-4)', () => {
  it('keeps a locked channel’s programmes out of the ribbon until the PIN', async () => {
    const now = Date.now();
    askMode([lock('item', 'c5')]);
    rpcMock.handlers['epg.programs'] = () => [program('Secret Film', now - 30 * MINUTE, now + 30 * MINUTE)];
    renderAt('/', [{ path: '/', element: ribbon(makeChannel(5)) }]);
    const locked = await screen.findByTestId('ribbon-locked');
    expect(locked.textContent).toContain('Locked. Enter the PIN to see what is on.');
    expect(within(locked).getByRole('button', { name: 'Unlock' })).toBeTruthy();
    expect(screen.getByTestId('ribbon-body').className).toContain('h-[104px]');
    expect(screen.queryByText('Secret Film')).toBeNull();
  });

  it('marks locked groups and the channels in them, without their programme titles', async () => {
    const now = Date.now();
    askMode([lock('category', 'g1')]);
    rpcMock.handlers['epg.nowNext'] = (a) =>
      Object.fromEntries(
        (a as { refs: { sourceId: string; contentType: string; itemId: string }[] }).refs.map((r) => [
          `${r.sourceId}|${r.contentType}|${r.itemId}`,
          { now: program(`Show on ${r.itemId}`, now - 10 * MINUTE, now + 20 * MINUTE) },
        ]),
      );
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    await waitFor(() => expect(screen.getAllByTestId('row-locked').length).toBeGreaterThan(0));
    const groups = screen.getAllByTestId('group-locked');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.closest('a')?.textContent).toContain('News');
    expect(screen.queryByText('Show on c0')).toBeNull();
    const row = document.querySelector('[data-row-index="0"]')!;
    expect(row.getAttribute('aria-label')).toContain('Locked');
  });

  it('marks nothing outside Ask mode', async () => {
    rpcMock.handlers['parental.status'] = () => ({ enabled: true, mode: 'hide', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
    rpcMock.handlers['parental.locks'] = () => [lock('category', 'g1')];
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryAllByTestId('row-locked')).toHaveLength(0);
    expect(screen.queryAllByTestId('group-locked')).toHaveLength(0);
  });
});

describe('Live page', () => {
  it('a number that tunes leaves the readout to the zap banner (L1-live-12)', async () => {
    rpcMock.handlers['catalog.channelByNumber'] = (a) => makeChannel((a as { number: number }).number - 1);
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    act(() => {
      fireEvent.keyDown(window, { key: '7' });
    });
    expect((await screen.findByTestId('digit-osd')).textContent).toContain('7');
    act(() => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    await waitFor(() => expect(fakes.recorded.playItem.length).toBe(1));
    await waitFor(() => expect(screen.queryByTestId('digit-osd')).toBeNull());
  });

  it('a missing number still says so', async () => {
    rpcMock.handlers['catalog.channelByNumber'] = () => null;
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    act(() => {
      fireEvent.keyDown(window, { key: '9' });
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    await waitFor(() => expect(screen.getByTestId('digit-osd').textContent).toContain('9'));
  });

  // LG-03 replaced the fixed archive slot of L1-visual-15 with a glyph after the name: a row without
  // catch-up gives that room to its title, and the bars still line up (the actions float over the end).
  it('marks catch-up after the name, leaves no empty slot, and keeps red off the progress bars (L1-visual-15, LG-03)', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.nowNext'] = (a) =>
      Object.fromEntries(
        (a as { refs: { sourceId: string; contentType: string; itemId: string }[] }).refs.map((r) => [
          `${r.sourceId}|${r.contentType}|${r.itemId}`,
          { now: program(`Show on ${r.itemId}`, now - 10 * MINUTE, now + 20 * MINUTE) },
        ]),
      );
    renderAt('/s/src1/live', ROUTE);
    await waitFor(() => expect(screen.getAllByTestId('channel-progress').length).toBeGreaterThan(4));
    for (const bar of screen.getAllByTestId('channel-progress')) expect(bar.className).not.toContain('bg-live');
    // makeChannel gives channels 0-2 an archive; channel 4 has none.
    const archived = document.querySelector<HTMLElement>('button[data-row-index="0"]')!;
    expect(within(archived).getByTestId('row-archive')).toBeTruthy();
    const plain = document.querySelector<HTMLElement>('button[data-row-index="4"]')!.parentElement!;
    expect(within(plain).queryByTestId('row-archive')).toBeNull();
    expect(plain.querySelector('span[aria-hidden="true"].size-6')).toBeNull();
    // The bars are as wide on both rows: the row's actions float, they take no column.
    expect(within(plain).getByTestId('row-actions').className).toContain('absolute');
  });

  it('the radio stage hosts the running player instead of drawing a second one (L1-live-6)', async () => {
    fakes.usePlayerStore.setState({
      source: { url: 'http://x/r.mp3', title: 'Radio One', isLive: true, isRadio: true, ref: { sourceId: 'src1', contentType: 'radio', itemId: 'r1' } },
    } as never);
    renderAt('/s/src1/radio', [{ path: '/s/:sourceId/radio', element: <LivePage mode="radio" /> }]);
    const stage = await screen.findByTestId('radio-stage');
    expect(within(stage).getByTestId('player-stage')).toBeTruthy();
    expect(within(stage).queryByTestId('radio-player')).toBeNull();
    act(() => fakes.usePlayerStore.setState({ source: undefined } as never));
  });

  it('focus returns to the row you left after a round trip (L1-live-18)', async () => {
    const first = renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    const row0 = document.querySelector<HTMLButtonElement>('[data-row-index="0"]')!;
    row0.focus();
    fireEvent.keyDown(row0, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement?.getAttribute('data-row-index')).toBe('2'));
    first.unmount();
    expect(document.activeElement).toBe(document.body);

    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    await waitFor(() => expect(document.activeElement?.getAttribute('data-row-index')).toBe('2'));
  });

  it('a first visit does not take focus', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).toBe(document.body);
  });
});
