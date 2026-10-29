import { cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, EpgProgram, ItemRef, Page, PageQuery } from '@/api/types';

import { defaultStart, EpgGridPage, GRID_ROW, SHORT_EPG_SETTLE_MS } from '../../components/EpgGridPage';
import { DAY, HOUR, MINUTE } from '../../lib/epgTime';
import { hasGuideGap } from '../../lib/guideCoverage';
import { resetStalkerPreviewSources, StalkerPreviewQueue } from '../../lib/stalkerPreviewQueue';
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
  h['catchup.table'] = (a) => table((a as { ref: ItemRef }).ref);
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
    const at = defaultStart(Date.now() - 2 * DAY);
    handlers(
      (r) => r.itemId === 'c0' ? [program('Current XML', at, at + 7 * HOUR)] : [],
      (r) => r.itemId === 'c0' ? [program('Earlier provider', at - 3 * HOUR, at - 2 * HOUR)] : [],
    );
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await screen.findByRole('button', { name: /^Current XML,/ });
    const channelCalls = () => rpc.of('catchup.table').filter((a) => (a as { ref: ItemRef }).ref.itemId === 'c0');
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
    expect(rpc.of('catchup.table').some((a) => (a as { ref: ItemRef }).ref.itemId === 'c0')).toBe(true);
    expect(rpc.of('catchup.table').some((a) => (a as { ref: ItemRef }).ref.itemId === 'c1')).toBe(false);
  });

  it('reuses one full-table request per channel across horizontal guide windows', async () => {
    const at = defaultStart(Date.now() - 2 * DAY);
    handlers(() => [], (r) => r.itemId === 'c0' ? [
      program('Beyond initial window', at - 8 * HOUR, at - 7 * HOUR),
      program('Current window', at, at + HOUR),
    ] : []);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    expect(await screen.findByRole('button', { name: /^Current window,/ })).toBeTruthy();
    const channelCalls = () => rpc.of('catchup.table').filter((a) => (a as { ref: ItemRef }).ref.itemId === 'c0');
    expect(channelCalls()).toHaveLength(1);

    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: '3 hours earlier' }));
    expect(await screen.findByRole('button', { name: /^Beyond initial window,/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '3 hours later' }));
    await new Promise((r) => setTimeout(r, SHORT_EPG_SETTLE_MS + 50));
    expect(channelCalls()).toHaveLength(1);
  });

  it('does not announce an empty guide while a visible channel table is still loading', async () => {
    const at = defaultStart(Date.now() - 2 * DAY);
    handlers(() => [], () => []);
    let answer!: (programs: EpgProgram[]) => void;
    const pending = new Promise<EpgProgram[]>((resolve) => { answer = resolve; });
    rpc.handlers['catchup.table'] = (a) => (a as { ref: ItemRef }).ref.itemId === 'c0' ? pending : [];
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await waitFor(() => expect(rpc.of('catchup.table').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('guide-no-data')).toBeNull();
    answer([program('Provider programme', at, at + HOUR)]);
    expect(await screen.findByRole('button', { name: /^Provider programme,/ })).toBeTruthy();
    expect(screen.queryByTestId('guide-no-data')).toBeNull();
  });

  it('does not flash the empty notice when a horizontal move keeps cached provider data', async () => {
    const at = defaultStart(Date.now() - 2 * DAY);
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
    expect(rpc.of('catchup.table')).toHaveLength(0);
  });

  it('drops queued channels passed during a vertical fling', async () => {
    const at = defaultStart(Date.now() - 2 * DAY);
    channels = Array.from({ length: 500 }, (_, i) => makeChannel(i));
    handlers(() => [], () => []);
    renderGuide({ path: `/epg?source=src1&at=${at}`, routes: GRID });
    await waitFor(() => expect(rpc.of('catchup.table').length).toBeGreaterThan(0));
    // Let the first screen's bounded queue drain, then watch only calls made during the fling.
    for (let seen = -1; seen !== rpc.of('catchup.table').length;) {
      seen = rpc.of('catchup.table').length;
      await new Promise((r) => setTimeout(r, 400));
    }
    rpc.calls.length = 0;
    const grid = screen.getByTestId('epg-grid');
    for (const row of [100, 250, 400]) {
      grid.scrollTop = row * GRID_ROW;
      fireEvent.scroll(grid);
      await new Promise((r) => setTimeout(r, 40));
    }
    const asked = () => rpc.of('catchup.table').map((a) => Number((a as { ref: ItemRef }).ref.itemId.slice(1)));
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
