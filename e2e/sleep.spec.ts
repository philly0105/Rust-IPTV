import type { Locator, Page } from '@playwright/test';

import type { Settings } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { mediaState } from './helpers/media';
import { openMovieFromGrid, playFirstLiveChannel, playMovieOnDetail } from './helpers/portal';
import { blurFocus, playerRegion } from './helpers/ui';

// C5: the zap banner on live channel changes (windowed, fullscreen, title hover) and the sleep
// timer (Z, the options menu, the countdown chip, the one-minute toast, the fade and the end).
// The timer tests install Playwright's clock and jump it forward; the media keeps real time.

const NAME = 'Sleep Xtream';
const MIN = 60_000;

const chip = (scope: Locator): Locator => scope.getByTestId('sleep-chip');
const toastById = (page: Page, id: string): Locator => page.locator(`[data-toast-id="${id}"]`);
const warningToast = (page: Page): Locator => toastById(page, 'player-sleep-warning');
const doneToast = (page: Page): Locator => toastById(page, 'player-sleep-done');

/** Wakes the overlay controls: the pointer moves over the video (the click layer covers it). */
async function wakeControls(page: Page, scope: Locator): Promise<void> {
  const box = await scope.locator('video').first().boundingBox();
  if (!box) throw new Error('no video to hover');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8);
}

/** Opens the player's options menu at its Sleep timer submenu. */
async function openSleepMenu(page: Page, scope: Locator): Promise<Locator> {
  await wakeControls(page, scope);
  await scope.getByRole('button', { name: 'Playback options' }).click();
  const menu = page.getByRole('menu', { name: 'Playback options' });
  await expect(menu).toBeVisible();
  const row = menu.getByRole('menuitem', { name: /^Sleep timer/ });
  await expect(row).toContainText('Off');
  await row.click();
  await expect(menu.getByRole('menuitemradio').first()).toBeFocused();
  return menu;
}

test.describe.serial('zap banner and sleep timer', () => {
  let sourceId: string;

  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    sourceId = (await ensureSource(request, 'xtream', NAME)).id;
    // A clock jump of minutes looks like a frozen stream to the stall detector, which would
    // reload the stream under the test. Nothing here tests reconnects.
    await rpc<Settings>(request, 'settings.update', { patch: { streamReconnect: false } });
  });

  test.afterAll(async ({ request }) => {
    await rpc<Settings>(request, 'settings.update', { patch: { streamReconnect: true } });
  });

  test('the zap banner comes up on a channel change, on hover of the title, and in fullscreen', async ({ page }) => {
    await playFirstLiveChannel(page, sourceId);
    const stage = playerRegion(page);
    await blurFocus(page);

    // Channel 3 by number: logo, number and name for 5 s.
    await page.keyboard.press('3');
    const banner = stage.getByTestId('zap-banner');
    await expect(banner).toBeVisible({ timeout: 8_000 });
    await expect(banner.getByTestId('zap-title')).toHaveText('CNN International');
    await expect(banner.getByTestId('zap-number')).toHaveText('3');
    await expect(banner.getByTestId('zap-logo').or(banner.getByTestId('zap-logo-fallback'))).toBeVisible();
    await expect(banner).toBeHidden({ timeout: 8_000 });

    // Resting on the channel title brings it back; leaving lets it go. The banner opens over the
    // title and holds while the pointer rests on it, so the hover skips the hit-target check.
    await stage.getByRole('heading', { level: 2, name: 'CNN International', exact: true }).hover({ force: true });
    await expect(banner).toBeVisible();
    await page.mouse.move(1, 1);
    await expect(banner).toBeHidden({ timeout: 3_000 });

    // Fullscreen: a zap shows it inside the fullscreen element. The pointer leaves the corner
    // first: in fullscreen a dwell on the left edge opens the channel panel, which focuses the
    // playing channel's row, and typed keys go on to its search field instead of zapping.
    const box = await stage.locator('video').first().boundingBox();
    if (!box) throw new Error('no video to point at');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await blurFocus(page);
    await page.keyboard.press('f');
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
    await page.keyboard.press('2');
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.querySelector('[data-testid="zap-title"]')?.textContent ?? null), { timeout: 8_000 })
      .toBe('BBC News');
    await page.keyboard.press('f');
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(false);
  });

  test('Z cycles the presets; the options menu sets the timer and the chip counts down', async ({ page }) => {
    await playFirstLiveChannel(page, sourceId);
    const stage = playerRegion(page);
    await blurFocus(page);

    await page.keyboard.press('z');
    await expect(chip(stage)).toHaveText(/^1[45]:\d\d$/);
    await expect(chip(stage)).toHaveAttribute('aria-label', /^Sleep timer, 1[45]:\d\d left$/);
    // 30, 45, 60, 90 min, then off.
    for (let i = 0; i < 4; i++) await page.keyboard.press('z');
    await expect(chip(stage)).toHaveText(/^1:(30:00|29:\d\d)$/);
    await page.keyboard.press('z');
    await expect(chip(stage)).toBeHidden();

    // The menu: off, the presets, and the end of the programme on live TV.
    const menu = await openSleepMenu(page, stage);
    const choices = menu.getByRole('menuitemradio');
    await expect(choices.first()).toHaveAccessibleName('Off');
    await expect(choices.first()).toHaveAttribute('aria-checked', 'true');
    for (const m of [15, 30, 45, 60, 90]) await expect(menu.getByRole('menuitemradio', { name: new RegExp(`^${m} min`) })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: /^End of programme/ })).toBeVisible();
    await menu.getByRole('menuitemradio', { name: /^30 min/ }).click();
    await expect(menu).toBeHidden();
    await expect(chip(stage)).toHaveText(/^(30:00|29:\d\d)$/);

    // The chip opens the same submenu; Off clears the timer.
    await wakeControls(page, stage);
    await chip(stage).click();
    const again = page.getByRole('menu', { name: 'Playback options' });
    await expect(again.getByRole('menuitemradio', { name: /^30 min/ })).toHaveAttribute('aria-checked', 'true');
    await again.getByRole('menuitemradio', { name: 'Off', exact: true }).click();
    await expect(chip(stage)).toBeHidden();
  });

  test('one minute before the end: a toast with Keep watching and Cancel', async ({ page }) => {
    await page.clock.install();
    await playFirstLiveChannel(page, sourceId);
    const stage = playerRegion(page);
    await blurFocus(page);

    await page.keyboard.press('z');
    await expect(chip(stage)).toBeVisible();
    await page.clock.fastForward(14 * MIN + 5_000);
    const warning = warningToast(page);
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('Sleep timer ending');
    await expect(warning).toContainText(/Playback stops in 0:\d\d/);

    // Keep watching: 15 more minutes, and the toast goes.
    await warning.getByRole('button', { name: 'Keep watching (+15 min)' }).click();
    await expect(warning).toBeHidden();
    await expect(chip(stage)).toHaveText(/^15:[45]\d$/);

    // Into the last minute again; Cancel turns the timer off.
    await page.clock.fastForward(15 * MIN);
    await expect(warning).toBeVisible();
    await warning.getByRole('button', { name: 'Cancel timer' }).click();
    await expect(warning).toBeHidden();
    await expect(chip(stage)).toBeHidden();
  });

  test('a movie fades out over the last 30 s, pauses, and gets its volume back', async ({ page }) => {
    await page.clock.install();
    await openMovieFromGrid(page, sourceId, MOCK_FACTS.firstMovie.title);
    await playMovieOnDetail(page);
    const nowPlaying = page.getByRole('region', { name: 'Now playing' });
    await blurFocus(page);
    // A level of the viewer's own, so the restore is not just "back to full".
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await expect.poll(async () => Math.round(((await mediaState(page))?.volume ?? 0) * 100)).toBe(80);
    const v0 = (await mediaState(page))!.volume;

    await page.keyboard.press('z');
    await expect(chip(nowPlaying)).toBeVisible();
    // Into the fade (29 s left), then halfway down it.
    await page.clock.fastForward(14 * MIN + 31_000);
    await expect(chip(nowPlaying)).toHaveClass(/player-sleep-fading/);
    await page.clock.fastForward(15_000);
    await expect.poll(async () => (await mediaState(page))!.volume).toBeLessThan(v0 * 0.75);
    expect((await mediaState(page))!.volume).toBeGreaterThan(v0 * 0.2);

    // The end: paused (VOD), the volume back where it was, and a toast that says why.
    await page.clock.fastForward(16_000);
    await expect.poll(async () => (await mediaState(page))!.paused).toBe(true);
    await expect.poll(async () => (await mediaState(page))!.volume).toBeCloseTo(v0, 2);
    await expect(doneToast(page)).toContainText('Sleep timer stopped playback');
    await expect(chip(nowPlaying)).toBeHidden();
  });

  test('live TV stops at the end of the timer', async ({ page }) => {
    await page.clock.install();
    await playFirstLiveChannel(page, sourceId);
    const stage = playerRegion(page);
    await blurFocus(page);

    await page.keyboard.press('z');
    await expect(chip(stage)).toBeVisible();
    await page.clock.fastForward(15 * MIN + 1_000);
    await expect(doneToast(page)).toContainText('Sleep timer stopped playback');
    // Stopped, not paused: the player let go of the stream.
    await expect.poll(async () => (await mediaState(page))?.src ?? null).toBeNull();
    await expect(warningToast(page)).toBeHidden();
  });
});
