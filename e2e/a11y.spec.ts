import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import type { Channel, CustomList, GuideSearchHit, Page as RpcPage } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { expectNoHorizontalScroll, settle } from './helpers/layout';

// SC5: axe serious/critical = 0 and no horizontal scrollbar at 800x600 and
// 2560x1440 on the main screens: dashboard, sources, live, movies landing,
// movies grid, series detail, settings, and this round's screens: multi-view
// (empty and with two tiles), My List and the parental controls section.
// Run 2 (check 12): a custom list page, watch stats, the guide with its
// search panel open, and the hidden-channels and rename dialogs.
// Run 3 (check 11): the image cache row in Settings > General (loaded, not its skeleton), the
// first-run tour (each of its three steps) and the What's new dialog, both opened from About.
// Check 14: under reduced motion the dashboard hero does not rotate.
// Also the screens no other sweep reached: Scheduled with a reminder, a channel's catch-up
// archive, a My Videos detail address with nothing behind it, and /lists before any list exists.

const NAME = 'A11y Xtream';
const VIEWPORTS = [
  { width: 800, height: 600 },
  { width: 2560, height: 1440 },
];

/** Local date `YYYY-MM-DD` (stats.record takes the browser's local day). */
function localDay(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function seriousViolations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')} (${v.nodes[0]?.any[0]?.message ?? v.nodes[0]?.all[0]?.message ?? ''})`);
}

test.describe('accessibility and layout', () => {
  let pages: { name: string; path: string; ready: (page: Page) => Promise<void> }[] = [];
  let wall = '';

  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    const id = (await ensureSource(request, 'xtream', NAME)).id;
    // A two-tile wall, saved the way the multi-view store saves it.
    const live = await rpc<RpcPage<Channel>>(request, 'catalog.channels', { sourceId: id, query: { offset: 0, limit: 2, sort: 'number', dir: 'asc' } });
    wall = JSON.stringify({
      v: 1,
      tiles: live.items.map((c, i) => ({ key: `a11y-${i}`, ref: c.ref, title: c.name })),
      layout: '1x2',
      audioKey: 'a11y-0',
    });
    // Run 2 fixtures: a list of three channels, one hidden channel, half an hour of watch time,
    // and a guide that search can see (the panel shows results, not its loading state).
    const first = await rpc<RpcPage<Channel>>(request, 'catalog.channels', { sourceId: id, query: { offset: 0, limit: 6, sort: 'number', dir: 'asc' } });
    for (const l of await rpc<CustomList[]>(request, 'lists.list')) if (l.name === 'A11y list') await rpc(request, 'lists.remove', { id: l.id });
    const list = await rpc<CustomList>(request, 'lists.create', {
      name: 'A11y list',
      items: first.items.slice(0, 3).map((c) => ({ ref: c.ref, snapshot: { title: c.name, contentType: c.ref.contentType } })),
    });
    await rpc(request, 'channels.setHidden', { refs: [first.items[5]!.ref], hidden: true });
    // The core takes at most 300 s per call.
    for (let i = 0; i < 6; i++) await rpc(request, 'stats.record', { ref: first.items[0]!.ref, title: first.items[0]!.name, seconds: 300, day: localDay() });
    await expect
      .poll(async () => (await rpc<GuideSearchHit[]>(request, 'epg.search', { sourceId: id, query: 'news' })).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    // A reminder for tomorrow, so /scheduled shows an upcoming row rather than its empty state.
    const start = Date.now() + 24 * 3600_000;
    await rpc(request, 'reminders.add', {
      ref: first.items[0]!.ref,
      channelName: first.items[0]!.name,
      title: 'A11y reminder',
      start: new Date(start).toISOString(),
      end: new Date(start + 30 * 60_000).toISOString(),
    });
    // A channel with catch-up (mock streams 101..105), for the archive page.
    const all = await rpc<RpcPage<Channel>>(request, 'catalog.channels', { sourceId: id, query: { offset: 0, limit: 200, sort: 'number', dir: 'asc' } });
    const archived = all.items.find((c) => !c.isRadio && c.archive);
    if (!archived) throw new Error('mock portal has no live channel with an archive');
    pages = [
      { name: 'dashboard', path: '/dashboard', ready: (p) => expect(p.getByTestId('dashboard')).toBeVisible() },
      { name: 'live', path: `/s/${id}/live`, ready: (p) => expect(p.getByRole('list', { name: 'Channels' }).getByRole('listitem').first()).toBeVisible() },
      { name: 'movies', path: `/s/${id}/movies`, ready: (p) => expect(p.getByTestId('vod-landing-movie')).toBeVisible() },
      {
        name: 'movies grid',
        path: `/s/${id}/movies`,
        ready: async (p) => {
          await p.getByRole('region', { name: 'Categories' }).getByRole('link', { name: /^All movies/ }).click();
          await expect(p.getByTestId('vod-grid-movie').getByRole('listbox').getByRole('option').first()).toBeVisible();
        },
      },
      {
        name: 'series detail',
        path: `/s/${id}/series`,
        ready: async (p) => {
          await p.getByRole('main').getByRole('link', { name: new RegExp(MOCK_FACTS.firstSeries.title) }).first().click();
          await expect(p.getByTestId('vod-series-detail').getByRole('heading', { level: 1 })).toBeVisible();
        },
      },
      {
        name: 'settings',
        path: '/settings/general',
        ready: async (p) => {
          await expect(p.getByRole('main')).toBeVisible();
          // Run 3: the image cache row with its numbers, not the loading skeleton.
          await expect(p.getByTestId('image-cache-row').getByTestId('image-cache-size')).toBeVisible();
        },
      },
      { name: 'sources', path: '/sources', ready: (p) => expect(p.getByTestId('sources-page')).toBeVisible() },
      { name: 'multiview empty', path: '/multiview', ready: (p) => expect(p.getByTestId('multiview-page')).toBeVisible() },
      {
        name: 'multiview two tiles',
        path: '/multiview',
        ready: async (p) => {
          await p.evaluate((v) => localStorage.setItem('tsrust.multiview', v), wall);
          await p.reload();
          await expect(p.getByTestId('multiview-tile')).toHaveCount(2);
        },
      },
      { name: 'my list', path: '/my-list', ready: (p) => expect(p.getByTestId('mylist-page')).toBeVisible() },
      {
        name: 'settings parental',
        path: '/settings/parental',
        ready: (p) => expect(p.getByRole('main').getByRole('heading', { name: 'Parental controls' }).first()).toBeVisible(),
      },
      {
        name: 'list page',
        path: `/lists/${list.id}`,
        ready: (p) => expect(p.getByTestId('list-page').getByTestId('channel-list').locator('button[data-row-index]').first()).toBeVisible(),
      },
      { name: 'stats', path: '/stats', ready: (p) => expect(p.getByTestId('stats-chart')).toBeVisible() },
      { name: 'scheduled', path: '/scheduled', ready: (p) => expect(p.getByTestId('upcoming-row').first()).toBeVisible() },
      {
        name: 'archive',
        path: `/live/archive/${encodeURIComponent(id)}/${encodeURIComponent(archived.ref.itemId)}`,
        ready: async (p) => {
          const archive = p.getByTestId('archive-page');
          await expect(archive.getByRole('tablist', { name: 'Archive day' })).toBeVisible();
          // The day settles into a programme list or the designed empty state.
          await expect(archive.getByTestId('archive-programs').or(archive.getByText('Nothing listed for this day')).first()).toBeVisible();
        },
      },
      {
        name: 'my video not found',
        path: '/my-videos/999999',
        ready: (p) => expect(p.getByRole('heading', { name: 'This video is not in your library' })).toBeVisible(),
      },
      {
        name: 'guide search',
        path: `/epg?source=${encodeURIComponent(id)}`,
        ready: async (p) => {
          await expect(p.getByTestId('epg-grid')).toBeVisible();
          await p.getByRole('searchbox', { name: 'Search the guide' }).fill('news');
          await expect(p.getByTestId('guide-search-panel')).toHaveAttribute('data-state', 'results');
        },
      },
      {
        name: 'hidden channels dialog',
        path: `/s/${id}/live`,
        ready: async (p) => {
          await expect(p.getByTestId('channel-list').locator('button[data-row-index]').first()).toBeVisible();
          // Below 1024 px the groups (and this button) are in a drawer.
          const open = p.getByRole('button', { name: /^Hidden channels/ });
          const groups = p.getByRole('button', { name: 'Show groups', exact: true });
          // The hidden count can land after the rows: wait for one of the two before choosing.
          await expect.poll(async () => (await open.isVisible()) || (await groups.isVisible())).toBe(true);
          if (!(await open.isVisible())) await groups.click();
          await open.click();
          await expect(p.getByTestId('hidden-channels-dialog').getByTestId('hidden-channel-row').first()).toBeVisible();
        },
      },
      {
        name: 'rename dialog',
        path: `/s/${id}/live`,
        ready: async (p) => {
          const row = p.getByTestId('channel-list').locator('button[data-row-index]').first();
          await expect(row).toBeVisible();
          await row.focus();
          await p.keyboard.press('F2');
          await expect(p.getByTestId('channel-rename-dialog')).toBeVisible();
        },
      },
      // Run 3 C7, opened by hand from About (the automatic ones are marked seen for this run).
      ...([1, 2, 3] as const).map((step) => ({
        name: `tour step ${step}`,
        path: '/settings/about',
        ready: async (p: Page) => {
          await p.getByTestId('about-tour').click();
          const card = p.getByTestId('tour-card');
          await expect(card).toBeVisible();
          for (let n = 1; n < step; n++) await card.getByTestId('tour-next').click();
          await expect(p.getByTestId('tour-progress')).toHaveText(`Step ${step} of 3`);
        },
      })),
      {
        name: "what's new",
        path: '/settings/about',
        ready: async (p) => {
          await p.getByTestId('about-whats-new').click();
          await expect(p.getByTestId('whats-new').getByTestId('whats-new-item').first()).toBeVisible();
        },
      },
    ];
  });

  for (const vp of VIEWPORTS) {
    test(`axe and layout at ${vp.width}x${vp.height}`, async ({ page }) => {
      // One test walks every page above (about 2-3 s each with axe), like the sweeps in
      // a11y-rtl.spec.ts, so it gets their budget rather than the 60 s default.
      test.setTimeout(120_000);
      await page.setViewportSize(vp);
      const failures: string[] = [];
      for (const target of pages) {
        await page.goto(target.path);
        await target.ready(page);
        await settle(page, 600);
        await expectNoHorizontalScroll(page, `${target.name} @ ${vp.width}x${vp.height}`);
        for (const v of await seriousViolations(page)) failures.push(`${target.name}: ${v}`);
      }
      expect(failures, 'axe serious/critical violations').toEqual([]);
    });
  }

  // Last but one: it removes the custom list the sweeps above open (beforeAll makes it again if a
  // retry restarts the worker).
  test('axe and layout on /lists before any list exists', async ({ page, request }) => {
    for (const l of await rpc<CustomList[]>(request, 'lists.list')) await rpc(request, 'lists.remove', { id: l.id });
    const failures: string[] = [];
    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await page.goto('/lists');
      await expect(page.getByTestId('lists-index').getByRole('heading', { name: 'No lists yet' })).toBeVisible();
      await settle(page, 600);
      await expectNoHorizontalScroll(page, `lists empty @ ${vp.width}x${vp.height}`);
      for (const v of await seriousViolations(page)) failures.push(`lists empty @ ${vp.width}x${vp.height}: ${v}`);
    }
    expect(failures, 'axe serious/critical violations').toEqual([]);
  });

  test('check 14: under reduced motion the dashboard hero does not rotate', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/dashboard');
    const hero = page.getByTestId('dashboard-hero');
    await expect(hero).toBeVisible();
    // More than one slide, so there is something it could rotate to.
    expect(await hero.locator('[data-hero-tab]').count()).toBeGreaterThan(1);
    const shown = await hero.locator('[data-hero-tab][aria-selected="true"]').getAttribute('data-hero-tab');
    await expect(hero).not.toHaveAttribute('data-rotating', /.*/);
    await settle(page, 9000);
    expect(await hero.locator('[data-hero-tab][aria-selected="true"]').getAttribute('data-hero-tab')).toBe(shown);
    await expect(hero).not.toHaveAttribute('data-rotating', /.*/);
    // Allowing motion again starts the rotation, so the attribute above means what it says.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(hero).toHaveAttribute('data-rotating', 'true');
  });
});
