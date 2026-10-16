import type { Page, Response } from '@playwright/test';

import type { AppInfo, ImageCacheStats, Settings, Source } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { MOCK } from './helpers/env';
import { expect, test } from './helpers/fixtures';

// Run 3 C2/C3: artwork loads through the server's disk image cache.
// - Movie posters on the mock Xtream grid load from /api/img and decode.
// - The first fetch is a miss; a browser with an empty HTTP cache gets hits.
// - Settings > General shows a non-zero cache, and Clear empties it.
// playwright.config.ts starts iptv-server with a fresh --data-dir, so the
// cache starts empty; resetApp clears it as well in case E2E_KEEP_DATA is set.

const NAME = 'Mock Xtream images';

/** Collects every /api/img response the page sees. */
function watchImages(page: Page): Response[] {
  const seen: Response[] = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/img') seen.push(r);
  });
  return seen;
}

/** Opens the movie grid and waits until the visible posters have decoded. */
async function openGridPosters(page: Page, sourceId: string): Promise<void> {
  await page.goto(`/s/${sourceId}/movies`);
  await expect(page.getByTestId('vod-landing-movie')).toBeVisible();
  await page.getByRole('region', { name: 'Categories' }).getByRole('link', { name: /^All movies/ }).click();
  const grid = page.getByTestId('vod-grid-movie');
  await expect(grid).toBeVisible();
  const posters = grid.locator('img[src^="/api/img?"]');
  await expect(posters.first()).toBeVisible();
  await expect
    .poll(() => posters.evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0).length))
    .toBeGreaterThanOrEqual(4);
}

test.describe.serial('image cache', () => {
  let source: Source;

  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    await rpc<ImageCacheStats>(request, 'images.clear');
    const { version } = await rpc<AppInfo>(request, 'app.info');
    // No tour or What's new over the pages under test.
    await rpc<Settings>(request, 'settings.update', { patch: { tourCompleted: true, lastSeenVersion: version } });
    source = await ensureSource(request, 'xtream', NAME);
  });

  test('grid posters load through /api/img, then come from disk', async ({ page, browser }) => {
    const first = watchImages(page);
    await openGridPosters(page, source.id);

    // Every poster on the grid points at the cache route with the provider URL and source.
    const srcs = await page.getByTestId('vod-grid-movie').locator('img[src^="/api/img?"]').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src')!));
    for (const src of srcs.slice(0, 4)) {
      const q = new URL(src, 'http://app.test').searchParams;
      expect(q.get('url')).toMatch(new RegExp(`^${MOCK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/img/poster/`));
      expect(q.get('sourceId')).toBe(source.id);
    }
    const firstLoads = first.filter((r) => r.status() === 200);
    expect(firstLoads.length).toBeGreaterThan(0);
    expect(firstLoads.map((r) => r.headers()['x-image-cache'])).toContain('miss');
    expect(firstLoads[0]!.headers()['content-type']).toMatch(/^image\//);

    // A second browser (empty HTTP cache) asks the server again: the server answers from disk.
    const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const again = await other.newPage();
      const second = watchImages(again);
      await openGridPosters(again, source.id);
      const secondLoads = second.filter((r) => r.status() === 200);
      expect(secondLoads.length).toBeGreaterThan(0);
      expect(secondLoads.every((r) => r.headers()['x-image-cache'] === 'hit')).toBe(true);
    } finally {
      await other.close();
    }
  });

  test('the cache route refuses what is not artwork', async ({ request }) => {
    const missing = await request.get(`/api/img?${new URLSearchParams({ url: `${MOCK}/img/no-such-kind/x.svg`, sourceId: source.id })}`);
    expect([404, 502]).toContain(missing.status());
    const bad = await request.get('/api/img?url=ftp%3A%2F%2Fexample.com%2Fp.png');
    expect(bad.status()).toBe(400);
  });

  test('settings show what the cache holds, and Clear empties it', async ({ page, request }) => {
    // This browser now holds the grid's posters in its own HTTP cache (max-age a week).
    await openGridPosters(page, source.id);
    const before = await rpc<ImageCacheStats>(request, 'images.stats');
    expect(before.files).toBeGreaterThan(0);
    expect(before.bytes).toBeGreaterThan(0);

    await page.goto('/settings/general');
    const row = page.getByTestId('image-cache-row');
    await row.scrollIntoViewIfNeeded();
    await expect(row.getByRole('meter', { name: 'Image cache' })).toBeVisible();
    const size = row.getByTestId('image-cache-size');
    await expect(size).toHaveAttribute('data-bytes', String(before.bytes));
    await expect(size).not.toHaveText(/^0 MB of/);
    await expect(row.getByTestId('image-cache-files')).toHaveText(new RegExp(`^${before.files.toLocaleString('en-US')} pictures?$`));
    await expect(row.getByLabel('Limit')).toHaveValue('500');

    await row.getByTestId('image-cache-clear').click();
    const dialog = page.getByTestId('image-cache-clear-dialog');
    await expect(dialog.getByRole('heading', { name: 'Clear the image cache?' })).toBeVisible();
    await dialog.getByTestId('image-cache-clear-confirm').click();
    await expect(dialog).toBeHidden();
    // The visible toast; the sr-only live region repeats its text.
    await expect(page.locator('[data-toast-id]').filter({ hasText: 'Image cache cleared' })).toBeVisible();
    await expect(size).toHaveAttribute('data-bytes', '0');
    await expect(size).toHaveText(/^0 MB of 500 MB$/);
    await expect(row.getByTestId('image-cache-files')).toHaveText('Empty. Pictures are saved as you browse.');
    // Unavailable, but it keeps the focus the dialog handed back (a disabled button would drop it to <body>).
    const clear = row.getByTestId('image-cache-clear');
    await expect(clear).toHaveAttribute('aria-disabled', 'true');
    await expect(clear).toBeFocused();

    const after = await rpc<ImageCacheStats>(request, 'images.stats');
    expect(after).toMatchObject({ bytes: 0, files: 0 });

    // The browser's own copies are not reused: the grid asks the emptied cache again under new URLs, and it refills.
    const refill = watchImages(page);
    await openGridPosters(page, source.id);
    const srcs = await page.getByTestId('vod-grid-movie').locator('img[src^="/api/img?"]').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src')!));
    for (const src of srcs.slice(0, 4)) expect(new URL(src, 'http://app.test').searchParams.get('gen')).toMatch(/^[1-9]\d*$/);
    expect(refill.filter((r) => r.status() === 200).map((r) => r.headers()['x-image-cache'])).toContain('miss');
    await expect.poll(async () => (await rpc<ImageCacheStats>(request, 'images.stats')).files).toBeGreaterThan(0);
  });

  test('a new cap is saved', async ({ page, request }) => {
    await page.goto('/settings/general');
    const row = page.getByTestId('image-cache-row');
    await row.scrollIntoViewIfNeeded();
    await row.getByLabel('Limit').selectOption('1000');
    await expect.poll(async () => (await rpc<Settings>(request, 'settings.get')).imageCacheMaxMb).toBe(1000);
    await expect(row.getByTestId('image-cache-size')).toHaveText(/ of 1 GB$/);
    await rpc<Settings>(request, 'settings.update', { patch: { imageCacheMaxMb: 500 } });
  });
});
