/**
 * B4-vod-D12 against the real player store: the series queue puts the earlier
 * episodes in front as placeholders, so the player's Prev goes back from
 * S01E02 to S01E01 (resolving it fresh, at its saved position).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Episode, ItemRef, PlaybackPosition, PlayerSource } from '@/api/types';

const handlers: Record<string, (args: unknown) => unknown> = {};
const rpcMock = vi.fn(async (name: string, args?: unknown) => {
  const h = handlers[name];
  if (!h) throw new Error(`unmocked rpc ${name}`);
  return h(args);
});

vi.mock('@/api/transport', () => ({
  rpc: (name: string, args?: unknown) => rpcMock(name, args),
  isDesktop: false,
  proxiedUrl: (s: { url: string }) => s.url,
}));
// The parental gate has its own tests (parentalHook.test.ts); here everything may play.
vi.mock('@/features/player/parentalHook', () => ({ ensurePlaybackAllowed: async () => true }));
vi.mock('@/features/player', () => import('@/features/player/store'));

const store = await import('@/features/player/store');
const media = await import('@/features/player/media');
const { startEpisodeQueue, stopEpisodeQueue } = await import('../lib/episodeQueue');
const { usePlayerStore, playItem } = store;

const sref: ItemRef = { sourceId: 's1', contentType: 'series', itemId: '9' };
const ep = (season: number, episode: number): Episode => ({ id: `e${season}${episode}`, seriesRef: sref, season, episode, title: `Ep ${episode}` });
const order = [ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1)];
let saved: Record<string, number> = {};

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
  rpcMock.mockClear();
  sessionStorage.clear();
  store.__resetPlayerForTests();
  media.resetMedia();
  saved = {};
  handlers['settings.get'] = () => ({ player: 'html5', playerAutoplayNextEpisode: true });
  handlers['recent.add'] = () => undefined;
  handlers['positions.set'] = () => undefined;
  handlers['positions.get'] = (a): PlaybackPosition | null => {
    const id = (a as { episodeId?: string }).episodeId ?? '';
    return saved[id] !== undefined
      ? { ref: sref, episodeId: id, positionSeconds: saved[id], durationSeconds: 1200, updatedAt: '', watched: false }
      : null;
  };
  handlers['sources.get'] = () => ({ id: 's1', kind: 'xtream' });
  handlers['xtream.streamUrl'] = (a) => {
    const id = (a as { episodeId: string }).episodeId;
    return { url: `http://x/${id}.mkv`, kind: 'direct', title: 'srv', isLive: false, isRadio: false };
  };
});

afterEach(() => {
  stopEpisodeQueue();
  store.__resetPlayerForTests();
});

const queueIds = (): string[] => usePlayerStore.getState().queue.map((q: PlayerSource) => q.episodeId ?? '?');

async function playFromSeriesPage(episodeId: string): Promise<void> {
  await playItem({ ref: sref, episodeId, title: 'Show', isLive: false, sourceKind: 'xtream' });
  await startEpisodeQueue({ ref: sref, sourceKind: 'xtream', title: 'Show', order }, episodeId);
}

describe('B4-vod-D12: Prev from the series queue (real player store)', () => {
  it('goes from S01E02 back to S01E01, resolved fresh at its saved position', async () => {
    await playFromSeriesPage('e12');
    expect(queueIds()).toEqual(['e11', 'e12', 'e13', 'e21']);
    saved = { e11: 300 };
    usePlayerStore.getState().prev();
    await vi.waitFor(() => expect(usePlayerStore.getState().source?.episodeId).toBe('e11'));
    const src = usePlayerStore.getState().source!;
    expect(src.url).toBe('http://x/e11.mkv');
    expect(src.resumeSeconds).toBe(300);
    // The manager rebuilt from e11: nothing before it, Next still works.
    await vi.waitFor(() => expect(queueIds()).toEqual(['e11', 'e12', 'e13', 'e21']));
  });

  it('from the first episode of a season, goes back to the previous season’s last', async () => {
    await playFromSeriesPage('e21');
    expect(queueIds()).toEqual(['e13', 'e21']);
    usePlayerStore.getState().prev();
    await vi.waitFor(() => expect(usePlayerStore.getState().source?.episodeId).toBe('e13'));
  });
});
