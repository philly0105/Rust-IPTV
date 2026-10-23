// Loop 2 VOD detail: a title opened from a grid (a PUSH) puts focus on Play, or on the title when
// nothing plays (L2-vod-9); Back (POP) and focus the user moved are left alone. The episode list
// holds only the selected season's rows (L2-vod-10). The focus waits for the browser's layout (a
// ResizeObserver callback, P2-RAILS-6); `layOut()` stands in for that layout here.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useRef } from 'react';
import { I18nextProvider } from 'react-i18next';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef, SeriesDetail, VodDetail } from '@/api/types';
import { useToastStore } from '@/ui';

import { useFocusOnOpen } from '../components/detail/useFocusOnOpen';
import { forgetSpots } from '../hooks/useScrollMemory';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { SeriesDetailPage } from '../pages/SeriesDetailPage';
import { fakeResizeObservers, i18n, installDomStubs, makeSource, renderAt, settings } from './harness';

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

const mref: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm7' };
const sref: ItemRef = { sourceId: 'src1', contentType: 'series', itemId: 's1' };
const ep = (id: string, season: number, episode: number) => ({ id, seriesRef: sref, season, episode, title: `Episode ${season}.${episode}` });
const seriesDetail: SeriesDetail = {
  item: { ref: sref, title: 'Severance', categoryId: 'c1' },
  seasons: [
    { number: 1, episodes: [ep('e11', 1, 1), ep('e12', 1, 2)] },
    { number: 2, episodes: [ep('e21', 2, 1), ep('e22', 2, 2), ep('e23', 2, 3)] },
  ],
  cast: [],
  backdrops: [],
  providerDetailsUnavailable: false,
};
const movieDetail: VodDetail = { item: { ref: mref, title: 'Dune: Part Two', categoryId: 'c1' }, cast: [], backdrops: [], providerDetailsUnavailable: false };

let observers: ReturnType<typeof fakeResizeObservers>;
beforeAll(installDomStubs);
beforeEach(() => {
  observers = fakeResizeObservers();
  forgetSpots();
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  const src = makeSource('src1', 'xtream', 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  h['favorites.contains'] = () => [];
  h['downloads.list'] = () => [];
  h['catalog.sameTitle'] = () => [];
  h['positions.get'] = () => null;
  h['positions.forSeries'] = () => [];
  h['xtream.vodDetail'] = () => movieDetail;
  h['xtream.seriesDetail'] = () => seriesDetail;
  h['userstate.setWatched'] = () => null;
  useToastStore.setState({ toasts: [] });
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  observers.restore();
});

/** Waits until `el` has focus, laying the page out on each try (the focus waits for layout). */
const focusLands = (el: Element) =>
  waitFor(() => {
    observers.layOut();
    expect(document.activeElement).toBe(el);
  });

/** A grid stand-in with a link into the detail page: clicking it is a PUSH, as opening a poster is. */
function openFrom(to: string, outside?: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/grid']}>
          {outside && <input aria-label="Outside" />}
          <Routes>
            <Route path="/grid" element={<Link to={to}>open</Link>} />
            <Route path="/s/:sourceId/movie/:itemId" element={<MovieDetailPage />} />
            <Route path="/s/:sourceId/series/:itemId" element={<SeriesDetailPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'open' }));
}

describe('Focus on open (L2-vod-9)', () => {
  it('a movie opened from the grid focuses Play, which names the title', async () => {
    openFrom('/s/src1/movie/m7');
    const play = await screen.findByRole('button', { name: 'Play' });
    await focusLands(play);
    expect(play.getAttribute('aria-describedby')).toBe('vod-detail-title');
    expect(document.getElementById('vod-detail-title')?.textContent).toBe('Dune: Part Two');
  });

  it('a series opened from the grid focuses Play on its first episode', async () => {
    openFrom('/s/src1/series/s1');
    const play = await screen.findByRole('button', { name: 'Play S01E01' });
    await focusLands(play);
    expect(screen.getByRole('heading', { level: 1, name: 'Severance' }).getAttribute('tabindex')).toBe('-1');
  });

  it('a series with nothing to play focuses its title instead', async () => {
    rpcMock.handlers['xtream.seriesDetail'] = () => ({ ...seriesDetail, seasons: [] });
    openFrom('/s/src1/series/s1');
    const title = await screen.findByRole('heading', { level: 1, name: 'Severance' });
    await focusLands(title);
  });

  it('Back or a cold start (POP) leaves focus alone', async () => {
    renderAt('/s/src1/movie/m7', [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }]);
    await screen.findByRole('button', { name: 'Play' });
    await new Promise((r) => setTimeout(r, 20));
    act(() => observers.layOut());
    expect(document.activeElement).toBe(document.body);
  });

  it('does not take focus the user already moved elsewhere', async () => {
    openFrom('/s/src1/movie/m7', true);
    const outside = screen.getByRole('textbox', { name: 'Outside' });
    outside.focus();
    await screen.findByRole('button', { name: 'Play' });
    await new Promise((r) => setTimeout(r, 20));
    act(() => observers.layOut());
    expect(document.activeElement).toBe(outside);
  });

  it('focuses once per visit: a later render does not pull focus back', async () => {
    openFrom('/s/src1/series/s1');
    const play = await screen.findByRole('button', { name: 'Play S01E01' });
    await focusLands(play);
    play.blur();
    fireEvent.click(screen.getByRole('tab', { name: /Season 2/ }));
    await screen.findByRole('button', { name: /Play S02E01/ });
    act(() => observers.layOut());
    expect(document.activeElement).not.toBe(play);
  });

  it('focuses once the page is laid out, not in the commit that shows it (P2-RAILS-6)', async () => {
    openFrom('/s/src1/movie/m7');
    const play = await screen.findByRole('button', { name: 'Play' });
    await new Promise((r) => setTimeout(r, 20));
    // focus() in the commit forced the new page's style and layout before the browser's own.
    expect(document.activeElement).toBe(document.body);
    act(() => observers.layOut());
    expect(document.activeElement).toBe(play);
  });

  it('focuses under StrictMode a page that mounts with its content (a cached row)', async () => {
    // StrictMode runs a mount's effects twice: the first run's observer is gone before the layout
    // it waits for, and the second run must not take the visit as handled.
    function Title() {
      const play = useRef<HTMLButtonElement>(null);
      useFocusOnOpen(true, () => play.current);
      return <button ref={play}>Play</button>;
    }
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/grid']}>
          <Routes>
            <Route path="/grid" element={<Link to="/title">open</Link>} />
            <Route path="/title" element={<Title />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('link', { name: 'open' }));
    await focusLands(await screen.findByRole('button', { name: 'Play' }));
  });

  it('the held Enter that opened the page does not press Play by auto-repeat', async () => {
    openFrom('/s/src1/movie/m7');
    const play = await screen.findByRole('button', { name: 'Play' });
    await focusLands(play);
    // Auto-repeat of the key still held is dropped...
    expect(fireEvent.keyDown(play, { key: 'Enter', repeat: true })).toBe(false);
    // ...and once it is released, Enter works as usual.
    fireEvent.keyUp(play, { key: 'Enter' });
    expect(fireEvent.keyDown(play, { key: 'Enter', repeat: true })).toBe(true);
  });
});

describe('Episode list renders one season (L2-vod-10)', () => {
  it('only the selected season has rows in the DOM', async () => {
    renderAt('/s/src1/series/s1', [{ path: '/s/:sourceId/series/:itemId', element: <SeriesDetailPage /> }]);
    await screen.findByRole('button', { name: 'Play S01E01' });
    const rows = () => screen.queryAllByRole('listitem').filter((el) => el.closest('[role=list]')?.getAttribute('aria-label') === 'Episodes');
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByRole('button', { name: /S02E01/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Season 2/ }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByRole('button', { name: /S01E01 Episode/ })).toBeNull();
  });
});
