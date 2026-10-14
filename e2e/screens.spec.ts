import type { APIRequestContext, Page } from '@playwright/test';

import type { Channel, CustomList, GuideSearchHit, Page as RpcPage, Settings } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { expectNoHorizontalScroll, settle } from './helpers/layout';
import { expectPlaying } from './helpers/media';
import { channelButton, gotoLive, playerRegion } from './helpers/ui';

// Check 7: the main screens (dashboard, live, movie detail, player, multi-view, settings) at
// desktop 1280x800 and phone 390x844, in the dark, light and OLED themes. Every screen must fit
// its width (no horizontal scroll: scrollWidth <= clientWidth on the document and the shell's
// scroller) and is saved to test-results/screens/<screen>-<viewport>-<theme>.png for review.
// Run 2 (check 13) adds a custom list page, the stats page and the guide with its search open.

const NAME = 'Screens Xtream';
const SHOTS = 'test-results/screens';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
] as const;

const THEMES = [
  { name: 'dark', patch: { theme: 'dark', oledBlack: false } },
  { name: 'light', patch: { theme: 'light', oledBlack: false } },
  { name: 'oled', patch: { theme: 'dark', oledBlack: true } },
] as const satisfies readonly { name: string; patch: Partial<Settings> }[];

type ThemeName = (typeof THEMES)[number]['name'];

/** Waits until the document wears the theme the settings asked for. */
async function expectTheme(page: Page, theme: ThemeName): Promise<void> {
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  if (theme === 'oled') await expect(html).toHaveAttribute('data-oled', '');
  else await expect(html).not.toHaveAttribute('data-oled', /.*/);
}

/** Local date `YYYY-MM-DD` (stats.record takes the browser's local day). */
function localDay(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A two-tile wall, saved the way the multi-view store saves it. */
async function twoTileWall(request: APIRequestContext, sourceId: string): Promise<string> {
  const live = await rpc<RpcPage<Channel>>(request, 'catalog.channels', { sourceId, query: { offset: 0, limit: 2, sort: 'number', dir: 'asc' } });
  expect(live.items).toHaveLength(2);
  return JSON.stringify({
    v: 1,
    tiles: live.items.map((c, i) => ({ key: `screens-${i}`, ref: c.ref, title: c.name })),
    layout: '1x2',
    audioKey: 'screens-0',
  });
}

test.describe.serial('main screens at desktop and phone widths, in every theme', () => {
  let sourceId = '';
  let wall = '';
  let listId = '';

  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    sourceId = (await ensureSource(request, 'xtream', NAME)).id;
    wall = await twoTileWall(request, sourceId);
    const first = await rpc<RpcPage<Channel>>(request, 'catalog.channels', { sourceId, query: { offset: 0, limit: 4, sort: 'number', dir: 'asc' } });
    for (const l of await rpc<CustomList[]>(request, 'lists.list')) if (l.name === 'Screens list') await rpc(request, 'lists.remove', { id: l.id });
    listId = (
      await rpc<CustomList>(request, 'lists.create', {
        name: 'Screens list',
        items: first.items.map((c) => ({ ref: c.ref, snapshot: { title: c.name, contentType: c.ref.contentType } })),
      })
    ).id;
    // Watch time for two channels (the core takes at most 300 s per call).
    for (const [i, c] of first.items.slice(0, 2).entries()) {
      for (let n = 0; n < 6 - i * 3; n++) await rpc(request, 'stats.record', { ref: c.ref, title: c.name, seconds: 300, day: localDay() });
    }
    await expect
      .poll(async () => (await rpc<GuideSearchHit[]>(request, 'epg.search', { sourceId, query: 'news' })).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
  });

  test.afterAll(async ({ request }) => {
    await rpc<Settings>(request, 'settings.update', { patch: { theme: 'system', oledBlack: false } });
  });

  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      test(`${theme.name} theme at ${vp.width}x${vp.height}`, async ({ page, request }) => {
        test.setTimeout(120_000);
        await rpc<Settings>(request, 'settings.update', { patch: theme.patch });
        await page.setViewportSize({ width: vp.width, height: vp.height });

        const shoot = async (screen: string): Promise<void> => {
          await expectTheme(page, theme.name);
          await settle(page, 500);
          await expectNoHorizontalScroll(page, `${screen} @ ${vp.width}x${vp.height} (${theme.name})`);
          await page.screenshot({ path: `${SHOTS}/${screen}-${vp.name}-${theme.name}.png` });
        };

        await page.goto('/dashboard');
        await expect(page.getByTestId('dashboard')).toBeVisible();
        await shoot('dashboard');

        await gotoLive(page, sourceId);
        await shoot('live');

        await page.goto(`/s/${sourceId}/movie/${MOCK_FACTS.firstMovie.id}`);
        await expect(page.getByTestId('vod-movie-detail').locator('h1:not(.sr-only)')).toBeVisible({ timeout: 20_000 });
        await shoot('movie-detail');

        await page.goto('/settings/appearance');
        await expect(page.getByRole('main').getByRole('radiogroup').first()).toBeVisible();
        await shoot('settings');

        await page.goto(`/lists/${listId}`);
        await expect(page.getByTestId('list-page').getByTestId('channel-list').locator('button[data-row-index]').first()).toBeVisible();
        await shoot('list');

        await page.goto('/stats');
        await expect(page.getByTestId('stats-chart')).toBeVisible();
        await shoot('stats');

        await page.goto(`/epg?source=${encodeURIComponent(sourceId)}`);
        await expect(page.getByTestId('epg-grid')).toBeVisible();
        await page.getByRole('searchbox', { name: 'Search the guide' }).fill('news');
        await expect(page.getByTestId('guide-search-panel')).toHaveAttribute('data-state', 'results');
        await shoot('guide-search');

        await page.evaluate((v) => localStorage.setItem('tsrust.multiview', v), wall);
        await page.goto('/multiview');
        await expect(page.getByTestId('multiview-tile')).toHaveCount(2);
        await expect(page.getByTestId('multiview-video').first()).toBeVisible();
        await shoot('multiview');
        // Leave the wall empty so its streams do not count against the account's two connections.
        await page.evaluate(() => localStorage.removeItem('tsrust.multiview'));

        // The player last: a live channel playing in the live view.
        await gotoLive(page, sourceId);
        await channelButton(page, 'BBC One').click();
        await expect(playerRegion(page).getByRole('heading', { level: 2, name: 'BBC One', exact: true })).toBeVisible();
        await expectPlaying(page, { advance: 1 });
        await shoot('player');
      });
    }
  }
});
