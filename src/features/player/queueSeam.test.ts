/**
 * The seam between the series page's episode queue (vod `episodeQueue.ts`, which sets
 * `usePlayerStore.setState({ queue })` and refreshes entries while an episode plays) and the
 * player's own Up next countdown and `playQueued`. Runs the real store and the real queue
 * manager against a mocked RPC.
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
// The queue manager only needs the store; skip the feature's component exports.
vi.mock('@/features/player', () => import('./store'));

const store = await import('./store');
const media = await import('./media');
const { startEpisodeQueue, stopEpisodeQueue } = await import('@/features/vod/lib/episodeQueue');
const { usePlayerStore, playItem, handleEnded } = store;

const sref: ItemRef = { sourceId: 's1', contentType: 'series', itemId: '9' };
const ep = (season: number, episode: number): Episode => ({ id: `e${season}${episode}`, seriesRef: sref, season, episode, title: `Ep ${episode}` });
const order = [ep(1, 1), ep(1, 2), ep(1, 3), ep(1, 4)];

let token = 0;
/** Saved positions the core reports right now, by episode id. */
let saved: Record<string, number> = {};

const pos = (episodeId: string, positionSeconds: number): PlaybackPosition => ({
  ref: sref,
  episodeId,
  positionSeconds,
  durationSeconds: 1200,
  updatedAt: '',
  watched: false,
});

/** Every distinct item the player started, in order (one entry per play()). */
let started: string[] = [];
let unwatch: () => void = () => undefined;

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
  rpcMock.mockClear();
  sessionStorage.clear();
  store.__resetPlayerForTests();
  media.resetMedia();
  token = 0;
  saved = {};
  started = [];
  handlers['settings.get'] = () => ({ player: 'html5', playerAutoplayNextEpisode: true });
  handlers['recent.add'] = () => undefined;
  handlers['positions.set'] = () => undefined;
  handlers['positions.get'] = (a) => {
    const id = (a as { episodeId?: string }).episodeId ?? '';
    return saved[id] !== undefined ? pos(id, saved[id]) : null;
  };
  handlers['sources.get'] = () => ({ id: 's1', kind: 'xtream' });
  handlers['xtream.streamUrl'] = (a) => {
    const id = (a as { episodeId: string }).episodeId;
    return { url: `http://x/${id}.mkv?t=${++token}`, kind: 'direct', title: 'srv', isLive: false, isRadio: false };
  };
  unwatch = usePlayerStore.subscribe((s, prev) => {
    if (s.source && s.source !== prev.source && s.source.url && s.status === 'loading') started.push(s.source.episodeId ?? '?');
  });
});

afterEach(() => {
  unwatch();
  stopEpisodeQueue();
  store.__resetPlayerForTests();
  vi.useRealTimers();
});

/** The series page path: playItem, then startEpisodeQueue (SeriesDetailPage.playEpisode). */
async function playFromSeriesPage(episodeId: string, positions = new Map<string, PlaybackPosition>()): Promise<void> {
  await playItem({ ref: sref, episodeId, title: 'Show', isLive: false, sourceKind: 'xtream' });
  await startEpisodeQueue({ ref: sref, sourceKind: 'xtream', title: 'Show', order, positions }, episodeId);
}

const queueIds = (): string[] => usePlayerStore.getState().queue.map((q: PlayerSource) => q.episodeId ?? '?');

describe('series queue and Up next', () => {
  it('auto-advances exactly once, to the next episode, at its current saved position', async () => {
    vi.useFakeTimers();
    // The page loaded e12 at 100 s; it was watched on to 300 s since.
    await playFromSeriesPage('e11', new Map([['e12', pos('e12', 100)]]));
    saved = { e12: 300 };
    expect(queueIds()).toEqual(['e11', 'e12', 'e13', 'e14']);

    store.reportStatus('playing');
    store.reportProgress(1200, 1200);
    handleEnded();
    // A duplicate end report (surface remount, late event) does not restart or double the countdown.
    handleEnded();
    await vi.advanceTimersByTimeAsync(media.UP_NEXT_SECONDS * 1000 + 50);

    expect(usePlayerStore.getState().source).toMatchObject({ episodeId: 'e12', resumeSeconds: 300 });
    store.reportStatus('playing');
    await vi.advanceTimersByTimeAsync(media.UP_NEXT_SECONDS * 3000);
    expect(started).toEqual(['e11', 'e12']);
    // The page's manager rebuilt the queue around the new episode: earlier ones stay as
    // URL-less placeholders for Prev, so the current item is not at index 0.
    expect(queueIds()).toEqual(['e11', 'e12', 'e13', 'e14']);
    expect(usePlayerStore.getState().queue[0]?.url).toBe('');
    expect(usePlayerStore.getState().source?.episodeId).toBe('e12');
    expect(store.nextInQueue()?.episodeId).toBe('e13');
    expect(store.prevInQueue()?.episodeId).toBe('e11');
  });

  it('from the middle of a season, Up next and Next go forward once, past the earlier placeholders', async () => {
    vi.useFakeTimers();
    await playFromSeriesPage('e13');
    expect(queueIds()).toEqual(['e11', 'e12', 'e13', 'e14']);
    store.reportStatus('playing');
    store.reportProgress(1200, 1200);
    await vi.advanceTimersByTimeAsync(0);
    handleEnded();
    handleEnded();
    expect(media.useMediaStore.getState().upNext?.source.episodeId).toBe('e14');
    await vi.advanceTimersByTimeAsync(media.UP_NEXT_SECONDS * 1000 + 50);
    store.reportStatus('playing');
    await vi.advanceTimersByTimeAsync(media.UP_NEXT_SECONDS * 3000);
    expect(started).toEqual(['e13', 'e14']);
    // The last episode: nothing further to offer.
    store.reportProgress(1200, 1200);
    handleEnded();
    expect(media.useMediaStore.getState().upNext).toBeUndefined();
  });

  it('a queue refreshed during the countdown advances to the refreshed entry', async () => {
    vi.useFakeTimers();
    await playFromSeriesPage('e11');
    store.reportStatus('playing');
    store.reportProgress(1200, 1200);
    // Let the page's own near-the-end refresh settle first.
    await vi.advanceTimersByTimeAsync(0);
    handleEnded();
    const before = media.useMediaStore.getState().upNext?.source;
    expect(before?.episodeId).toBe('e12');

    // A late link refresh (Stalker tokens expire) lands while the card counts down.
    const q = usePlayerStore.getState().queue;
    const fresh: PlayerSource = { ...q[1]!, url: 'http://x/e12.mkv?t=fresh' };
    usePlayerStore.setState({ queue: [q[0]!, fresh, ...q.slice(2)] });
    expect(media.useMediaStore.getState().upNext?.source).toBe(fresh);

    await vi.advanceTimersByTimeAsync(media.UP_NEXT_SECONDS * 1000 + 50);
    expect(usePlayerStore.getState().source?.url).toBe('http://x/e12.mkv?t=fresh');
    expect(started).toEqual(['e11', 'e12']);
  });

  it('an episode picked during the countdown wins over the countdown', async () => {
    vi.useFakeTimers();
    await playFromSeriesPage('e11');
    store.reportStatus('playing');
    store.reportProgress(1200, 1200);
    handleEnded();

    let release!: () => void;
    const slow = { url: 'http://x/e14.mkv', kind: 'direct', title: 'srv', isLive: false, isRadio: false };
    handlers['xtream.streamUrl'] = () => new Promise((r) => (release = () => r(slow)));
    const picked = playItem({ ref: sref, episodeId: 'e14', title: 'Show', isLive: false, sourceKind: 'xtream' });
    // The countdown would have fired while the pick was still resolving.
    await vi.advanceTimersByTimeAsync(media.UP_NEXT_SECONDS * 1000 + 50);
    release();
    await picked;
    expect(usePlayerStore.getState().source?.episodeId).toBe('e14');
    expect(started).toEqual(['e11', 'e14']);
  });

  it('Next during the countdown advances once', async () => {
    vi.useFakeTimers();
    await playFromSeriesPage('e11');
    store.reportStatus('playing');
    store.reportProgress(1200, 1200);
    handleEnded();
    await vi.advanceTimersByTimeAsync(media.UP_NEXT_SECONDS * 1000 - 10);
    usePlayerStore.getState().next();
    expect(media.useMediaStore.getState().upNext).toBeUndefined();
    await vi.advanceTimersByTimeAsync(media.UP_NEXT_SECONDS * 2000);
    expect(started).toEqual(['e11', 'e12']);
  });

  it('a queue that arrives after the episode ended still offers the next one, once', async () => {
    vi.useFakeTimers();
    await playItem({ ref: sref, episodeId: 'e11', title: 'Show', isLive: false, sourceKind: 'xtream' });
    store.reportStatus('playing');
    store.reportProgress(1200, 1200);
    handleEnded();
    expect(media.useMediaStore.getState().upNext).toBeUndefined();

    // The page's queue build finishes late.
    await startEpisodeQueue({ ref: sref, sourceKind: 'xtream', title: 'Show', order }, 'e11');
    expect(media.useMediaStore.getState().upNext?.source.episodeId).toBe('e12');

    // Cancelled: a later queue change does not bring the card back.
    store.cancelUpNext();
    usePlayerStore.setState({ queue: [...usePlayerStore.getState().queue] });
    expect(media.useMediaStore.getState().upNext).toBeUndefined();
    await vi.advanceTimersByTimeAsync(media.UP_NEXT_SECONDS * 2000);
    expect(started).toEqual(['e11']);
  });

  it('Prev back to a finished episode starts it over instead of at the copied resume point', async () => {
    saved = { e11: 500 };
    await playFromSeriesPage('e11');
    expect(usePlayerStore.getState().source?.resumeSeconds).toBe(500);
    usePlayerStore.getState().next();
    await vi.waitFor(() => expect(usePlayerStore.getState().source?.episodeId).toBe('e12'));
    // e11 was finished meanwhile: the core dropped its row.
    saved = {};
    usePlayerStore.getState().prev();
    await vi.waitFor(() => expect(usePlayerStore.getState().source?.episodeId).toBe('e11'));
    expect(usePlayerStore.getState().source?.resumeSeconds).toBeUndefined();
    expect(usePlayerStore.getState().positionSeconds).toBe(0);
  });

  it('Prev to a watched episode (kept as a row at its end, C13) starts at 0 even when the core sends a resume', async () => {
    // The core still reports the watched row's position as the stream's resume point.
    const watchedRow = (id: string): PlaybackPosition => ({ ...pos(id, 1200), watched: true });
    const plain = handlers['xtream.streamUrl']!;
    handlers['xtream.streamUrl'] = (a) => {
      const r = plain(a) as PlayerSource;
      return (a as { episodeId: string }).episodeId === 'e11' ? { ...r, resumeSeconds: 1200 } : r;
    };
    await playFromSeriesPage('e12');
    expect(queueIds()).toEqual(['e11', 'e12', 'e13', 'e14']);
    expect(usePlayerStore.getState().queue[0]?.url).toBe('');
    handlers['positions.get'] = (a) => ((a as { episodeId?: string }).episodeId === 'e11' ? watchedRow('e11') : null);
    usePlayerStore.getState().prev();
    await vi.waitFor(() => expect(usePlayerStore.getState().source?.episodeId).toBe('e11'));
    expect(usePlayerStore.getState().source?.url).toMatch(/^http:\/\/x\/e11\.mkv/);
    expect(usePlayerStore.getState().source?.resumeSeconds).toBeUndefined();
    expect(usePlayerStore.getState().positionSeconds).toBe(0);
  });
});
