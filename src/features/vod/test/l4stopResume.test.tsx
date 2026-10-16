/**
 * L4-hf-vod-1: stopping playback on a detail page refetched `positions.` before the stop's own
 * `positions.set` landed, so the page came back with Play (or the previous save) instead of
 * Resume from the point just reached.
 */
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { queryClient, rpcKey } from '@/api/query';
import type { ItemRef, PlaybackPosition } from '@/api/types';

const movie: ItemRef = { sourceId: 's1', contentType: 'movie', itemId: 'm1' };
const series: ItemRef = { sourceId: 's1', contentType: 'series', itemId: 'v1' };

const { player, rpcSpy } = vi.hoisted(() => ({
  player: {
    source: undefined as { ref: ItemRef; isLive: boolean; episodeId?: string } | undefined,
    positionSeconds: 0,
    durationSeconds: undefined as number | undefined,
    stop: vi.fn(),
  },
  rpcSpy: vi.fn(async (..._args: unknown[]) => null),
}));

vi.mock('@/features/player', () => ({ playItem: vi.fn(), usePlayerStore: { getState: () => player } }));
vi.mock('@/api/transport', async (orig) => ({ ...(await orig<typeof import('@/api/transport')>()), rpc: rpcSpy }));
vi.mock('@/ui', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

const { usePlayback } = await import('../hooks/usePlayback');

beforeEach(() => {
  queryClient.clear();
  player.stop.mockClear();
  rpcSpy.mockClear();
});
afterEach(() => cleanup());

describe('usePlayback stop (L4-hf-vod-1)', () => {
  it('shows the position being saved on the movie page without refetching ahead of the save', () => {
    const key = rpcKey('positions.get', { ref: movie });
    queryClient.setQueryData(key, null);
    player.source = { ref: movie, isLive: false };
    player.positionSeconds = 9.7;
    player.durationSeconds = 5580.4;
    const { result } = renderHook(() => usePlayback({ ref: movie, sourceKind: 'xtream', title: 'Black Harbor' }));
    result.current.stop();
    expect(player.stop).toHaveBeenCalledOnce();
    const row = queryClient.getQueryData<PlaybackPosition>(key);
    expect(row).toMatchObject({ ref: movie, positionSeconds: 9, durationSeconds: 5580, watched: false });
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    expect(rpcSpy).not.toHaveBeenCalledWith('positions.get', expect.anything());
  });

  it('updates the episode row of the series page and keeps the watched flag', () => {
    const key = rpcKey('positions.forSeries', { ref: series });
    const other: PlaybackPosition = { ref: series, episodeId: 'e2', positionSeconds: 30, updatedAt: 'x', watched: false };
    const replay: PlaybackPosition = { ref: series, episodeId: 'e1', positionSeconds: 3000, durationSeconds: 3100, updatedAt: 'x', watched: true };
    queryClient.setQueryData(key, [replay, other]);
    player.source = { ref: series, isLive: false, episodeId: 'e1' };
    player.positionSeconds = 120.2;
    player.durationSeconds = 3100;
    const { result } = renderHook(() => usePlayback({ ref: series, sourceKind: 'xtream', title: 'Harbor Lights' }));
    result.current.stop();
    const list = queryClient.getQueryData<PlaybackPosition[]>(key)!;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ episodeId: 'e1', positionSeconds: 120, watched: true });
    expect(list[1]).toBe(other);
  });

  it('leaves the cache to a normal refetch when nothing was played', () => {
    const key = rpcKey('positions.get', { ref: movie });
    const saved: PlaybackPosition = { ref: movie, positionSeconds: 50, updatedAt: 'x', watched: false };
    queryClient.setQueryData(key, saved);
    player.source = undefined;
    const { result } = renderHook(() => usePlayback({ ref: movie, sourceKind: 'xtream', title: 'Black Harbor' }));
    result.current.stop();
    expect(queryClient.getQueryData(key)).toBe(saved);
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });
});
