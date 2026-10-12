import { ensureSource, resetApp } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { expectPlaying, mediaState, resumeRecord } from './helpers/media';
import { openMovieFromGrid, playFirstLiveChannel, playMovieOnDetail } from './helpers/portal';
import { blurFocus, playerRegion } from './helpers/ui';

// Check 14 (SC12): a movie seeked to 30 s resumes at >= 28 s after a reload;
// a live channel is restored after a reload.

const NAME = 'Resume Xtream';

test.describe.serial('resume after reload', () => {
  let sourceId: string;

  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    sourceId = (await ensureSource(request, 'xtream', NAME)).id;
  });

  test('movie resumes at the saved position', async ({ page }) => {
    await openMovieFromGrid(page, sourceId, MOCK_FACTS.firstMovie.title);
    const src = await playMovieOnDetail(page);
    expect(src).toContain(`/${MOCK_FACTS.firstMovie.id}.mp4`);

    // Seek to 30 s: pause, then three 10 s steps with the arrow key from the start.
    await blurFocus(page);
    await page.keyboard.press('k');
    await expect.poll(async () => (await mediaState(page))?.paused).toBe(true);
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) v.currentTime = 0;
    });
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await expect.poll(async () => Math.round((await mediaState(page))?.currentTime ?? 0)).toBe(30);
    await page.keyboard.press('k');
    await expectPlaying(page, { advance: 1 });

    // The session record catches up (written every 5 s and on page hide).
    await expect.poll(async () => (await resumeRecord(page))?.positionSeconds ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(28);

    await page.reload();
    await expect.poll(async () => (await mediaState(page))?.src ?? '', { timeout: 20_000 }).toContain(`/${MOCK_FACTS.firstMovie.id}.mp4`);
    await expect.poll(async () => (await mediaState(page))?.currentTime ?? 0, { timeout: 20_000 }).toBeGreaterThanOrEqual(28);
    const rec = await resumeRecord(page);
    expect(rec?.source.isLive).toBe(false);
    expect(rec?.source.title).toContain(MOCK_FACTS.firstMovie.title);
  });

  test('live channel is restored after reload', async ({ page }) => {
    await playFirstLiveChannel(page, sourceId, 'BBC News');
    await page.reload();
    await expect(playerRegion(page).getByRole('heading', { level: 2, name: 'BBC News', exact: true })).toBeVisible({ timeout: 20_000 });
    await expectPlaying(page, { advance: 1 });
    const rec = await resumeRecord(page);
    expect(rec?.source.isLive).toBe(true);
    expect(rec?.source.url).toContain('/102.');
  });
});
