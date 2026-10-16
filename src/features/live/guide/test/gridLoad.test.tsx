/**
 * What the guide grid asks for: the provider's short guide only for a window it can fill
 * (L3-guide-library-4), the grid without descriptions, and the selected programme's description
 * when its detail opens (L3-serve-ui-6), with a core that still sends descriptions too.
 */
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, EpgProgram, Page, PageQuery } from '@/api/types';
import { useToastStore } from '@/ui';

import { defaultStart, EpgGridPage, GRID_ROW, SHORT_EPG_REACH_MS, SHORT_EPG_SETTLE_MS, shortEpgReaches } from '../../components/EpgGridPage';
import { DAY, HOUR, MINUTE } from '../../lib/epgTime';
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

let channels = Array.from({ length: 6 }, (_, i) => makeChannel(i));
const key = (r: Channel['ref']) => `${r.sourceId}|${r.contentType}|${r.itemId}`;
const GRID = [{ path: '/epg', element: <EpgGridPage /> }];

function handlers(kind: 'm3u' | 'xtream', grid: (ref: Channel['ref']) => EpgProgram[], offsetMinutes = 0) {
  rpc.reset();
  const h = rpc.handlers;
  h['sources.list'] = () => [{ id: 'src1', kind, name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings({ epgShortFallback: true, epgOffsetMinutes: offsetMinutes });
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [];
  h['catalog.channels'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    return { items: channels.slice(q.offset, q.offset + q.limit), total: channels.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['epg.grid'] = (a) => Object.fromEntries((a as { refs: Channel['ref'][] }).refs.map((r) => [key(r), grid(r)]));
  h['epg.shortEpg'] = () => [];
  h['epg.programs'] = () => [];
  h['epg.sources'] = () => [];
  h['epg.search'] = () => [];
  h['reminders.list'] = () => [];
  h['recordings.list'] = () => [];
  h['recordings.rules'] = () => [];
  h['recordings.capabilities'] = () => ({ supported: true });
  h['channels.edits'] = () => [];
}

beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 4000 });
  vi.setConfig({ testTimeout: 20_000 });
});
beforeEach(() => {
  channels = Array.from({ length: 6 }, (_, i) => makeChannel(i));
  useToastStore.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the provider's short guide (L3-guide-library-4)", () => {
  it('reaches only windows that touch the next few hours', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    expect(shortEpgReaches(now - HOUR, now + HOUR, now)).toBe(true);
    expect(shortEpgReaches(now + 5 * HOUR, now + 11 * HOUR, now)).toBe(true);
    expect(shortEpgReaches(now + SHORT_EPG_REACH_MS, now + SHORT_EPG_REACH_MS + 6 * HOUR, now)).toBe(false);
    expect(shortEpgReaches(now - 7 * HOUR, now - HOUR, now)).toBe(false);
  });

  it('is not asked for a window two days ahead, and is for the window on now', async () => {
    handlers('xtream', () => []);
    const later = defaultStart(Date.now()) + 2 * DAY;
    const view = renderGuide({ path: `/epg?source=src1&at=${later}`, routes: GRID });
    await screen.findByText('Channel 1');
    await waitFor(() => expect(rpc.of('epg.grid').length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 400));
    expect(rpc.of('epg.shortEpg')).toHaveLength(0);
    view.unmount();

    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await screen.findByText('Channel 1');
    await waitFor(() => expect(rpc.of('epg.shortEpg').length).toBeGreaterThan(0));
  });

  it('a burst of moves asks for the rows it stops on once they hold still, not the rows it passes (L3-perf-ui-5)', async () => {
    channels = Array.from({ length: 400 }, (_, i) => makeChannel(i));
    handlers('xtream', () => []);
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await screen.findByText('Channel 1');
    await waitFor(() => expect(rpc.of('epg.shortEpg').length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, SHORT_EPG_SETTLE_MS + 100));
    rpc.calls.length = 0;
    const grid = screen.getByTestId('epg-grid');
    for (const row of [60, 120, 180, 240]) {
      Object.defineProperty(grid, 'scrollTop', { configurable: true, writable: true, value: row * GRID_ROW });
      fireEvent.scroll(grid);
      await new Promise((r) => setTimeout(r, 40));
    }
    const asked = () => rpc.of('epg.shortEpg').map((a) => Number((a as { ref: Channel['ref'] }).ref.itemId.slice(1)));
    // Room for a busy machine (the suite runs files in parallel); the settle itself is 200 ms.
    await waitFor(() => expect(asked()).toContain(241), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, SHORT_EPG_SETTLE_MS + 100));
    expect(asked().filter((i) => i < 200)).toEqual([]);
  });
});

describe('descriptions (L3-serve-ui-6)', () => {
  it('the grid asks for its chunks without descriptions', async () => {
    handlers('m3u', () => []);
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    await waitFor(() => expect(rpc.of('epg.grid').length).toBeGreaterThan(0));
    for (const a of rpc.of('epg.grid')) expect((a as { withDescription?: boolean }).withDescription).toBe(false);
  });

  it("the detail asks for the programme's description when it opens, in guide time, and shows it when it arrives", async () => {
    const now = Date.now();
    const offset = 60;
    // Guide time: the grid shows it an hour later.
    const raw = program('Evening News', now - 70 * MINUTE, now - 10 * MINUTE);
    handlers('m3u', (r) => (r.itemId === 'c1' ? [raw] : []), offset);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    rpc.handlers['epg.programs'] = async () => {
      await gate;
      return [{ ...raw, description: 'Headlines and the weather.' }];
    };
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    const cell = await screen.findByRole('button', { name: /^Evening News, / });
    fireEvent.pointerDown(cell);
    fireEvent.click(cell);
    const popover = await screen.findByTestId('program-popover');
    expect(within(popover).getByTestId('program-description-pending')).toBeTruthy();
    expect(rpc.of('epg.programs')[0]).toEqual({ ref: channels[1]!.ref, from: raw.start, to: raw.end });
    release();
    expect((await within(popover).findByTestId('program-description')).textContent).toBe('Headlines and the weather.');
    expect(within(popover).queryByTestId('program-description-pending')).toBeNull();
  });

  it('a grid answer that still carries the description shows it at once and asks nothing more', async () => {
    const now = Date.now();
    handlers('m3u', (r) => (r.itemId === 'c1' ? [{ ...program('Evening News', now - 10 * MINUTE, now + 50 * MINUTE), description: 'Tonight.' }] : []));
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    fireEvent.click(await screen.findByRole('button', { name: /^Evening News, / }));
    const popover = await screen.findByTestId('program-popover');
    expect(within(popover).getByTestId('program-description').textContent).toBe('Tonight.');
    expect(within(popover).queryByTestId('program-description-pending')).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(rpc.of('epg.programs')).toHaveLength(0);
  });
});
