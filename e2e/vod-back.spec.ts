import type { Locator, Page } from '@playwright/test';

import { ensureSource, resetApp } from './helpers/api';
import { expect, test } from './helpers/fixtures';
import { openAllTitlesGrid } from './helpers/ui';

// VOD grid -> detail -> Back: one Back press returns to the grid (not the
// category landing), with the opened title visible and the keyboard cursor on it.

const NAME = 'Back Xtream';
/** A card past the first row, so "restored" is not the same as "fresh grid". */
const OPEN_INDEX = 7;

let sourceId = '';

async function openGrid(page: Page): Promise<string> {
  await page.goto(`/s/${sourceId}/movies`);
  await expect(page.getByTestId('vod-landing-movie')).toBeVisible();
  await openAllTitlesGrid(page);
  const grid = page.getByTestId('vod-grid-movie');
  await expect(grid.getByRole('listbox').getByRole('option').nth(OPEN_INDEX)).toBeVisible();
  return page.url();
}

/**
 * The poster card inside a grid option. Its `title` attribute is the item's full title; the
 * option's text starts with the rating chip drawn on the artwork, so it cannot name the title.
 */
function posterCard(option: Locator): Locator {
  return option.locator('[data-poster-card]');
}

/** Opens the OPEN_INDEX card; returns its full title. */
async function openCard(page: Page): Promise<string> {
  const option = page.getByTestId('vod-grid-movie').getByRole('listbox').getByRole('option').nth(OPEN_INDEX);
  const title = (await posterCard(option).getAttribute('title')) ?? '';
  expect(title.length).toBeGreaterThan(0);
  await option.click();
  await expect(page.getByTestId('vod-movie-detail').getByRole('heading', { level: 1 })).toBeVisible();
  // No hover tooltip on the detail page: Escape would close it first.
  await page.mouse.move(1, 1);
  return title;
}

async function expectGridRestored(page: Page, gridUrl: string, title: string): Promise<void> {
  await expect(page).toHaveURL(gridUrl);
  const listbox = page.getByTestId('vod-grid-movie').getByRole('listbox');
  // The grid mounts again, so the option ids (useId) are new: compare the cards, not the ids.
  const opened = listbox.getByRole('option').filter({ has: page.locator(`[data-poster-card][title="${cssString(title)}"]`) });
  await expect(opened).toHaveCount(1);
  await expect(opened).toBeInViewport();
  await expect(opened).toHaveAttribute('aria-posinset', String(OPEN_INDEX + 1));
  await expect(listbox).toBeFocused();
  // The keyboard cursor (aria-activedescendant) is on the title that was opened.
  const activeId = await listbox.getAttribute('aria-activedescendant');
  expect(activeId, 'grid has an active cell after Back').toBeTruthy();
  await expect(opened).toHaveAttribute('id', activeId!);
}

/** `s` as the inside of a double-quoted CSS attribute value. */
function cssString(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

test.describe('VOD back navigation', () => {
  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    sourceId = (await ensureSource(request, 'xtream', NAME)).id;
  });

  test('Escape on a movie detail returns to the grid on the opened title', async ({ page }) => {
    const gridUrl = await openGrid(page);
    const title = await openCard(page);
    await page.keyboard.press('Escape');
    await expectGridRestored(page, gridUrl, title);
  });

  test('browser Back on a movie detail returns to the grid on the opened title', async ({ page }) => {
    const gridUrl = await openGrid(page);
    const title = await openCard(page);
    await page.goBack();
    await expectGridRestored(page, gridUrl, title);
  });
});
