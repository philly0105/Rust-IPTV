/** B6 library fixes: undo with original dates, focus after removal, fresh data, URL search, series queue. */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecentEntry, Source } from '@/api/types';
import { useToastStore } from '@/ui';

import { ContinueRail } from '../components/ContinueRail';
import { DialProgress } from '../components/DownloadRow';
import { reinsertFavorite } from '../lib/favorites';
import { collectHistory, restoreHistory, RECENT_LIST_MAX, type RecentAddArgs } from '../lib/recent';
import { DownloadsPage } from '../pages/DownloadsPage';
import { FavoritesPage } from '../pages/FavoritesPage';
import { MyVideoDetailPage } from '../pages/MyVideoDetailPage';
import { MyVideosPage } from '../pages/MyVideosPage';
import { RecentPage } from '../pages/RecentPage';
import { stopTrackingDownloadPosition } from '../lib/positionSync';
import { makeDownload, makeEpisode, makeFavorite, makePosition, makeRecent } from './fixtures';
import { fakePlayer, i18n, installDomStubs, renderAt } from './harness';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./harness')['createRpcMock']> }));
const queueSpy = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock('@/api/transport', () => {
  class RpcError extends Error {
    code = 'internal';
    static from(err: unknown) {
      return err instanceof RpcError ? err : new RpcError(err instanceof Error ? err.message : String(err));
    }
  }
  return {
    rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
    isDesktop: false,
    RpcError,
    proxiedUrl: (s: { url: string }) => s.url,
  };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
const headerSpy = vi.hoisted(() => ({
  last: null as null | { actions?: React.ReactNode; search?: { value: string; onChange: (v: string) => void } },
}));
vi.mock('@/shell', () => {
  const setHeader = (h: typeof headerSpy.last) => {
    headerSpy.last = h;
  };
  return { useShell: () => ({ setHeader }), useShortcut: () => undefined };
});
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);
vi.mock('@/features/vod/lib/episodeQueue', () => ({
  queueSeriesFrom: async (args: unknown) => {
    queueSpy.calls.push(args);
  },
}));

const harness = await import('./harness');
rpcMock.current = harness.createRpcMock();
const rpc = rpcMock.current;

const sources: Partial<Source>[] = [{ id: 'src1', kind: 'xtream', name: 'Home portal' }];
const recentRoute = [{ path: '/recent', element: <RecentPage /> }];
const favoritesRoute = [{ path: '/favorites', element: <FavoritesPage /> }];

function lastToast() {
  const toasts = useToastStore.getState().toasts;
  return toasts[toasts.length - 1];
}

beforeAll(installDomStubs);
beforeEach(() => {
  rpc.reset();
  useToastStore.setState({ toasts: [] });
  rpc.handlers['sources.list'] = () => sources;
  rpc.handlers['downloads.dir'] = () => ({ path: 'D:/Videos' });
  fakePlayer.usePlayerStore.setState({ source: undefined, positionSeconds: 0 });
  fakePlayer.items.length = 0;
  queueSpy.calls.length = 0;
  headerSpy.last = null;
});
afterEach(() => {
  stopTrackingDownloadPosition();
  cleanup();
});

describe('clear history can be undone with the original dates (D2)', () => {
  it('re-adds every cleared entry with its own viewedAt and confirms', async () => {
    const entries = [makeRecent('a', '2026-10-11T10:00:00Z'), makeRecent('b', '2026-09-01T08:00:00Z')];
    let stored: RecentEntry[] = entries;
    rpc.handlers['recent.list'] = () => stored;
    rpc.handlers['positions.continueWatching'] = () => [];
    rpc.handlers['recent.clear'] = () => {
      stored = [];
    };
    rpc.handlers['recent.add'] = () => undefined;
    renderAt('/recent', recentRoute);

    await screen.findByTestId('recent-list');
    await waitFor(() => expect(headerSpy.last?.actions).toBeTruthy());
    render(<>{headerSpy.last?.actions}</>);
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear history' }));
    await waitFor(() => expect(lastToast()?.title).toBe('History cleared'));
    expect(lastToast()?.action?.label).toBe('Undo');

    lastToast()!.action!.onClick();
    await waitFor(() => expect(lastToast()?.title).toBe('History restored'));
    expect(rpc.callsOf('recent.add')).toEqual(entries.map((e) => ({ ref: e.ref, snapshot: e.snapshot, viewedAt: e.viewedAt })));
  });

  it('collectHistory reads each source when the global page is full', async () => {
    const full = Array.from({ length: RECENT_LIST_MAX }, (_, i) => makeRecent(`g${i}`, '2026-10-01T00:00:00Z'));
    const extra = makeRecent('old', '2025-01-01T00:00:00Z', 'movie', 'src2');
    const calls: unknown[] = [];
    const out = await collectHistory(
      async (a) => {
        calls.push(a);
        return a.sourceId === 'src2' ? [extra, full[0]!] : a.sourceId ? [] : full;
      },
      undefined,
      ['src1', 'src2'],
    );
    expect(calls).toEqual([{ limit: 1000 }, { sourceId: 'src1', limit: 200 }, { sourceId: 'src2', limit: 200 }]);
    expect(out).toHaveLength(RECENT_LIST_MAX + 1);
  });

  it('restoreHistory counts what came back when some adds fail', async () => {
    const entries = [makeRecent('a', '2026-10-01T00:00:00Z'), makeRecent('b', '2026-10-02T00:00:00Z')];
    const seen: RecentAddArgs[] = [];
    const n = await restoreHistory(entries, async (a) => {
      seen.push(a);
      if (a.ref.itemId === 'a') throw new Error('nope');
    });
    expect(n).toBe(1);
    expect(seen.map((a) => a.viewedAt)).toEqual(['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z']);
  });
});

describe('favorite undo puts it back in place (D3)', () => {
  it('re-adds only when missing, then restores the old position', async () => {
    const list = [makeFavorite('movie', 'm1', 0), makeFavorite('movie', 'm2', 1), makeFavorite('movie', 'm3', 2)];
    let stored = list;
    rpc.handlers['favorites.list'] = () => stored;
    rpc.handlers['favorites.remove'] = () => {
      stored = [list[0]!, list[2]!];
    };
    rpc.handlers['favorites.contains'] = () => [];
    rpc.handlers['favorites.toggle'] = () => {
      stored = [list[0]!, list[2]!, { ...list[1]!, position: 3 }];
      return { isFavorite: true };
    };
    rpc.handlers['favorites.reorder'] = () => undefined;
    renderAt('/favorites', favoritesRoute);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove movie m2 from favorites' }));
    await waitFor(() => expect(lastToast()?.title).toBe('Removed movie m2 from favorites'));
    lastToast()!.action!.onClick();
    await waitFor(() => expect(rpc.callsOf('favorites.reorder')).toHaveLength(1));
    expect(rpc.callsOf('favorites.toggle')).toHaveLength(1);
    expect(rpc.callsOf('favorites.reorder')[0]).toEqual({ refs: [list[0]!.ref, list[1]!.ref, list[2]!.ref] });
  });

  it('does not toggle a favorite that was already added back', async () => {
    const list = [makeFavorite('movie', 'm1', 0), makeFavorite('movie', 'm2', 1)];
    rpc.handlers['favorites.list'] = () => list;
    rpc.handlers['favorites.remove'] = () => undefined;
    rpc.handlers['favorites.contains'] = () => [list[0]!.ref];
    rpc.handlers['favorites.toggle'] = () => ({ isFavorite: false });
    rpc.handlers['favorites.reorder'] = () => undefined;
    renderAt('/favorites', favoritesRoute);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove movie m1 from favorites' }));
    await waitFor(() => expect(lastToast()?.action).toBeTruthy());
    lastToast()!.action!.onClick();
    await waitFor(() => expect(rpc.callsOf('favorites.reorder')).toHaveLength(1));
    expect(rpc.callsOf('favorites.toggle')).toEqual([]);
  });

  it('reinsertFavorite keeps the current order of the others', () => {
    const [a, b, c] = [makeFavorite('live', 'a', 0), makeFavorite('live', 'b', 1), makeFavorite('live', 'c', 2)];
    expect(reinsertFavorite([{ ...c!, position: 0 }, { ...a!, position: 1 }], b!, 1).map((e) => e.ref.itemId)).toEqual(['c', 'b', 'a']);
    expect(reinsertFavorite([a!], b!, 9).map((e) => e.ref.itemId)).toEqual(['a', 'b']);
  });
});

describe('focus stays in the list after a row is removed (D4)', () => {
  it('moves focus to the row that took its place', async () => {
    const now = new Date().toISOString();
    let stored = [makeRecent('a', now), makeRecent('b', now)];
    rpc.handlers['recent.list'] = () => stored;
    rpc.handlers['positions.continueWatching'] = () => [];
    rpc.handlers['recent.remove'] = () => {
      stored = stored.slice(1);
    };
    renderAt('/recent', recentRoute);

    const first = (await screen.findByRole('button', { name: 'Remove Watched a from history' })).closest<HTMLElement>('[role="listitem"]')!;
    act(() => first.focus());
    fireEvent.keyDown(first, { key: 'Delete' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Watched a from history' })).toBeNull());
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Watched b'));
  });
});

describe('MyVideoDetailPage follows the series when its URL episode is removed (D5)', () => {
  it('stays on the series instead of showing not found', async () => {
    const ep2 = makeEpisode('s1', 'Severance', 'S01E02 Half Loop', { id: 2, completedAt: '2026-10-03T00:00:00Z' });
    const ep3 = makeEpisode('s1', 'Severance', 'S01E01 Good News', { id: 3, completedAt: '2026-10-02T00:00:00Z' });
    let stored = [ep2, ep3];
    rpc.handlers['myvideos.list'] = () => stored;
    rpc.handlers['downloads.remove'] = () => {
      stored = [ep3];
    };
    renderAt('/my-videos/2', [{ path: '/my-videos/:id', element: <MyVideoDetailPage /> }]);

    fireEvent.click(await screen.findByRole('button', { name: /Remove .*Half Loop/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove from library' }));
    await waitFor(() => expect(screen.getAllByTestId('episode-row')).toHaveLength(1));
    expect(screen.queryByText('This video is not in your library')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Severance' })).toBeTruthy();
  });

  it('redownloading a fully missing series shows one toast (D15)', async () => {
    const eps = [1, 2, 3].map((n) =>
      makeEpisode('s9', 'Dark', `S01E0${n} Part ${n}`, { id: 40 + n, fileAvailable: false, completedAt: '2026-10-02T00:00:00Z' }),
    );
    rpc.handlers['myvideos.list'] = () => eps;
    rpc.handlers['downloads.retry'] = () => undefined;
    renderAt('/my-videos/41', [{ path: '/my-videos/:id', element: <MyVideoDetailPage /> }]);

    fireEvent.click(await screen.findByRole('button', { name: 'Download again' }));
    await waitFor(() => expect(rpc.callsOf('downloads.retry')).toHaveLength(3));
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(lastToast()?.title).toBe('3 episodes of Dark are queued to download again');
  });

  it('a series card names its missing files (D14)', async () => {
    rpc.handlers['myvideos.list'] = () => [
      makeEpisode('s1', 'Severance', 'S01E01 Good News', { id: 5, fileAvailable: false }),
      makeEpisode('s1', 'Severance', 'S01E02 Half Loop', { id: 6 }),
    ];
    renderAt('/my-videos', [{ path: '/my-videos', element: <MyVideosPage /> }]);
    expect(await screen.findByRole('listitem', { name: 'Severance, 2 episodes, 1 episode file is missing' })).toBeTruthy();
  });
});

describe('Recent stays current while something plays (D8)', () => {
  it('refetches history and continue watching when the player changes title', async () => {
    rpc.handlers['recent.list'] = () => [makeRecent('a', new Date().toISOString())];
    rpc.handlers['positions.continueWatching'] = () => [];
    renderAt('/recent', recentRoute);
    await screen.findByTestId('recent-list');
    const before = rpc.callsOf('recent.list').length;
    const cwBefore = rpc.callsOf('positions.continueWatching').length;

    act(() => fakePlayer.usePlayerStore.setState({ source: { url: 'http://x/1', kind: 'hls', title: 'X', isLive: false, isRadio: false } }));
    await waitFor(() => expect(rpc.callsOf('recent.list').length).toBeGreaterThan(before));
    await waitFor(() => expect(rpc.callsOf('positions.continueWatching').length).toBeGreaterThan(cwBefore));
  });
});

describe('search survives a reload (D17)', () => {
  it('reads ?q= on Recent and Favorites', async () => {
    rpc.handlers['recent.list'] = () => [makeRecent('alpha', new Date().toISOString()), makeRecent('beta', new Date().toISOString())];
    rpc.handlers['positions.continueWatching'] = () => [];
    renderAt('/recent?q=alpha', recentRoute);
    await waitFor(() => expect(screen.getAllByTestId('entry-row')).toHaveLength(1));
    expect(headerSpy.last?.search?.value).toBe('alpha');
    cleanup();

    rpc.handlers['favorites.list'] = () => [makeFavorite('movie', 'one', 0), makeFavorite('movie', 'two', 1)];
    renderAt('/favorites?q=two', favoritesRoute);
    await waitFor(() => expect(screen.getAllByTestId('entry-row')).toHaveLength(1));
  });
});

describe('continue watching (D18, series queue)', () => {
  const series = {
    ...makePosition('show1', 300, 1800),
    ref: { sourceId: 'src1', contentType: 'series' as const, itemId: 'show1' },
    episodeId: 'ep7',
    snapshot: { title: 'Show One', contentType: 'series' as const, subtitle: 'S01E07', posterUrl: 'http://img/p.jpg' },
  };

  it('resumes a series episode and queues the rest of the series', async () => {
    rpc.handlers['recent.list'] = () => [];
    rpc.handlers['positions.continueWatching'] = () => [series];
    renderAt('/recent', recentRoute);

    fireEvent.click(await screen.findByRole('button', { name: /Continue Show One/ }));
    await waitFor(() => expect(queueSpy.calls).toHaveLength(1));
    expect(fakePlayer.items[0]).toMatchObject({ ref: series.ref, episodeId: 'ep7', title: 'Show One', sourceKind: 'xtream', isLive: false });
    expect(queueSpy.calls[0]).toEqual({ ref: series.ref, sourceKind: 'xtream', title: 'Show One', episodeId: 'ep7', posterUrl: 'http://img/p.jpg' });
  });

  it('a movie resumes without a queue', async () => {
    rpc.handlers['recent.list'] = () => [];
    rpc.handlers['positions.continueWatching'] = () => [makePosition('m1', 300, 1800)];
    renderAt('/recent', recentRoute);
    fireEvent.click(await screen.findByRole('button', { name: /Continue Continue m1/ }));
    await waitFor(() => expect(fakePlayer.items).toHaveLength(1));
    expect(queueSpy.calls).toEqual([]);
  });

  it('removing a series card clears every unfinished episode; Undo restores exactly those rows (C13)', async () => {
    const at = (ms: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, 0, ms)).toISOString();
    const e1 = { ...series, episodeId: 'ep1', positionSeconds: 300, updatedAt: at(1) };
    const e2 = { ...series, episodeId: 'ep7', positionSeconds: 120, updatedAt: at(3) };
    const done = { ...series, episodeId: 'ep3', positionSeconds: 1800, updatedAt: at(2), watched: true };
    rpc.handlers['recent.list'] = () => [];
    rpc.handlers['positions.continueWatching'] = () => [e2];
    rpc.handlers['positions.forSeries'] = () => [e2, done, e1];
    rpc.handlers['positions.remove'] = () => undefined;
    rpc.handlers['positions.set'] = () => undefined;
    renderAt('/recent', recentRoute);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Show One from continue watching' }));
    await waitFor(() => expect(lastToast()?.title).toBe('Removed Show One from continue watching'));
    expect(rpc.callsOf('positions.remove')).toEqual([{ ref: series.ref, allEpisodes: true }]);

    lastToast()!.action!.onClick();
    await waitFor(() => expect(rpc.callsOf('positions.set')).toHaveLength(2));
    // Oldest first, so ep7 is again the series' newest row; the watched ep3 was never removed.
    expect(rpc.callsOf('positions.set')).toEqual([
      { ref: series.ref, episodeId: 'ep1', positionSeconds: 300, durationSeconds: 1800, snapshot: series.snapshot, updatedAt: at(1) },
      { ref: series.ref, episodeId: 'ep7', positionSeconds: 120, durationSeconds: 1800, snapshot: series.snapshot, updatedAt: at(3) },
    ]);
  });

  it('Undo puts a removed card back in its old place in the rail (C14)', async () => {
    type Row = ReturnType<typeof makePosition>;
    let rows: Row[] = [
      { ...makePosition('first', 300, 1800), updatedAt: '2026-10-03T00:00:00.000Z' },
      { ...makePosition('middle', 300, 1800), updatedAt: '2026-10-02T00:00:00.000Z' },
      { ...makePosition('last', 300, 1800), updatedAt: '2026-10-01T00:00:00.000Z' },
    ];
    // A core in miniature: newest first; a save without updatedAt is stamped now.
    rpc.handlers['recent.list'] = () => [];
    rpc.handlers['positions.continueWatching'] = () => [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    rpc.handlers['positions.remove'] = (a) => {
      rows = rows.filter((r) => r.ref.itemId !== (a as { ref: Row['ref'] }).ref.itemId);
    };
    rpc.handlers['positions.set'] = (a) => {
      const x = a as Row & { updatedAt?: string };
      rows.push({ ...x, watched: false, updatedAt: x.updatedAt ?? new Date().toISOString() });
    };
    renderAt('/recent', recentRoute);
    const order = () => screen.getAllByRole('button', { name: /^Continue Continue/ }).map((b) => b.getAttribute('aria-label'));
    await screen.findByRole('button', { name: /Continue Continue middle/ });
    const before = order();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Continue middle from continue watching' }));
    await waitFor(() => expect(order()).toHaveLength(2));
    lastToast()!.action!.onClick();
    await waitFor(() => expect(order()).toEqual(before));
  });

  it('removing a movie card removes just that row', async () => {
    const movie = makePosition('m1', 300, 1800);
    rpc.handlers['recent.list'] = () => [];
    rpc.handlers['positions.continueWatching'] = () => [movie];
    rpc.handlers['positions.remove'] = () => undefined;
    renderAt('/recent', recentRoute);
    fireEvent.click(await screen.findByRole('button', { name: /^Remove .* from continue watching$/ }));
    await waitFor(() => expect(rpc.callsOf('positions.remove')).toEqual([{ ref: movie.ref }]));
    expect(rpc.callsOf('positions.forSeries')).toEqual([]);
  });

  it('arrow keys, Home and End move between cards', () => {
    const ps = [makePosition('a', 10, 100), makePosition('b', 10, 100), makePosition('c', 10, 100)];
    render(
      <harness.I18nWrap>
        <ContinueRail positions={ps} onOpen={() => undefined} onRemove={() => undefined} />
      </harness.I18nWrap>,
    );
    const cards = screen.getAllByRole('button', { name: /^Continue Continue/ });
    act(() => cards[0]!.focus());
    fireEvent.keyDown(cards[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cards[1]);
    fireEvent.keyDown(cards[1]!, { key: 'End' });
    expect(document.activeElement).toBe(cards[2]);
    fireEvent.keyDown(cards[2]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cards[2]);
    fireEvent.keyDown(cards[2]!, { key: 'Home' });
    expect(document.activeElement).toBe(cards[0]);
  });
});

describe('downloads', () => {
  it('the confirm dialog closes before the command runs, so focus can return to the row (D12)', async () => {
    let release: () => void = () => undefined;
    rpc.handlers['downloads.list'] = () => [makeDownload({ id: 70, status: 'downloading', title: 'Big file', bytesDownloaded: 10, totalBytes: 100 })];
    rpc.handlers['downloads.cancel'] = () => new Promise<void>((r) => (release = r));
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Big file' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel download' }));
    await waitFor(() => expect(rpc.callsOf('downloads.cancel')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    release();
  });

  it('a folder that cannot be read says so and retries (D19)', async () => {
    let fail = true;
    rpc.handlers['downloads.dir'] = () => {
      if (fail) throw new Error('denied');
      return { path: 'E:/Media' };
    };
    rpc.handlers['downloads.list'] = () => [];
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);

    const alert = await screen.findByTestId('downloads-dir-error');
    expect(alert.textContent).toContain("Couldn't read the downloads folder.");
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('E:/Media')).toBeTruthy();
  });

  it('an outage shows one error state, and its retry reloads the folder too (R1-4)', async () => {
    let down = true;
    rpc.handlers['downloads.dir'] = () => {
      if (down) throw new Error('core unreachable');
      return { path: 'E:/Media' };
    };
    rpc.handlers['downloads.list'] = () => {
      if (down) throw new Error('core unreachable');
      return [];
    };
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);

    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    expect(await screen.findByTestId('downloads-dir-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('downloads-dir-error')).toBeNull();
    // Only the library namespace is loaded here, so the kit's retry shows its key.
    const retries = screen.getAllByRole('button', { name: /^(Try again|retry)$/ });
    expect(retries).toHaveLength(1);
    down = false;
    fireEvent.click(retries[0]!);
    expect(await screen.findByText('E:/Media')).toBeTruthy();
    await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0));
  });

  it('the progress needle is placed with a logical inset for RTL (D6)', () => {
    render(<DialProgress percent={40} tone="accent" label="p" />);
    const needle = document.querySelector<HTMLElement>('.bg-fg');
    expect(needle?.style.insetInlineStart).toBe('calc(40% - 1px)');
    expect(needle?.style.left).toBe('');
  });
});

void i18n;
