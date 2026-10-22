/**
 * The guide's Favorites view asks `epg.grid` once per chunk on screen, with every favorite's ref
 * from the start, instead of again each time another batch of `catalog.item` answers lands
 * (GD-FAV-GRID). The channel lookups answer after a staggered delay, so they land in separate
 * ticks as real calls do.
 */
import { cleanup, configure, screen, waitFor } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, ItemRef } from '@/api/types';

import { defaultStart, EpgGridPage, GRID_CHUNK } from '../../components/EpgGridPage';
import { HOUR } from '../../lib/epgTime';
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

const FAVORITES = 60;
const key = (r: ItemRef) => `${r.sourceId}|${r.contentType}|${r.itemId}`;
const indexOf = (r: ItemRef) => Number(r.itemId.slice(1));
const later = <T,>(ms: number, value: () => T) => new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms));

let commits = 0;
const GRID = [
  {
    path: '/epg',
    element: (
      <Profiler id="guide" onRender={() => void commits++}>
        <EpgGridPage />
      </Profiler>
    ),
  },
];

beforeAll(() => {
  installDomStubs();
  configure({ asyncUtilTimeout: 8000 });
  vi.setConfig({ testTimeout: 20_000 });
});
beforeEach(() => {
  rpc.reset();
  commits = 0;
  const h = rpc.handlers;
  const start = defaultStart(Date.now());
  h['sources.list'] = () => [{ id: 'src1', kind: 'm3u', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } }];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['catalog.categories'] = () => [];
  h['lists.list'] = () => [];
  h['favorites.list'] = () =>
    Array.from({ length: FAVORITES }, (_, i) => ({ ref: makeChannel(i).ref, position: i, addedAt: '', snapshot: { title: `Fav ${i}`, contentType: 'live' } }));
  h['catalog.item'] = (a) => {
    const ref = (a as { ref: ItemRef }).ref;
    return later(2 * (1 + indexOf(ref)), () => makeChannel(indexOf(ref)));
  };
  h['catalog.items'] = (a) => {
    const refs = (a as { refs: ItemRef[] }).refs;
    return later(2 * (1 + Math.max(...refs.map(indexOf))), () => refs.map((r) => ({ item: makeChannel(indexOf(r)) as Channel })));
  };
  h['epg.grid'] = (a) => Object.fromEntries((a as { refs: ItemRef[] }).refs.map((r) => [key(r), [program(`${r.itemId} show`, start, start + HOUR)]]));
  h['epg.sources'] = () => [];
  h['epg.search'] = () => [];
  h['reminders.list'] = () => [];
  h['recordings.list'] = () => [];
  h['recordings.rules'] = () => [];
  h['recordings.capabilities'] = () => ({ supported: true });
  h['channels.edits'] = () => [];
});
afterEach(() => cleanup());

describe("the guide's Favorites view (GD-FAV-GRID)", () => {
  it('asks the grid once per chunk, with every favorite in it from the start', async () => {
    renderGuide({ path: `/epg?source=src1&view=favorites&at=${defaultStart(Date.now())}`, routes: GRID });
    await screen.findByTestId('epg-grid');
    await waitFor(() => {
      for (let i = 0; i < 12; i++) expect(screen.getByText(`c${i} show`)).toBeTruthy();
    });
    const commitsToCells = commits;
    await new Promise((r) => setTimeout(r, 200));
    const grids = rpc.of('epg.grid') as { refs: ItemRef[] }[];
    console.log(
      `[measure GD-FAV-GRID] epg.grid ${grids.length} (${grids.map((g) => g.refs.length).join(', ')} refs), ` +
        `catalog.item ${rpc.of('catalog.item').length}, catalog.items ${rpc.of('catalog.items').length}, EpgGridPage commits to cells ${commitsToCells}`,
    );
    const asked = (first: number) => grids.filter((g) => indexOf(g.refs[0]!) === first).map((g) => g.refs.map(indexOf));
    const rows = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
    expect(asked(0)).toEqual([rows(0, GRID_CHUNK)]);
    // The chunk below is read ahead at rest, once: its refs are known too.
    expect(asked(GRID_CHUNK)).toEqual([rows(GRID_CHUNK, FAVORITES)]);
    expect(grids).toHaveLength(2);
  });
});
