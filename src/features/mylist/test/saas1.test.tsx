// VL-mylist-rows: a My List row shows how far its title got and plays from there.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef, PlaybackPosition } from '@/api/types';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
const played = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', () => ({
  playItem: async (args: unknown) => {
    played.items.push(args);
  },
  playSource: async () => undefined,
  usePlayerStore: Object.assign(() => undefined, { getState: () => ({ source: undefined }), setState: () => undefined, subscribe: () => () => undefined }),
  PlayerStage: () => null,
}));
vi.mock('@/features/vod/lib/episodeQueue', () => ({ queueSeriesFrom: async () => undefined }));

const h = await import('./harness');
const rpc = h.createRpcMock();
rpcMock.current = rpc;
const { MyListPage } = await import('../pages/MyListPage');

const m = (id: string): ItemRef => ({ sourceId: 'src1', contentType: 'movie', itemId: id });
const s = (id: string): ItemRef => ({ sourceId: 'src1', contentType: 'series', itemId: id });
const ARRIVAL = h.entry(m('m1'), 'Arrival', { addedAt: '2026-10-01T10:00:00Z' });
const DARK = h.entry(s('s1'), 'Dark', { addedAt: '2026-10-05T10:00:00Z' });
const LOST = h.entry(s('s2'), 'Lost', { addedAt: '2026-10-04T10:00:00Z' });

const rowOf = (title: string) => screen.getAllByTestId('mylist-row').find((r) => r.querySelector('[data-action="open"] span')!.textContent === title)!;

beforeAll(h.installDomStubs);
beforeEach(() => {
  rpc.reset();
  h.resetShared();
  played.items.length = 0;
  rpc.handlers['positions.get'] = () => null;
  rpc.handlers['positions.forSeries'] = () => [];
});
afterEach(cleanup);

describe('VL-mylist-rows', () => {
  it('draws the saved position and plays from it; a series names the episode it resumes', async () => {
    const positions: PlaybackPosition[] = [
      { ref: m('m1'), positionSeconds: 1800, durationSeconds: 7200, updatedAt: '2026-10-12T00:00:00Z', watched: false, snapshot: { title: 'Arrival', contentType: 'movie' } },
      { ref: s('s1'), episodeId: 'e5', positionSeconds: 600, durationSeconds: 3000, updatedAt: '2026-10-11T00:00:00Z', watched: false, snapshot: { title: 'Dark', subtitle: 'S01E05', contentType: 'series' } },
    ];
    rpc.handlers['positions.continueWatching'] = () => positions;
    h.installCore(rpc, [ARRIVAL, DARK, LOST]);
    h.renderAt('/my-list', [{ path: '/my-list', element: <MyListPage /> }]);
    await screen.findAllByTestId('mylist-row');

    const arrival = await waitFor(() => {
      const row = rowOf('Arrival');
      expect(within(row).getByTestId('mylist-progress')).toBeTruthy();
      return row;
    });
    expect(within(arrival).getByText('90 minutes left')).toBeTruthy();
    expect(within(rowOf('Dark')).getByText('S01E05')).toBeTruthy();
    // A series not started has nothing to resume: its page picks the episode.
    expect(rowOf('Lost').querySelector('[data-action="play"]')).toBeNull();

    fireEvent.click(arrival.querySelector<HTMLElement>('[data-action="play"]')!);
    await waitFor(() => expect(played.items).toHaveLength(1));
    expect(played.items[0]).toMatchObject({ ref: m('m1'), isLive: false });
    fireEvent.click(rowOf('Dark').querySelector<HTMLElement>('[data-action="play"]')!);
    await waitFor(() => expect(played.items).toHaveLength(2));
    expect(played.items[1]).toMatchObject({ ref: s('s1'), episodeId: 'e5' });
  });
});
