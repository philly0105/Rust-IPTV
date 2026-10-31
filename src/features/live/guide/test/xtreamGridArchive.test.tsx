import { act, cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, EpgProgram, ItemRef, Page, PageQuery } from '@/api/types';

import { defaultStart, EpgGridPage, GRID_DATA_LENGTH, GRID_ROW, guideDataStart, SHORT_EPG_SETTLE_MS } from '../../components/EpgGridPage';
import { xtreamGridRange } from '../../hooks/useXtreamGridPrograms';
import { DAY, HOUR, MINUTE } from '../../lib/epgTime';
import { hasGuideGap } from '../../lib/guideCoverage';
import { releaseStalkerPreviewAnswers, resetStalkerPreviewSources, StalkerPreviewQueue } from '../../lib/stalkerPreviewQueue';
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
const GRID = [{ path: '/epg', element: <EpgGridPage /> }];
let channels: Channel[];
const key = (r: ItemRef) => `${r.sourceId}|${r.contentType}|${r.itemId}`;
/**
 * 20:00 UTC two or three days back: three-hour moves of up to 12 h earlier stay in the same days
 * of `catchup.programs`, whatever the time of day the test runs (those days are UTC-aligned).
 */
const eveningBack = () => Math.floor((Date.now() - 2 * DAY) / DAY) * DAY + 20 * HOUR;
type ProgramsArgs = { ref: ItemRef; from: string; to: string };
const channelCalls = (itemId = 'c0') => (rpc.of('catchup.programs') as ProgramsArgs[]).filter((a) => a.ref.itemId === itemId);

function handlers(xmltv: (ref: ItemRef) => EpgProgram[], table: (ref: ItemRef) => EpgProgram[]) {
  rpc.reset();
  const h = rpc.handlers;
  h['sources.list'] = () => [{ id: 'src1', kind: 'xtream', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings({ epgShortFallback: false });
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [];
  h['catalog.channels'] = (a) => {
    const { query: q } = a as { query: PageQuery };
    return { items: channels.slice(q.offset, q.offset + q.limit), total: channels.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
  h['epg.grid'] = (a) => Object.fromEntries((a as { refs: ItemRef[] }).refs.map((r) => [key(r), xmltv(r)]));
  // As the core answers: the panel's table cut to the programmes overlapping [from, to).
  h['catchup.programs'] = (a) => {
    const { ref, from, to } = a as ProgramsArgs;
    return table(ref).filter((p) => Date.parse(p.end) > Date.parse(from) && Date.parse(p.start) < Date.parse(to));
  };
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
  resetStalkerPreviewSources();
  channels = Array.from({ length: 6 }, (_, i) => makeChannel(i));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Xtream programmes in the grid', () => {
  it('loads a provider table for a nearby archive gap before horizontal scrolling exposes it', async () => {
    const at = eveningBack();
    handlers(
      (r) => r.itemId === 'c0' ? [program('Current XML', at, at + 7 * HOUR)] : [],
      (r) => r.itemId === 'c0' ? [program('Earlier provider', at - 3 * HOUR, at - 2 * HOUR)] : [],
    );
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^Current XML,/ });
    await waitFor(() => expect(channelCalls()).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: '3 hours earlier' }));
    expect(await screen.findByRole('button', { name: /^Earlier provider,/ })).toBeTruthy();
    expect(channelCalls()).toHaveLength(1);
  });

  it('fills older XMLTV gaps from the provider while keeping XMLTV for overlaps', async () => {
    const at = defaultStart(Date.now() - 2 * DAY);
    handlers(
      (r) => r.itemId === 'c0' ? [program('XML programme', at + HOUR, at + 2 * HOUR)]
        : r.itemId === 'c1' ? [program('Full XML', at - 6 * HOUR, at + 12 * HOUR)] : [],
      (r) => r.itemId === 'c0' ? [
        program('Provider before', at, at + HOUR),
        program('Provider overlap', at + HOUR, at + 2 * HOUR),
      ] : [],
    );
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });

    expect(await screen.findByRole('button', { name: /^Provider before,/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^XML programme,/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Provider overlap,/ })).toBeNull();
    expect(channelCalls('c0')).not.toHaveLength(0);
    expect(channelCalls('c1')).toHaveLength(0);
  });

  it('asks for the whole UTC days around the data window, not the panel\'s whole table (F3-1)', async () => {
    const at = eveningBack();
    handlers(() => [], (r) => r.itemId === 'c0' ? [program('Current window', at, at + HOUR)] : []);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    expect(await screen.findByRole('button', { name: /^Current window,/ })).toBeTruthy();
    expect(rpc.of('catchup.table')).toHaveLength(0);
    const { from, to } = channelCalls()[0]!;
    const dataStart = guideDataStart(at);
    const range = xtreamGridRange(dataStart, dataStart + GRID_DATA_LENGTH, 0);
    expect([Date.parse(from), Date.parse(to)]).toEqual([range.from, range.to]);
    // From the day before the window's first day, through any window that starts on that day.
    const firstDay = Math.floor(dataStart / DAY) * DAY;
    expect(range).toEqual({ from: firstDay - DAY, to: firstDay + 2 * DAY });
    expect(range.to).toBeGreaterThanOrEqual(firstDay + DAY + GRID_DATA_LENGTH);
  });

  it('reuses one request per channel across horizontal guide windows within its days', async () => {
    const at = eveningBack();
    handlers(() => [], (r) => r.itemId === 'c0' ? [
      program('Beyond initial window', at - 9 * HOUR, at - 8 * HOUR),
      program('Current window', at, at + HOUR),
    ] : []);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    expect(await screen.findByRole('button', { name: /^Current window,/ })).toBeTruthy();
    expect(channelCalls()).toHaveLength(1);

    // Outside the first data window, inside the days asked for.
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: '3 hours earlier' }));
    expect(await screen.findByRole('button', { name: /^Beyond initial window,/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '3 hours later' }));
    await new Promise((r) => setTimeout(r, SHORT_EPG_SETTLE_MS + 50));
    expect(channelCalls()).toHaveLength(1);
  });

  it('a move into other days asks each row once and keeps the earlier answer on screen meanwhile (F3-1)', async () => {
    const at = eveningBack();
    const day = at - 20 * HOUR;
    handlers(() => [], (r) => r.itemId === 'c0' ? [
      program('Early', day + 5 * HOUR, day + 6 * HOUR),
      program('Current window', at, at + HOUR),
    ] : []);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    expect(await screen.findByRole('button', { name: /^Current window,/ })).toBeTruthy();
    const first = channelCalls()[0]!;
    const table = rpc.handlers['catchup.programs']!;
    let answer!: () => void;
    const held = new Promise<void>((resolve) => { answer = resolve; });
    rpc.handlers['catchup.programs'] = async (a) => {
      if ((a as ProgramsArgs).from !== first.from) await held;
      return table(a);
    };
    // 05:00: the data window now starts the evening before, so the days asked for move back one.
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole('button', { name: '3 hours earlier' }));
    await waitFor(() => expect(channelCalls()).toHaveLength(2));
    expect(Date.parse(channelCalls()[1]!.from)).toBe(Date.parse(first.from) - DAY);
    // The earlier days' answer covers 05:00 too: its cell stays while the new answer loads.
    expect(await screen.findByRole('button', { name: /^Early,/ })).toBeTruthy();
    expect(screen.queryByTestId('guide-no-data')).toBeNull();
    act(() => answer());
    await new Promise((r) => setTimeout(r, SHORT_EPG_SETTLE_MS + 50));
    expect(screen.getByRole('button', { name: /^Early,/ })).toBeTruthy();
    expect(channelCalls()).toHaveLength(2);
  });

  it('lets the provider answers go when the guide unmounts (F3-1)', async () => {
    const at = eveningBack();
    handlers(() => [], (r) => r.itemId === 'c0' ? [program('Current window', at, at + HOUR)] : []);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    expect(await screen.findByRole('button', { name: /^Current window,/ })).toBeTruthy();
    expect(channelCalls()).toHaveLength(1);
    cleanup();
    // Kept for the life of the app before; the core's own cache answers the next visit.
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    expect(await screen.findByRole('button', { name: /^Current window,/ })).toBeTruthy();
    expect(channelCalls()).toHaveLength(2);
  });

  it('asks no short guide again for a row whose provider table covers its reach (F3-1)', async () => {
    channels = Array.from({ length: 200 }, (_, i) => makeChannel(i));
    const now = Date.now();
    handlers(() => [], (r) => r.itemId === 'c0'
      ? Array.from({ length: 12 }, (_, k) => program(`Table ${k}`, now + (k - 3) * HOUR, now + (k - 2) * HOUR))
      : []);
    rpc.handlers['settings.get'] = () => settings({ epgShortFallback: true });
    // Both short answers go stale a second later, as at a programme boundary; c1 has no table.
    rpc.handlers['epg.shortEpg'] = (a) => {
      const id = (a as { ref: ItemRef }).ref.itemId;
      return id === 'c0' || id === 'c1' ? [program(`Short ${id}`, now - HOUR, now + 1000)] : [];
    };
    const shortCalls = (itemId: string) => (rpc.of('epg.shortEpg') as { ref: ItemRef }[]).filter((a) => a.ref.itemId === itemId);
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    expect(await screen.findByRole('button', { name: /^Table 3,/ })).toBeTruthy();
    // The first view asks both: they go out together, before the table is in.
    await waitFor(() => expect(shortCalls('c0')).toHaveLength(1));
    expect(shortCalls('c1')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1100));
    const grid = screen.getByTestId('epg-grid');
    grid.scrollTop = 100 * GRID_ROW;
    fireEvent.scroll(grid);
    await waitFor(() => expect(shortCalls('c100')).toHaveLength(1));
    grid.scrollTop = 0;
    fireEvent.scroll(grid);
    // Back on screen with stale short answers: c1 asks again, c0's table holds the next six hours.
    await waitFor(() => expect(shortCalls('c1')).toHaveLength(2));
    await new Promise((r) => setTimeout(r, SHORT_EPG_SETTLE_MS + 150));
    expect(shortCalls('c0')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Table 3,/ })).toBeTruthy();
  }, 20_000);

  it('shows no empty notice over a row whose provider table stands in for its short guide (F3-1)', async () => {
    const now = Date.now();
    handlers(() => [], (r) => r.itemId === 'c0'
      ? Array.from({ length: 16 }, (_, k) => program(`Table ${k}`, now + (k - 3) * HOUR, now + (k - 2) * HOUR))
      : []);
    rpc.handlers['settings.get'] = () => settings({ epgShortFallback: true });
    rpc.handlers['epg.shortEpg'] = () => [];
    renderGuide({ path: '/epg?source=src1', routes: GRID });
    expect(await screen.findByRole('button', { name: /^Table 3,/ })).toBeTruthy();
    // Nine hours on: the window probes no archive (it starts past now), yet still reaches the short
    // guide's hours, which c0 does not ask for since its table covers them.
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: '3 hours later' }));
    expect(await screen.findByRole('button', { name: /^Table 12,/ })).toBeTruthy();
    await new Promise((r) => setTimeout(r, SHORT_EPG_SETTLE_MS + 150));
    expect(screen.queryByTestId('guide-no-data')).toBeNull();
    expect((rpc.of('epg.shortEpg') as { ref: ItemRef }[]).some((a) => a.ref.itemId === 'c1')).toBe(true);
  });

  it('does not announce an empty guide while a visible channel table is still loading', async () => {
    const at = defaultStart(Date.now() - 2 * DAY);
    handlers(() => [], () => []);
    let answer!: (programs: EpgProgram[]) => void;
    const pending = new Promise<EpgProgram[]>((resolve) => { answer = resolve; });
    rpc.handlers['catchup.programs'] = (a) => (a as { ref: ItemRef }).ref.itemId === 'c0' ? pending : [];
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await waitFor(() => expect(rpc.of('catchup.programs').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('guide-no-data')).toBeNull();
    answer([program('Provider programme', at, at + HOUR)]);
    expect(await screen.findByRole('button', { name: /^Provider programme,/ })).toBeTruthy();
    expect(screen.queryByTestId('guide-no-data')).toBeNull();
  });

  it('does not flash the empty notice when a horizontal move keeps cached provider data', async () => {
    const at = eveningBack();
    handlers(() => [], (r) => r.itemId === 'c0' ? [
      program('Earlier programme', at - 3 * HOUR, at - 2 * HOUR),
      program('Current programme', at, at + HOUR),
    ] : []);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    expect(await screen.findByRole('button', { name: /^Current programme,/ })).toBeTruthy();
    const initialGridCalls = rpc.of('epg.grid').length;
    rpc.handlers['epg.grid'] = () => new Promise(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: '3 hours earlier' }));
    fireEvent.click(screen.getByRole('button', { name: '3 hours earlier' }));
    await waitFor(() => expect(rpc.of('epg.grid').length).toBeGreaterThan(initialGridCalls));
    expect(screen.queryByTestId('guide-no-data')).toBeNull();
    expect(screen.getByRole('button', { name: /^Earlier programme,/ })).toBeTruthy();
  });

  it('shows the empty notice once every visible provider lookup confirms no programmes', async () => {
    const at = defaultStart(Date.now() - 2 * DAY);
    handlers(() => [], () => []);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    const notice = await screen.findByTestId('guide-no-data');
    expect(notice.textContent).toContain('Nothing in the guide for this time.');
  });

  it('does not ask the archive table for a future-only guide window', async () => {
    const at = defaultStart(Date.now() + 2 * DAY);
    handlers(() => [], () => []);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await waitFor(() => expect(rpc.of('epg.grid').length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, SHORT_EPG_SETTLE_MS + 50));
    expect(rpc.of('catchup.programs')).toHaveLength(0);
  });

  it('drops queued channels passed during a vertical fling', async () => {
    const at = defaultStart(Date.now() - 2 * DAY);
    channels = Array.from({ length: 500 }, (_, i) => makeChannel(i));
    handlers(() => [], () => []);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await waitFor(() => expect(rpc.of('catchup.programs').length).toBeGreaterThan(0));
    // Let the first screen's bounded queue drain, then watch only calls made during the fling.
    for (let seen = -1; seen !== rpc.of('catchup.programs').length;) {
      seen = rpc.of('catchup.programs').length;
      await new Promise((r) => setTimeout(r, 400));
    }
    rpc.calls.length = 0;
    const grid = screen.getByTestId('epg-grid');
    for (const row of [100, 250, 400]) {
      grid.scrollTop = row * GRID_ROW;
      fireEvent.scroll(grid);
      await new Promise((r) => setTimeout(r, 40));
    }
    const asked = () => rpc.of('catchup.programs').map((a) => Number((a as { ref: ItemRef }).ref.itemId.slice(1)));
    await waitFor(() => expect(asked().some((i) => i >= 380)).toBe(true));
    await new Promise((r) => setTimeout(r, SHORT_EPG_SETTLE_MS + 100));
    expect(asked().filter((i) => i < 380)).toEqual([]);
  });
});

describe('guide coverage', () => {
  const at = Date.UTC(2026, 9, 7, 9);
  it('asks for a missing head, tail or internal gap but ignores small schedule seams', () => {
    const full = [program('A', at, at + HOUR), program('B', at + HOUR + MINUTE, at + 2 * HOUR)];
    expect(hasGuideGap(full, at, at + 2 * HOUR)).toBe(false);
    expect(hasGuideGap(full, at - HOUR, at + HOUR)).toBe(true);
    expect(hasGuideGap(full, at + HOUR, at + 3 * HOUR)).toBe(true);
    expect(hasGuideGap([program('A', at, at + HOUR), program('B', at + 2 * HOUR, at + 3 * HOUR)], at, at + 3 * HOUR)).toBe(true);
  });
});

it('keeps a complete provider table visible while its cache refreshes', async () => {
  const at = Date.UTC(2026, 9, 7, 9);
  let now = at;
  let response = program('Original', at - HOUR, at + MINUTE);
  const fetch = vi.fn(async () => [response]);
  const queue = new StalkerPreviewQueue(fetch, () => undefined, {
    clock: () => now,
    ttlMs: 1000,
    delayMs: 0,
    expireAtProgramBoundary: false,
    staleWhileRevalidate: true,
  });
  const ref = makeChannel(0).ref;
  queue.sync([ref]);
  await waitFor(() => expect(queue.get(ref)?.[0]?.title).toBe('Original'));
  now += 2 * MINUTE;
  expect(queue.get(ref)?.[0]?.title).toBe('Original');
  response = program('Updated', at + MINUTE, at + HOUR);
  queue.sync([ref]);
  await waitFor(() => expect(queue.get(ref)?.[0]?.title).toBe('Updated'));
  expect(fetch).toHaveBeenCalledTimes(2);
  queue.destroy();
});

it('keeps at most maxCached answers per source, the oldest going first (F3-1)', async () => {
  const fetch = vi.fn(async (ref: ItemRef) => [program(ref.itemId, Date.UTC(2026, 9, 7, 9), Date.UTC(2026, 9, 7, 10))]);
  const queue = new StalkerPreviewQueue(fetch, () => undefined, { sourceId: 'xtream-grid:cap', delayMs: 0, maxCached: 3, expireAtProgramBoundary: false });
  const refs = Array.from({ length: 5 }, (_, i) => makeChannel(i).ref);
  queue.sync(refs);
  await waitFor(() => expect(queue.get(refs[4]!)).toBeDefined());
  expect(refs.map((r) => queue.get(r) !== undefined)).toEqual([false, false, true, true, true]);
  // Released only once no queue of the source syncs.
  releaseStalkerPreviewAnswers('xtream-grid:cap');
  expect(queue.get(refs[4]!)).toBeDefined();
  queue.reset();
  releaseStalkerPreviewAnswers('xtream-grid:cap');
  expect(queue.get(refs[4]!)).toBeUndefined();
});
