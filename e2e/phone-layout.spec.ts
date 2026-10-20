import type { Locator, Page } from '@playwright/test';

import type { Settings } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { expect, test } from './helpers/fixtures';
import { expectNoHorizontalScroll, settle } from './helpers/layout';

// Phone width (390x844). The dashboard hero fits the page: its slide column shrinks instead of
// pushing the page sideways (L2-visual-5). Below 640 px the bottom tab bar carries navigation and
// search (CB-PHONE-NAV), so the header keeps only the page title and its actions. In Arabic the
// title and the tab bar stay on screen beside a labelled page action, which gives way first
// (L2-visual-4: on /my-videos the header's own buttons used to sit at x < 0).

// Long enough that the hero's "New in <source>" line must truncate at phone width.
const NAME = 'Phone Xtream with a name far longer than a phone screen is wide';
const PHONE = { width: 390, height: 844 };

/** Labels of the visible buttons and links in `scope` that stick out of the viewport sideways. */
function offScreenControls(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const vw = document.documentElement.clientWidth;
    return [...root.querySelectorAll<HTMLElement>('button, a[href]')]
      // Inactive slides are visibility: hidden and only hold the height.
      .filter((el) => el.checkVisibility({ visibilityProperty: true }))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.left < -1 || r.right > vw + 1))
      .map(({ el, r }) => `${el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName} [${Math.round(r.left)}, ${Math.round(r.right)}]`);
  });
}

async function expectInViewport(page: Page, testId: string, label: string): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${label}: ${testId} is laid out`).not.toBeNull();
  expect(box!.x, `${label}: ${testId} left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${label}: ${testId} right edge`).toBeLessThanOrEqual(PHONE.width);
  expect(box!.y + box!.height, `${label}: ${testId} bottom edge`).toBeLessThanOrEqual(PHONE.height);
}

test.describe.serial('phone layout at 390x844', () => {
  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    await ensureSource(request, 'xtream', NAME);
  });

  test.afterAll(async ({ request }) => {
    await rpc<Settings>(request, 'settings.update', { patch: { language: 'en' } });
  });

  test('the dashboard hero fits the page', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/dashboard');
    const hero = page.getByTestId('dashboard-hero');
    const slide = hero.getByTestId('hero-slide');
    await expect(slide).toBeVisible();
    await settle(page);

    await expectNoHorizontalScroll(page, '/dashboard @ 390px');
    // The hero clips what overflows it, so the page check alone would miss a slide wider than its frame.
    const frame = (await hero.boundingBox())!;
    const box = (await slide.boundingBox())!;
    expect(frame.x).toBeGreaterThanOrEqual(0);
    expect(frame.x + frame.width).toBeLessThanOrEqual(PHONE.width);
    expect(box.x, 'slide left edge').toBeGreaterThanOrEqual(frame.x - 1);
    expect(box.x + box.width, 'slide right edge').toBeLessThanOrEqual(frame.x + frame.width + 1);
    expect(await offScreenControls(hero), 'hero buttons off screen').toEqual([]);
  });

  test('in Arabic the page title and the tab bar stay on screen beside a page action', async ({ page }) => {
    await rpc<Settings>(page.request, 'settings.update', { patch: { language: 'ar' } });
    await page.setViewportSize(PHONE);
    for (const path of ['/my-videos', '/recent', '/downloads']) {
      await page.goto(path);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('page-title')).not.toBeEmpty();
      // The phone header has no palette or theme button: the tab bar and its More sheet stand in.
      const tabs = page.getByTestId('tab-bar');
      await expect(tabs).toBeVisible();
      await expect(page.getByTestId('open-palette')).toHaveCount(0);
      await expect(page.getByTestId('theme-toggle')).toHaveCount(0);
      await settle(page);

      await expectInViewport(page, 'page-title', path);
      await expectInViewport(page, 'tab-bar', path);
      // Every tab, More included, is inside the screen.
      expect(await offScreenControls(tabs), `${path}: tabs off screen`).toEqual([]);
      await expectNoHorizontalScroll(page, `${path} @ 390px (ar)`);
    }
  });
});
