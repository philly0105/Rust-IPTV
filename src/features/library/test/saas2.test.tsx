/**
 * Product redesign, stage 2 (library): Favorites and Recently watched rows say what is on air
 * (EntryRow), Downloads names the source only when the queue mixes sources, Scheduled says the
 * recording padding once and has a labelled Stop, My Videos keeps the queue link in its toolbar
 * with the active count, and an offline title's page is the catalogue's detail hero with its
 * facts and a way back to the title in its source.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Recording } from '@/api/types';

import { DownloadsPage } from '../pages/DownloadsPage';
import { FavoritesPage } from '../pages/FavoritesPage';
import { MyVideoDetailPage } from '../pages/MyVideoDetailPage';
import { MyVideosPage } from '../pages/MyVideosPage';
import { RecentPage } from '../pages/RecentPage';
import { ScheduledPage, commonPadding } from '../pages/ScheduledPage';
import { makeDownload, makeFavorite, makeRecent } from './fixtures';
import { installDomStubs, renderAt } from './harness';

const rpcMock = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./harness')['createRpcMock']> }));

vi.mock('@/api/transport', () => {
  class RpcError extends Error {
    code = 'internal';
    static from(err: unknown) {
      return err instanceof RpcError ? err : Object.assign(new RpcError(err instanceof Error ? err.message : String(err)), {});
    }
  }
  return {
    rpc: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.current!.call(cmd, args),
    isDesktop: true,
    RpcError,
    proxiedUrl: (s: { url: string }) => s.url,
  };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => (await import('./harness')).shellModule);
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const harness = await import('./harness');
rpcMock.current = harness.createRpcMock();
const rpc = rpcMock.current;

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const sources = [
  { id: 'src1', name: 'Northwind', kind: 'xtream' },
  { id: 'src2', name: 'Harbor Lights', kind: 'm3u' },
];

beforeAll(installDomStubs);
beforeEach(() => {
  rpc.reset();
  rpc.handlers['sources.list'] = () => sources;
  rpc.handlers['settings.get'] = () => ({ epgOffsetMinutes: 0, coverSize: 'medium' });
  rpc.handlers['recordings.capabilities'] = () => ({ supported: true, mpv: true });
  rpc.handlers['downloads.dir'] = () => ({ path: '/data/downloads' });
  rpc.handlers['recordings.library'] = () => [];
});
afterEach(cleanup);

describe('Favorites rows say what is on air', () => {
  it('shows the programme on now, with how far it is, for a live favorite; a movie keeps its type line', async () => {
    rpc.handlers['favorites.list'] = () => [makeFavorite('live', 'ch1', 0), makeFavorite('movie', 'm1', 1)];
    rpc.handlers['epg.nowNext'] = () => ({
      'src1|live|ch1': { now: { channelId: 'ch1', title: 'Evening Bulletin', start: minutes(-20), end: minutes(10) } },
    });
    renderAt('/favorites', [{ path: '/favorites', element: <FavoritesPage /> }]);
    const now = await screen.findByTestId('entry-now');
    expect(now.textContent).toContain('Evening Bulletin');
    expect(now.textContent).toMatch(/10 minutes left/);
    // 20 of 30 minutes in, as a percentage (a 0..1 scale would read "1").
    expect(within(now).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('67');
    // Asked once for the page, titles only, and only for the channels.
    const asked = rpc.callsOf('epg.nowNext') as { refs: { itemId: string }[]; withDescription: boolean }[];
    expect(asked.at(-1)!.refs.map((r) => r.itemId)).toEqual(['ch1']);
    expect(asked.at(-1)!.withDescription).toBe(false);
    const movie = screen.getAllByTestId('entry-row').find((r) => r.dataset['contentType'] === 'movie')!;
    expect(within(movie).queryByTestId('entry-now')).toBeNull();
    expect(within(movie).getByText('Movie')).toBeTruthy();
  });

  it('keeps the plain type line when the guide has nothing on now', async () => {
    rpc.handlers['favorites.list'] = () => [makeFavorite('live', 'ch1', 0)];
    rpc.handlers['epg.nowNext'] = () => ({});
    renderAt('/favorites', [{ path: '/favorites', element: <FavoritesPage /> }]);
    await screen.findByTestId('entry-row');
    await waitFor(() => expect(rpc.callsOf('epg.nowNext')).toHaveLength(1));
    expect(screen.queryByTestId('entry-now')).toBeNull();
  });

  it('floats the row actions over the row end on a fine pointer, the grip last, and gives touch one menu with all of them', async () => {
    rpc.handlers['favorites.list'] = () => [makeFavorite('live', 'ch1', 0), makeFavorite('live', 'ch2', 1)];
    rpc.handlers['epg.nowNext'] = () => ({});
    renderAt('/favorites', [{ path: '/favorites', element: <FavoritesPage /> }]);
    const row = (await screen.findAllByTestId('entry-row'))[0]!;
    // The artwork leads the row, on the headings' line.
    expect(row.firstElementChild?.getAttribute('data-testid')).toBe('entry-artwork');
    // Hover strip: out of the layout (absolute, so the time keeps the row's end), shown on hover or
    // keyboard focus, and only on a fine pointer; the drag handle comes last in it.
    const strip = within(row).getByTestId('entry-actions');
    expect(strip.className).toContain('absolute');
    expect(strip.className).toContain('group-hover:opacity-100');
    expect(strip.className).toContain('in-focus-visible:opacity-100');
    expect(strip.className).toContain('not-pointer-coarse:flex');
    expect(strip.querySelector('[data-action="open"]')).toBeTruthy();
    expect(strip.lastElementChild?.getAttribute('draggable')).toBe('true');
    // The time hides while the strip covers it (invisible, so the row keeps its layout), on the
    // strip's own conditions; with the moves and the grip its column holds the whole strip.
    const time = within(row).getByTestId('entry-time');
    expect(time.className).toContain('not-pointer-coarse:group-hover:invisible');
    expect(time.className).toContain('not-pointer-coarse:in-focus-visible:invisible');
    expect(time.className).toContain('not-pointer-coarse:group-has-[[data-testid=entry-actions]:focus-within]:invisible');
    expect(time.className).toMatch(/(^|\s)w-40(\s|$)/);
    // Touch: one menu button, hidden on a fine pointer, holding Play, the moves and remove.
    const trigger = within(row).getByRole('button', { name: /Actions for/ });
    expect(trigger.className).toContain('not-pointer-coarse:hidden');
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    // The red item says what it does in full: the menu is named for the row, so no title in it
    // (a long channel name cut a titled label before "from favorites").
    expect(items).toEqual(['Play', 'Move up', 'Move down', 'Remove from favorites']);
    // The first row cannot move up.
    expect(within(menu).getByRole('menuitem', { name: 'Move up' }).getAttribute('aria-disabled')).toBe('true');
    expect(within(menu).getByRole('menuitem', { name: 'Move down' }).getAttribute('aria-disabled')).toBeNull();
    // The hover strip's remove button keeps the titled name, for a screen reader on the button alone.
    expect(within(strip).getByRole('button', { name: /^Remove .+ from favorites$/ })).toBeTruthy();
  });

  it('gives a Recently watched row a menu whose remove item says "from history", without the title', async () => {
    rpc.handlers['recent.list'] = () => [makeRecent('m1', new Date().toISOString())];
    rpc.handlers['epg.nowNext'] = () => ({});
    renderAt('/recent', [{ path: '/recent', element: <RecentPage /> }]);
    const row = await screen.findByTestId('entry-row');
    // No reorder on this page: the time keeps the usual column.
    expect(within(row).getByTestId('entry-time').className).toMatch(/(^|\s)w-36(\s|$)/);
    fireEvent.click(within(row).getByRole('button', { name: 'Actions for Watched m1' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Open', 'Remove from history']);
    expect(within(row).getByRole('button', { name: 'Remove Watched m1 from history' })).toBeTruthy();
  });

  it('draws a channel with its Live TV logo tile and no movie glyph', async () => {
    rpc.handlers['favorites.list'] = () => [makeFavorite('live', 'ch1', 0), makeFavorite('movie', 'm1', 1)];
    rpc.handlers['epg.nowNext'] = () => ({});
    renderAt('/favorites', [{ path: '/favorites', element: <FavoritesPage /> }]);
    const rows = await screen.findAllByTestId('entry-row');
    const live = rows.find((r) => r.dataset['contentType'] === 'live')!;
    const movie = rows.find((r) => r.dataset['contentType'] === 'movie')!;
    // Live's monogram tile (ChannelLogo), not the poster fallback with its clapperboard.
    expect(within(live).getByTestId('entry-artwork').querySelector('[data-monogram]')).toBeTruthy();
    expect(within(live).getByTestId('entry-artwork').querySelector('[data-poster-fallback]')).toBeNull();
    // Both art boxes take the same 40 px column, so the titles start at one x.
    expect(within(live).getByTestId('entry-artwork').className).toContain('w-10');
    expect(within(movie).getByTestId('entry-artwork').className).toContain('w-10');
  });
});

describe('Favorites and Recently watched name a source only when there is more than one', () => {
  it('leaves the source column out with one source set up, and shows it on each row with two', async () => {
    rpc.handlers['sources.list'] = () => [sources[0]];
    rpc.handlers['favorites.list'] = () => [makeFavorite('live', 'ch1', 0), makeFavorite('movie', 'm1', 1)];
    rpc.handlers['epg.nowNext'] = () => ({});
    renderAt('/favorites', [{ path: '/favorites', element: <FavoritesPage /> }]);
    await screen.findAllByTestId('entry-row');
    await waitFor(() => expect(rpc.callsOf('sources.list').length).toBeGreaterThan(0));
    expect(screen.queryAllByTestId('source-badge')).toHaveLength(0);
    cleanup();

    rpc.handlers['sources.list'] = () => sources;
    renderAt('/favorites', [{ path: '/favorites', element: <FavoritesPage /> }]);
    await waitFor(() => expect(screen.getAllByTestId('source-badge')).toHaveLength(2));
  });

  it('does the same on Recently watched', async () => {
    rpc.handlers['sources.list'] = () => [sources[0]];
    rpc.handlers['recent.list'] = () => [makeRecent('m1', new Date().toISOString()), makeRecent('m2', new Date().toISOString())];
    rpc.handlers['positions.continueWatching'] = () => [];
    rpc.handlers['epg.nowNext'] = () => ({});
    renderAt('/recent', [{ path: '/recent', element: <RecentPage /> }]);
    await screen.findAllByTestId('entry-row');
    await waitFor(() => expect(rpc.callsOf('sources.list').length).toBeGreaterThan(0));
    expect(screen.queryAllByTestId('source-badge')).toHaveLength(0);
    cleanup();

    rpc.handlers['sources.list'] = () => sources;
    renderAt('/recent', [{ path: '/recent', element: <RecentPage /> }]);
    await waitFor(() => expect(screen.getAllByTestId('source-badge')).toHaveLength(2));
  });
});

describe('Downloads names a source only when the queue mixes them', () => {
  it('leaves the source out when every row shares one, and shows it on each row when they differ', async () => {
    rpc.handlers['downloads.list'] = () => [makeDownload({ id: 1, status: 'downloading', totalBytes: 100, bytesDownloaded: 10 }), makeDownload({ id: 2, status: 'queued' })];
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    await screen.findAllByTestId('download-row');
    expect(screen.queryAllByTestId('source-badge')).toHaveLength(0);
    cleanup();

    rpc.handlers['downloads.list'] = () => [
      makeDownload({ id: 1, status: 'downloading', totalBytes: 100, bytesDownloaded: 10 }),
      makeDownload({ id: 2, status: 'queued', ref: { sourceId: 'src2', contentType: 'movie', itemId: 'x' } }),
    ];
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    await screen.findAllByTestId('download-row');
    // The name beside the source's monogram (the monogram's initials are decorative).
    await waitFor(() => expect(screen.getAllByTestId('source-badge').map((b) => b.querySelector('.truncate')?.textContent)).toEqual(['Northwind', 'Harbor Lights']));
  });

  it('draws a paused row neutral, with its glyph, and only the running row in the accent', async () => {
    rpc.handlers['downloads.list'] = () => [
      makeDownload({ id: 1, status: 'downloading', totalBytes: 100, bytesDownloaded: 10 }),
      makeDownload({ id: 2, status: 'paused', totalBytes: 100, bytesDownloaded: 40 }),
    ];
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    const rows = await screen.findAllByTestId('download-row');
    const paused = rows.find((r) => r.dataset['status'] === 'paused')!;
    const badge = paused.querySelector<HTMLElement>('[data-status="paused"]:not([data-testid])')!;
    expect(badge.className).not.toContain('text-warning');
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(within(paused).getByTestId('dial-fill').className).toContain('bg-fg-subtle/50');
    const running = rows.find((r) => r.dataset['status'] === 'downloading')!;
    expect(within(running).getByTestId('dial-fill').className).toContain('bg-accent');
  });

  it('shows the folder as a line of text, not a bordered panel', async () => {
    rpc.handlers['downloads.list'] = () => [makeDownload({ id: 1, status: 'queued' })];
    renderAt('/downloads', [{ path: '/downloads', element: <DownloadsPage /> }]);
    const folder = await screen.findByTestId('downloads-folder');
    expect(await within(folder).findByTestId('downloads-dir')).toBeTruthy();
    expect(folder.className).not.toMatch(/(^|\s)border(\s|$)/);
  });
});

function rec(over: Partial<Recording>): Recording {
  return {
    id: 'r1',
    ref: { sourceId: 's1', contentType: 'live', itemId: '7' },
    channelName: 'Alpha',
    title: 'Film',
    kind: 'programme',
    start: minutes(60),
    end: minutes(120),
    paddingBeforeMinutes: 1,
    paddingAfterMinutes: 5,
    status: 'scheduled',
    fileNames: [],
    bytes: 0,
    ...over,
  };
}

describe('Scheduled says the padding once and stops with a labelled button', () => {
  it('commonPadding picks the padding most programme recordings share', () => {
    const entry = (r: Recording) => ({ type: 'recording' as const, id: r.id, at: Date.parse(r.start), recording: r });
    expect(commonPadding([])).toBeUndefined();
    expect(commonPadding([entry(rec({ paddingBeforeMinutes: 0, paddingAfterMinutes: 0 }))])).toBeUndefined();
    expect(
      commonPadding([entry(rec({ id: 'a' })), entry(rec({ id: 'b' })), entry(rec({ id: 'c', paddingBeforeMinutes: 2, paddingAfterMinutes: 10 }))]),
    ).toEqual({ before: 1, after: 5 });
  });

  it('puts the shared padding beside the Upcoming heading; a row that differs keeps its own note', async () => {
    rpc.handlers['reminders.list'] = () => [];
    rpc.handlers['recordings.rules'] = () => [];
    rpc.handlers['recordings.list'] = () => [
      rec({ id: 'a', title: 'First' }),
      rec({ id: 'b', title: 'Second', start: minutes(130), end: minutes(160) }),
      rec({ id: 'c', title: 'Third', start: minutes(170), end: minutes(200), paddingBeforeMinutes: 2, paddingAfterMinutes: 10 }),
    ];
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    const hint = await screen.findByTestId('scheduled-upcoming-hint');
    expect(hint.textContent).toBe('Recordings start 1 min early and end 5 min late');
    const rows = screen.getAllByTestId('upcoming-row');
    expect(rows.map((r) => r.textContent?.includes('Starts 2 min early, ends 10 min late'))).toEqual([false, false, true]);
    expect(rows.some((r) => r.textContent?.includes('Starts 1 min early'))).toBe(false);
  });

  it('marks the kind once: a record dot or a bell, named for screen readers', async () => {
    rpc.handlers['reminders.list'] = () => [{ id: 'm1', ref: rec({}).ref, channelName: 'Alpha', title: 'News', start: minutes(30), end: minutes(60), status: 'pending' }];
    rpc.handlers['recordings.rules'] = () => [];
    rpc.handlers['recordings.list'] = () => [rec({})];
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    const rows = await screen.findAllByTestId('upcoming-row');
    const reminder = rows.find((r) => r.dataset['kind'] === 'reminder')!;
    expect(within(reminder).getByTestId('upcoming-reminder-mark')).toBeTruthy();
    expect(within(reminder).getByText('Reminder').className).toContain('sr-only');
    const recording = rows.find((r) => r.dataset['kind'] === 'recording')!;
    expect(within(recording).getByTestId('upcoming-record-mark').className).toContain('bg-live');
  });

  it('heads each day with its word and date', async () => {
    rpc.handlers['reminders.list'] = () => [];
    rpc.handlers['recordings.rules'] = () => [];
    rpc.handlers['recordings.list'] = () => [rec({ start: minutes(5), end: minutes(30) })];
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    const group = await screen.findByRole('group', { name: /today|tomorrow/i });
    const heading = group.firstElementChild as HTMLElement;
    expect(heading.firstElementChild!.className).toContain('font-semibold');
    expect(heading.className).toContain('text-body-sm');
    expect(heading.textContent).toMatch(/\d/);
  });

  it('labels Stop on a running recording, beside a REC mark', async () => {
    rpc.handlers['reminders.list'] = () => [];
    rpc.handlers['recordings.rules'] = () => [];
    rpc.handlers['recordings.list'] = () => [rec({ status: 'recording', start: minutes(-10), end: minutes(20), startedAt: minutes(-11), bytes: 1_000_000 })];
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    const stop = await screen.findByTestId('recording-stop');
    expect(stop.textContent).toBe('Stop');
    expect(stop.getAttribute('aria-label')).toBe('Stop recording Film');
    expect(screen.getByTestId('recording-rec').textContent).toBe('Rec');
  });

  it('says once, in a quiet line, why a server without mpv cannot record', async () => {
    rpc.handlers['recordings.capabilities'] = () => ({ supported: false, mpv: false });
    rpc.handlers['reminders.list'] = () => [];
    rpc.handlers['recordings.rules'] = () => [];
    rpc.handlers['recordings.list'] = () => [];
    renderAt('/scheduled', [{ path: '/scheduled', element: <ScheduledPage /> }]);
    const note = await screen.findByRole('note');
    expect(note.dataset['testid']).toBe('scheduled-no-recording');
    expect(note.textContent).toBe('Recording is unavailable because the server has no mpv. Reminders still work.');
    // Not a page-wide card over the empty state.
    expect(note.className).not.toMatch(/\bborder\b|bg-surface/);
  });
});

describe('My Videos toolbar and the offline detail page', () => {
  it('keeps the download queue link beside the tabs, counting what is active', async () => {
    rpc.handlers['myvideos.list'] = () => [makeDownload({ id: 1, status: 'completed', fileAvailable: true, completedAt: '2026-10-14T00:00:00Z' })];
    rpc.handlers['downloads.list'] = () => [makeDownload({ id: 2, status: 'downloading' }), makeDownload({ id: 3, status: 'queued' })];
    renderAt('/my-videos', [{ path: '/my-videos', element: <MyVideosPage /> }]);
    const link = await screen.findByTestId('my-videos-queue');
    expect(link.getAttribute('href')).toBe('/downloads');
    await waitFor(() => expect(within(link).getByTestId('my-videos-queue-count').textContent).toContain('2'));
    // Not in the shell header any more.
    expect(within(screen.getByTestId('fake-header')).queryByRole('link', { name: /download queue/i })).toBeNull();
  });

  it('gives the tabs the whole row on a phone, and fades the edge that hides tabs', async () => {
    rpc.handlers['myvideos.list'] = () => [makeDownload({ id: 1, status: 'completed', fileAvailable: true, completedAt: '2026-10-14T00:00:00Z' })];
    renderAt('/my-videos', [{ path: '/my-videos', element: <MyVideosPage /> }]);
    const strip = await screen.findByTestId('my-videos-tabs');
    // Below sm the strip spans the row, so the queue link wraps under it instead of squeezing it.
    expect(strip.className).toContain('max-sm:w-full');
    expect(strip.parentElement!.className).toContain('flex-wrap');
    expect(screen.getByTestId('my-videos-queue').className).toContain('sm:ms-auto');
    const tablist = within(strip).getByRole('tablist');
    expect(within(tablist).getByRole('tab', { name: /Recordings/ })).toBeTruthy();
    expect(strip.getAttribute('style') ?? '').not.toContain('mask');
    // 376 px of tabs in a 286 px row (a phone): the end that hides Recordings fades.
    Object.defineProperty(tablist, 'clientWidth', { configurable: true, value: 286 });
    Object.defineProperty(tablist, 'scrollWidth', { configurable: true, value: 376 });
    fireEvent.scroll(tablist);
    await waitFor(() => expect(strip.getAttribute('style') ?? '').toMatch(/mask-image: linear-gradient\(to right, #000 0, #000 calc\(100% - 2rem\), transparent 100%\)/));
  });

  it('shows an offline movie in the detail hero, with its facts and the title in its source', async () => {
    rpc.handlers['myvideos.list'] = () => [
      makeDownload({
        id: 7,
        title: 'Heat',
        status: 'completed',
        fileAvailable: true,
        fileName: 'Heat (1995).mkv',
        totalBytes: 2_000_000_000,
        bytesDownloaded: 2_000_000_000,
        completedAt: '2026-10-14T00:00:00Z',
        positionSeconds: 600,
      }),
    ];
    renderAt('/my-videos/7', [{ path: '/my-videos/:id', element: <MyVideoDetailPage /> }]);
    expect((await screen.findByTestId('play-offline')).textContent).toContain('10:00');
    expect(screen.getByRole('heading', { level: 1, name: 'Heat' })).toBeTruthy();
    expect(screen.getByTestId('vod-detail-poster')).toBeTruthy();
    // One Back pattern: the hero's pill, back to the library.
    expect(screen.getByRole('link', { name: 'Back to My Videos' }).getAttribute('href')).toBe('/my-videos');
    const about = screen.getByTestId('vod-about');
    expect(within(about).getByText('Heat (1995).mkv')).toBeTruthy();
    expect(within(about).getByText('Northwind')).toBeTruthy();
    expect(screen.getByTestId('myvideo-catalogue-link').getAttribute('href')).toBe('/s/src1/movie/m7');
    // The header names the library while the hero's own title is on screen.
    fireEvent.scroll(window);
    expect(screen.getByTestId('page-title').textContent).toBeTruthy();
  });
});
