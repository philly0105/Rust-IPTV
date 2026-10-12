import AxeBuilder from '@axe-core/playwright';
import type { Page, Request } from '@playwright/test';

import type { Settings } from '../src/api/types';
import { ensureSource, rpc } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { settle } from './helpers/layout';

// SC5: zero serious or critical axe violations on every route, in English
// (LTR) and in Arabic (dir=rtl). The layout checks at 800x600 and 2560x1440
// stay in a11y.spec.ts; this spec walks every routed page once per direction
// at the default 1280x800, then every settings section again at 1440x900.

const NAME = 'Axe Xtream';

const SETTINGS_SECTIONS = ['general', 'playback', 'players', 'epg', 'metadata', 'appearance', 'remote', 'backup', 'shortcuts', 'about'];

function routes(id: string): string[] {
  return [
    '/dashboard',
    '/sources',
    ...SETTINGS_SECTIONS.map((s) => `/settings/${s}`),
    '/favorites',
    '/recent',
    '/downloads',
    '/my-videos',
    '/search',
    '/epg',
    `/s/${id}/live`,
    `/s/${id}/radio`,
    `/s/${id}/favorites`,
    `/s/${id}/recent`,
    `/s/${id}/search`,
    `/s/${id}/movies`,
    `/s/${id}/movies/c/all`,
    `/s/${id}/movie/${MOCK_FACTS.firstMovie.id}`,
    `/s/${id}/series`,
    `/s/${id}/series/c/all`,
    `/s/${id}/series/${MOCK_FACTS.firstSeries.id}`,
    `/s/${id}/actor/1`,
    '/definitely-missing',
  ];
}

async function seriousViolations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.impact} ${v.id}: ${v.help} -> ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(' | ')} (${v.nodes[0]?.any[0]?.message ?? v.nodes[0]?.all[0]?.message ?? ''})`,
    );
}

/** Waits for the page's loading states to finish (best effort: a live page may keep a busy player). */
async function ready(page: Page): Promise<void> {
  await expect(page.getByRole('main')).toBeVisible();
  await page
    .waitForFunction(() => !document.querySelector('main [aria-busy="true"], [data-testid="shell-skeleton"], [data-testid="app-loading"]'), undefined, {
      timeout: 10_000,
    })
    .catch(() => undefined);
  await settle(page, 500);
}

/**
 * Counts the page's image requests still in flight. These specs walk 30-odd poster-heavy pages
 * in one test; navigating while posters are still loading aborts those requests and their
 * connections. Over a full suite run that piles up sockets until Windows refuses new ones
 * (`net::ERR_NO_BUFFER_SPACE` on a mock poster). Waiting for the posters to finish before each
 * navigation removes those aborts.
 */
function trackImages(page: Page): { settled(): Promise<void> } {
  const inFlight = new Set<Request>();
  page.on('request', (r) => {
    if (r.resourceType() === 'image') inFlight.add(r);
  });
  const done = (r: Request) => inFlight.delete(r);
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return {
    settled: () => expect.poll(() => inFlight.size, { timeout: 15_000, message: 'image requests still loading' }).toBe(0),
  };
}

async function setLanguage(page: Page, language: string): Promise<void> {
  await rpc<Settings>(page.request, 'settings.update', { patch: { language } });
}

test.describe.serial('axe on every route, LTR and RTL', () => {
  let sourceId: string;

  test.beforeAll(async ({ request }) => {
    sourceId = (await ensureSource(request, 'xtream', NAME)).id;
  });

  test.afterAll(async ({ request }) => {
    await rpc<Settings>(request, 'settings.update', { patch: { language: 'en' } });
  });

  for (const lang of [
    { code: 'en', dir: 'ltr', bcp47: 'en' },
    { code: 'ar', dir: 'rtl', bcp47: 'ar' },
  ]) {
    test(`no serious or critical violations in ${lang.code} (${lang.dir})`, async ({ page }) => {
      test.setTimeout(240_000);
      await setLanguage(page, lang.code);
      const images = trackImages(page);
      const failures: string[] = [];
      for (const path of routes(sourceId)) {
        await page.goto(path);
        await expect(page.locator('html')).toHaveAttribute('dir', lang.dir);
        await expect(page.locator('html')).toHaveAttribute('lang', lang.bcp47);
        await ready(page);
        await images.settled();
        for (const v of await seriousViolations(page)) failures.push(`[${lang.code}] ${path}: ${v}`);
      }
      expect(failures, 'axe serious/critical violations').toEqual([]);
    });

    // Some pages lay out differently at other widths (a violation on /settings/shortcuts showed
    // only at 1440 px), so these are checked again on top of the default 1280x800 pass above:
    // every settings section at 1440x900, and the movie and series detail pages at 1440x900
    // and 800x600.
    for (const vp of [
      { width: 1440, height: 900, pages: 'settings' as const },
      { width: 800, height: 600, pages: 'detail' as const },
    ]) {
      const label = vp.pages === 'settings' ? 'every settings section and the detail pages' : 'the detail pages';
      test(`${label} at ${vp.width}x${vp.height} in ${lang.code} (${lang.dir})`, async ({ page }) => {
        test.setTimeout(120_000);
        await setLanguage(page, lang.code);
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const images = trackImages(page);
        const paths = [...(vp.pages === 'settings' ? SETTINGS_SECTIONS.map((s) => `/settings/${s}`) : []), ...detailRoutes(sourceId)];
        const failures: string[] = [];
        for (const path of paths) {
          await page.goto(path);
          await expect(page.locator('html')).toHaveAttribute('dir', lang.dir);
          await detailReady(page, path);
          await ready(page);
          await images.settled();
          for (const v of await seriousViolations(page)) failures.push(`[${lang.code} ${vp.width}x${vp.height}] ${path}: ${v}`);
        }
        expect(failures, 'axe serious/critical violations').toEqual([]);
      });
    }
  }
});

function detailRoutes(id: string): string[] {
  return [`/s/${id}/movie/${MOCK_FACTS.firstMovie.id}`, `/s/${id}/series/${MOCK_FACTS.firstSeries.id}`];
}

/**
 * On a detail page, waits for the hero's visible title so axe sees the loaded page. The loading
 * skeleton and the error state carry only a screen-reader h1 (`sr-only`), so that one does not count.
 */
async function detailReady(page: Page, path: string): Promise<void> {
  const testId = /\/movie\//.test(path) ? 'vod-movie-detail' : /\/series\/[^/]+$/.test(path) ? 'vod-series-detail' : undefined;
  if (testId) await expect(page.getByTestId(testId).locator('h1:not(.sr-only)')).toBeVisible({ timeout: 20_000 });
}
