/**
 * Run 3 check 7: the `imageUrl` rewriting rules (C3) as the VOD pages and the hover prefetch
 * (C4) rely on them, so `pnpm vitest run src/api src/features/vod` covers them. B2's full suite
 * for the module is src/ui/test/images.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { imageCandidates, imageUrl, WEB_IMAGE_ROUTE } from '@/api/images';

const route = (url: string, sourceId?: string) => `${WEB_IMAGE_ROUTE}?${new URLSearchParams(sourceId ? { url, sourceId } : { url })}`;

describe('imageUrl in server (web) mode', () => {
  it('fronts remote http(s) posters and backdrops with /api/img, keeping the source id', () => {
    expect(imageUrl('http://cdn.example/poster.jpg', 'x1')).toBe(route('http://cdn.example/poster.jpg', 'x1'));
    expect(imageUrl('https://image.tmdb.org/t/p/w780/b.jpg')).toBe(route('https://image.tmdb.org/t/p/w780/b.jpg'));
    // A provider URL with its own query string stays one encoded parameter.
    const parsed = new URL(imageUrl('http://cdn.example/p.jpg?token=a&size=b', 'x1')!, 'http://app.test');
    expect(parsed.pathname).toBe('/api/img');
    expect(parsed.searchParams.get('url')).toBe('http://cdn.example/p.jpg?token=a&size=b');
    expect(parsed.searchParams.get('sourceId')).toBe('x1');
  });

  it('leaves missing, local and already-local artwork alone', () => {
    expect(imageUrl(undefined, 'x1')).toBeUndefined();
    expect(imageUrl('  ', 'x1')).toBeUndefined();
    for (const src of ['data:image/png;base64,AA==', 'blob:http://localhost/1', '/api/files/p.jpg', 'poster.jpg', 'https://asset.localhost/p.png', `${window.location.origin}/api/files/p.jpg`]) {
      expect(imageUrl(src, 'x1'), src).toBe(src);
    }
    // A cache URL is not wrapped twice.
    const once = route('http://cdn.example/poster.jpg', 'x1');
    expect(imageUrl(once, 'x1')).toBe(once);
  });

  it('gives the prefetch the URL the poster tries first, then the original and the cache again as fallbacks', () => {
    const poster = 'http://cdn.example/poster.jpg';
    expect(imageCandidates([poster], 'x1')).toEqual([imageUrl(poster, 'x1'), poster, `${imageUrl(poster, 'x1')}&retry=1`]);
  });
});

describe('imageUrl on desktop', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.doUnmock('@tauri-apps/api/core');
    vi.resetModules();
  });

  it('loads originals until app.info names the loopback proxy, then uses its /img route', async () => {
    let answer: (info: unknown) => void = () => undefined;
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => new Promise((resolve) => (answer = resolve))) }));
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.resetModules();
    const images = await import('@/api/images');
    const src = 'http://cdn.example/poster.jpg';
    expect(images.imageUrl(src, 'x1')).toBe(src);

    answer({ proxyBase: 'http://127.0.0.1:41234/t0k/api/proxy' });
    await vi.waitFor(() => expect(images.imageCacheBase()).toBe('http://127.0.0.1:41234/t0k/api/img'));
    expect(images.imageUrl(src, 'x1')).toBe(`http://127.0.0.1:41234/t0k/api/img?${new URLSearchParams({ url: src, sourceId: 'x1' })}`);
    // No /api/img on desktop: the web route is only the server-mode base.
    expect(images.imageUrl(src, 'x1')!.startsWith(WEB_IMAGE_ROUTE)).toBe(false);
  });
});
