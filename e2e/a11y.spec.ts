import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import type { Channel, Page as RpcPage } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { expectNoHorizontalScroll, settle } from './helpers/layout';

// SC5: axe serious/critical = 0 and no horizontal scrollbar at 800x600 and
// 2560x1440 on the main screens: dashboard, sources, live, movies landing,
// movies grid, series detail, settings, and this round's screens: multi-view
// (empty and with two tiles), My List and the parental controls section.

const NAME = 'A11y Xtream';
const VIEWPORTS = [
  { width: 800, height: 600 },
  { width: 2560, height: 1440 },
];

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
      { name: 'settings', path: '/settings/general', ready: (p) => expect(p.getByRole('main')).toBeVisible() },
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
    ];
  });

  for (const vp of VIEWPORTS) {
    test(`axe and layout at ${vp.width}x${vp.height}`, async ({ page }) => {
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
});
