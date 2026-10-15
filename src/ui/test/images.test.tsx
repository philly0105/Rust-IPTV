import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { imageAttempts, imageCandidates, imageUrl, isImageCacheUrl, preloadImage, WEB_IMAGE_ROUTE } from '@/api/images';
import { ChannelLogo } from '@/features/live/components/ChannelLogo';
import { Poster } from '@/ui/Poster';
import { useImageChain } from '@/ui/image';

// Run 3 C3: artwork goes through the image cache, and a failed cache route falls back to the original once.

const cache = (url: string, sourceId?: string) =>
  `${WEB_IMAGE_ROUTE}?${new URLSearchParams(sourceId ? { url, sourceId } : { url }).toString()}`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
});
