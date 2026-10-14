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

function yearGroup(page: Page): Locator {
  return page.getByTestId('vod-filter-bar').getByRole('group', { name: 'Year' });
}

async function openAllMovies(page: Page, search = ''): Promise<void> {
  await page.goto(`/s/${sourceId}/movies/c/all${search}`);
  await expect(grid(page)).toBeVisible();
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

    await group.getByRole('combobox', { name: 'From' }).selectOption('2026');
    await group.getByRole('combobox', { name: 'To' }).selectOption('2026');
    await expect(page).toHaveURL(/[?&]yf=2026&yt=2026/);
    await expect(options(page).first()).toContainText('2026');
    const shown = await options(page).count();
    for (let i = 0; i < shown; i++) await expect(options(page).nth(i)).toContainText('2026');

    // A reload keeps the range.
    await page.reload();
    await expect(group.getByRole('combobox', { name: 'From' })).toHaveValue('2026');
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

  test('the filter row fits a phone without scrolling the page sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAllMovies(page);
    await expect(yearGroup(page)).toBeVisible();
    await settle(page);
    await expectNoHorizontalScroll(page, 'vod grid with filters at 390 px');
  });
});
