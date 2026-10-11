import { readFile } from 'node:fs/promises';

import { listSources, removeAllSources, resetApp, rpc } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { expectNoHorizontalScroll, settle } from './helpers/layout';
import { addXtream, channelList, gotoLive } from './helpers/ui';

// Check 16: fresh data dir onboarding, dashboard rails after adding the mock
// Xtream portal, theme persistence, backup export + import. Plus shell smoke:
// not-found page, no console errors, no horizontal scroll 800..2560.

const XT = 'Smoke Xtream';

test.describe.serial('smoke', () => {
  test.beforeAll(async ({ request }) => {
    await resetApp(request);
  });

  test.afterEach(async ({ consoleLog }) => {
    expect(consoleLog.errors, 'no console errors or uncaught exceptions').toEqual([]);
  });

  test('fresh install: dashboard welcome and sources onboarding', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId('shell')).toBeVisible();
    await expect(page.getByTestId('dashboard-welcome')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();

    await page.goto('/sources');
    const onboarding = page.getByTestId('sources-onboarding');
    await expect(onboarding).toBeVisible();
    for (const kind of ['m3u', 'xtream', 'stalker']) {
      await expect(onboarding.getByTestId(`onboard-${kind}`)).toBeVisible();
    }
    await expect(page.getByTestId('rail-sources')).toHaveCount(0);
    await expect(onboarding.getByRole('link', { name: 'Import a backup' })).toHaveAttribute('href', '/settings/backup');
  });

  test('unknown route shows a not-found page with a way home', async ({ page }) => {
    await page.goto('/definitely/not/a/page');
    await expect(page.getByTestId('page-title')).toHaveText('Not found');
    const home = page.getByRole('main').getByRole('link', { name: 'Home' });
    await expect(home).toBeVisible();
    await home.click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('adding the mock Xtream portal fills the dashboard rails', async ({ page }) => {
    const source = await addXtream(page, XT);
    expect(source.channelCount).toBe(MOCK_FACTS.xtreamLive);
    expect(source.movieCount).toBe(MOCK_FACTS.xtreamMovies);
    expect(source.seriesCount).toBe(MOCK_FACTS.xtreamSeries);

    // The source card and the rail entry appear.
    await expect(page.getByTestId('source-card').filter({ hasText: XT })).toBeVisible();
    await expect(page.getByTestId('rail-sources').getByRole('button', { name: new RegExp(XT) })).toBeVisible();

    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard')).toBeVisible();
    const sourcesRail = page.getByRole('region', { name: 'Your sources' });
    await expect(sourcesRail.getByRole('link', { name: new RegExp(XT) })).toBeVisible();
    const added = page.getByRole('region', { name: 'Recently added' });
    await expect(added.getByRole('listitem').first()).toBeVisible();
    expect(await added.getByRole('listitem').count()).toBeGreaterThan(3);
  });

  test('live, movies and series pages render the new source', async ({ page }) => {
    const source = (await listSources(page.request)).find((s) => s.name === XT)!;
    await gotoLive(page, source.id);
    await expect(page.getByRole('navigation', { name: 'Groups' }).getByRole('link', { name: /^All channels/ })).toBeVisible();
    await expect(channelList(page).getByRole('listitem').first()).toBeVisible();

    await page.goto(`/s/${source.id}/movies`);
    await expect(page.getByTestId('vod-landing-movie')).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: new RegExp(MOCK_FACTS.firstMovie.title) }).first()).toBeVisible();

    await page.goto(`/s/${source.id}/series`);
    await expect(page.getByRole('main').getByRole('link', { name: new RegExp(MOCK_FACTS.firstSeries.title) }).first()).toBeVisible();
  });

  test('theme choice persists across reload', async ({ page }) => {
    await page.goto('/settings/appearance');
    const html = page.locator('html');
    // The radios are visually hidden inside their preview cards; click the card (label).
    const themes = page.getByRole('radiogroup', { name: 'Theme' });
    await themes.locator('label').filter({ has: page.getByTestId('theme-dark') }).click();
    await expect(page.getByTestId('theme-dark')).toBeChecked();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect.poll(async () => (await rpc<{ theme: string }>(page.request, 'settings.get')).theme).toBe('dark');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByTestId('theme-dark')).toBeChecked();

    // The header toggle flips it and that persists too.
    await page.getByTestId('theme-toggle').click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect.poll(async () => (await rpc<{ theme: string }>(page.request, 'settings.get')).theme).toBe('light');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect(page.getByTestId('theme-light')).toBeChecked();
  });

  test('backup export downloads JSON and import restores the sources', async ({ page }) => {
    await page.goto('/settings/backup');
    await page.getByTestId('toggle-include-secrets').click();
    await expect(page.getByTestId('toggle-include-secrets')).toBeChecked();
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('backup-export').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    const file = await download.path();
    const manifest = JSON.parse(await readFile(file, 'utf8')) as {
      kind: string;
      version: number;
      includeSecrets: boolean;
      playlists: { portalType: string; title: string }[];
    };
    expect(manifest.kind).toBe('iptvnator-playlist-backup');
    expect(manifest.version).toBe(1);
    expect(manifest.includeSecrets).toBe(true);
    expect(manifest.playlists.map((p) => [p.portalType, p.title])).toContainEqual(['xtream', XT]);

    // Back to an empty install, then restore from the downloaded file.
    await removeAllSources(page.request);
    await page.reload();
    await page.getByTestId('backup-file-input').setInputFiles(file);
    await expect(page.getByTestId('backup-summary')).toBeVisible();
    await page.getByTestId('backup-import').click();
    await expect(page.getByTestId('backup-result')).toBeVisible({ timeout: 90_000 });

    await expect
      .poll(async () => (await listSources(page.request)).find((s) => s.name === XT)?.movieCount ?? -1, { timeout: 60_000 })
      .toBe(MOCK_FACTS.xtreamMovies);
    await page.goto('/sources');
    await expect(page.getByTestId('source-card').filter({ hasText: XT })).toBeVisible();
  });

  test('no horizontal scroll from 800 to 2560 px', async ({ page }) => {
    const source = (await listSources(page.request)).find((s) => s.name === XT)!;
    const paths = ['/dashboard', '/sources', `/s/${source.id}/live`, `/s/${source.id}/movies`, '/settings/general', '/definitely-missing'];
    for (const width of [800, 1024, 1440, 1920, 2560]) {
      await page.setViewportSize({ width, height: width >= 1920 ? 1080 : 700 });
      for (const path of paths) {
        await page.goto(path);
        await expect(page.getByRole('main')).toBeVisible();
        await settle(page);
        await expectNoHorizontalScroll(page, `${path} @ ${width}px`);
      }
    }
  });

  // Last in the serial block so a heading defect does not skip the layout check.
  test('every routed page has exactly one h1', async ({ page }) => {
    const source = (await listSources(page.request)).find((s) => s.name === XT)!;
    const paths = [
      '/dashboard',
      '/sources',
      `/s/${source.id}/live`,
      `/s/${source.id}/movies`,
      `/s/${source.id}/series`,
      '/search',
      '/downloads',
      '/my-videos',
      '/favorites',
      '/recent',
      '/settings/general',
      '/definitely-missing',
    ];
    const h1s = () => page.locator('h1').allInnerTexts();
    for (const path of paths) {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      await settle(page);
      // Soft, so one run reports every page that breaks the rule. Polls so a
      // loading state that swaps its heading has time to finish; the failure
      // output lists the h1 texts found.
      await expect.soft.poll(h1s, { message: `${path} has exactly one h1` }).toHaveLength(1);
    }
  });
});
