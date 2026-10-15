import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

import type { AppInfo, Settings } from '../src/api/types';
import { ensureSource, removeAllSources, resetApp, rpc } from './helpers/api';
import { expect, test } from './helpers/fixtures';
import { expectNoHorizontalScroll, settle } from './helpers/layout';

// Check 10 (e2e part), with the tour parts of checks 11 and 14: the
// first-run tour and What's new (contract C7) against the real core.
//
// - A fresh data dir with no source stores `lastSeenVersion` silently and
//   shows nothing; once the mock Xtream source exists the 3-step tour opens:
//   Next, Back, the arrow keys and Escape work, focus stays in the card, and
//   `tourCompleted` is true afterwards (Skip and Done store it too).
// - `lastSeenVersion = 0.0.1` and a reload show What's new; Got it stores the
//   running version, and the next reload shows nothing.
// - Under reduced motion the tour has no transitions or animations.
// - axe finds no serious or critical issue on either overlay, and neither
//   scrolls sideways, at 390x844 and 1280x800.
//
// `settings.reset` keeps both markers (C1 amendment), so each test writes
// the markers it needs. The last step puts them back to "seen" so the specs
// that run after this one are not blocked by an overlay.

const NAME = 'Onboarding Xtream';
/** Start delay plus the lazy chunk, with room for a slow CI machine. */
const SHOW = { timeout: 15_000 };

let version = '';

async function markers(request: APIRequestContext): Promise<Pick<Settings, 'tourCompleted' | 'lastSeenVersion'>> {
  const s = await rpc<Settings>(request, 'settings.get');
  return { tourCompleted: s.tourCompleted, lastSeenVersion: s.lastSeenVersion };
}

function setMarkers(request: APIRequestContext, patch: Partial<Pick<Settings, 'tourCompleted' | 'lastSeenVersion'>>): Promise<Settings> {
  return rpc<Settings>(request, 'settings.update', { patch });
}

async function openShell(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('shell')).toBeVisible();
}

function tourCard(page: Page): Locator {
  return page.getByTestId('tour-card');
}

async function expectStep(page: Page, n: 1 | 2 | 3): Promise<void> {
  await expect(page.getByTestId('tour-progress')).toHaveText(`Step ${n} of 3`);
  await expect(page.getByTestId('tour')).toHaveAttribute('data-tour-step', ['live', 'vod', 'search'][n - 1]!);
}

async function seriousViolations(page: Page, include: string): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .include(include)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

test.describe.serial('first-run tour and What\'s new', () => {
  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    version = (await rpc<AppInfo>(request, 'app.info')).version;
    // A fresh data dir: neither marker set.
    await setMarkers(request, { tourCompleted: false, lastSeenVersion: '' });
  });

  test.afterAll(async ({ request }) => {
    await setMarkers(request, { tourCompleted: true, lastSeenVersion: version });
  });

  test('a fresh install with no source stores the version silently and shows nothing', async ({ page, request }) => {
    await openShell(page);
    await expect.poll(async () => (await markers(request)).lastSeenVersion, { timeout: 10_000 }).toBe(version);
    await settle(page, 1500);
    await expect(page.getByTestId('tour')).toHaveCount(0);
    await expect(page.getByTestId('whats-new')).toHaveCount(0);
    expect((await markers(request)).tourCompleted).toBe(false);
  });

  test('the tour opens once a source exists: Next, Back, arrows, focus trap, Escape', async ({ page, request }) => {
    await ensureSource(request, 'xtream', NAME);
    await page.setViewportSize({ width: 1280, height: 800 });
    await openShell(page);

    const card = tourCard(page);
    await expect(card).toBeVisible(SHOW);
    await expect(page.getByTestId('whats-new')).toHaveCount(0);
    await expect(card).toHaveAttribute('aria-modal', 'true');
    await expectStep(page, 1);
    await expect(card.getByRole('heading', { name: 'Live TV' })).toBeVisible();
    await expect(page.getByTestId('tour-next')).toBeFocused();

    // A visible anchor gets the spotlight; without one the card is centred.
    const anchored = (await page.locator('[data-tour="live"]:visible').count()) > 0;
    if (anchored) await expect(page.getByTestId('tour-spotlight')).toBeVisible();
    else await expect(card).toHaveAttribute('data-side', 'center');

    await card.getByRole('button', { name: 'Next' }).click();
    await expectStep(page, 2);
    await expect(card.getByRole('heading', { name: 'Movies and series' })).toBeVisible();
    await card.getByRole('button', { name: 'Back' }).click();
    await expectStep(page, 1);
    await page.keyboard.press('ArrowRight');
    await expectStep(page, 2);
    await page.keyboard.press('ArrowLeft');
    await expectStep(page, 1);

    // Tab and Shift+Tab never leave the card.
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      expect(await card.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    // The app's shortcuts stay quiet: `?` would open the shortcuts overlay.
    await page.keyboard.press('Shift+Slash');
    await expect(page.getByRole('dialog')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('tour')).toHaveCount(0);
    await expect.poll(async () => (await markers(request)).tourCompleted, { timeout: 10_000 }).toBe(true);

    // It does not come back on the next start.
    await page.reload();
    await expect(page.getByTestId('shell')).toBeVisible();
    await settle(page, 1500);
    await expect(page.getByTestId('tour')).toHaveCount(0);
    await expect(page.getByTestId('whats-new')).toHaveCount(0);
  });

  test('Skip tour stores tourCompleted', async ({ page, request }) => {
    await setMarkers(request, { tourCompleted: false, lastSeenVersion: version });
    await openShell(page);
    await expect(tourCard(page)).toBeVisible(SHOW);
    await tourCard(page).getByRole('button', { name: 'Skip tour' }).click();
    await expect(page.getByTestId('tour')).toHaveCount(0);
    await expect.poll(async () => (await markers(request)).tourCompleted, { timeout: 10_000 }).toBe(true);
  });

  test('Done on the last step stores tourCompleted', async ({ page, request }) => {
    await setMarkers(request, { tourCompleted: false, lastSeenVersion: version });
    await openShell(page);
    const card = tourCard(page);
    await expect(card).toBeVisible(SHOW);
    await card.getByRole('button', { name: 'Next' }).click();
    await card.getByRole('button', { name: 'Next' }).click();
    await expectStep(page, 3);
    await expect(card.getByRole('heading', { name: 'Search everything' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Skip tour' })).toHaveCount(0);
    await card.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('tour')).toHaveCount(0);
    await expect.poll(async () => (await markers(request)).tourCompleted, { timeout: 10_000 }).toBe(true);
  });

  test('under reduced motion the tour has no transitions', async ({ page, request }) => {
    await setMarkers(request, { tourCompleted: false, lastSeenVersion: version });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openShell(page);
    await expect(tourCard(page)).toBeVisible(SHOW);
    await tourCard(page).getByRole('button', { name: 'Next' }).click();
    // The global reduced-motion rule leaves 0.01 ms on everything; anything a person could see counts.
    const moving = await page.getByTestId('tour').evaluate((root) =>
      [root, ...root.querySelectorAll<HTMLElement>('*')]
        .map((el) => {
          const s = getComputedStyle(el);
          const seconds = (list: string) => list.split(',').map((d) => (d.trim().endsWith('ms') ? Number.parseFloat(d) / 1000 : Number.parseFloat(d)));
          const visible = (list: string) => seconds(list).some((d) => d > 0.001);
          const transition = visible(s.transitionDuration);
          const animation = s.animationName !== 'none' && visible(s.animationDuration);
          return transition || animation ? `${el.tagName.toLowerCase()}[data-testid=${el.dataset['testid'] ?? ''}]` : '';
        })
        .filter(Boolean),
    );
    expect(moving, 'elements that still move under reduced motion').toEqual([]);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await markers(request)).tourCompleted, { timeout: 10_000 }).toBe(true);
  });

  test("What's new shows after an update and closing it stores the version", async ({ page, request }) => {
    await setMarkers(request, { tourCompleted: true, lastSeenVersion: '0.0.1' });
    await openShell(page);
    const dialog = page.getByTestId('whats-new');
    await expect(dialog).toBeVisible(SHOW);
    await expect(page.getByTestId('tour')).toHaveCount(0);
    await expect(dialog.getByRole('heading', { name: "What's new" })).toBeVisible();
    await expect(dialog).toContainText(`Version ${version}`);
    expect(await dialog.getByTestId('whats-new-item').count()).toBeGreaterThan(0);
    await expect(dialog.getByTestId('whats-new-item').first().locator('svg')).toBeVisible();
    await expect(dialog.getByTestId('whats-new-close')).toBeFocused();

    await dialog.getByTestId('whats-new-close').click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await markers(request)).lastSeenVersion, { timeout: 10_000 }).toBe(version);

    await page.reload();
    await expect(page.getByTestId('shell')).toBeVisible();
    await settle(page, 1500);
    await expect(page.getByTestId('whats-new')).toHaveCount(0);
  });

  test("What's new waits for the tour when both are due", async ({ page, request }) => {
    await setMarkers(request, { tourCompleted: false, lastSeenVersion: '0.0.1' });
    await openShell(page);
    await expect(tourCard(page)).toBeVisible(SHOW);
    await expect(page.getByTestId('whats-new')).toHaveCount(0);
    await page.keyboard.press('Escape');
    const dialog = page.getByTestId('whats-new');
    await expect(dialog).toBeVisible(SHOW);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => markers(request), { timeout: 10_000 }).toEqual({ tourCompleted: true, lastSeenVersion: version });
  });

  for (const vp of [
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]) {
    test(`axe and layout of both overlays at ${vp.width}x${vp.height}`, async ({ page, request }) => {
      await page.setViewportSize(vp);
      await setMarkers(request, { tourCompleted: false, lastSeenVersion: '0.0.1' });
      await openShell(page);
      const failures: string[] = [];

      for (const n of [1, 2, 3] as const) {
        await expect(tourCard(page)).toBeVisible(SHOW);
        await expectStep(page, n);
        await settle(page, 300);
        const box = await tourCard(page).boundingBox();
        expect(box, 'tour card on screen').not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
        expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
        await expectNoHorizontalScroll(page, `tour step ${n} @ ${vp.width}x${vp.height}`);
        for (const v of await seriousViolations(page, '[data-testid="tour"]')) failures.push(`tour step ${n}: ${v}`);
        await tourCard(page).getByTestId('tour-next').click();
      }

      const dialog = page.getByTestId('whats-new');
      await expect(dialog).toBeVisible(SHOW);
      await settle(page, 300);
      await expectNoHorizontalScroll(page, `What's new @ ${vp.width}x${vp.height}`);
      for (const v of await seriousViolations(page, '[data-testid="whats-new"]')) failures.push(`What's new: ${v}`);
      await dialog.getByTestId('whats-new-close').click();
      await expect(dialog).toHaveCount(0);

      expect(failures, 'axe serious/critical violations').toEqual([]);
    });
  }

  test('a data dir whose sources are all gone shows nothing new', async ({ page, request }) => {
    await removeAllSources(request);
    await setMarkers(request, { tourCompleted: true, lastSeenVersion: version });
    await openShell(page);
    await settle(page, 1500);
    await expect(page.getByTestId('tour')).toHaveCount(0);
    await expect(page.getByTestId('whats-new')).toHaveCount(0);
  });
});
