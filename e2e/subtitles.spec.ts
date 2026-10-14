import { join } from 'node:path';

import type { Locator, Page } from '@playwright/test';

import type { Settings } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { openMovieFromGrid, playMovieOnDetail } from './helpers/portal';
import { blurFocus } from './helpers/ui';

// C6: subtitle files in the built-in player (load, pick, Off, a bad file), the subtitle look on
// the Playback settings page (live preview, saved settings) and in the player's menu, and Shift+C.

const NAME = 'Subtitles Xtream';
const FIXTURES = join(import.meta.dirname, 'fixtures', 'subtitles');

const toast = (page: Page, text: string): Locator => page.locator('[data-toast-id]').filter({ hasText: text });
const nowPlaying = (page: Page): Locator => page.getByRole('region', { name: 'Now playing' });

interface TrackInfo {
  label: string;
  mode: string;
  cues: number;
  firstText: string | null;
  line: number | string | null;
}

/** The video's subtitle tracks as the browser sees them. */
async function textTracks(page: Page): Promise<TrackInfo[]> {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('[data-player-host] video');
    if (!video) return [];
    return Array.from(video.textTracks).map((t) => {
      // A disabled track hides its cues.
      const cues = t.cues ? Array.from(t.cues) : [];
      const first = cues[0] as VTTCue | undefined;
      return { label: t.label, mode: t.mode, cues: cues.length, firstText: first?.text ?? null, line: first ? first.line : null };
    });
  });
}

/** A subtitle variable on the player host (`video::cue` reads them, player.css). */
async function hostVar(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => document.querySelector<HTMLElement>('[data-player-host]')?.style.getPropertyValue(n) ?? '', name);
}

/** Opens the player's options menu at its Subtitles submenu. */
async function openSubtitleMenu(page: Page): Promise<Locator> {
  const stage = nowPlaying(page);
  const box = await stage.locator('video').first().boundingBox();
  if (!box) throw new Error('no video to hover');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8);
  await stage.getByRole('button', { name: 'Playback options' }).click();
  const menu = page.getByRole('menu', { name: 'Playback options' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /^Subtitles/ }).click();
  await expect(menu.getByTestId('subtitle-menu')).toBeVisible();
  return menu;
}

/** Clicks "Load subtitle file…" and answers the browser's file chooser with `file`. */
async function loadFile(page: Page, menu: Locator, file: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await menu.getByTestId('subtitle-load').click();
  await (await chooser).setFiles(join(FIXTURES, file));
}

test.describe.serial('subtitles', () => {
  let sourceId: string;

  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    sourceId = (await ensureSource(request, 'xtream', NAME)).id;
    await rpc<Settings>(request, 'settings.update', {
      patch: { subtitleSize: 'medium', subtitleColor: 'white', subtitleBackground: 'box', subtitlePosition: 0 },
    });
  });

  test('the Playback settings page previews and saves the subtitle look', async ({ page, request }) => {
    await page.goto('/settings/playback');
    const preview = page.getByTestId('subtitle-preview');
    await expect(preview).toBeVisible();
    const line = page.getByTestId('subtitle-preview-line');
    await expect(line).toHaveCSS('color', 'rgb(255, 255, 255)');

    await page.getByTestId('subtitle-size').getByRole('radio', { name: 'Large', exact: true }).click();
    await page.getByTestId('subtitle-color').getByRole('radio', { name: 'Yellow' }).click();
    await expect(line).toHaveCSS('color', 'rgb(255, 230, 0)');
    await page.getByTestId('subtitle-background').getByRole('radio', { name: 'Solid' }).click();
    await expect(line).toHaveCSS('background-color', 'rgb(0, 0, 0)');

    // Keyboard: arrows move along a radio group.
    const sizes = page.getByTestId('subtitle-size');
    await sizes.getByRole('radio', { name: 'Large', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(sizes.getByRole('radio', { name: 'Extra large' })).toBeFocused();
    await expect(sizes.getByRole('radio', { name: 'Extra large' })).toHaveAttribute('aria-checked', 'true');

    // The slider previews while it moves and saves when the key is released.
    const slider = page.getByTestId('subtitle-position');
    await slider.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('subtitle-position-value')).toHaveText('Raised 5%');

    await expect
      .poll(async () => {
        const s = await rpc<Settings>(request, 'settings.get');
        return [s.subtitleSize, s.subtitleColor, s.subtitleBackground, s.subtitlePosition];
      })
      .toEqual(['xlarge', 'yellow', 'solid', 5]);
  });

  test('a loaded SRT file shows as a track, can be switched off, and is placed at the saved position', async ({ page }) => {
    await openMovieFromGrid(page, sourceId, MOCK_FACTS.firstMovie.title);
    await playMovieOnDetail(page);

    // The player takes the saved look from the settings page.
    await expect.poll(() => hostVar(page, '--sub-color')).toBe('#FFE600');
    await expect.poll(() => hostVar(page, '--sub-scale')).toBe('1.5');
    await expect.poll(() => hostVar(page, '--sub-bg')).toBe('rgb(0 0 0)');

    let menu = await openSubtitleMenu(page);
    await expect(menu.getByTestId('subtitle-menu-empty')).toBeVisible();
    await loadFile(page, menu, 'sample.srt');
    await expect(toast(page, 'Showing subtitles from sample.srt')).toBeVisible();
    await expect(menu).toBeHidden();
    await expect
      .poll(() => textTracks(page))
      .toEqual([{ label: 'sample.srt', mode: 'showing', cues: 3, firstText: 'First subtitle line\nwith a second line', line: 85 }]);

    menu = await openSubtitleMenu(page);
    await expect(menu.getByRole('menuitemradio', { name: 'sample.srt' })).toHaveAttribute('aria-checked', 'true');
    await menu.getByRole('menuitemradio', { name: 'Off' }).click();
    await expect.poll(async () => (await textTracks(page)).map((t) => t.mode)).toEqual(['disabled']);

    // Shift+C opens the same submenu from the keyboard.
    await blurFocus(page);
    await page.keyboard.press('Shift+C');
    menu = page.getByRole('menu', { name: 'Playback options' });
    await expect(menu.getByTestId('subtitle-menu')).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true');
    await menu.getByRole('menuitemradio', { name: 'sample.srt' }).click();
    await expect.poll(async () => (await textTracks(page)).map((t) => t.mode)).toEqual(['showing']);
  });

  test('WebVTT and ASS files load; a file without subtitles says why', async ({ page }) => {
    await openMovieFromGrid(page, sourceId, MOCK_FACTS.firstMovie.title);
    await playMovieOnDetail(page);

    let menu = await openSubtitleMenu(page);
    await loadFile(page, menu, 'sample.vtt');
    await expect(toast(page, 'Showing subtitles from sample.vtt')).toBeVisible();

    menu = await openSubtitleMenu(page);
    await loadFile(page, menu, 'sample.ass');
    await expect(toast(page, 'Showing subtitles from sample.ass')).toBeVisible();
    await expect
      .poll(async () => (await textTracks(page)).map((t) => [t.label, t.mode, t.cues]))
      .toEqual([
        ['sample.vtt', 'disabled', 0],
        ['sample.ass', 'showing', 2],
      ]);
    // ASS override tags are gone; \N is a line break.
    expect((await textTracks(page))[1]?.firstText).toBe('Styled line\nsecond row');

    menu = await openSubtitleMenu(page);
    await loadFile(page, menu, 'broken.srt');
    const failed = toast(page, 'Could not load broken.srt');
    await expect(failed).toBeVisible();
    await expect(failed).toContainText('The file has no subtitle lines that can be read.');
    await expect.poll(async () => (await textTracks(page)).length).toBe(2);
  });

  test('the player menu changes the subtitle look in place', async ({ page, request }) => {
    await openMovieFromGrid(page, sourceId, MOCK_FACTS.firstMovie.title);
    await playMovieOnDetail(page);
    const menu = await openSubtitleMenu(page);
    await menu.getByRole('menuitem', { name: 'Subtitle style…' }).click();
    const style = menu.getByTestId('subtitle-style-menu');
    await expect(style).toBeVisible();
    await style.getByRole('radio', { name: 'Cyan' }).click();
    await expect.poll(() => hostVar(page, '--sub-color')).toBe('#00E5FF');
    await expect.poll(async () => (await rpc<Settings>(request, 'settings.get')).subtitleColor).toBe('cyan');

    // Escape steps back to the track list.
    await page.keyboard.press('Escape');
    await expect(menu.getByTestId('subtitle-menu')).toBeVisible();
  });
});
