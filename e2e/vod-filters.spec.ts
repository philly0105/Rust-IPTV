import type { Locator, Page } from '@playwright/test';

import type { ItemRef } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { expectNoHorizontalScroll, settle } from './helpers/layout';

// Run 2 C4: decade chips and an exact year range (yf/yt in the URL), the
// watched tick on posters, the "Hide watched" switch and the W / Shift+W keys.
// The mock Xtream movies are all from 2024..2026, so the catalog has one
// decade (the 2020s) and the exact range narrows it to 2026.

const NAME = 'Filters Xtream';
let sourceId = '';
let blackHarbor: ItemRef;

function grid(page: Page): Locator {
  return page.getByTestId('vod-grid-movie');
}

function options(page: Page): Locator {
  return grid(page).getByRole('listbox').getByRole('option');
}

/** The decade chips in the grid's toolbar (exact: the From/To group is "Year range"). */
function yearGroup(page: Page): Locator {
  return page.getByTestId('vod-grid-toolbar').getByRole('group', { name: 'Year', exact: true });
}

/** The From/To selects, in the Filters panel. */
function rangeGroup(page: Page): Locator {
  return page.getByTestId('vod-filter-bar').getByRole('group', { name: 'Year range', exact: true });
}

async function openAllMovies(page: Page, search = ''): Promise<void> {
  await page.goto(`/s/${sourceId}/movies/c/all${search}`);
  await expect(grid(page)).toBeVisible();
}

/**
 * The Filters button opens the panel with the year range and Hide watched; below 640 px the sort
 * and the decade chips fold into it as well (L2-vod-7).
 */
async function openFilters(page: Page): Promise<void> {
  const toggle = page.getByTestId('vod-filters-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

async function setHideWatched(page: Page, on: boolean): Promise<void> {
  await rpc(page.request, 'settings.update', { patch: { vodHideWatched: on } });
}

test.describe('VOD year filter and watched', () => {
  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    sourceId = (await ensureSource(request, 'xtream', NAME)).id;
    blackHarbor = { sourceId, contentType: 'movie', itemId: MOCK_FACTS.firstMovie.id };
  });

  test.afterEach(async ({ request }) => {
    await rpc(request, 'settings.update', { patch: { vodHideWatched: false } });
    await rpc(request, 'userstate.setWatched', { ref: blackHarbor, watched: false });
  });

  test('decade chips come from the catalog and the exact range lands in the URL', async ({ page }) => {
    await openAllMovies(page);
    const group = yearGroup(page);
    await expect(group.getByRole('button', { name: 'All years' })).toHaveAttribute('aria-pressed', 'true');
    const decade = group.getByRole('button', { name: /^2020s, \d+ titles$/ });
    await expect(decade).toBeVisible();
    // Nothing in the mock catalog is older, so no other decade is offered.
    await expect(group.getByRole('button', { name: /^19\d0s/ })).toHaveCount(0);

    await decade.click();
    await expect(page).toHaveURL(/[?&]yf=2020&yt=2029/);
    await expect(decade).toHaveAttribute('aria-pressed', 'true');
    await expect(options(page).first()).toBeVisible();

    await openFilters(page);
    await rangeGroup(page).getByRole('combobox', { name: 'From' }).selectOption('2026');
    await rangeGroup(page).getByRole('combobox', { name: 'To' }).selectOption('2026');
    await expect(page).toHaveURL(/[?&]yf=2026&yt=2026/);
    await expect(options(page).first()).toContainText('2026');
    // The grid stays mounted and keeps the old titles (dimmed) until the new range answers (L3-vod-3).
    await expect
      .poll(async () => {
        const texts = await options(page).allInnerTexts();
        return texts.length > 0 && texts.every((t) => t.includes('2026'));
      })
      .toBe(true);

    // A reload keeps the range.
    await page.reload();
    await openFilters(page);
    await expect(rangeGroup(page).getByRole('combobox', { name: 'From' })).toHaveValue('2026');
    await group.getByRole('button', { name: 'All years' }).click();
    await expect(page).not.toHaveURL(/yf=/);
  });

  test('an empty year range explains itself and clears from the empty state', async ({ page }) => {
    await openAllMovies(page, '?yf=1950&yt=1959');
    await expect(page.getByText('No titles from these years')).toBeVisible();
    await grid(page).getByRole('button', { name: 'All years' }).last().click();
    await expect(options(page).first()).toBeVisible();
    await expect(page).not.toHaveURL(/yf=/);
  });

  test('a watched movie carries the tick, and Hide watched drops it', async ({ page }) => {
    await rpc(page.request, 'userstate.setWatched', { ref: blackHarbor, watched: true });
    await openAllMovies(page, '?sort=name');
    const watchedCard = options(page).filter({ hasText: MOCK_FACTS.firstMovie.title }).first();
    await expect(watchedCard.getByRole('group', { name: /, Watched/ })).toBeVisible();
    await expect(watchedCard.getByTestId('poster-watched')).toBeVisible();

    await openFilters(page);
    const toggle = page.getByRole('switch', { name: 'Hide watched' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(options(page).filter({ hasText: MOCK_FACTS.firstMovie.title })).toHaveCount(0);
    const settings = await rpc<{ vodHideWatched: boolean }>(page.request, 'settings.get');
    expect(settings.vodHideWatched).toBe(true);

    // Shift+W brings them back.
    await grid(page).getByRole('listbox').focus();
    await page.keyboard.press('Shift+W');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(options(page).filter({ hasText: MOCK_FACTS.firstMovie.title }).first()).toBeVisible();
  });

  test('W marks the title under the keyboard cursor watched, then unwatched', async ({ page }) => {
    await setHideWatched(page, false);
    await openAllMovies(page);
    const listbox = grid(page).getByRole('listbox');
    await listbox.focus();
    await page.keyboard.press('ArrowRight');
    const activeId = await listbox.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    const cell = page.locator(`[id="${activeId}"]`);
    await expect(cell.getByTestId('poster-watched')).toHaveCount(0);
    await page.keyboard.press('w');
    // The toast itself; the sr-only live region repeats its text outside the list.
    await expect(page.getByRole('region', { name: 'Notifications' }).getByRole('listitem').filter({ hasText: 'Marked as watched' })).toBeVisible();
    await expect(cell.getByTestId('poster-watched')).toBeVisible();
    await page.keyboard.press('w');
    await expect(cell.getByTestId('poster-watched')).toHaveCount(0);
  });

  test('a long decade row scrolls on its own: From, To and Hide watched stay in view', async ({ page }) => {
    // Eleven decades (1920s..2020s): more chips than one line holds at 1280 px, let alone at 390.
    const facets = Array.from({ length: 11 }, (_, i) => ({ year: 2024 - i * 10, count: 2 + i }));
    await page.route('**/rpc/catalog.yearFacets', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(facets) }),
    );
    for (const size of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      const at = `${size.width} px`;
      await page.setViewportSize(size);
      await openAllMovies(page);
      await openFilters(page);
      const chips = yearGroup(page);
      await expect(chips.getByRole('button', { name: /^1920s, / })).toBeAttached();
      await settle(page);
      const bar = (await page.getByTestId('vod-filter-bar').boundingBox())!;
      for (const control of [
        rangeGroup(page).getByRole('combobox', { name: 'From' }),
        rangeGroup(page).getByRole('combobox', { name: 'To' }),
        page.getByRole('switch', { name: 'Hide watched' }),
      ]) {
        await expect(control, at).toBeInViewport({ ratio: 1 });
        const box = (await control.boundingBox())!;
        expect(box.x, at).toBeGreaterThanOrEqual(bar.x);
        expect(box.x + box.width, at).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
      }
      // The chips that do not fit scroll inside their own row, and the edge hiding them fades.
      const row = await chips.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          overflow: el.scrollWidth - el.clientWidth,
          mask: style.getPropertyValue('mask-image') || style.getPropertyValue('-webkit-mask-image'),
        };
      });
      if (size.width < 600) expect(row.overflow, at).toBeGreaterThan(1);
      if (row.overflow > 1) expect(row.mask, at).toContain('linear-gradient');
      await expectNoHorizontalScroll(page, `vod grid with 11 decades at ${at}`);
    }
  });

  test('the filter row fits a phone without scrolling the page sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAllMovies(page);
    await openFilters(page);
    await expect(yearGroup(page)).toBeVisible();
    await settle(page);
    await expectNoHorizontalScroll(page, 'vod grid with filters at 390 px');
  });
});
