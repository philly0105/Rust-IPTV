import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';

import type { ItemRef, VodItem, WatchlistEntry, Page as RpcPage } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { expectNoHorizontalScroll, settle } from './helpers/layout';

// My List (contract C3) end to end against the real core: save a movie from
// its page, find it on the dashboard rail, then on /my-list filter, reorder
// by keyboard, remove with Undo, and check axe and layout from phone to wide
// desktop. Needs the integration wiring: the /my-list route, the dashboard
// rail and MyListButton on the movie page.

const NAME = 'My List Xtream';
let sourceId = '';
let movies: VodItem[] = [];

const seriesRef = (itemId: string): ItemRef => ({ sourceId, contentType: 'series', itemId });

function listed(request: APIRequestContext): Promise<WatchlistEntry[]> {
  return rpc<WatchlistEntry[]>(request, 'watchlist.list', {});
}
const titlesOf = (list: WatchlistEntry[]) => list.map((e) => e.snapshot.title);

async function clearList(request: APIRequestContext): Promise<void> {
  for (const e of await listed(request)) await rpc(request, 'watchlist.remove', { ref: e.ref });
}

async function save(request: APIRequestContext, ref: ItemRef, title: string): Promise<void> {
  const { inList } = await rpc<{ inList: boolean }>(request, 'watchlist.toggle', { ref, snapshot: { title, contentType: ref.contentType } });
  expect(inList, `${title} was saved`).toBe(true);
}

/** The /my-list rows in the order on screen (titles only). */
async function rowTitles(page: Page): Promise<string[]> {
  const rows = page.getByTestId('mylist-row');
  const n = await rows.count();
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) out.push((await rows.nth(i).locator('[data-action="open"] > span').first().innerText()).trim());
  return out;
}

/** The visible toast with this text (the sr-only live region repeats it outside the list). */
function toastWith(page: Page, text: string) {
  return page.getByRole('region', { name: 'Notifications' }).getByRole('listitem').filter({ hasText: text });
}

function listItem(page: Page, title: string) {
  return page.getByRole('list', { name: 'My List' }).getByRole('listitem').filter({ hasText: title });
}

async function seriousViolations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

test.describe('My List', () => {
  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    sourceId = (await ensureSource(request, 'xtream', NAME)).id;
    const page = await rpc<RpcPage<VodItem>>(request, 'catalog.movies', { sourceId, query: { offset: 0, limit: 5 } });
    movies = page.items;
    expect(movies.length).toBeGreaterThanOrEqual(3);
  });

  test.beforeEach(async ({ request }) => {
    await clearList(request);
  });

  test('save a movie from its page and find it on the dashboard rail', async ({ page, request }) => {
    const { id, title } = MOCK_FACTS.firstMovie;
    await page.goto(`/s/${sourceId}/movie/${id}`);
    const detail = page.getByTestId('vod-movie-detail');
    await expect(detail.getByRole('heading', { level: 1 })).toBeVisible();

    const button = detail.getByTestId('mylist-button');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(toastWith(page, `Added ${title} to My List`)).toBeVisible();
    await expect.poll(async () => titlesOf(await listed(request))).toEqual([title]);

    await page.goto('/dashboard');
    const rail = page.getByTestId('dashboard-rail-my-list');
    await expect(rail).toBeVisible();
    await expect(rail.getByTestId('mylist-rail-count')).toHaveText('1 title');
    await rail.getByRole('link', { name: 'See all' }).click();
    await expect(page).toHaveURL(/\/my-list$/);
    await expect(page.getByTestId('mylist-row')).toHaveCount(1);

    // Pressing the button again takes it out, with Undo.
    await page.goto(`/s/${sourceId}/movie/${id}`);
    await expect(detail.getByTestId('mylist-button')).toHaveAttribute('aria-pressed', 'true');
    await detail.getByTestId('mylist-button').click();
    await expect(detail.getByTestId('mylist-button')).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(detail.getByTestId('mylist-button')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => titlesOf(await listed(request))).toEqual([title]);
  });

  test('filter, reorder by keyboard, remove with Undo; the order survives a reload', async ({ page, request }) => {
    const [a, b, c] = movies as [VodItem, VodItem, VodItem];
    // Each save goes to the top, so this order lists c, series, b, a.
    await save(request, a.ref, a.title);
    await save(request, b.ref, b.title);
    await save(request, seriesRef(MOCK_FACTS.firstSeries.id), MOCK_FACTS.firstSeries.title);
    await save(request, c.ref, c.title);
    const series = MOCK_FACTS.firstSeries.title;

    await page.goto('/my-list');
    await expect(page.getByTestId('mylist-row')).toHaveCount(4);
    expect(await rowTitles(page)).toEqual([c.title, series, b.title, a.title]);
    await expect(page.getByTestId('mylist-rank').first()).toHaveText('1');

    // Filter: Movies only, in the URL; ranks still count the whole list.
    await page.getByRole('tab', { name: /Movies/ }).click();
    await expect(page).toHaveURL(/type=movie/);
    await expect(page.getByTestId('mylist-row')).toHaveCount(3);
    await expect(page.getByTestId('mylist-rank')).toHaveText(['1', '3', '4']);
    await page.getByRole('tab', { name: /All/ }).click();
    await expect(page.getByTestId('mylist-row')).toHaveCount(4);

    // Alt+ArrowDown moves the focused row; focus stays on it.
    await listItem(page, c.title).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => rowTitles(page)).toEqual([series, c.title, b.title, a.title]);
    await expect(listItem(page, c.title)).toBeFocused();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(async () => titlesOf(await listed(request))).toEqual([series, b.title, c.title, a.title]);

    // Delete removes the focused row; Undo puts it back in its place.
    await page.keyboard.press('Delete');
    await expect(toastWith(page, `Removed ${c.title} from My List`)).toBeVisible();
    await expect(page.getByTestId('mylist-row')).toHaveCount(3);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => titlesOf(await listed(request))).toEqual([series, b.title, c.title, a.title]);

    // Sort by title: no ranks, no move controls; back to my order restores them.
    await page.getByTestId('mylist-sort').selectOption('title');
    await expect(page).toHaveURL(/sort=title/);
    await expect(page.getByTestId('mylist-rank')).toHaveCount(0);
    await page.getByTestId('mylist-sort').selectOption('order');

    await page.reload();
    await expect.poll(() => rowTitles(page)).toEqual([series, b.title, c.title, a.title]);
  });

  test('designed empty state, then axe and layout from phone to wide desktop', async ({ page, request }) => {
    await page.goto('/my-list');
    await expect(page.getByTestId('mylist-empty')).toBeVisible();
    await expect(page.getByTestId('mylist-empty-browse')).toHaveAttribute('href', `/s/${sourceId}/movies`);

    const [a, b] = movies as [VodItem, VodItem];
    await save(request, a.ref, a.title);
    await save(request, seriesRef(MOCK_FACTS.firstSeries.id), MOCK_FACTS.firstSeries.title);
    await save(request, b.ref, b.title);

    const failures: string[] = [];
    for (const vp of [
      { width: 390, height: 844 },
      { width: 800, height: 600 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(vp);
      for (const path of ['/my-list', '/my-list?type=series&watched=hide']) {
        await page.goto(path);
        await expect(page.getByTestId('mylist-page')).toBeVisible();
        await settle(page, 500);
        await expectNoHorizontalScroll(page, `${path} @ ${vp.width}x${vp.height}`);
        if (vp.width === 390 && path === '/my-list') {
          // R1-craft: on a phone the title gets the row's width (rank on the poster, actions on a line of their own).
          const rows = await page.getByTestId('mylist-row').evaluateAll((els) =>
            els.map((r) => {
              const title = r.querySelector<HTMLElement>('[data-testid="mylist-title"]')!;
              return { row: r.getBoundingClientRect().width, title: title.getBoundingClientRect().width, clipped: title.scrollHeight > title.clientHeight + 1 };
            }),
          );
          expect(rows.length).toBeGreaterThan(0);
          for (const r of rows) expect(r.title / r.row, 'title share of the row at 390 px').toBeGreaterThan(0.6);
          expect(rows.filter((r) => r.clipped), 'titles cut short at 390 px').toEqual([]);
          // The move buttons show without hover, and the search sits in the page toolbar.
          expect(await page.getByTestId('mylist-move').first().evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
          await expect(page.getByTestId('mylist-search')).toBeVisible();
        }
        for (const v of await seriousViolations(page)) failures.push(`${path} @ ${vp.width}: ${v}`);
      }
    }
    expect(failures, 'axe serious/critical violations').toEqual([]);
  });
});
