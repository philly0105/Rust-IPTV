import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Settings, Theme } from '../src/api/types';
import { rpc } from './helpers/api';
import { expect, test } from './helpers/fixtures';

// L2-visual-6: public/theme-boot.js applies the saved theme from localStorage before the first
// paint. With every app script held back, a light user's page is already light: data-theme, the
// page background and the browser chrome colour match tokens.css, not index.html's dark default.

const TOKENS = readFileSync(join(import.meta.dirname, '..', 'src', 'styles', 'tokens.css'), 'utf8');

/** `--color-bg` of the light theme in tokens.css, as hex and as a computed `rgb()` value. */
function lightBg(): { hex: string; rgb: string } {
  const at = TOKENS.indexOf(":root[data-theme='light'] {");
  expect(at, 'light theme block in tokens.css').toBeGreaterThanOrEqual(0);
  const hex = /--color-bg:\s*#([0-9a-f]{6})\b/i.exec(TOKENS.slice(at))![1]!.toLowerCase();
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return { hex: `#${hex}`, rgb: `rgb(${r}, ${g}, ${b})` };
}

// A service worker would answer the asset requests itself, past page.route.
test.use({ serviceWorkers: 'block' });

test.describe('theme before first paint', () => {
  let saved: Theme;

  test.beforeAll(async ({ request }) => {
    saved = (await rpc<Settings>(request, 'settings.get')).theme;
    // The server copy agrees, so the app keeps light once it loads.
    await rpc<Settings>(request, 'settings.update', { patch: { theme: 'light' } });
  });

  test.afterAll(async ({ request }) => {
    await rpc<Settings>(request, 'settings.update', { patch: { theme: saved } });
  });

  test('a saved light theme paints light while the app script is held back', async ({ page }) => {
    const bg = lightBg();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const heldUrls: string[] = [];
    // Every script under /assets (the entry module and its preloads); theme-boot.js is at the root.
    await page.route(/\/assets\/[^/?]+\.js(\?|$)/, async (route) => {
      heldUrls.push(route.request().url());
      await held;
      await route.continue().catch(() => undefined);
    });
    await page.addInitScript(() => localStorage.setItem('tsrust.theme', 'light'));

    const loaded = page.goto('/dashboard', { waitUntil: 'commit' });
    try {
      await loaded;
      const html = page.locator('html');
      await expect(html).toHaveAttribute('data-theme', 'light');
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(bg.rgb);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(bg.rgb);
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', bg.hex);
      // Nothing from the app ran yet: the entry module is still held and the root is empty.
      expect(heldUrls.some((u) => /\/assets\/index-[^/]+\.js/.test(u)), 'entry module request held').toBe(true);
      await expect(page.locator('#root')).toBeEmpty();
    } finally {
      release();
    }

    // Once the app loads it keeps the theme.
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});
