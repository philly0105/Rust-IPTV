/**
 * Live list polish (B3): kept place on return, no skeleton flash while searching, row-shaped
 * loading state, error with retry, empty states, search keyboard path, cursor following the
 * playing channel, and the 10k-channel responsiveness budget (SC7).
 */
import { act, cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category, Channel, Page, PageQuery } from '@/api/types';

import { CategorySidebar } from '../components/CategorySidebar';
import { resetChannelListMemory } from '../components/ChannelList';
import { scaleRowPx, setUiScaleState } from '@/ui/scale';

import { CHANNEL_ROW_HEIGHT, CHANNEL_ROW_SPACING } from '../components/ChannelRow';
import { EpgGridPage } from '../components/EpgGridPage';
import { EpgRibbon } from '../components/EpgRibbon';
import { LivePage } from '../components/LivePage';
import { installDomStubs, makeChannel, renderAt, settings } from './harness';

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

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
}));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

const fakes = await import('./fakes');

const ROUTE = [{ path: '/s/:sourceId/live', element: <LivePage /> }];

/** Serves `all` like the core does: case-insensitive name search, offset paging. */
function serve(all: Channel[]) {
  return (a: unknown) => {
    const q = (a as { query: PageQuery }).query;
    const needle = q.search?.toLowerCase();
    const hits = needle ? all.filter((c) => c.name.toLowerCase().includes(needle)) : all;
    return { items: hits.slice(q.offset, q.offset + q.limit), total: hits.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
}

function baseHandlers(total = 500) {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => ({ id: 'src1', kind: 'xtream', name: 'Demo portal', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['settings.get'] = () => settings();
  h['settings.update'] = () => settings();
  h['catalog.categories'] = () => [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: total, position: 0 }];
  h['catalog.channels'] = serve(Array.from({ length: total }, (_, i) => makeChannel(i)));
  h['epg.nowNext'] = () => ({});
  h['epg.programs'] = () => [];
  h['favorites.contains'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
  h['catalog.item'] = (a) => makeChannel(Number((a as { ref: { itemId: string } }).ref.itemId.slice(1)));
}

const list = () => screen.getByTestId('channel-list');
const rowButton = (i: number) => document.querySelector<HTMLButtonElement>(`[data-testid="channel-list"] [data-row-index="${i}"]`);
const cursorIndex = () => Number(document.querySelector('[data-testid="channel-list"] [data-row-index][tabindex="0"]')?.getAttribute('data-row-index'));
const searchBox = () => screen.getByRole('searchbox', { name: 'Search channels' }) as HTMLInputElement;

/** jsdom has no scrolling: give the list a scrollTop that sticks, then tell the virtualizer. */
function scrollListTo(top: number) {
  const el = list();
  Object.defineProperty(el, 'scrollTop', { configurable: true, value: top, writable: true });
  fireEvent.scroll(el);
}

beforeAll(() => {
  installDomStubs();
  // Builders share the machine; findBy/waitFor get room beyond the 1 s default.
  configure({ asyncUtilTimeout: 4000 });
  vi.setConfig({ testTimeout: 15_000 });
});
beforeEach(() => {
  baseHandlers();
  resetChannelListMemory();
  fakes.usePlayerStore.setState({ source: undefined, zapContext: undefined });
  fakes.recorded.playItem.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Live list: place kept on return', () => {
  it('restores the keyboard cursor after leaving and coming back', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    rowButton(0)!.focus();
    for (let i = 0; i < 5; i++) fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(cursorIndex()).toBe(5));

    cleanup();
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 5');
    expect(cursorIndex()).toBe(5);
  });

  it('restores the scroll offset so the same rows are on screen at first paint', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    scrollListTo(CHANNEL_ROW_HEIGHT * 200);
    await screen.findByText('Channel 200');

    cleanup();
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 200');
    expect(screen.queryByText('Channel 0')).toBeNull();
  });

  it('Live and Radio on the same source keep separate places', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    rowButton(0)!.focus();
    for (let i = 0; i < 4; i++) fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(cursorIndex()).toBe(4));

    cleanup();
    renderAt('/s/src1/radio', [{ path: '/s/:sourceId/radio', element: <LivePage mode="radio" /> }]);
    await screen.findByText('Channel 0');
    expect(cursorIndex()).toBe(0);
    rowButton(0)!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(cursorIndex()).toBe(1));

    cleanup();
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 4');
    expect(cursorIndex()).toBe(4);
  });

  it('a remembered cursor past the end of a shrunken list is clamped to the last row', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    rowButton(0)!.focus();
    for (let i = 0; i < 9; i++) fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(cursorIndex()).toBe(9));

    cleanup();
    rpcMock.handlers['catalog.channels'] = serve(Array.from({ length: 3 }, (_, i) => makeChannel(i)));
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 2');
    await waitFor(() => expect(cursorIndex()).toBe(2));
    rowButton(2)!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await waitFor(() => expect(fakes.recorded.playItem).toHaveLength(1));
    expect(fakes.recorded.playItem[0]).toMatchObject({ title: 'Channel 2' });
  });

  it('a different group starts at the top with its own cursor', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    rowButton(0)!.focus();
    for (let i = 0; i < 3; i++) fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(cursorIndex()).toBe(3));

    cleanup();
    renderAt('/s/src1/live/g1', [{ path: '/s/:sourceId/live/:categoryId', element: <LivePage /> }]);
    await screen.findByText('Channel 0');
    expect(cursorIndex()).toBe(0);
  });
});

describe('Live list: states', () => {
  it('loading shows row-shaped skeletons at the real row height', async () => {
    rpcMock.handlers['catalog.channels'] = () => new Promise(() => undefined);
    renderAt('/s/src1/live', ROUTE);
    const loading = await screen.findByTestId('channel-list-loading');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.getAttribute('aria-label')).toBe('Loading channels');
    const rows = [...loading.children] as HTMLElement[];
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) expect(r.style.height).toBe(`${CHANNEL_ROW_HEIGHT}px`);
  });

  it('a failed list shows the error and Retry loads it', async () => {
    let fail = true;
    const ok = serve(Array.from({ length: 20 }, (_, i) => makeChannel(i)));
    rpcMock.handlers['catalog.channels'] = (a) => {
      if (fail) throw new Error('Portal timed out');
      return ok(a);
    };
    renderAt('/s/src1/live', ROUTE);
    expect(await screen.findByText('Portal timed out')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Channel 0')).toBeTruthy();
  });

  it('a source with no channels says so and links to Sources', async () => {
    rpcMock.handlers['catalog.categories'] = () => [];
    rpcMock.handlers['catalog.channels'] = serve([]);
    renderAt('/s/src1/live', ROUTE);
    expect(await screen.findByText('No channels in this source')).toBeTruthy();
    expect(screen.getByRole('link', { name: /sources/i }).getAttribute('href')).toBe('/sources');
  });

  it('a search with no hits offers Clear search, which brings the list back', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    fireEvent.change(searchBox(), { target: { value: 'zzz' } });
    expect(await screen.findByText('No channels match "zzz"', undefined, { timeout: 4000 })).toBeTruthy();
    // The empty state's button (the input's own X is the first one).
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear search' }).at(-1)!);
    await waitFor(() => expect(within(list()).getByText('Channel 0')).toBeTruthy(), { timeout: 4000 });
    expect(searchBox().value).toBe('');
  });

  it('a new search keeps the old rows up (dimmed, busy) instead of flashing a skeleton', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    let release: () => void = () => undefined;
    const ok = rpcMock.handlers['catalog.channels']!;
    rpcMock.handlers['catalog.channels'] = (a) =>
      (a as { query: PageQuery }).query.search ? new Promise((res) => (release = () => res(ok(a)))) : ok(a);

    fireEvent.change(searchBox(), { target: { value: 'Channel 42' } });
    await waitFor(() => expect(list().getAttribute('aria-busy')).toBe('true'));
    expect(screen.queryByTestId('channel-list-loading')).toBeNull();
    expect(within(list()).getByText('Channel 0')).toBeTruthy();

    act(() => release());
    await within(list()).findByText('Channel 42');
    await waitFor(() => expect(list().getAttribute('aria-busy')).toBeNull());
    expect(within(list()).queryByText('Channel 0')).toBeNull();
  });

  it('the groups column shows 36px skeleton rows while loading and Retry on error', async () => {
    const props = {
      hiddenCount: 0,
      activeId: undefined,
      hrefFor: (id?: string) => `/s/src1/live${id ? `/${id}` : ''}`,
      onManage: () => undefined,
      totalLabel: 'All channels',
    };
    renderAt('/', [{ path: '/', element: <CategorySidebar {...props} categories={undefined} isLoading error={null} onRetry={() => undefined} /> }]);
    const loading = screen.getByLabelText('Loading groups');
    for (const r of [...loading.children] as HTMLElement[]) expect(r.style.height).toBe('36px');
    cleanup();

    const onRetry = vi.fn();
    renderAt('/', [{ path: '/', element: <CategorySidebar {...props} categories={undefined} isLoading={false} error={new Error('Bad credentials')} onRetry={onRetry} /> }]);
    expect(screen.getByText('Bad credentials')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('Live list: keyboard', () => {
  it('"/" jumps to search; Escape clears it, a second Escape returns to the list cursor', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    rowButton(0)!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(cursorIndex()).toBe(1));

    fireEvent.keyDown(window, { key: '/', code: 'Slash' });
    expect(document.activeElement).toBe(searchBox());
    fireEvent.change(searchBox(), { target: { value: 'abc' } });
    fireEvent.keyDown(searchBox(), { key: 'Escape' });
    expect(searchBox().value).toBe('');
    expect(document.activeElement).toBe(searchBox());
    fireEvent.keyDown(searchBox(), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(rowButton(1)));
  });

  it('Enter in the search box moves to the first result', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    searchBox().focus();
    fireEvent.keyDown(searchBox(), { key: 'Enter' });
    expect(document.activeElement).toBe(rowButton(0));
  });

  it('Enter plays the row and focus stays on it', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    rowButton(0)!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(rowButton(2)));
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await waitFor(() => expect(fakes.recorded.playItem).toHaveLength(1));
    expect(fakes.recorded.playItem[0]).toMatchObject({ title: 'Channel 2' });
    await waitFor(() => expect(rowButton(2)?.getAttribute('aria-current')).toBe('true'));
    expect(document.activeElement).toBe(rowButton(2));
  });

  it('the cursor follows the playing channel after a zap', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    rowButton(0)!.focus();
    act(() => {
      fakes.usePlayerStore.setState({
        source: { url: '', kind: 'hls', title: 'Channel 7', ref: makeChannel(7).ref, isLive: true, isRadio: false },
      });
    });
    await waitFor(() => expect(cursorIndex()).toBe(7));
    await waitFor(() => expect(document.activeElement).toBe(rowButton(7)));
  });
});

describe('Live list: 10k channels (SC7)', () => {
  // No wall-clock budgets: jsdom on a busy machine is too noisy for them. O(n) work shows up as an
  // unbounded DOM, oversized pages or extra queries, which are asserted instead.
  const N = 10_000;
  const all = Array.from({ length: N }, (_, i) => ({ ...makeChannel(i), name: `${['BBC', 'Sky', 'CNN', 'ESPN'][i % 4]} ${i}` }));

  it('renders, scrolls to the end and searches a 10k list, virtualized', async () => {
    rpcMock.handlers['catalog.channels'] = serve(all);
    rpcMock.handlers['catalog.categories'] = () => [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'All', hidden: false, itemCount: N, position: 0 }];

    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('BBC 0');
    expect(screen.getByText('10,000 channels')).toBeTruthy();
    expect(list().querySelectorAll('[role="listitem"]').length).toBeLessThan(60);
    // First paint asks for the first page only.
    expect(rpcMock.calls.filter((c) => c.cmd === 'catalog.channels').map((c) => (c.args as { query: PageQuery }).query.offset)).toEqual([0]);

    // End: the last row, fetched as one page, not 10k nodes. jsdom cannot scroll, so the
    // browser's scroll to the cursor is replayed by hand.
    rowButton(0)!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    scrollListTo(N * CHANNEL_ROW_HEIGHT - 800);
    await waitFor(() => expect(rowButton(N - 1)?.textContent ?? '').toContain('ESPN 9999'));
    expect(cursorIndex()).toBe(N - 1);
    expect(list().querySelectorAll('[role="listitem"]').length).toBeLessThan(60);
    const offsets = rpcMock.calls.filter((c) => c.cmd === 'catalog.channels').map((c) => (c.args as { query: PageQuery }).query);
    for (const q of offsets) expect(q.limit).toBeLessThanOrEqual(120);
    // Jumping to the end fetched the pages at the two ends, not the 80 in between.
    expect(new Set(offsets.map((q) => q.offset)).size).toBeLessThanOrEqual(4);

    // Typing a burst of characters sends one debounced search, not one per key.
    const before = rpcMock.calls.filter((c) => (c.args as { query?: PageQuery } | undefined)?.query?.search).length;
    for (const v of ['e', 'es', 'esp', 'espn', 'espn 99']) fireEvent.change(searchBox(), { target: { value: v } });
    const expected = all.filter((c) => c.name.toLowerCase().includes('espn 99')).length;
    await screen.findByText(`${expected} channels`, undefined, { timeout: 10_000 });
    expect(list().querySelectorAll('[role="listitem"]').length).toBeLessThan(60);
    const searches = rpcMock.calls.filter((c) => (c.args as { query?: PageQuery } | undefined)?.query?.search).slice(before);
    expect(new Set(searches.map((c) => (c.args as { query: PageQuery }).query.search))).toEqual(new Set(['espn 99']));
    // A new list goes back to the top (the browser fires the scroll event jsdom does not).
    expect(list().scrollTop).toBe(0);
    fireEvent.scroll(list());
    expect(await screen.findByText('ESPN 99')).toBeTruthy();
  });

  it('filters 10k groups in the groups column and renders only a window', async () => {
    const cats: Category[] = Array.from({ length: N }, (_, i) => ({
      id: `g${i}`,
      sourceId: 'src1',
      contentType: 'live',
      name: `Group ${i}`,
      hidden: false,
      itemCount: 1,
      position: i,
    }));
    renderAt('/', [
      {
        path: '/',
        element: (
          <CategorySidebar
            categories={cats}
            hiddenCount={0}
            isLoading={false}
            error={null}
            onRetry={() => undefined}
            hrefFor={(id) => `/s/src1/live${id ? `/${id}` : ''}`}
            onManage={() => undefined}
            totalLabel="All channels"
          />
        ),
      },
    ]);
    expect(screen.getAllByRole('link').length).toBeLessThan(80);
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter groups' }), { target: { value: 'Group 9999' } });
    expect(await screen.findByText('Group 9999')).toBeTruthy();
    // "All channels" + the one match
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
});

describe('Guide ribbon and guide page states', () => {
  const ribbon = (channel?: Channel) => (
    <EpgRibbon channel={channel} sourceKind="xtream" watchingLive={false} onPlayLive={() => undefined} onMapEpg={() => undefined} />
  );

  it('ribbon: no channel asks you to pick one', () => {
    renderAt('/', [{ path: '/', element: ribbon(undefined) }]);
    expect(screen.getByText('Pick a channel to see what is on')).toBeTruthy();
  });

  it('ribbon: loading shows a busy skeleton', async () => {
    rpcMock.handlers['epg.programs'] = () => new Promise(() => undefined);
    renderAt('/', [{ path: '/', element: ribbon(makeChannel(4)) }]);
    expect((await screen.findByLabelText('Loading guide')).getAttribute('aria-busy')).toBe('true');
  });

  it('ribbon: a failed guide shows the error and Retry asks again', async () => {
    let fail = true;
    rpcMock.handlers['epg.programs'] = () => {
      if (fail) throw new Error('Guide timed out');
      return [];
    };
    renderAt('/', [{ path: '/', element: ribbon(makeChannel(4)) }]);
    expect(await screen.findByText('Guide timed out')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No guide data for Channel 4')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Match guide channel' })).toBeTruthy();
  });

  it('holding an arrow key asks the guide only for the channel the cursor settles on', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'epg.programs')).toBe(true));
    rpcMock.calls.length = 0;
    rowButton(0)!.focus();
    for (let i = 0; i < 6; i++) fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'epg.programs')).toBe(true));
    const asked = rpcMock.calls.filter((c) => c.cmd === 'epg.programs').map((c) => (c.args as { ref: { itemId: string } }).ref.itemId);
    expect(new Set(asked)).toEqual(new Set(['c6']));
  });

  it('guide page: no sources links to Sources; a failed channel list offers Retry', async () => {
    rpcMock.handlers['sources.list'] = () => [];
    renderAt('/epg', [{ path: '/epg', element: <EpgGridPage /> }]);
    expect(await screen.findByText('No sources yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: /sources/i }).getAttribute('href')).toBe('/sources');
    cleanup();

    baseHandlers();
    rpcMock.handlers['epg.grid'] = () => ({});
    rpcMock.handlers['catalog.channels'] = () => {
      throw new Error('Playlist not found (404)');
    };
    renderAt('/epg?source=src1', [{ path: '/epg', element: <EpgGridPage /> }]);
    expect(await screen.findByText('Playlist not found (404)', undefined, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('Empty groups and group filter', () => {
  it('an empty group links back to all channels', async () => {
    rpcMock.handlers['catalog.channels'] = serve([]);
    renderAt('/s/src1/live/g1', [{ path: '/s/:sourceId/live/:categoryId', element: <LivePage /> }]);
    const title = await screen.findByText('This group has no channels');
    const link = within(title.parentElement!).getByRole('link', { name: 'All channels' });
    expect(link.getAttribute('href')).toBe('/s/src1/live');
  });

  it('a group filter with no match offers Clear search; Escape clears too', () => {
    const cats: Category[] = [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: 3, position: 0 }];
    renderAt('/', [
      {
        path: '/',
        element: (
          <CategorySidebar
            categories={cats}
            hiddenCount={0}
            isLoading={false}
            error={null}
            onRetry={() => undefined}
            hrefFor={(id) => `/s/src1/live${id ? `/${id}` : ''}`}
            onManage={() => undefined}
            totalLabel="All channels"
          />
        ),
      },
    ]);
    const box = screen.getByRole('textbox', { name: 'Filter groups' }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'sport' } });
    expect(screen.getByText('No groups match "sport"')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByText('News')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'sport' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');
    expect(screen.getByText('News')).toBeTruthy();
  });
});

describe('Live list: density and UI scale', () => {
  afterEach(() => setUiScaleState(1, 'comfortable'));
  const rowSlot = (i: number) => rowButton(i)?.closest<HTMLElement>('[style*="translateY"]');
  const groupSlot = (i: number) => document.querySelector<HTMLElement>(`[data-cat-index="${i}"]`)?.parentElement;

  it('compact density tightens the loading skeleton rows', async () => {
    setUiScaleState(1, 'compact');
    rpcMock.handlers['catalog.channels'] = () => new Promise(() => undefined);
    renderAt('/s/src1/live', ROUTE);
    const loading = await screen.findByTestId('channel-list-loading');
    const compact = scaleRowPx(CHANNEL_ROW_HEIGHT, CHANNEL_ROW_SPACING, 1, 'compact');
    expect(compact).toBeLessThan(CHANNEL_ROW_HEIGHT);
    for (const r of [...loading.children] as HTMLElement[]) expect(r.style.height).toBe(`${compact}px`);
  });

  it('channel and group rows follow a density or scale change without a remount', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    expect(rowSlot(0)?.style.height).toBe(`${CHANNEL_ROW_HEIGHT}px`);
    await waitFor(() => expect(groupSlot(0)?.style.height).toBe('36px'));

    act(() => setUiScaleState(1, 'compact'));
    await waitFor(() => expect(rowSlot(0)?.style.height).toBe(`${scaleRowPx(CHANNEL_ROW_HEIGHT, CHANNEL_ROW_SPACING, 1, 'compact')}px`));
    expect(Number.parseFloat(groupSlot(0)!.style.height)).toBeLessThan(36);
    // The next row starts where the tightened one ends.
    expect(rowSlot(1)?.style.transform).toBe(`translateY(${scaleRowPx(CHANNEL_ROW_HEIGHT, CHANNEL_ROW_SPACING, 1, 'compact')}px)`);

    act(() => setUiScaleState(1.25, 'comfortable'));
    await waitFor(() => expect(rowSlot(0)?.style.height).toBe(`${scaleRowPx(CHANNEL_ROW_HEIGHT, CHANNEL_ROW_SPACING, 1.25, 'comfortable')}px`));
    expect(groupSlot(0)?.style.height).toBe('45px');
  });
});
