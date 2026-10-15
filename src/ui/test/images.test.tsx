import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { Episode, ItemRef, VodItem } from '@/api/types';
import { EpisodeList } from '@/features/vod/components/detail/EpisodeList';
import { OtherSourcesDialog } from '@/features/vod/components/detail/OtherSourcesDialog';
import { UpNextRail } from '@/features/vod/components/detail/UpNext';

import {
  forgetImageFailures,
  IMAGE_FAILURE_TTL_MS,
  imageAttempts,
  imageCandidates,
  imageFailedRecently,
  imageUrl,
  isImageCacheUrl,
  markImageFailed,
  preloadImage,
  WEB_IMAGE_ROUTE,
} from '@/api/images';
import { ChannelLogo } from '@/features/live/components/ChannelLogo';
import { Poster } from '@/ui/Poster';
import { useImageChain } from '@/ui/image';

// Run 3 C3: artwork goes through the image cache, and a failed cache route falls back to the original once.

const cache = (url: string, sourceId?: string) =>
  `${WEB_IMAGE_ROUTE}?${new URLSearchParams(sourceId ? { url, sourceId } : { url }).toString()}`;

/** A stand-in for `Image` that records what preloadImage made. */
function stubImage() {
  const made: { src: string; fetchPriority?: string; referrerPolicy: string; onerror: (() => void) | null }[] = [];
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      decoding = '';
      referrerPolicy = '';
      fetchPriority?: string;
      onerror: (() => void) | null = null;
      constructor() {
        made.push(this);
      }
      decode() {
        return Promise.resolve();
      }
    },
  );
  return made;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // The failure memo is module state; tests reuse URLs.
  forgetImageFailures();
});

describe('imageUrl (server mode)', () => {
  it('sends remote http(s) artwork through /api/img with the source id', () => {
    expect(imageUrl('http://cdn.example/a b.jpg?x=1&y=2', 's1')).toBe(cache('http://cdn.example/a b.jpg?x=1&y=2', 's1'));
    expect(imageUrl('https://image.tmdb.org/t/p/w342/p.jpg')).toBe(cache('https://image.tmdb.org/t/p/w342/p.jpg'));
    expect(imageUrl('  HTTPS://cdn.example/p.png  ', 's1')).toBe(cache('HTTPS://cdn.example/p.png', 's1'));
    // The query is encoded: the provider URL's own `&` cannot leak into the route's params.
    const route = new URL(imageUrl('http://cdn.example/p.jpg?token=a&b=c', 's1')!, 'http://app.test');
    expect(route.pathname).toBe('/api/img');
    expect(route.searchParams.get('url')).toBe('http://cdn.example/p.jpg?token=a&b=c');
    expect(route.searchParams.get('sourceId')).toBe('s1');
    expect([...route.searchParams.keys()]).toEqual(['url', 'sourceId']);
  });

  it('leaves everything that is not remote artwork alone', () => {
    expect(imageUrl(undefined)).toBeUndefined();
    expect(imageUrl(null)).toBeUndefined();
    expect(imageUrl('   ')).toBeUndefined();
    for (const src of [
      'data:image/png;base64,iVBORw0KGgo=',
      'blob:http://localhost/1234',
      'asset://localhost/C:/art.png',
      '/api/files/poster.jpg',
      'poster.jpg',
      'http://asset.localhost/C%3A/art.png',
      'https://tauri.localhost/logo.png',
      `${window.location.origin}/api/files/poster.jpg`,
      'ftp://files.example/p.jpg',
      'http://',
    ]) {
      expect(imageUrl(src, 's1'), src).toBe(src);
    }
  });

  it('recognises its own cache URLs', () => {
    expect(isImageCacheUrl(imageUrl('http://cdn.example/a.jpg', 's1'))).toBe(true);
    expect(isImageCacheUrl('http://cdn.example/a.jpg')).toBe(false);
    expect(isImageCacheUrl(undefined)).toBe(false);
  });

  it('lists the cache URL then the original for each source, without repeats', () => {
    const provider = 'http://cdn.example/p.jpg';
    const tmdb = 'https://image.tmdb.org/t/p/w342/t.jpg';
    expect(imageAttempts([provider, null, tmdb], 's1')).toEqual([
      { url: cache(provider, 's1'), source: provider },
      { url: provider, source: provider },
      { url: cache(tmdb, 's1'), source: tmdb },
      { url: tmdb, source: tmdb },
    ]);
    // A picture that cannot be cached is tried once; the same source twice is tried once.
    expect(imageCandidates(['data:image/png;base64,AA', 'data:image/png;base64,AA'])).toEqual(['data:image/png;base64,AA']);
    expect(imageCandidates([provider, ` ${provider} `], 's1')).toEqual([cache(provider, 's1'), provider]);
    expect(imageCandidates([undefined, '', null])).toEqual([]);
  });

  it('preloads through the cache at low priority, once per URL', () => {
    const made: { src: string; fetchPriority?: string; referrerPolicy: string }[] = [];
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        decoding = '';
        referrerPolicy = '';
        fetchPriority?: string;
        constructor() {
          made.push(this);
        }
        decode() {
          return Promise.resolve();
        }
      },
    );
    const src = 'http://cdn.example/preload-once.jpg';
    expect(preloadImage(src, 's9')).toBe(cache(src, 's9'));
    expect(preloadImage(src, 's9')).toBe(cache(src, 's9'));
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ src: cache(src, 's9'), fetchPriority: 'low', referrerPolicy: 'no-referrer' });
    expect(preloadImage(undefined)).toBeUndefined();
    expect(made).toHaveLength(1);
  });
});

describe('useImageChain', () => {
  it('moves on one step per error, ignores a late error from a step it left, and restarts for a new picture', () => {
    const a = 'http://cdn.example/a.jpg';
    const b = 'http://cdn.example/b.jpg';
    const { result, rerender } = renderHook(({ src }: { src: string }) => useImageChain([src], 's1'), { initialProps: { src: a } });
    expect(result.current).toMatchObject({ url: cache(a, 's1'), source: a, failed: false });
    const firstOnError = result.current.onError;
    act(() => firstOnError());
    expect(result.current.url).toBe(a);
    act(() => firstOnError());
    expect(result.current.url).toBe(a);
    act(() => result.current.onError());
    expect(result.current).toMatchObject({ url: undefined, failed: true });
    rerender({ src: b });
    expect(result.current).toMatchObject({ url: cache(b, 's1'), failed: false });
  });
});

describe('Poster', () => {
  const provider = 'http://cdn.example/alpha.jpg';
  const tmdb = 'https://image.tmdb.org/t/p/w342/alpha.jpg';
  const img = (c: HTMLElement) => c.querySelector('img');

  it('tries the cache, the original, the stand-in the same way, then shows the initials', () => {
    const { container } = render(<Poster src={provider} fallbackSrc={tmdb} sourceId="s1" alt="Alpha Beta" />);
    const seen: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const el = img(container)!;
      seen.push(el.getAttribute('src'));
      expect(el.dataset.posterState).toBe('loading');
      fireEvent.error(el);
    }
    expect(seen).toEqual([cache(provider, 's1'), provider, cache(tmdb, 's1'), tmdb]);
    expect(img(container)).toBeNull();
    expect(container.textContent).toBe('AB');
  });

  it('shows the picture when the original loads after the cache route failed', () => {
    const { container } = render(<Poster src={provider} sourceId="s1" alt="Alpha" />);
    fireEvent.error(img(container)!);
    const el = img(container)!;
    expect(el.getAttribute('src')).toBe(provider);
    fireEvent.load(el);
    expect(el.dataset.posterState).toBe('loaded');
    expect(container.textContent).toBe('');
  });

  it('reveals with opacity only', () => {
    const { container } = render(<Poster src={provider} alt="Alpha" />);
    const el = img(container)!;
    expect(el.className).toContain('opacity-0');
    fireEvent.load(el);
    expect(el.className).toContain('opacity-100');
    expect(el.className).toContain('motion-safe:transition-opacity');
    expect(el.className).not.toMatch(/blur|scale-|transition-(all|transform|\[)|(^|\s)(motion-safe:)?transition(\s|$)/);
  });

  it('lazy-loads by default and fetches a priority picture first', () => {
    const { container, rerender } = render(<Poster src={provider} alt="Alpha" />);
    expect(img(container)!.getAttribute('loading')).toBe('lazy');
    expect(img(container)!.getAttribute('fetchpriority')).toBeNull();
    rerender(<Poster src={provider} alt="Alpha" priority />);
    expect(img(container)!.getAttribute('loading')).toBe('eager');
    expect(img(container)!.getAttribute('fetchpriority')).toBe('high');
    expect(img(container)!.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('shows the initials at once without a picture', () => {
    const { container } = render(<Poster src={null} alt="" label="The Gamma Ray" />);
    expect(img(container)).toBeNull();
    expect(container.textContent).toBe('GR');
  });
});

describe('ChannelLogo', () => {
  it('tries the cache route, then the original once, then shows letters', () => {
    const logo = 'http://logos.example/bbc-one.png';
    const { container, rerender } = render(<ChannelLogo src={logo} name="BBC One" sourceId="s2" />);
    expect(container.querySelector('img')!.getAttribute('src')).toBe(cache(logo, 's2'));
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')!.getAttribute('src')).toBe(logo);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('BO');
    // A reused row with another channel starts again.
    rerender(<ChannelLogo src="http://logos.example/itv.png" name="ITV" sourceId="s2" />);
    expect(container.querySelector('img')!.getAttribute('src')).toBe(cache('http://logos.example/itv.png', 's2'));
  });
});

describe('detail artwork names its source (the cache guard needs sourceId)', () => {
  const series: ItemRef = { sourceId: 'src-7', contentType: 'series', itemId: 'show' };
  const ep = (n: number): Episode => ({ id: `e${n}`, seriesRef: series, season: 1, episode: n, title: `Ep ${n}`, posterUrl: `http://cdn.example/ep${n}.jpg` });
  const movie = (sourceId: string): VodItem => ({
    ref: { sourceId, contentType: 'movie', itemId: 'm1' },
    title: 'Movie',
    categoryId: 'c1',
    posterUrl: `http://cdn.example/${sourceId}.jpg`,
  });
  const sourceIds = (root: ParentNode) =>
    [...root.querySelectorAll('img')].map((i) => new URL(i.getAttribute('src')!, 'http://app.test').searchParams.get('sourceId'));
  const client = new QueryClient();
  const wrap = (ui: ReactNode) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );

  it('Up next', () => {
    const { container } = render(wrap(<UpNextRail episodes={[ep(1), ep(2)]} positions={new Map()} onPlay={() => {}} />));
    expect(sourceIds(container)).toEqual(['src-7', 'src-7']);
  });

  it('the episode list', async () => {
    // jsdom has no layout: give the virtualizer a box so it renders rows.
    if (typeof ResizeObserver === 'undefined') {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
    }
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });
    try {
      function List({ layoutKey }: { layoutKey: number }) {
        const scrollRef = useRef<HTMLDivElement>(null);
        return (
          <div ref={scrollRef} style={{ overflow: 'auto', height: 800 }}>
            <EpisodeList
              episodes={[ep(1), ep(2)]}
              positions={new Map()}
              downloads={new Map()}
              onPlay={() => {}}
              canDownload={false}
              pendingDownload={null}
              onDownload={() => {}}
              scrollRef={scrollRef}
              layoutKey={layoutKey}
            />
          </div>
        );
      }
      const { container, rerender } = render(wrap(<List layoutKey={0} />));
      // The scroller's ref lands after the list's first layout effects (as on the page, where it re-renders on data).
      rerender(wrap(<List layoutKey={1} />));
      await waitFor(() => expect(sourceIds(container)).toEqual(['src-7', 'src-7']));
    } finally {
      if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height);
      if (width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
    }
  });

  it('other sources: each copy through its own source', () => {
    render(
      wrap(
        <OtherSourcesDialog
          open
          onClose={() => {}}
          current={movie('src-a')}
          currentSourceName="A"
          others={[movie('src-b')]}
          sources={new Map()}
          pin={undefined}
          onPin={() => {}}
          onPlay={() => {}}
        />,
      ),
    );
    expect(sourceIds(screen.getByRole('dialog'))).toEqual(['src-a', 'src-b']);
  });
});

describe('failed pictures are remembered', () => {
  const logo = 'http://logos.example/dead.png';

  it('a remounted logo that failed everywhere shows its letters without asking the cache or the provider again', () => {
    const first = render(<ChannelLogo src={logo} name="Dead Channel" sourceId="s2" />);
    fireEvent.error(first.container.querySelector('img')!);
    fireEvent.error(first.container.querySelector('img')!);
    expect(first.container.querySelector('img')).toBeNull();
    // A virtual row scrolled out and back in.
    first.unmount();
    const again = render(<ChannelLogo src={logo} name="Dead Channel" sourceId="s2" />);
    expect(again.container.querySelector('img')).toBeNull();
    expect(again.container.textContent).toBe('DC');
  });

  it('a remounted picture whose cache route failed starts at the original', () => {
    const src = 'http://cdn.example/cache-refused.jpg';
    const first = render(<Poster src={src} sourceId="s1" alt="Refused" />);
    fireEvent.error(first.container.querySelector('img')!);
    first.unmount();
    const again = render(<Poster src={src} sourceId="s1" alt="Refused" />);
    expect(again.container.querySelector('img')!.getAttribute('src')).toBe(src);
  });

  it('tries again once the memo expires, and after the connection comes back', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    markImageFailed(logo);
    expect(imageFailedRecently(logo)).toBe(true);
    now.mockReturnValue(1_000_000 + IMAGE_FAILURE_TTL_MS - 1);
    expect(imageFailedRecently(logo)).toBe(true);
    now.mockReturnValue(1_000_000 + IMAGE_FAILURE_TTL_MS);
    expect(imageFailedRecently(logo)).toBe(false);
    const { container } = render(<ChannelLogo src={logo} name="Dead Channel" sourceId="s2" />);
    expect(container.querySelector('img')!.getAttribute('src')).toBe(cache(logo, 's2'));
    cleanup();

    markImageFailed(logo);
    expect(imageFailedRecently(logo)).toBe(true);
    window.dispatchEvent(new Event('online'));
    expect(imageFailedRecently(logo)).toBe(false);
  });

  it('a preload that failed makes the visible picture skip that URL', () => {
    const made = stubImage();
    const src = 'http://cdn.example/preload-fails.jpg';
    preloadImage(src, 's1');
    expect(made).toHaveLength(1);
    made[0]!.onerror?.();
    expect(imageFailedRecently(cache(src, 's1'))).toBe(true);
    const { container } = render(<Poster src={src} sourceId="s1" alt="Preloaded" />);
    expect(container.querySelector('img')!.getAttribute('src')).toBe(src);
  });
});

describe('cache generation (Clear)', () => {
  afterEach(() => {
    localStorage.removeItem('tsrust.imageCacheGen');
    vi.resetModules();
  });

  it('adds gen to cache URLs after a clear, persists it, and forgets warmed URLs and failures', async () => {
    localStorage.removeItem('tsrust.imageCacheGen');
    vi.resetModules();
    const images = await import('@/api/images');
    const src = 'http://cdn.example/gen.jpg';
    expect(images.imageCacheGeneration()).toBe(0);
    expect(new URL(images.imageUrl(src, 's1')!, 'http://app.test').searchParams.has('gen')).toBe(false);
    const made = stubImage();
    images.preloadImage(src, 's1');
    images.markImageFailed(src);

    expect(images.bumpImageCacheGeneration()).toBe(1);
    const url = new URL(images.imageUrl(src, 's1')!, 'http://app.test');
    expect([...url.searchParams.entries()]).toEqual([
      ['url', src],
      ['sourceId', 's1'],
      ['gen', '1'],
    ]);
    expect(localStorage.getItem('tsrust.imageCacheGen')).toBe('1');
    expect(images.imageFailedRecently(src)).toBe(false);
    // The new URL is warmed again; the old one is not asked for twice.
    images.preloadImage(src, 's1');
    expect(made.map((m) => new URL(m.src, 'http://app.test').searchParams.get('gen'))).toEqual([null, '1']);
    // Non-cacheable sources never carry it.
    expect(images.imageUrl('data:image/png;base64,AA')).toBe('data:image/png;base64,AA');

    // A new session starts from the stored generation; another tab's clear is picked up.
    vi.resetModules();
    const later = await import('@/api/images');
    expect(later.imageCacheGeneration()).toBe(1);
    localStorage.setItem('tsrust.imageCacheGen', '4');
    window.dispatchEvent(new StorageEvent('storage', { key: 'tsrust.imageCacheGen', newValue: '4' }));
    expect(later.imageCacheGeneration()).toBe(4);
    expect(later.bumpImageCacheGeneration()).toBe(5);
  });
});

describe('imageUrl (desktop)', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.doUnmock('@tauri-apps/api/core');
    vi.resetModules();
  });

  it('keeps original URLs until app.info gives the loopback base, then uses its /img route', async () => {
    let answer: (info: unknown) => void = () => undefined;
    const invoke = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }));
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    const images = await import('@/api/images');
    expect(invoke).toHaveBeenCalledWith('rpc', { cmd: 'app.info', args: null });
    const src = 'http://cdn.example/p.jpg';
    expect(images.imageUrl(src, 's1')).toBe(src);
    expect(images.imageCandidates([src], 's1')).toEqual([src]);

    answer({ proxyBase: 'http://127.0.0.1:41234/tok3n/api/proxy' });
    await vi.waitFor(() => expect(images.imageCacheBase()).toBe('http://127.0.0.1:41234/tok3n/api/img'));
    const url = images.imageUrl(src, 's1')!;
    expect(url).toBe(`http://127.0.0.1:41234/tok3n/api/img?${new URLSearchParams({ url: src, sourceId: 's1' })}`);
    expect(images.isImageCacheUrl(url)).toBe(true);
    // The loopback proxy's own URLs (a proxied stream thumbnail, a cache URL) are not wrapped again.
    expect(images.imageUrl(url, 's1')).toBe(url);
    expect(images.imageUrl('http://127.0.0.1:41234/tok3n/api/proxy?u=x')).toBe('http://127.0.0.1:41234/tok3n/api/proxy?u=x');

    images.setDesktopImageBase(null);
    expect(images.imageUrl(src, 's1')).toBe(src);
    images.setDesktopImageBase('http://127.0.0.1:1/other');
    expect(images.imageCacheBase()).toBeNull();
  });

  const desktopModules = async () => {
    let answer: (info: unknown) => void = () => undefined;
    let fail: (e: unknown) => void = () => undefined;
    const invoke = vi.fn(
      () =>
        new Promise((resolve, reject) => {
          answer = resolve;
          fail = reject;
        }),
    );
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }));
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    const images = await import('@/api/images');
    return { images, answer: (info: unknown) => answer(info), fail: (e: unknown) => fail(e) };
  };

  it('imageBaseReady waits for app.info, and for at most its timeout', async () => {
    const { images, answer } = await desktopModules();
    let ready = false;
    void images.imageBaseReady(60_000).then(() => (ready = true));
    await Promise.resolve();
    expect(ready).toBe(false);
    answer({ proxyBase: 'http://127.0.0.1:41234/tok3n/api/proxy' });
    await vi.waitFor(() => expect(ready).toBe(true));
    expect(images.imageCacheBase()).toBe('http://127.0.0.1:41234/tok3n/api/img');

    const silent = await desktopModules();
    const started = Date.now();
    await silent.images.imageBaseReady(30);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(silent.images.imageCacheBase()).toBeNull();

    const broken = await desktopModules();
    broken.fail(new Error('no proxy'));
    await broken.images.imageBaseReady(60_000);
    expect(broken.images.imageCacheBase()).toBeNull();
  });

  it('a picture on screen keeps its URL when the base arrives (no second fade); the next picture uses the cache', async () => {
    const { images, answer } = await desktopModules();
    const { Poster: DesktopPoster } = await import('@/ui/Poster');
    const src = 'http://cdn.example/early.jpg';
    const { container, rerender } = render(<DesktopPoster src={src} sourceId="s1" alt="Early" />);
    const el = container.querySelector('img')!;
    expect(el.getAttribute('src')).toBe(src);
    fireEvent.load(el);
    answer({ proxyBase: 'http://127.0.0.1:41234/tok3n/api/proxy' });
    await images.imageBaseReady();
    rerender(<DesktopPoster src={src} sourceId="s1" alt="Early" className="w-20" />);
    expect(container.querySelector('img')).toBe(el);
    expect(el.getAttribute('src')).toBe(src);
    expect(el.dataset.posterState).toBe('loaded');
    const next = render(<DesktopPoster src={src} sourceId="s1" alt="Early" />);
    expect(next.container.querySelector('img')!.getAttribute('src')).toBe(
      `http://127.0.0.1:41234/tok3n/api/img?${new URLSearchParams({ url: src, sourceId: 's1' })}`,
    );
  });
});

describe('imageBaseReady (server mode)', () => {
  it('is ready at once', async () => {
    const { imageBaseReady } = await import('@/api/images');
    let ready = false;
    void imageBaseReady().then(() => (ready = true));
    await Promise.resolve();
    expect(ready).toBe(true);
  });
});
