import { readFile } from 'node:fs/promises';

import type { Download, Locator, Page } from '@playwright/test';

import type { AppInfo, Settings } from '../src/api/types';
import { ensureSource, rpc } from './helpers/api';
import { MOCK, MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { mediaState } from './helpers/media';
import { openMovieFromGrid, playFirstLiveChannel, playMovieOnDetail } from './helpers/portal';
import { blurFocus, playerRegion } from './helpers/ui';

// C6 in server mode: a screenshot of the built-in player downloads as a PNG named after what
// plays, and the toast says "Saved to your downloads". Live TV plays through MSE (mpegts.js on
// the Xtream `.ts` the Auto format picks, hls.js on HLS), so its frames can be copied; a direct
// MP4 from the mock's origin taints the canvas, and the failure toast names CORS. The desktop
// save path (`screenshot.save`, `screenshot.mpv`) is covered by
// crates/iptv-core/tests/screenshot.rs and the vitest suites.

const NAME = 'Screenshot Xtream';
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const FILE_NAME = /^BBC One.* \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.png$/;

/**
 * Wakes the overlay controls: the pointer moves over the video (the click layer covers it), which
 * shows the bar and, in a small player like the live page's, takes the zap chip down. It then
 * rests on the bar's pane, which keeps the bar up (the shade above the pane lets the pointer
 * through).
 */
async function wakeControls(page: Page, scope: Locator): Promise<void> {
  const box = await scope.locator('video').first().boundingBox();
  if (!box) throw new Error('no video to hover');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8);
  await scope.getByTestId('controls-pane').hover();
}

/** The downloaded file is a real PNG of a decoded frame, not an empty canvas. */
async function expectPng(download: Download): Promise<void> {
  expect(download.suggestedFilename()).toMatch(FILE_NAME);
  const bytes = await readFile(await download.path());
  expect(bytes.length).toBeGreaterThan(1024);
  expect([...bytes.subarray(0, 8)]).toEqual(PNG_MAGIC);
}

test.describe.serial('screenshots in server mode', () => {
  let sourceId: string;

  test.beforeAll(async ({ request }) => {
    sourceId = (await ensureSource(request, 'xtream', NAME)).id;
    // Keep the first-run tour and What's new out of the way of the player.
    const { version } = await rpc<AppInfo>(request, 'app.info');
    await rpc<Settings>(request, 'settings.update', { patch: { tourCompleted: true, lastSeenVersion: version } });
  });

  test('S downloads the live frame as a PNG and says where it went', async ({ page }) => {
    await playFirstLiveChannel(page, sourceId);
    await blurFocus(page);
    const downloading = page.waitForEvent('download');
    await page.keyboard.press('s');
    const download = await downloading;
    await expectPng(download);
    // The visible toast; the sr-only live region repeats its text.
    await expect(page.locator('[data-toast-id]').filter({ hasText: 'Saved to your downloads' })).toBeVisible();
    await expect(page.getByText(download.suggestedFilename()).first()).toBeVisible();
  });

  test("Take screenshot in the player's options menu does the same", async ({ page }) => {
    await playFirstLiveChannel(page, sourceId);
    const stage = playerRegion(page);
    await wakeControls(page, stage);
    // A row of the options menu, with its key, since the control bar keeps only the main controls.
    await stage.getByRole('button', { name: 'Playback options' }).click();
    const camera = page.getByRole('menu', { name: 'Playback options' }).getByRole('menuitem', { name: 'Take screenshot' });
    await expect(camera).toBeVisible();
    await expect(camera).toHaveAttribute('aria-keyshortcuts', 'S');
    const downloading = page.waitForEvent('download');
    await camera.click();
    await expectPng(await downloading);
    // The visible toast; the sr-only live region repeats its text.
    await expect(page.locator('[data-toast-id]').filter({ hasText: 'Saved to your downloads' })).toBeVisible();
  });

  test('a frame from another origin without CORS is refused, and the toast says why', async ({ page }) => {
    await openMovieFromGrid(page, sourceId, MOCK_FACTS.firstMovie.title);
    await playMovieOnDetail(page);
    // The precondition: the MP4 loads straight from the mock, a different origin from the app.
    expect((await mediaState(page))?.src.startsWith(MOCK)).toBe(true);
    await blurFocus(page);
    let downloaded = false;
    page.on('download', () => {
      downloaded = true;
    });
    await page.keyboard.press('s');
    await expect(page.getByText('Screenshot not saved').first()).toBeVisible();
    await expect(page.getByText(/does not allow its picture to be copied \(no CORS permission\)/).first()).toBeVisible();
    expect(downloaded).toBe(false);
  });
});
