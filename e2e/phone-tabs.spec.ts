import type { Locator, Page } from '@playwright/test';

import type { Source } from '../src/api/types';
import { ensureSource, resetApp } from './helpers/api';
import { expect, test } from './helpers/fixtures';

// The phone tab bar (CB-PHONE-NAV, src/shell/TabBar.tsx) at 390x844: each tab opens its page and
// is the one marked current; with no source yet, Live TV leads to Sources. More opens a sheet with
// the Library, the sources and Settings: a link in it moves on, closes the sheet and puts focus on
// the new page; Escape closes it and gives focus back to More.

const PHONE = { width: 390, height: 844 };
const NAME = 'Phone Tabs Xtream';

function tabBar(page: Page): Locator {
  return page.getByTestId('tab-bar');
}

function tab(page: Page, name: string): Locator {
  return tabBar(page).getByRole('link', { name, exact: true });
}

function moreButton(page: Page): Locator {
  return tabBar(page).getByRole('button', { name: 'More', exact: true });
}

/** `name` is the current tab: its link says so, and no other tab (More included) does. */
async function expectCurrent(page: Page, name: string): Promise<void> {
  await expect(tab(page, name)).toHaveAttribute('aria-current', 'page');
  await expect(tabBar(page).locator('[aria-current]')).toHaveCount(1);
}

test.describe.serial('phone tab bar at 390x844', () => {
  let source: Source;

  test.beforeAll(async ({ request }) => {
    await resetApp(request);
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE);
  });

  test('with no source yet, Live TV leads to Sources', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(tabBar(page)).toBeVisible();
    await expectCurrent(page, 'Home');
    await tab(page, 'Live TV').click();
    await expect(page).toHaveURL(/\/sources$/);
    await expect(page.getByTestId('sources-page')).toBeVisible();
    // Sources lives in the More sheet, so More is the current tab.
    await expect(moreButton(page)).toHaveAttribute('aria-current', 'true');
    await expect(tab(page, 'Live TV')).not.toHaveAttribute('aria-current');
  });

  test('each tab opens its page and is the one marked current', async ({ page, request }) => {
    source = await ensureSource(request, 'xtream', NAME);
    await page.goto('/dashboard');
    await expectCurrent(page, 'Home');
    const stops: [string, RegExp, string][] = [
      ['Live TV', new RegExp(`/s/${source.id}/live$`), 'live-page'],
      ['TV guide', /\/epg(\?|$)/, 'epg-grid'],
      ['Search', /\/search(\?|$)/, 'vod-search'],
      ['Home', /\/dashboard$/, 'dashboard'],
    ];
    for (const [name, url, testId] of stops) {
      await tab(page, name).click();
      await expect(page).toHaveURL(url);
      await expect(page.getByTestId(testId)).toBeVisible();
      await expectCurrent(page, name);
    }
  });

  test('a link in the More sheet moves on, closes the sheet and focuses the page', async ({ page }) => {
    await page.goto('/dashboard');
    const more = moreButton(page);
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    const sheet = page.getByRole('dialog', { name: 'More' });
    await expect(sheet).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    // Library, the source with what it holds, and the pages below them.
    await expect(sheet.getByRole('list', { name: NAME }).getByRole('link', { name: 'Movies', exact: true })).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Manage sources', exact: true })).toBeVisible();

    await sheet.getByRole('link', { name: 'Favorites', exact: true }).click();
    await expect(page).toHaveURL(/\/favorites$/);
    await expect(sheet).toBeHidden();
    await expect(page.locator('#main')).toBeFocused();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toHaveAttribute('aria-current', 'true');
    await expect(tabBar(page).locator('[aria-current]')).toHaveCount(1);
  });

  test('Escape closes the More sheet and gives focus back to More', async ({ page }) => {
    await page.goto('/dashboard');
    const more = moreButton(page);
    await more.click();
    const sheet = page.getByRole('dialog', { name: 'More' });
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(more).toBeFocused();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expectCurrent(page, 'Home');
  });
});
