/**
 * Live's Favorites view asks for its rows' channels in one `catalog.items` call per tick instead of
 * one `catalog.item` per row, and fills them in one or two commits instead of one per answer.
 * The mocks answer each ref after a staggered delay, so separate calls land in separate ticks, as
 * Tauri invokes and server requests do (a synchronous mock would hide the batching).
 */
import { cleanup, configure, screen, waitFor } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, ItemRef } from '@/api/types';

import { resetChannelListMemory } from '../components/ChannelList';
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

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<object>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

const FAVORITES = 200;
const calls = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const indexOf = (r: ItemRef) => Number(r.itemId.slice(1));
const later = <T,>(ms: number, value: () => T) => new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms));

let commits = 0;
const LIVE = [
  {
    path: '/s/:sourceId/live/:categoryId?',
    element: (
      <Profiler id="live" onRender={() => void commits++}>
        <LivePage />
      </Profiler>
    ),
  },
];

vi.setConfig({ testTimeout: 20_000 });
beforeAll(() => {
  configure({ asyncUtilTimeout: 8000 });
  installDomStubs();
});
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  commits = 0;
  h['sources.get'] = () => ({ id: 'src1', kind: 'xtream', name: 'Demo', channelCount: 500, movieCount: 0, seriesCount: 0, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['settings.get'] = () => settings();
  h['catalog.categories'] = () => [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: 500, position: 0 }];
  const now = Date.now();
  h['epg.nowNext'] = (a) =>
    Object.fromEntries(
      (a as { refs: ItemRef[] }).refs.map((r) => [`${r.sourceId}|${r.contentType}|${r.itemId}`, { now: program(`${r.itemId} show`, now - 10 * MINUTE, now + 20 * MINUTE) }]),
    );
  h['favorites.contains'] = () => [];
  h['recent.list'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
  h['favorites.list'] = () =>
    Array.from({ length: FAVORITES }, (_, i) => ({ ref: makeChannel(i).ref, position: i, addedAt: '', snapshot: { title: `Fav ${i}`, contentType: 'live' } }));
  // Each answer lands in its own tick, a millisecond per row apart.
  h['catalog.item'] = (a) => {
    const ref = (a as { ref: ItemRef }).ref;
    return later(1 + indexOf(ref), () => makeChannel(indexOf(ref)));
  };
  h['catalog.items'] = (a) => {
    const refs = (a as { refs: ItemRef[] }).refs;
    return later(1 + Math.max(...refs.map(indexOf)), () => refs.map((r) => ({ item: makeChannel(indexOf(r)) as Channel })));
  };
  resetChannelListMemory();
});
afterEach(() => cleanup());

describe('Live > Favorites (FAV-1)', () => {
  it('asks for the rows on screen in one call and fills them in a few commits', async () => {
    renderAt('/s/src1/live/@favorites', LIVE);
    const t0 = performance.now();
    await waitFor(() => {
      for (let i = 0; i < 15; i++) expect(screen.getByText(`Channel ${i}`)).toBeTruthy();
    });
    const named = performance.now() - t0;
    const commitsToNamed = commits;
    // Let the answers for the rows past the first screen land too.
    await new Promise((r) => setTimeout(r, 120));
    const single = calls('catalog.item').length;
    const batched = calls('catalog.items') as { refs: ItemRef[] }[];
    console.log(
      `[measure FAV-1] catalog.item ${single}, catalog.items ${batched.length} (${batched.map((b) => b.refs.length).join('+')} refs), ` +
        `LivePage commits to 15 named rows ${commitsToNamed}, after all answers ${commits}, ${named.toFixed(0)} ms to named`,
    );
    expect(single).toBe(0);
    expect(batched.length).toBeGreaterThanOrEqual(1);
    expect(batched.length).toBeLessThanOrEqual(2);
    // Every row near the screen was asked for exactly once.
    const asked = batched.flatMap((b) => b.refs.map(indexOf));
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked).toEqual(expect.arrayContaining(Array.from({ length: 15 }, (_, i) => i)));
  });
});
