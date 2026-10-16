/**
 * Campaign loop 2 (live channels): search answers within the budget (L2-live-2), the list jumps
 * to a channel tuned outside its loaded pages (L2-live-3), pages are read ahead of a scroll
 * (L2-live-4), number entry commits as soon as no longer number exists (L2-live-7), a source
 * emptied by parental Hide mode says so (L2-settings-4), focus comes back to the row on Back even
 * from the shell's sidebar (L2-live-14), the ribbon header wraps on a phone (L2-live-15) and the
 * idle stage shrinks to a bar on a phone (L2-visual-13).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, configure, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, Page, PageQuery } from '@/api/types';

import { resetChannelListMemory } from '../components/ChannelList';
import { EpgRibbon } from '../components/EpgRibbon';
import { LivePage, SEARCH_DEBOUNCE_MS } from '../components/LivePage';
import { DIGIT_COMMIT_MS, digitsComplete, useDigitEntry } from '../hooks/useDigitEntry';
import { usePagedChannels } from '../hooks/usePagedChannels';
import { i18n, installDomStubs, makeChannel, renderAt, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const env = { desktop: false };
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, calls, call, env };
});

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  get isDesktop() {
    return rpcMock.env.desktop;
  },
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

function serve(all: Channel[]) {
  return (a: unknown) => {
    const q = (a as { query: PageQuery }).query;
    let list = all;
    if (q.search) list = list.filter((c) => c.name.toLowerCase().includes(q.search!.toLowerCase()));
    if (q.sort === 'number') list = [...list].sort((x, y) => (q.dir === 'desc' ? (y.number ?? 0) - (x.number ?? 0) : (x.number ?? 0) - (y.number ?? 0)));
    return { items: list.slice(q.offset, q.offset + q.limit), total: list.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
}

function baseHandlers(total = 40) {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => ({
    id: 'src1',
    kind: 'xtream',
    name: 'Demo portal',
    channelCount: total,
    movieCount: 0,
    seriesCount: 0,
    epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] },
  });
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

const channelCalls = () =>
  rpcMock.calls.filter((c) => c.cmd === 'catalog.channels').map((c) => (c.args as { query: PageQuery }).query);

beforeAll(() => {
  configure({ asyncUtilTimeout: 3000 });
  installDomStubs();
});
beforeEach(() => {
  rpcMock.env.desktop = false;
  baseHandlers();
  resetChannelListMemory();
  fakes.usePlayerStore.setState({ source: undefined, zapContext: undefined });
  fakes.recorded.playItem.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function hookWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('live search answers within 150 ms of the last key (L2-live-2)', () => {
  it('asks for the typed query after a short pause, well under the budget', async () => {
    expect(SEARCH_DEBOUNCE_MS).toBeLessThanOrEqual(100);
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    rpcMock.calls.length = 0;
    const started = performance.now();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Channel 3' } });
    await waitFor(() => expect(channelCalls().some((q) => q.search === 'Channel 3')).toBe(true));
    const waited = performance.now() - started;
    // The request waits for the pause (jsdom render time varies too much to time the upper bound here).
    expect(waited).toBeGreaterThanOrEqual(SEARCH_DEBOUNCE_MS - 5);
    // The old rows stay up meanwhile: no loading skeleton between keys.
    expect(screen.queryByTestId('channel-list-loading')).toBeNull();
  });
});

describe('number entry commits once no longer number exists (L2-live-7)', () => {
  it('digitsComplete knows the five-digit cap and the highest number', () => {
    expect(digitsComplete('15000', undefined)).toBe(true);
    expect(digitsComplete('1500', undefined)).toBe(false);
    expect(digitsComplete('7', 30)).toBe(true);
    expect(digitsComplete('3', 30)).toBe(false); // 30 exists
    expect(digitsComplete('31', 30)).toBe(true);
  });

  it('commits a fifth digit at once, and a digit past the highest number at once', () => {
    vi.useFakeTimers();
    const commits: number[] = [];
    const { result, rerender } = renderHook(({ max }: { max?: number }) => useDigitEntry((n) => commits.push(n), undefined, max), {
      initialProps: { max: undefined as number | undefined },
    });
    for (const d of '15000') act(() => result.current.push(d));
    expect(commits).toEqual([15000]);
    expect(result.current.buffer).toBe('');

    // A digit right after an early commit belongs to the same typed number (L3-live-9): the next
    // number starts after a pause.
    act(() => void vi.advanceTimersByTime(DIGIT_COMMIT_MS));
    rerender({ max: 30 });
    act(() => result.current.push('7'));
    expect(commits).toEqual([15000, 7]);

    act(() => void vi.advanceTimersByTime(DIGIT_COMMIT_MS));
    act(() => result.current.push('3'));
    expect(commits).toEqual([15000, 7]);
    act(() => void vi.advanceTimersByTime(DIGIT_COMMIT_MS));
    expect(commits).toEqual([15000, 7, 3]);
  });

  it('a highest number that arrives after the first digit commits it then', () => {
    vi.useFakeTimers();
    const commits: number[] = [];
    const { result, rerender } = renderHook(({ max }: { max?: number }) => useDigitEntry((n) => commits.push(n), undefined, max), {
      initialProps: { max: undefined as number | undefined },
    });
    act(() => result.current.push('7'));
    expect(commits).toEqual([]);
    rerender({ max: 30 });
    expect(commits).toEqual([7]);
  });

  it('the Live page asks for the highest number only once digits are typed', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    const top = () => channelCalls().filter((q) => q.sort === 'number' && q.dir === 'desc' && q.limit === 1);
    expect(top()).toHaveLength(0);
    rpcMock.handlers['catalog.channelByNumber'] = (a) => makeChannel((a as { number: number }).number - 1);
    fireEvent.keyDown(window, { key: '7' });
    await waitFor(() => expect(top()).toHaveLength(1));
    // 40 channels: nothing above 7 can start with 7, so 7 tunes without the pause.
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'catalog.channelByNumber')).toBe(true), { timeout: DIGIT_COMMIT_MS - 200 });
  });
});

describe('pages are read ahead of a scroll (L2-live-4)', () => {
  it('reads the next page once the range nears it, and two ahead when moving fast', async () => {
    baseHandlers(2000);
    const { result } = renderHook(() => usePagedChannels({ sourceId: 'src1' }), { wrapper: hookWrapper() });
    await waitFor(() => expect(result.current.total).toBe(2000));
    act(() => result.current.setVisibleRange(0, 20));
    rpcMock.calls.length = 0;
    act(() => result.current.setVisibleRange(2, 22));
    // Far from the next page and slow: nothing extra.
    expect(channelCalls().filter((q) => q.offset === 120)).toHaveLength(0);
    act(() => result.current.setVisibleRange(70, 90));
    await waitFor(() => expect(channelCalls().some((q) => q.offset === 120)).toBe(true));
    // Its now/next and favourite flags come with it.
    await waitFor(() => expect(rpcMock.calls.filter((c) => c.cmd === 'epg.nowNext').length).toBeGreaterThan(0));
    act(() => result.current.setVisibleRange(250, 270));
    await waitFor(() => expect(channelCalls().some((q) => q.offset === 360)).toBe(true));
    expect(channelCalls().some((q) => q.offset === 480)).toBe(true);
  });

  it('rows of a cached page show at once when the range moves onto it', async () => {
    baseHandlers(2000);
    const { result } = renderHook(() => usePagedChannels({ sourceId: 'src1' }), { wrapper: hookWrapper() });
    await waitFor(() => expect(result.current.total).toBe(2000));
    act(() => result.current.setVisibleRange(0, 20));
    act(() => result.current.setVisibleRange(80, 100));
    await waitFor(() => expect(channelCalls().some((q) => q.offset === 120)).toBe(true));
    await waitFor(() => expect(result.current.getChannel(130)?.name).toBe('Channel 130'));
  });
});

describe('a channel tuned outside the loaded pages (L2-live-3)', () => {
  it('locate finds a row by its number, also when numbers are sparse', async () => {
    const all = Array.from({ length: 20000 }, (_, i) => ({ ...makeChannel(i), number: 2 * i + 1 }));
    baseHandlers(20000);
    rpcMock.handlers['catalog.channels'] = serve(all);
    const { result } = renderHook(() => usePagedChannels({ sourceId: 'src1' }), { wrapper: hookWrapper() });
    await waitFor(() => expect(result.current.total).toBe(20000));
    rpcMock.calls.length = 0;
    const target = all[15000]!;
    let index: number | undefined;
    await act(async () => {
      index = await result.current.locate!(target.ref, target.number);
    });
    expect(index).toBe(15000);
    expect(channelCalls().length).toBeLessThanOrEqual(12);
  });

  it("the list reads the playing channel's page when it is not loaded", async () => {
    baseHandlers(20000);
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    rpcMock.calls.length = 0;
    // Channel number 15001 (row 15000), tuned by number entry or a zap from elsewhere.
    act(() =>
      fakes.usePlayerStore.setState({ source: { url: '', kind: 'hls', title: 'Channel 15000', ref: makeChannel(15000).ref, isLive: true, isRadio: false } }),
    );
    await waitFor(() => expect(channelCalls().some((q) => q.offset === 15000 && q.limit === 120)).toBe(true));
  });
});

describe('parental Hide mode emptying a source (L2-settings-4)', () => {
  it('says parental controls hide the channels and offers the PIN, not Sources', async () => {
    rpcMock.handlers['catalog.channels'] = serve([]);
    rpcMock.handlers['parental.status'] = () => ({ enabled: true, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
    rpcMock.handlers['parental.locks'] = () => [];
    renderAt('/s/src1/live', ROUTE);
    expect(await screen.findByText("Parental controls are hiding this source's channels")).toBeTruthy();
    expect(screen.getByTestId('live-parental-unlock').textContent).toContain('Unlock');
    expect(screen.queryByText('Open sources')).toBeNull();
  });

  it('a source that is really empty still points at Sources', async () => {
    rpcMock.handlers['catalog.channels'] = serve([]);
    rpcMock.handlers['sources.get'] = () => ({ id: 'src1', kind: 'xtream', name: 'Demo portal', channelCount: 0, movieCount: 0, seriesCount: 0 });
    rpcMock.handlers['catalog.categories'] = () => [];
    rpcMock.handlers['parental.status'] = () => ({ enabled: true, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
    renderAt('/s/src1/live', ROUTE);
    expect(await screen.findByText('No channels in this source')).toBeTruthy();
  });
});

describe('focus back on the row after Back from the sidebar (L2-live-14)', () => {
  function Shell() {
    const navigate = useNavigate();
    return (
      <>
        <nav>
          <button type="button" data-testid="side-fav" onClick={() => void navigate('/fav')}>
            Favorites
          </button>
          <button type="button" data-testid="side-live" onClick={() => void navigate('/s/src1/live')}>
            Live
          </button>
          <button type="button" data-testid="side-back" onClick={() => void navigate(-1)}>
            Back
          </button>
        </nav>
        <main>
          <Routes>
            <Route path="/s/:sourceId/live" element={<LivePage />} />
            <Route path="/fav" element={<p>Favorites page</p>} />
          </Routes>
        </main>
      </>
    );
  }
  const renderShell = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={['/s/src1/live']}>
            <Shell />
          </MemoryRouter>
        </I18nextProvider>
      </QueryClientProvider>,
    );

  it('Back with focus on a sidebar link returns focus to the row', async () => {
    renderShell();
    await screen.findByText('Channel 0');
    const row0 = document.querySelector<HTMLButtonElement>('[data-row-index="0"]')!;
    row0.focus();
    fireEvent.keyDown(row0, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement?.getAttribute('data-row-index')).toBe('2'));
    const fav = screen.getByTestId('side-fav');
    fav.focus();
    fireEvent.click(fav);
    await screen.findByText('Favorites page');
    const back = screen.getByTestId('side-back');
    back.focus();
    fireEvent.click(back);
    await screen.findByText('Channel 0');
    await waitFor(() => expect(document.activeElement?.getAttribute('data-row-index')).toBe('2'));
  });

  it('a sidebar link to Live (not Back) leaves focus on the link', async () => {
    renderShell();
    await screen.findByText('Channel 0');
    const row0 = document.querySelector<HTMLButtonElement>('[data-row-index="0"]')!;
    row0.focus();
    fireEvent.keyDown(row0, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement?.getAttribute('data-row-index')).toBe('1'));
    fireEvent.click(screen.getByTestId('side-fav'));
    await screen.findByText('Favorites page');
    const live = screen.getByTestId('side-live');
    live.focus();
    fireEvent.click(live);
    await screen.findByText('Channel 0');
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).toBe(live);
  });
});

describe('phone layout (L2-live-15, L2-visual-13)', () => {
  it('the ribbon header wraps its buttons under the programme below 480 px', () => {
    renderAt('/', [
      {
        path: '/',
        element: <EpgRibbon channel={makeChannel(1)} sourceKind="xtream" watchingLive={false} onPlayLive={() => undefined} onMapEpg={() => undefined} />,
      },
    ]);
    const header = screen.getByTestId('ribbon-header');
    expect(header.className).toContain('flex-wrap');
    expect((header.firstElementChild as HTMLElement).className).toContain('max-[480px]:basis-full');
  });

  it('with nothing playing the stage is a slim bar on a phone and the ribbon waits for a channel', async () => {
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 0');
    const stage = screen.getByTestId('live-stage');
    expect(stage.hasAttribute('data-idle')).toBe(true);
    expect(stage.className).toContain('max-md:h-14');
    // 16:9 from md up only (L3-player-4); a phone gets the slim bar.
    expect(stage.className).not.toMatch(/(^|\s)aspect-video(\s|$)/);
    expect(stage.className).toContain('md:aspect-video');
    expect(stage.nextElementSibling?.className).toContain('max-md:hidden');

    act(() =>
      fakes.usePlayerStore.setState({ source: { url: '', kind: 'hls', title: 'Channel 1', ref: makeChannel(1).ref, isLive: true, isRadio: false } }),
    );
    await waitFor(() => expect(screen.getByTestId('live-stage').hasAttribute('data-idle')).toBe(false));
    expect(screen.getByTestId('live-stage').className).toMatch(/(^|\s)aspect-video(\s|$)/);
    expect(screen.getByTestId('live-stage').nextElementSibling?.className).not.toContain('max-md:hidden');
  });
});

describe('Play in MPV from the list (L2-desktop-9)', () => {
  it('hands the stage to the external player instead of leaving "Nothing playing"', async () => {
    rpcMock.env.desktop = true;
    rpcMock.handlers['parental.status'] = () => ({ enabled: false, mode: 'ask', unlocked: false, hasPin: false });
    rpcMock.handlers['parental.check'] = () => ({ allowed: true });
    rpcMock.handlers['xtream.streamUrl'] = () => ({ url: 'http://mock/live/2.ts', kind: 'mpegts' });
    rpcMock.handlers['player.openExternal'] = () => null;
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 2');
    const row = document.querySelector<HTMLElement>('[data-testid="channel-list"] [data-row-index="2"]')!.parentElement!;
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 });
    fireEvent.click(await screen.findByRole('menuitem', { name: /MPV/ }));
    await waitFor(() => expect(fakes.usePlayerStore.getState().mode).toBe('external'));
    expect(rpcMock.calls.some((c) => c.cmd === 'player.openExternal' && (c.args as { player: string }).player === 'mpv')).toBe(true);
    const state = fakes.usePlayerStore.getState();
    expect(state.source?.url).toBe('http://mock/live/2.ts');
    expect(state.source?.ref?.itemId).toBe('c2');
    expect(state.status).toBe('playing');
    // Through the store, with the player chosen here, so the stage's Reopen uses it too (L3-live-ch-x4).
    expect(fakes.recorded.play.at(-1)?.opts).toEqual({ mode: 'external', externalPlayer: 'mpv', queue: [] });
  });

  it('Play in VLC opens VLC and keeps it as the choice (L3-live-ch-x4)', async () => {
    rpcMock.env.desktop = true;
    rpcMock.handlers['parental.status'] = () => ({ enabled: false, mode: 'ask', unlocked: false, hasPin: false });
    rpcMock.handlers['parental.check'] = () => ({ allowed: true });
    rpcMock.handlers['xtream.streamUrl'] = () => ({ url: 'http://mock/live/3.ts', kind: 'mpegts' });
    rpcMock.handlers['player.openExternal'] = () => null;
    renderAt('/s/src1/live', ROUTE);
    await screen.findByText('Channel 3');
    const row = document.querySelector<HTMLElement>('[data-testid="channel-list"] [data-row-index="3"]')!.parentElement!;
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 });
    fireEvent.click(await screen.findByRole('menuitem', { name: /VLC/ }));
    await waitFor(() => expect(fakes.usePlayerStore.getState().status).toBe('playing'));
    expect(fakes.recorded.play.at(-1)?.opts).toEqual({ mode: 'external', externalPlayer: 'vlc', queue: [] });
    expect(fakes.recorded.play.at(-1)?.source.ref?.itemId).toBe('c3');
    expect(rpcMock.calls.filter((c) => c.cmd === 'player.openExternal').at(-1)?.args).toMatchObject({ player: 'vlc' });
  });
});
