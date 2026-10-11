import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { ensureSource, resetApp } from './helpers/api';
import { expect, test } from './helpers/fixtures';
import { expectNoHorizontalScroll, settle } from './helpers/layout';

// Check 12 (SC10), a11y half: axe serious/critical = 0 and no horizontal
// scrollbar at 800x600 and 2560x1440 on dashboard, live, movies, settings.

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

  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    const id = (await ensureSource(request, 'xtream', NAME)).id;
    pages = [
      { name: 'dashboard', path: '/dashboard', ready: (p) => expect(p.getByTestId('dashboard')).toBeVisible() },
      { name: 'live', path: `/s/${id}/live`, ready: (p) => expect(p.getByRole('list', { name: 'Channels' }).getByRole('listitem').first()).toBeVisible() },
      { name: 'movies', path: `/s/${id}/movies`, ready: (p) => expect(p.getByTestId('vod-landing-movie')).toBeVisible() },
      { name: 'settings', path: '/settings/general', ready: (p) => expect(p.getByRole('main')).toBeVisible() },
      { name: 'sources', path: '/sources', ready: (p) => expect(p.getByTestId('sources-page')).toBeVisible() },
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
