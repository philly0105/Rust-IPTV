import { ensureSource, resetApp } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { expectPlaying, mediaState } from './helpers/media';
import { openMovieFromGrid, playMovieOnDetail } from './helpers/portal';
import { blurFocus, gotoLive, playerRegion } from './helpers/ui';

// Check 12 (SC10), shortcut half: every C16 shortcut is listed in the `?`
// overlay and does what it says.

const NAME = 'Shortcut Xtream';
const MOD = 'ControlOrMeta';

/** C16's required shortcuts, by the overlay's `data-combo` value. */
const C16 = ['mod+k', 'mod+f', 'mod+r', 'mod+b', 'digit', 'space', 'k', 'f', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'm', '?', 'escape'];

test.describe.serial('keyboard shortcuts', () => {
  let sourceId: string;

  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    sourceId = (await ensureSource(request, 'xtream', NAME)).id;
  });

  test('? opens the overlay listing every C16 shortcut; Escape closes it', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await blurFocus(page);
    await page.keyboard.press('?');
    const overlay = page.getByTestId('shortcut-overlay');
    await expect(overlay).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    for (const combo of C16) {
      const row = overlay.locator(`[data-combo="${combo}"]`).first();
      await expect(row, `overlay lists ${combo}`).toBeVisible();
      await expect(row.locator('dt')).not.toBeEmpty();
    }
    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
  });

  test('mod+k opens the command palette; Escape closes it', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard')).toBeVisible();
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await page.keyboard.press(`${MOD}+k`);
    await expect(palette).toBeVisible();
    // The palette runs commands: typing filters, Enter runs the match.
    await page.keyboard.type('settings');
    await expect(palette.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    // It reopens after closing (mod+k pressed inside the open palette does not close it; see report).
    await page.keyboard.press(`${MOD}+k`);
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  });

  test('mod+f opens global search with the field focused', async ({ page }) => {
    await page.goto('/sources');
    await expect(page.getByTestId('sources-page')).toBeVisible();
    await blurFocus(page);
    await page.keyboard.press(`${MOD}+f`);
    const focused = page.locator('[data-shell-search]:focus, [data-page-search]:focus');
    await expect(focused).toHaveCount(1);
    await page.keyboard.type('harbor');
    await expect(focused).toHaveValue('harbor');
  });

  test('mod+r opens recently watched', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await page.keyboard.press(`${MOD}+r`);
    await expect(page).toHaveURL(/\/recent$/);
    // The browser reload was prevented: still the same document, on /recent.
    await expect(page.getByTestId('page-title')).toBeVisible();
  });

  test('mod+b toggles the live groups sidebar', async ({ page }) => {
    await gotoLive(page, sourceId);
    const groups = page.getByRole('navigation', { name: 'Groups' });
    await expect(groups).toBeVisible();
    await blurFocus(page);
    await page.keyboard.press(`${MOD}+b`);
    await expect(groups).toBeHidden();
    await page.keyboard.press(`${MOD}+b`);
    await expect(groups).toBeVisible();
  });

  test('digits zap to a channel number', async ({ page }) => {
    await gotoLive(page, sourceId);
    await blurFocus(page);
    await page.keyboard.press('3');
    await expect(page.getByTestId('digit-osd')).toContainText('3');
    // Channel 3 on the mock Xtream portal.
    await expect(playerRegion(page).getByRole('heading', { level: 2, name: 'CNN International', exact: true })).toBeVisible({ timeout: 8_000 });
    await expectPlaying(page, { advance: 1 });
  });

  test('playback keys: space/k, arrows, m, f', async ({ page }) => {
    await openMovieFromGrid(page, sourceId, MOCK_FACTS.firstMovie.title);
    await playMovieOnDetail(page);
    await blurFocus(page);
    const media = async () => (await mediaState(page))!;

    // space and k toggle play/pause.
    await page.keyboard.press('Space');
    await expect.poll(async () => (await media()).paused).toBe(true);
    await page.keyboard.press('k');
    await expect.poll(async () => (await media()).paused).toBe(false);
    await page.keyboard.press('k');
    await expect.poll(async () => (await media()).paused).toBe(true);

    // Arrow left/right seek 5 s (while paused, so the clock does not move).
    const t0 = (await media()).currentTime;
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await media()).currentTime).toBeGreaterThanOrEqual(t0 + 4.5);
    const t1 = (await media()).currentTime;
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await media()).currentTime).toBeLessThanOrEqual(t1 - 4.5);

    // Arrow up/down change volume by 5 %.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const v0 = (await media()).volume;
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => Math.round(((await media()).volume - v0) * 100)).toBe(5);
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => Math.round(((await media()).volume - v0) * 100)).toBe(0);

    // m toggles mute.
    const muted0 = (await media()).muted;
    await page.keyboard.press('m');
    await expect.poll(async () => (await media()).muted).toBe(!muted0);
    await page.keyboard.press('m');
    await expect.poll(async () => (await media()).muted).toBe(muted0);

    // space resumes.
    await page.keyboard.press('Space');
    await expect.poll(async () => (await media()).paused).toBe(false);

    // f enters and leaves fullscreen.
    await page.keyboard.press('f');
    await expect(page.getByRole('button', { name: 'Exit fullscreen' }).first()).toBeAttached();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
    await page.keyboard.press('f');
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(false);
  });
});
