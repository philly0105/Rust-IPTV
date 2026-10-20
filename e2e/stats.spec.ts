import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';

import type { Channel, ItemRef, Page as RpcPage, WatchStats } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { expectNoHorizontalScroll, settle } from './helpers/layout';

// Watch stats (contract C7) end to end against the real core: seed the
// watch log through `stats.record`, then on /stats check the headline, the
// range in the URL and on 7/3, the chart's keyboard readout and table, the
// top lists, Clear stats behind its confirm, the empty states, and axe and
// layout from phone to wide desktop. A last test plays the first movie and
// waits for the reporter's flush on stop. Needs the integration wiring: the
// /stats route and `useWatchStatsReporter` in the shell effects.

const NAME = 'Stats Xtream';
let sourceId = '';
let channel: Channel;

/** Local date `daysAgo` days back, `YYYY-MM-DD` (the page asks with the browser's local day). */
function localDay(daysAgo = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function record(request: APIRequestContext, ref: ItemRef, title: string, seconds: number, daysAgo = 0): Promise<void> {
  // The core takes at most 300 s per call.
  for (let left = seconds; left > 0; left -= 300) {
    await rpc(request, 'stats.record', { ref, title, seconds: Math.min(left, 300), day: localDay(daysAgo) });
  }
}

function summary(request: APIRequestContext, days: 7 | 30 = 7): Promise<WatchStats> {
  return rpc<WatchStats>(request, 'stats.summary', { days, today: localDay() });
}

const movieRef = (): ItemRef => ({ sourceId, contentType: 'movie', itemId: MOCK_FACTS.firstMovie.id });

// The core takes days within 2 of its UTC date. West of UTC late in the
// evening the local date is a day behind, so local "two days ago" is three UTC
// days back; the 5 min film then goes on yesterday instead.
const FILM_DAYS_AGO = localDay() < new Date().toISOString().slice(0, 10) ? 1 : 2;

async function seed(request: APIRequestContext): Promise<void> {
  // Today 1 h 20 min (1 h live, 20 min film); yesterday 1 h live; two days ago 5 min film.
  await record(request, channel.ref, channel.name, 3600, 0);
  await record(request, movieRef(), MOCK_FACTS.firstMovie.title, 1200, 0);
  await record(request, channel.ref, channel.name, 3600, 1);
  await rpc(request, 'stats.record', { ref: movieRef(), title: MOCK_FACTS.firstMovie.title, seconds: 300, day: localDay(FILM_DAYS_AGO) });
}

/**
 * The total tile reads as one sentence to a screen reader and is drawn as a number over its label
 * (both aria-hidden), so the tile's own text holds all three. Check the sentence and the two drawn parts.
 */
async function expectTotal(page: Page, time: string, days: 7 | 30): Promise<void> {
  const tile = page.getByTestId('stats-total');
  await expect(tile.locator('span.sr-only')).toHaveText(`${time} watched in the last ${days} days`);
  const drawn = tile.locator('span[aria-hidden]');
  await expect(drawn).toHaveText([time, `Watched in the last ${days} days`]);
}

/** The visible toast with this text (the sr-only live region repeats it outside the list). */
function toastWith(page: Page, text: string) {
  return page.getByRole('region', { name: 'Notifications' }).getByRole('listitem').filter({ hasText: text });
}

async function seriousViolations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

test.describe('Watch stats', () => {
  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    sourceId = (await ensureSource(request, 'xtream', NAME)).id;
    const page = await rpc<RpcPage<Channel>>(request, 'catalog.channels', { sourceId, query: { offset: 0, limit: 1 } });
    channel = page.items[0]!;
    expect(channel, 'the mock has a live channel').toBeTruthy();
  });

  test.beforeEach(async ({ request }) => {
    await rpc(request, 'stats.clear');
  });

  test('headline, range, chart keyboard and table, top lists', async ({ page, request }) => {
    await seed(request);
    const week = await summary(request);
    expect(week.totalSeconds).toBe(3600 + 1200 + 3600 + 300);

    await page.goto('/stats');
    await expect(page.getByTestId('stats-page')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Watch stats' })).toBeAttached();
    await expectTotal(page, '2 hr 25 min', 7);

    // The chart: today is picked; arrows move, the readout follows.
    const slider = page.getByRole('slider', { name: 'Watch time per day' });
    await expect(slider).toHaveAttribute('aria-valuenow', '6');
    await expect(page.getByTestId('stats-readout')).toContainText('1 hr 20 min (1 hr live, 20 min movies and series)');
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(slider).toHaveAttribute('aria-valuenow', '5');
    await expect(page.getByTestId('stats-readout')).toContainText(
      FILM_DAYS_AGO === 1 ? '1 hr 5 min (1 hr live, 5 min movies and series)' : '1 hr (1 hr live, 0 min movies and series)',
    );
    await page.keyboard.press('Home');
    await expect(slider).toHaveAttribute('aria-valuenow', '0');

    // The table toggle shows the same numbers.
    await page.getByTestId('stats-table-toggle').click();
    await expect(page.getByTestId('stats-table')).toBeVisible();
    await expect(page.getByTestId('stats-table').getByRole('row')).toHaveCount(8);

    // Top lists: the channel plays from here, the film opens its page.
    const channels = page.getByTestId('stats-top-channels');
    await expect(channels.getByTestId('stats-channel')).toHaveCount(1);
    await expect(channels.getByTestId('stats-channel').first()).toContainText(channel.name);
    await expect(channels.getByRole('button', { name: `Play ${channel.name}` })).toBeVisible();
    const film = page.getByTestId('stats-top-titles').getByRole('link', { name: `Open ${MOCK_FACTS.firstMovie.title}` });
    await expect(film).toHaveAttribute('href', `/s/${sourceId}/movie/${MOCK_FACTS.firstMovie.id}`);

    // Range: tabs and the 7/3 keys, kept in the URL across a reload.
    await page.getByRole('tab', { name: '30 days' }).click();
    await expect(page).toHaveURL(/\/stats\?range=30$/);
    await expectTotal(page, '2 hr 25 min', 30);
    await expect(page.getByTestId('stats-bars').locator(':scope > div')).toHaveCount(30);
    await page.reload();
    await expect(page.getByRole('tab', { name: '30 days' })).toHaveAttribute('aria-selected', 'true');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('7');
    await expect(page).toHaveURL(/\/stats$/);
    await page.keyboard.press('3');
    await expect(page).toHaveURL(/\/stats\?range=30$/);

    // Clear behind a confirm.
    await page.getByTestId('stats-clear').click();
    const dialog = page.getByRole('dialog', { name: 'Clear watch stats?' });
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('stats-clear-confirm').click();
    await expect(toastWith(page, 'Watch stats cleared')).toBeVisible();
    await expect(page.getByText('Nothing watched yet')).toBeVisible();
    await expect.poll(async () => (await summary(request, 30)).totalSeconds).toBe(0);
  });

  test('designed empty states', async ({ page, request }) => {
    // Nothing watched at all: no "Show 30 days", point at the source's live TV instead.
    await page.goto('/stats');
    await expect(page.getByText('Nothing watched yet')).toBeVisible();
    await expect(page.getByText('Time spent on live TV, movies and series shows up here.')).toBeVisible();
    await expect(page.getByTestId('stats-watch-live')).toHaveAttribute('href', `/s/${encodeURIComponent(sourceId)}/live`);
    await expect(page.getByTestId('stats-show-month')).toHaveCount(0);

    // Ten days ago shows on 30 days only. The core takes a record only within two days of its
    // own date, so record today and move the page's clock ten days on.
    await record(request, movieRef(), MOCK_FACTS.firstMovie.title, 600, 0);
    await page.clock.setFixedTime(Date.now() + 10 * 86_400_000);
    await page.reload();
    await expect(page.getByText('Nothing played in the last 7 days.')).toBeVisible();
    await page.getByTestId('stats-show-month').click();
    await expect(page).toHaveURL(/range=30/);
    await expectTotal(page, '10 min', 30);
    await page.getByRole('tab', { name: '7 days' }).click();
    await expect(page.getByText('Nothing played in the last 7 days.')).toBeVisible();
  });

  test('axe and layout from phone to wide desktop, LTR and RTL', async ({ page, request }) => {
    await seed(request);
    const failures: string[] = [];
    for (const vp of [
      { width: 390, height: 844 },
      { width: 800, height: 600 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(vp);
      for (const path of ['/stats', '/stats?range=30']) {
        await page.goto(path);
        await expect(page.getByTestId('stats-chart')).toBeVisible();
        await settle(page, 500);
        await expectNoHorizontalScroll(page, `${path} @ ${vp.width}x${vp.height}`);
        for (const v of await seriousViolations(page)) failures.push(`${path} @ ${vp.width}: ${v}`);
      }
    }
    // RTL: the arrows follow the mirrored chart.
    await page.goto('/stats');
    await expect(page.getByTestId('stats-chart')).toBeVisible();
    // After load: the app writes `dir` from the UI language once settings arrive.
    await settle(page, 500);
    await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const slider = page.getByRole('slider', { name: 'Watch time per day' });
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuenow', '5');
    await expectNoHorizontalScroll(page, '/stats rtl');
    expect(failures).toEqual([]);
  });

  test('the 7-day axis keeps its weekday names apart in Arabic on a phone', async ({ page, request }) => {
    // Arabic short weekday names are whole words ("الأربعاء"); at 390 px they used to overlap.
    await seed(request);
    await rpc(request, 'settings.update', { patch: { language: 'ar' } });
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/stats');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByTestId('stats-chart')).toBeVisible();
      await settle(page, 500);
      const labels = await page.getByTestId('stats-day-labels').evaluate((row) =>
        Array.from(row.children)
          .filter((el) => el.getAttribute('data-testid') !== 'stats-day-probe' && el.textContent)
          .map((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const box = range.getBoundingClientRect();
            return { text: el.textContent ?? '', left: box.left, right: box.right };
          })
          .sort((a, b) => a.left - b.left),
      );
      expect(labels).toHaveLength(7);
      for (let i = 1; i < labels.length; i++) {
        const [prev, next] = [labels[i - 1]!, labels[i]!];
        expect(next.left, `"${prev.text}" and "${next.text}" overlap`).toBeGreaterThanOrEqual(prev.right);
      }
      await expectNoHorizontalScroll(page, '/stats ar @ 390');
    } finally {
      await rpc(request, 'settings.update', { patch: { language: 'en' } });
    }
  });

  test('playing a film adds its time when playback stops', async ({ page, request }) => {
    await page.goto(`/s/${sourceId}/movie/${MOCK_FACTS.firstMovie.id}`);
    const detail = page.getByTestId('vod-movie-detail');
    await expect(detail.getByRole('heading', { level: 1 })).toBeVisible();
    await detail.getByRole('button', { name: /^(Play|Resume)/ }).first().click();
    const video = page.locator('video').first();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(4);
    // Leaving the page stops playback; the reporter flushes on stop and on pagehide.
    await page.goto('/stats');
    await expect
      .poll(async () => (await summary(request)).topTitles.find((t) => t.ref.itemId === MOCK_FACTS.firstMovie.id)?.seconds ?? 0, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(3);
  });
});
