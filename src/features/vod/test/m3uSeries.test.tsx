/**
 * F-M3U-SERIES: an M3U source's series (grouped from playlist episodes by the core) open from
 * `m3u.seriesDetail`, play and queue their episodes through `m3u.streamUrl`, and download them
 * one by one or as a season.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Episode, ItemRef, PlayerSource, SeriesDetail } from '@/api/types';

import { movieDetailQuery, seriesDetailQuery } from '../hooks/queries';
import { queueSeriesFrom, stopEpisodeQueue } from '../lib/episodeQueue';
import { SeriesDetailPage } from '../pages/SeriesDetailPage';
import { installDomStubs, makeSource, played, renderAt, settings, usePlayerStore } from './harness';

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

vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  return {
    ...actual,
    rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const sref: ItemRef = { sourceId: 'src1', contentType: 'series', itemId: 's1' };
const ep = (id: string, season: number, episode: number): Episode => ({ id, seriesRef: sref, season, episode, title: `Part ${season}.${episode}`, containerExtension: 'mkv' });
const detail = (): SeriesDetail => ({
  item: { ref: sref, title: 'EN - Dark (2017)', titleBase: 'Dark', year: 2017, categoryId: 'c1' },
  seasons: [
    { number: 1, episodes: [ep('e11', 1, 1), ep('e12', 1, 2)] },
    { number: 2, episodes: [ep('e21', 2, 1)] },
  ],
  cast: [],
  backdrops: [],
  providerDetailsUnavailable: false,
});
function streamUrl(a: unknown): PlayerSource {
  const { episodeId } = a as { episodeId: string };
  return { url: `http://h/series/u/p/${episodeId}.mkv`, kind: 'direct', headers: { userAgent: 'Row/1' }, title: 'EN - Dark (2017)', ref: sref, episodeId, isLive: false, isRadio: false };
}
const callsOf = (cmd: string) => rpcMock.calls.filter((c) => c.cmd === cmd);
const queueIds = () => (usePlayerStore.getState().queue as { episodeId?: string }[]).map((q) => q.episodeId);
const route = [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }];

beforeAll(installDomStubs);
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  const src = makeSource('src1', 'm3u', 'Home list');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings();
  // Parental controls off: detail pages open without a lock check (C2).
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['favorites.contains'] = () => [];
  h['downloads.list'] = () => [];
  h['positions.forSeries'] = () => [];
  h['positions.continueWatching'] = () => [];
  h['tmdb.tv'] = () => null;
  h['m3u.seriesDetail'] = detail;
  h['m3u.streamUrl'] = streamUrl;
  stopEpisodeQueue();
  played.length = 0;
  usePlayerStore.setState({ source: undefined, status: 'idle', mode: 'inline', positionSeconds: 0, durationSeconds: undefined, queue: [] });
});
afterEach(() => {
  cleanup();
  stopEpisodeQueue();
});

describe('F-M3U-SERIES: detail queries by source kind', () => {
  it('asks m3u.seriesDetail for an M3U series and keeps catalog.item for an M3U movie', () => {
    expect(seriesDetailQuery('m3u', sref).queryKey[0]).toBe('m3u.seriesDetail');
    expect(movieDetailQuery('m3u', { ...sref, contentType: 'movie' }).queryKey[0]).toBe('catalog.item');
    expect(seriesDetailQuery('xtream', sref).queryKey[0]).toBe('xtream.seriesDetail');
  });
});

describe('F-M3U-SERIES: SeriesDetailPage for an M3U series', () => {
  it('lists the stored seasons and plays an episode with the rest of the season and the next queued', async () => {
    renderAt('/s/src1/series/s1', route);
    fireEvent.click(await screen.findByRole('button', { name: 'Play S01E01' }));
    await waitFor(() => expect(played).toHaveLength(1));
    expect(played[0]).toMatchObject({ ref: sref, episodeId: 'e11', sourceKind: 'm3u' });
    await waitFor(() => expect(queueIds()).toEqual(['e11', 'e12', 'e21']));
    expect(callsOf('m3u.streamUrl').map((c) => (c.args as { episodeId: string }).episodeId).sort()).toEqual(['e12', 'e21']);
    expect(callsOf('m3u.seriesDetail')[0]!.args).toEqual({ ref: sref });
    expect(callsOf('catalog.item')).toHaveLength(0);
  });

  it('downloads a season from the stored episode URLs, with the headers the core merged', async () => {
    rpcMock.handlers['downloads.start'] = (a) => ({ id: 1, ...(a as object), status: 'queued' });
    renderAt('/s/src1/series/s1', route);
    fireEvent.click(await screen.findByTestId('vod-download-season'));
    await waitFor(() => expect(callsOf('downloads.start')).toHaveLength(2));
    expect(callsOf('downloads.start')[0]!.args).toMatchObject({
      ref: sref,
      episodeId: 'e11',
      title: 'Dark',
      subtitle: 'S01E01 · Part 1.1',
      url: 'http://h/series/u/p/e11.mkv',
      headers: { userAgent: 'Row/1' },
    });
  });
});

describe('F-M3U-SERIES: continue watching an M3U episode', () => {
  it('queueSeriesFrom loads m3u.seriesDetail and resolves the next episodes through m3u.streamUrl', async () => {
    usePlayerStore.setState({ source: { ref: sref, episodeId: 'e12' }, status: 'playing', positionSeconds: 0 });
    await queueSeriesFrom({ ref: sref, sourceKind: 'm3u', title: 'Dark', episodeId: 'e12' });
    expect(queueIds()).toEqual(['e11', 'e12', 'e21']);
    expect(callsOf('m3u.streamUrl').map((c) => (c.args as { episodeId: string }).episodeId)).toEqual(['e21']);
  });
});
