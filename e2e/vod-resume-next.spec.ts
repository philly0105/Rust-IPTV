import type { PlaybackPosition } from '../src/api/types';
import { ensureSource, rpc } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { expectPlaying, mediaState, resumeRecord } from './helpers/media';
import { openMovieFromGrid, playFirstEpisode, playMovieOnDetail } from './helpers/portal';
import { blurFocus } from './helpers/ui';

// Brief: playback picks up where you stopped (the saved position survives a
// reload and the detail page offers it), and a series episode advances to the
// next one through Up next.

const NAME = 'Resume Next Xtream';

test.describe.serial('vod: resume offer and next episode', () => {
  let sourceId: string;

  test.beforeAll(async ({ request }) => {
    sourceId = (await ensureSource(request, 'xtream', NAME)).id;
  });

  test('a saved movie position is offered as Resume after a reload and resumes there', async ({ page, consoleLog }) => {
    // Opening the JSON /api/health page below makes the browser ask for /favicon.ico, which
    // the server does not have (the app itself declares an inline icon).
    consoleLog.allow(/status of 404 .*\/favicon\.ico\b/);
    await openMovieFromGrid(page, sourceId, MOCK_FACTS.firstMovie.title);
    const itemId = /\/movie\/([^/?#]+)/.exec(page.url())?.[1];
    expect(itemId, 'movie id in the detail url').toBeTruthy();
    const ref = { sourceId, contentType: 'movie' as const, itemId: decodeURIComponent(itemId!) };
    await rpc(page.request, 'positions.remove', { ref });
    await page.reload();
    await expect(page.getByTestId('vod-movie-detail').getByRole('button', { name: 'Play', exact: true })).toBeVisible();

    await playMovieOnDetail(page);
    // Seek to 30 s and pause there.
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.pause();
        v.currentTime = 30;
      }
    });
    await expect.poll(async () => Math.round((await mediaState(page))?.currentTime ?? 0)).toBe(30);

    // The core keeps the position (saved on pause, every few seconds and on page hide).
    await expect
      .poll(async () => (await rpc<PlaybackPosition | null>(page.request, 'positions.get', { ref }))?.positionSeconds ?? 0, {
        timeout: 20_000,
        message: 'positions.get reaches the seek target',
      })
      .toBeGreaterThanOrEqual(28);

    // Reload without the tab's own session restore, so the page has to offer the saved position:
    // leave the app (its pagehide writes the session record), drop that record on a same-origin
    // page that is not the app, then open the detail page again.
    const detailUrl = page.url();
    await page.goto('/api/health');
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(detailUrl);
    const detail = page.getByTestId('vod-movie-detail');
    const resume = detail.getByRole('button', { name: /^Resume from 0:[2-5]\d$/ });
    await expect(resume).toBeVisible({ timeout: 20_000 });
    await expect(detail.getByRole('button', { name: 'Start over' })).toBeVisible();
    expect(await resumeRecord(page)).toBeNull();

    await resume.click();
    await expect.poll(async () => (await mediaState(page))?.src ?? '', { timeout: 20_000 }).toContain(`/${MOCK_FACTS.firstMovie.id}.mp4`);
    await expect.poll(async () => (await mediaState(page))?.currentTime ?? 0, { timeout: 20_000 }).toBeGreaterThanOrEqual(28);
    await expectPlaying(page, { advance: 1 });
    expect((await mediaState(page))?.currentTime ?? 0).toBeGreaterThanOrEqual(28);
  });

  test('Up next advances from S01E01 to S01E02', async ({ page }) => {
    const first = await playFirstEpisode(page, sourceId, MOCK_FACTS.firstSeries.title);
    expect(first).toMatch(/\/3001\.\w+/);

    // Jump to the last seconds of the episode; the end offers the next one.
    await blurFocus(page);
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v && Number.isFinite(v.duration)) v.currentTime = Math.max(0, v.duration - 1.5);
    });
    const upNext = page.getByTestId('up-next');
    await expect(upNext).toBeVisible({ timeout: 20_000 });
    await expect(upNext).toHaveAccessibleName('Next episode');
    await expect(upNext).toContainText(/S0?1\s*E0?2|1x02|Episode 2/i);
    await expect(upNext).toContainText(/Starts in \d+ s/);

    await upNext.getByRole('button', { name: 'Play now' }).click();
    await expect(upNext).toBeHidden();
    await expect.poll(async () => (await mediaState(page))?.src ?? '', { timeout: 20_000 }).toMatch(/\/3002\.\w+/);
    await expectPlaying(page, { advance: 1 });
    expect((await mediaState(page))?.currentTime ?? 99, 'the next episode starts from the beginning').toBeLessThan(20);
    expect((await resumeRecord(page))?.source.ref?.itemId ?? '').not.toBe('');
  });

  test('Up next also advances on its own when the countdown ends', async ({ page }) => {
    await playFirstEpisode(page, sourceId, MOCK_FACTS.firstSeries.title);
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v && Number.isFinite(v.duration)) v.currentTime = Math.max(0, v.duration - 1.5);
    });
    await expect(page.getByTestId('up-next')).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await mediaState(page))?.src ?? '', { timeout: 25_000 }).toMatch(/\/3002\.\w+/);
    await expectPlaying(page, { advance: 1 });
  });
});
