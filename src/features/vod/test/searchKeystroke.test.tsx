/**
 * What a key in the search field renders. The field's own render echoes the key; Top results (its
 * rails and channel rows) render again only when the results they show change, and narrowing the
 * results to the longer query follows as a deferred render (L3-vod-5 still holds: the narrowed
 * results show before the new answer).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement, memo } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, Source, VodItem } from '@/api/types';
import { useShellStore } from '@/shell/store';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const call = async (cmd: string, args?: unknown) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, call };
});

vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  return {
    ...actual,
    rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  };
});
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
}));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

/** Renders of Top results' poster rails, counted through a memoized wrapper of the real rail. */
const counts = vi.hoisted(() => ({ rails: 0 }));
vi.mock('../components/PosterRail', async (orig) => {
  const real = await orig<typeof import('../components/PosterRail')>();
  return {
    ...real,
    PosterRail: memo((p: Parameters<typeof real.PosterRail>[0]) => (counts.rails++, createElement(real.PosterRail, p))),
  };
});

const { SearchPage } = await import('../pages/SearchPage');
const { i18n, installDomStubs, makeSource, settings } = await import('./harness');

const movie = (i: number, title: string): VodItem => ({ ref: { sourceId: 'src1', contentType: 'movie', itemId: `m${i}` }, title, categoryId: 'c1' });
const channel = (i: number, name: string): Channel =>
  ({ ref: { sourceId: 'src1', contentType: 'live', itemId: `c${i}` }, name, categoryId: 'g', isRadio: false }) as Channel;
const never = () => new Promise<never>(() => undefined);

let sources: Source[] = [];

beforeAll(installDomStubs);
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  counts.rails = 0;
  sources = [makeSource('src1', 'xtream', 'Alpha IPTV')];
  h['sources.list'] = () => sources;
  h['sources.get'] = () => sources[0];
  h['settings.get'] = () => settings();
  h['stalker.search'] = () => ({ items: [], total: 0, offset: 0, limit: 14 });
  h['epg.search'] = () => [];
  h['positions.continueWatching'] = () => [];
  h['positions.watchedContains'] = () => [];
  h['watchlist.list'] = () => [];
  h['parental.status'] = () => ({ enabled: false });
  h['catalog.search'] = (a) =>
    (a as { query: string }).query === 'black'
      ? {
          live: [channel(0, 'Black TV'), channel(1, 'Black News')],
          movies: [movie(0, 'Black Harbor'), movie(1, 'Black Coast'), movie(2, 'Blackout'), movie(3, 'Black Hills')],
          series: [],
        }
      : never();
});
afterEach(() => cleanup());

function FakeHeader() {
  const search = useShellStore((s) => s.header?.search);
  if (!search) return null;
  return <input aria-label="Header search" value={search.value} onChange={(e) => search.onChange(e.target.value)} />;
}

function renderApp(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <FakeHeader />
          <Routes>
            <Route path="/search" element={<SearchPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const field = () => screen.getByLabelText('Header search');

describe('a key in the search field', () => {
  it('leaves Top results alone while the results it shows stay the same', async () => {
    renderApp('/search?q=black');
    await screen.findByTestId('search-top');
    await screen.findByText('Black Hills');
    const before = counts.rails;
    // A trailing space: the same query, so the results do not change; only the field echoes it.
    fireEvent.change(field(), { target: { value: 'black ' } });
    await waitFor(() => expect((field() as HTMLInputElement).value).toBe('black '));
    expect(counts.rails - before).toBe(0);
  });

  it('narrows the results to the longer query before its answer comes', async () => {
    renderApp('/search?q=black');
    const top = await screen.findByTestId('search-top');
    await within(top).findByText('Black Coast');
    await act(async () => {
      fireEvent.change(field(), { target: { value: 'black h' } });
    });
    // Only movies are left ("Black TV" and "Black News" have no word starting with "h"), so the
    // page shows the movies' own grid in place of Top results.
    await waitFor(() => expect(screen.queryByText('Black Coast')).toBeNull());
    expect(screen.queryByText('Black TV')).toBeNull();
    expect(screen.getByText('Black Harbor')).toBeTruthy();
    expect(screen.getByText('Black Hills')).toBeTruthy();
  });
});
