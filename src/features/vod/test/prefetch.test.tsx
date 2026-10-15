/**
 * Run 3 C4: hover and focus prefetch of VOD detail pages (usePrefetchIntent),
 * the TMDB rail search prefetch, and the keyboard-cursor variant.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef, Source, VodDetail } from '@/api/types';

import {
  PREFETCH_REST_MS,
  prefetchVodDetail,
  resetPrefetchMemory,
  usePrefetchIntent,
  usePrefetchOnRest,
  useSearchPrefetchIntent,
  type PrefetchTarget,
} from '../hooks/prefetch';
import { useMovieDetail } from '../hooks/queries';
import { makeSource } from './harness';

const rpcMock = vi.hoisted(() => {
  const calls: { cmd: string; args: unknown }[] = [];
  const handlers: Record<string, (args: unknown) => unknown> = {};
  return {
    calls,
    handlers,
    call: async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      const h = handlers[cmd];
      if (!h) throw new Error(`unmocked rpc ${cmd}`);
      return h(args);
    },
  };
});
vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
}));

/** Image URLs the prefetch asked to warm: the cache URLs `preloadImage` loads (its own once-per-session memory is skipped). */
const images = vi.hoisted(() => ({ preloaded: [] as string[] }));
vi.mock('@/api/images', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/api/images')>();
  return {
    ...real,
    preloadImage: (src: string | null | undefined, sourceId?: string) => {
      const url = real.imageUrl(src, sourceId);
      if (url) images.preloaded.push(url);
      return url;
    },
  };
});

const chunks = vi.hoisted(() => ({ loaded: [] as string[] }));
vi.mock('../routes', () => ({
  loadMovieDetailPage: async () => {
    chunks.loaded.push('movie');
    return {};
  },
  loadSeriesDetailPage: async () => {
    chunks.loaded.push('series');
    return {};
  },
  loadSearchPage: async () => {
    chunks.loaded.push('search');
    return {};
  },
}));


const movieRef: ItemRef = { sourceId: 'x1', contentType: 'movie', itemId: '42' };
const seriesRef: ItemRef = { sourceId: 'x1', contentType: 'series', itemId: '7' };
const movieTarget: PrefetchTarget = { ref: movieRef, sourceKind: 'xtream', posterUrl: 'http://cdn/p42.jpg' };

function movieDetail(ref: ItemRef, backdrop?: string): VodDetail {
  return {
    item: { ref, title: `Movie ${ref.itemId}`, categoryId: 'c', ...(backdrop ? { backdropUrl: backdrop } : {}) },
    cast: [],
    backdrops: ['http://cdn/provider-backdrop.jpg'],
    providerDetailsUnavailable: false,
  } as unknown as VodDetail;
}

let client: QueryClient;
function wrap(children: ReactNode) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function Card({ target, label = 'card' }: { target: PrefetchTarget | null; label?: string }) {
  const intent = usePrefetchIntent(target);
  return (
    <a href="#d" data-testid={label} {...intent}>
      {label}
    </a>
  );
}

const detailCalls = () => rpcMock.calls.filter((c) => c.cmd.endsWith('Detail') || c.cmd === 'catalog.item');

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  rpcMock.calls.length = 0;
  for (const k of Object.keys(rpcMock.handlers)) delete rpcMock.handlers[k];
  rpcMock.handlers['xtream.vodDetail'] = (args) => movieDetail((args as { ref: ItemRef }).ref);
  rpcMock.handlers['xtream.seriesDetail'] = (args) => ({ ...movieDetail((args as { ref: ItemRef }).ref), seasons: [] });
  chunks.loaded = [];
  images.preloaded.length = 0;
  resetPrefetchMemory();
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('usePrefetchIntent (C4)', () => {
  it('prefetches once after the pointer rests 120 ms', async () => {
    render(wrap(<Card target={movieTarget} />));
    fireEvent.pointerEnter(screen.getByTestId('card'));
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS - 1));
    expect(detailCalls()).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(detailCalls()).toEqual([{ cmd: 'xtream.vodDetail', args: { ref: movieRef } }]);
    expect(chunks.loaded).toEqual(['movie']);
    expect(images.preloaded[0]).toBe(`/api/img?url=${encodeURIComponent('http://cdn/p42.jpg')}&sourceId=x1`);
    // The data lands in the cache under the detail key.
    expect(client.getQueryData(['xtream.vodDetail', { ref: movieRef }])).toBeTruthy();
  });

  it('prefetches nothing when the pointer leaves before 120 ms', async () => {
    render(wrap(<Card target={movieTarget} />));
    const card = screen.getByTestId('card');
    fireEvent.pointerEnter(card);
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS - 20));
    fireEvent.pointerLeave(card);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(detailCalls()).toHaveLength(0);
    expect(chunks.loaded).toEqual([]);
    expect(images.preloaded).toEqual([]);
  });

  it('does not refetch on a second hover, from the same card or another', async () => {
    render(wrap(
      <>
        <Card target={movieTarget} label="a" />
        <Card target={{ ...movieTarget }} label="b" />
      </>,
    ));
    fireEvent.pointerEnter(screen.getByTestId('a'));
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS));
    fireEvent.pointerLeave(screen.getByTestId('a'));
    fireEvent.pointerEnter(screen.getByTestId('a'));
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 3));
    fireEvent.pointerEnter(screen.getByTestId('b'));
    fireEvent.focus(screen.getByTestId('b'));
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 3));
    expect(detailCalls()).toHaveLength(1);
    expect(chunks.loaded).toEqual(['movie']);
  });

  it('prefetches on focus after the same 120 ms rest', async () => {
    render(wrap(<Card target={movieTarget} />));
    act(() => screen.getByTestId('card').focus());
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS - 1));
    expect(detailCalls()).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(detailCalls()).toHaveLength(1);
    expect(client.getQueryData(['xtream.vodDetail', { ref: movieRef }])).toBeTruthy();
  });

  it('warms only the card focus stops on when Tab or a held arrow key passes through a rail (data-perf r1 F3)', async () => {
    const at = (id: string): PrefetchTarget => ({ ref: { ...movieRef, itemId: id }, sourceKind: 'xtream' });
    render(wrap(
      <>
        <Card target={at('1')} label="a" />
        <Card target={at('2')} label="b" />
        <Card target={at('3')} label="c" />
        <button type="button">elsewhere</button>
      </>,
    ));
    for (const id of ['a', 'b', 'c']) {
      act(() => screen.getByTestId(id).focus());
      await act(() => vi.advanceTimersByTimeAsync(40));
    }
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS));
    expect(detailCalls().map((c) => (c.args as { ref: ItemRef }).ref.itemId)).toEqual(['3']);

    // Blur cancels: focus that leaves before the rest ends warms nothing.
    act(() => screen.getByTestId('a').focus());
    await act(() => vi.advanceTimersByTimeAsync(40));
    act(() => screen.getByRole('button', { name: 'elsewhere' }).focus());
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 2));
    expect(detailCalls()).toHaveLength(1);
  });

  it('a focus rest ends quietly when focus moved on and the caller wired no onBlur', async () => {
    function NoBlur({ target }: { target: PrefetchTarget }) {
      const { onFocus } = usePrefetchIntent(target);
      return <a href="#n" data-testid="noblur" onFocus={onFocus}>card</a>;
    }
    render(wrap(
      <>
        <NoBlur target={movieTarget} />
        <button type="button">elsewhere</button>
      </>,
    ));
    act(() => screen.getByTestId('noblur').focus());
    act(() => screen.getByRole('button', { name: 'elsewhere' }).focus());
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 2));
    expect(detailCalls()).toHaveLength(0);
  });

  it('skips with Data Saver on', async () => {
    vi.stubGlobal('navigator', { ...navigator, connection: { saveData: true } });
    render(wrap(<Card target={movieTarget} />));
    fireEvent.pointerEnter(screen.getByTestId('card'));
    fireEvent.focus(screen.getByTestId('card'));
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 2));
    expect(detailCalls()).toHaveLength(0);
  });

  it('skips when the primary pointer is coarse, and for touch pointers', async () => {
    const coarse = vi.fn((query: string) => ({ matches: query === '(pointer: coarse)' }) as MediaQueryList);
    vi.stubGlobal('matchMedia', coarse);
    render(wrap(<Card target={movieTarget} />));
    fireEvent.pointerEnter(screen.getByTestId('card'));
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 2));
    expect(detailCalls()).toHaveLength(0);
    vi.unstubAllGlobals();

    // A touch contact on a fine-pointer device (a touch screen laptop) is not hover intent either.
    const intentOf: { current?: ReturnType<typeof usePrefetchIntent> } = {};
    function Probe() {
      intentOf.current = usePrefetchIntent(movieTarget);
      return null;
    }
    render(wrap(<Probe />));
    act(() => intentOf.current?.onPointerEnter({ pointerType: 'touch' }));
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 2));
    expect(detailCalls()).toHaveLength(0);
  });

  it('does nothing without a target, or for a live ref', async () => {
    render(wrap(
      <>
        <Card target={null} label="none" />
        <Card target={{ ref: { sourceId: 'x1', contentType: 'live', itemId: '1' }, sourceKind: 'xtream' }} label="live" />
      </>,
    ));
    fireEvent.focus(screen.getByTestId('none'));
    fireEvent.focus(screen.getByTestId('live'));
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 2));
    expect(rpcMock.calls).toHaveLength(0);
    expect(chunks.loaded).toEqual([]);
  });

  it('cancels a pending rest when the card unmounts', async () => {
    const view = render(wrap(<Card target={movieTarget} />));
    fireEvent.pointerEnter(screen.getByTestId('card'));
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 2));
    expect(detailCalls()).toHaveLength(0);
  });

  describe('content scrolling under a still pointer (data-perf r1 F2)', () => {
    const move = (x: number, y: number) => act(() => void window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y })));
    const wheel = () => act(() => void window.dispatchEvent(new Event('wheel')));
    const scroll = () => act(() => void window.dispatchEvent(new Event('scroll')));

    it('does not prefetch a card that scrolls under the pointer until the pointer moves', async () => {
      render(wrap(<Card target={movieTarget} />));
      move(10, 10);
      wheel();
      // Chromium's hover update after the scroll: pointerenter, and maybe a move at the same spot.
      fireEvent.pointerEnter(screen.getByTestId('card'));
      move(10, 10);
      await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 3));
      expect(detailCalls()).toHaveLength(0);

      // The user nudges the mouse and rests: now it is intent.
      move(12, 10);
      await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS - 1));
      expect(detailCalls()).toHaveLength(0);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(detailCalls()).toHaveLength(1);
    });

    it('a card the pointer left while still is not started by later movement', async () => {
      render(wrap(<Card target={movieTarget} />));
      scroll();
      const card = screen.getByTestId('card');
      fireEvent.pointerEnter(card);
      fireEvent.pointerLeave(card);
      move(30, 30);
      await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 3));
      expect(detailCalls()).toHaveLength(0);
    });

    it('a wheel or a scroll cancels a pending pointer rest', async () => {
      render(wrap(
        <>
          <Card target={movieTarget} label="a" />
          <Card target={{ ...movieTarget, ref: { ...movieRef, itemId: '43' } }} label="b" />
        </>,
      ));
      move(5, 5);
      fireEvent.pointerEnter(screen.getByTestId('a'));
      await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS - 20));
      wheel();
      await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 3));
      expect(detailCalls()).toHaveLength(0);

      move(6, 5);
      fireEvent.pointerEnter(screen.getByTestId('b'));
      await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS - 20));
      scroll();
      await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 3));
      // Card a is still under the pointer (no pointerleave came), so it waits for movement too.
      expect(detailCalls()).toHaveLength(0);
    });

    it('keeps the keyboard cursor and focus rests through a scroll (the grid scrolls the cursor into view)', async () => {
      function Cursor({ target }: { target: PrefetchTarget }) {
        usePrefetchOnRest(target);
        return null;
      }
      render(wrap(
        <>
          <Cursor target={{ ref: { ...movieRef, itemId: '50' }, sourceKind: 'xtream' }} />
          <Card target={{ ref: { ...movieRef, itemId: '51' }, sourceKind: 'xtream' }} />
        </>,
      ));
      act(() => screen.getByTestId('card').focus());
      await act(() => vi.advanceTimersByTimeAsync(40));
      scroll();
      wheel();
      await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS));
      expect(detailCalls().map((c) => (c.args as { ref: ItemRef }).ref.itemId).sort()).toEqual(['50', '51']);
    });
  });

  it('cancels a pending rest when a recycled card gets a new title', async () => {
    const view = render(wrap(<Card target={movieTarget} />));
    fireEvent.pointerEnter(screen.getByTestId('card'));
    view.rerender(wrap(<Card target={{ ...movieTarget, ref: { ...movieRef, itemId: '43' } }} />));
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 2));
    expect(detailCalls()).toHaveLength(0);
  });
});

describe('prefetchVodDetail (C4)', () => {
  it('fills the cache the detail page reads, so opening it makes no second call', async () => {
    prefetchVodDetail(client, movieTarget);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(detailCalls()).toHaveLength(1);

    const source = makeSource('x1', 'xtream', 'X') as Source;
    let title: string | undefined;
    function Detail() {
      // The page builds its own ref from the URL: a new object with the same fields.
      title = useMovieDetail(source, { sourceId: 'x1', contentType: 'movie', itemId: '42' }).data?.item.title;
      return null;
    }
    render(wrap(<Detail />));
    expect(title).toBe('Movie 42');
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(detailCalls()).toHaveLength(1);
  });

  it('wraps the catalog row for m3u sources, like useMovieDetail', async () => {
    rpcMock.handlers['catalog.item'] = (args) => ({ ref: (args as { ref: ItemRef }).ref, title: 'Row' });
    prefetchVodDetail(client, { ref: { ...movieRef, sourceId: 'm1' }, sourceKind: 'm3u' });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(rpcMock.calls.map((c) => c.cmd)).toEqual(['catalog.item']);
    const data = client.getQueryData<VodDetail>(['catalog.item', { ref: { ...movieRef, sourceId: 'm1' } }]);
    expect(data?.cast).toEqual([]);
    expect(data?.item.title).toBe('Row');
  });

  it('uses the series command and chunk for a series ref', async () => {
    prefetchVodDetail(client, { ref: seriesRef, sourceKind: 'xtream' });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(rpcMock.calls.map((c) => c.cmd)).toEqual(['xtream.seriesDetail']);
    expect(chunks.loaded).toEqual(['series']);
  });

  it('sends only the ref fields, so extra properties do not split the cache', async () => {
    const wide = { ...movieRef, title: 'extra' } as ItemRef;
    prefetchVodDetail(client, { ref: wide, sourceKind: 'xtream' });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(rpcMock.calls[0]?.args).toEqual({ ref: movieRef });
  });

  it('preloads the backdrop the detail page shows first when the target has none', async () => {
    rpcMock.handlers['xtream.vodDetail'] = (args) => movieDetail((args as { ref: ItemRef }).ref, 'http://cdn/item-backdrop.jpg');
    prefetchVodDetail(client, { ref: movieRef, sourceKind: 'xtream' });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(images.preloaded).toEqual([`/api/img?url=${encodeURIComponent('http://cdn/item-backdrop.jpg')}&sourceId=x1`]);

    // No item backdrop: the provider's first.
    rpcMock.handlers['xtream.vodDetail'] = (args) => movieDetail((args as { ref: ItemRef }).ref);
    images.preloaded.length = 0;
    prefetchVodDetail(client, { ref: { ...movieRef, itemId: '9' }, sourceKind: 'xtream' });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(images.preloaded).toEqual([`/api/img?url=${encodeURIComponent('http://cdn/provider-backdrop.jpg')}&sourceId=x1`]);
  });

  it('preloads the target artwork without waiting for the data', () => {
    prefetchVodDetail(client, { ...movieTarget, backdropUrl: 'http://cdn/b.jpg' });
    expect(images.preloaded).toEqual([
      `/api/img?url=${encodeURIComponent('http://cdn/p42.jpg')}&sourceId=x1`,
      `/api/img?url=${encodeURIComponent('http://cdn/b.jpg')}&sourceId=x1`,
    ]);
  });

  it('swallows a failed detail call', async () => {
    rpcMock.handlers['xtream.vodDetail'] = () => {
      throw new Error('portal down');
    };
    prefetchVodDetail(client, movieTarget);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(detailCalls()).toHaveLength(1);
    expect(client.getQueryData(['xtream.vodDetail', { ref: movieRef }])).toBeUndefined();
  });
});

describe('useSearchPrefetchIntent (TMDB rails)', () => {
  function SearchLink({ title, sourceId }: { title: string; sourceId?: string }) {
    const intent = useSearchPrefetchIntent({ title, sourceId });
    return (
      <a href="#s" data-testid="link" {...intent}>
        {title}
      </a>
    );
  }

  it('warms the search chunk and the first catalog.search page SearchPage asks for', async () => {
    rpcMock.handlers['catalog.search'] = () => ({ live: [], movies: [], series: [] });
    render(wrap(<SearchLink title="  The  Matrix " sourceId="x1" />));
    fireEvent.pointerEnter(screen.getByTestId('link'));
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS));
    // SearchPage: normalizeQuery(q), scoped source, searchRequestLimit(SEARCH_LIMIT) = 61.
    expect(rpcMock.calls).toEqual([{ cmd: 'catalog.search', args: { query: 'The Matrix', sourceId: 'x1', limit: 61 } }]);
    expect(chunks.loaded).toEqual(['search']);
    expect(client.getQueryData(['catalog.search', { query: 'The Matrix', sourceId: 'x1', limit: 61 }])).toBeTruthy();

    fireEvent.pointerLeave(screen.getByTestId('link'));
    fireEvent.pointerEnter(screen.getByTestId('link'));
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS * 2));
    expect(rpcMock.calls).toHaveLength(1);
  });

  it('skips titles too short to search', async () => {
    render(wrap(<SearchLink title="X" />));
    fireEvent.focus(screen.getByTestId('link'));
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS));
    expect(rpcMock.calls).toHaveLength(0);
  });
});

describe('usePrefetchOnRest (keyboard cursor)', () => {
  function Cursor({ target }: { target: PrefetchTarget | null }) {
    usePrefetchOnRest(target);
    return null;
  }

  it('prefetches the cell the cursor stays on for 120 ms, not the ones it passes', async () => {
    const at = (id: string): PrefetchTarget => ({ ref: { ...movieRef, itemId: id }, sourceKind: 'xtream' });
    const view = render(wrap(<Cursor target={at('1')} />));
    await act(() => vi.advanceTimersByTimeAsync(50));
    view.rerender(wrap(<Cursor target={at('2')} />));
    await act(() => vi.advanceTimersByTimeAsync(50));
    view.rerender(wrap(<Cursor target={at('3')} />));
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS));
    expect(detailCalls().map((c) => (c.args as { ref: ItemRef }).ref.itemId)).toEqual(['3']);
    view.rerender(wrap(<Cursor target={null} />));
    await act(() => vi.advanceTimersByTimeAsync(PREFETCH_REST_MS));
    expect(detailCalls()).toHaveLength(1);
  });
});
