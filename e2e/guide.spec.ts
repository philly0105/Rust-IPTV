import type { Page } from '@playwright/test';

import type { ChannelEdit, GuideSearchHit, RecordingCapabilities, RecordingRule, Source } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { expect, test } from './helpers/fixtures';
import { expectPlaying, resumeRecord } from './helpers/media';
import { blurFocus } from './helpers/ui';

// Run 2 C5 guide UI against the mock M3U and its XMLTV (three days of programmes whose
// titles repeat across slots and channels): the URL-backed window with back and forward,
// Jump to date and time, guide search, Record series from a search hit, and the preview band.

const NAME = 'Guide M3U';

let source: Source;

test.describe.serial('guide: window, jump, search, series', () => {
  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    source = await ensureSource(request, 'm3u', NAME);
    // The playlist's url-tvg guide is fetched in the background; wait until search sees it.
    await expect
      .poll(async () => (await rpc<GuideSearchHit[]>(request, 'epg.search', { sourceId: source.id, query: 'news' })).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
  });

  const gotoGuide = async (page: Page) => {
    await page.goto(`/epg?source=${encodeURIComponent(source.id)}`);
    await expect(page.getByTestId('epg-grid')).toBeVisible();
  };
  const windowLabel = (page: Page) => page.getByTestId('guide-window');
  const atOf = (url: string) => new URL(url).searchParams.get('at');
  // textContent, as toHaveText reads it: innerText breaks the line before the sr-only ", Jump to date and time".
  const labelOf = async (page: Page) => ((await windowLabel(page).textContent()) ?? '').trim();

  test('the window lives in the URL: Later, Jump, back and forward', async ({ page }) => {
    // The live window's label moves on at every :00 and :30; a test that crossed one would
    // compare two different "now" windows. Timers keep running.
    await page.clock.setFixedTime(Date.now());
    await gotoGuide(page);
    const label0 = await labelOf(page);
    expect(atOf(page.url())).toBeNull();

    await page.getByRole('button', { name: '3 hours later' }).click();
    await expect(windowLabel(page)).not.toHaveText(label0);
    const label1 = await labelOf(page);
    const at1 = atOf(page.url());
    expect(at1).toMatch(/^\d+$/);

    // `t` opens Jump to date and time; tomorrow at the last slot of the day (always after `at1`).
    await blurFocus(page);
    await page.keyboard.press('t');
    const dialog = page.getByTestId('guide-jump');
    await expect(dialog).toBeVisible();
    const days = dialog.getByTestId('guide-jump-day');
    await expect(days).toHaveCount(16);
    await expect(days.nth(2)).toContainText(/today/i);
    await days.nth(3).click();
    await expect(days.nth(3)).toHaveAttribute('aria-checked', 'true');
    const time = dialog.getByRole('combobox', { name: 'Time' });
    await time.selectOption({ index: (await time.locator('option').count()) - 1 });
    await dialog.getByTestId('guide-jump-go').click();
    await expect(dialog).toBeHidden();
    // The window label names the day as a date ("Thu, Oct 15"), the way formatDay writes it.
    const tomorrow = await page.evaluate(() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
    });
    await expect(windowLabel(page)).toContainText(tomorrow);
    const at2 = atOf(page.url());
    expect(Number(at2)).toBeGreaterThan(Number(at1));
    const label2 = await labelOf(page);

    await page.goBack();
    await expect(windowLabel(page)).toHaveText(label1);
    expect(atOf(page.url())).toBe(at1);
    await page.goBack();
    await expect(windowLabel(page)).toHaveText(label0);
    expect(atOf(page.url())).toBeNull();
    await page.goForward();
    await page.goForward();
    await expect(windowLabel(page)).toHaveText(label2);
    expect(atOf(page.url())).toBe(at2);

    // A shared link opens the same window.
    await page.goto(`/epg?source=${encodeURIComponent(source.id)}&at=${at2}`);
    await expect(windowLabel(page)).toHaveText(label2);

    // The window label opens the dialog too; Now returns to the live window.
    await windowLabel(page).click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('guide-jump-now').click();
    await expect(dialog).toBeHidden();
    await expect(windowLabel(page)).toHaveText(label0);
    expect(atOf(page.url())).toBeNull();
  });

  test('search finds programmes by day; picking one moves the grid and marks the channel', async ({ page }) => {
    await gotoGuide(page);
    await blurFocus(page);
    await page.keyboard.press('/');
    const field = page.getByRole('searchbox', { name: 'Search the guide' });
    await expect(field).toBeFocused();

    await field.fill('n');
    const panel = page.getByTestId('guide-search-panel');
    await expect(panel).toHaveAttribute('data-state', 'hint');
    await field.fill('news');
    await expect(panel).toHaveAttribute('data-state', 'results');
    await expect(panel.getByTestId('guide-search-day').first()).toBeVisible();
    const hits = panel.getByTestId('guide-search-hit');
    expect(await hits.count()).toBeGreaterThan(0);

    await field.fill('zzzz no such programme');
    await expect(panel).toHaveAttribute('data-state', 'empty');
    await expect(panel).toContainText('Nothing matches “zzzz no such programme”');

    // Pick a hit that has not started: the grid moves to it.
    await field.fill('news');
    await expect(panel).toHaveAttribute('data-state', 'results');
    const later = hits.filter({ hasNot: page.getByTestId('guide-search-watch') }).last();
    const channel = (await later.locator('[data-hit]').getAttribute('aria-label'))!.split(', ').at(-2)!;
    await later.locator('[data-hit]').click();
    await expect(panel).toBeHidden();
    await expect.poll(() => atOf(page.url())).toMatch(/^\d+$/);
    const marked = page.locator('[data-highlighted]');
    await expect(marked).toHaveCount(1);
    await expect(marked).toContainText(channel);

    // Escape closes the panel first, then clears the field.
    await field.focus();
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(field).toHaveValue('news');
    await page.keyboard.press('Escape');
    await expect(field).toHaveValue('');
  });

  test('Record series from a search hit adds a rule once', async ({ page, request }) => {
    const caps = await rpc<RecordingCapabilities>(request, 'recordings.capabilities');
    test.skip(!caps.supported, 'recording is not available on this machine');

    await gotoGuide(page);
    const field = page.getByRole('searchbox', { name: 'Search the guide' });
    await field.fill('news');
    const panel = page.getByTestId('guide-search-panel');
    await expect(panel).toHaveAttribute('data-state', 'results');
    const hit = panel.getByTestId('guide-search-hit').first();
    const title = (await hit.locator('[data-hit]').getAttribute('aria-label'))!.split(', ')[0]!;

    await hit.getByTestId('program-record-series').click();
    const confirm = page.getByTestId('series-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(title);
    await confirm.getByTestId('series-confirm-ok').click();
    await expect(confirm).toBeHidden();
    // The toast itself; the sr-only live region repeats its text.
    await expect(page.locator('[data-toast-id]').filter({ hasText: `Recording every “${title}”` })).toBeVisible();

    const rules = await rpc<RecordingRule[]>(request, 'recordings.rules');
    expect(rules.filter((r) => r.title === title)).toHaveLength(1);
    // The same hit now shows the series as on.
    await expect(hit.getByTestId('program-record-series')).toHaveAttribute('aria-pressed', 'true');

    for (const r of rules) await rpc(request, 'recordings.removeRule', { id: r.id, keepScheduled: false });
  });

  // Review round 1: at 390 px the time controls ran off screen (Now at x 387-437), the window
  // label overflowed its h-8 box, and the search panel ran under the rail and past the edge.
  test('on a phone the time controls, the label and the search panel stay on screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoGuide(page);
    const inside = async (loc: ReturnType<Page['getByTestId']>, left: number) => {
      const box = (await loc.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(left - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(390.5);
    };
    const pageBox = (await page.getByTestId('epg-grid-page').boundingBox())!;
    const time = page.getByTestId('guide-time');
    await inside(time.getByRole('button', { name: 'Now' }), pageBox.x);
    await inside(time.getByRole('button', { name: '3 hours later' }), pageBox.x);
    await inside(windowLabel(page), pageBox.x);
    const overflow = await windowLabel(page).evaluate((el) => ({
      y: el.scrollHeight - el.clientHeight,
      x: el.scrollWidth - el.clientWidth,
    }));
    expect(overflow.y).toBeLessThanOrEqual(1);
    expect(overflow.x).toBeLessThanOrEqual(1);

    const field = page.getByRole('searchbox', { name: 'Search the guide' });
    await field.fill('news');
    const panel = page.getByTestId('guide-search-panel');
    await expect(panel).toHaveAttribute('data-state', 'results');
    await inside(panel, pageBox.x);
  });

  // Review round 1 (C2): the guide's channel rows had no menu, so rename and hide were missing there.
  test('a channel row’s menu renames the channel, by right click and from the keyboard', async ({ page, request }) => {
    await rpc(request, 'channels.reset', { sourceId: source.id });
    await gotoGuide(page);
    const cell = page.locator('[data-channel-row="0"]');
    // The cell also holds the number and the logo's initials; the name is its truncating span.
    const name = ((await cell.locator('span.truncate').textContent()) ?? '').trim();
    expect(name).not.toBe('');

    await cell.click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('aria-label', name);
    for (const item of ['Play', 'Add to list…', 'Rename…', 'Hide channel']) await expect(menu.getByRole('menuitem', { name: item, exact: true })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
    const dialog = page.getByTestId('channel-rename-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('channel-rename-input')).toHaveValue(name);
    await dialog.getByTestId('channel-rename-input').fill('Guide Desk');
    await page.getByTestId('channel-rename-save').click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await rpc<ChannelEdit[]>(request, 'channels.edits', { sourceId: source.id })).find((e) => e.originalName === name)?.name)
      .toBe('Guide Desk');
    await expect(cell.locator('span.truncate')).toHaveText('Guide Desk');

    // The keyboard's way in: the context-menu key in the grid opens the cursor row's menu.
    await cell.focus();
    await page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Rename…', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    await rpc(request, 'channels.reset', { sourceId: source.id });
  });

  // CB-GUIDE-PREVIEW: the band above the grid shows the programme under the keyboard cursor and
  // plays its channel. Under 1000 px tall it starts hidden; the toolbar opens it, and the choice
  // lasts across reloads. It needs 768 px of width and 700 px of height, and has no toggle below.
  test('the preview band follows the cursor, plays the channel and remembers being open', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoGuide(page);
    const band = page.getByTestId('guide-preview');
    const toggle = page.getByTestId('guide-preview-toggle');
    await expect(band).toHaveCount(0);
    await expect(toggle).toHaveAccessibleName('Show preview');
    await toggle.click();
    await expect(band).toBeVisible();
    await expect(band).toHaveAccessibleName('Programme preview');
    await expect(toggle).toHaveAccessibleName('Hide preview');

    // The keyboard cursor on the second channel's current programme; the pointer stays off the grid.
    await page.mouse.move(1, 1);
    const channel = ((await page.locator('[data-channel-row="1"] span.truncate').textContent()) ?? '').trim();
    expect(channel).not.toBe('');
    const cell = page.locator('button[data-cell-row="1"][aria-label*=", on now"]');
    await expect(cell).toHaveCount(1);
    const title = (await cell.getAttribute('title')) ?? '';
    await cell.focus();
    await expect(band.getByTestId('guide-preview-title')).toHaveText(title);
    await expect(band).toContainText(channel);
    // The XMLTV description of that programme.
    await expect(band.getByTestId('guide-preview-description')).not.toBeEmpty();

    // Watch live plays that channel in the band.
    await band.getByRole('button', { name: 'Watch live', exact: true }).click();
    await expect(band.locator('video')).toHaveCount(1);
    await expectPlaying(page, { advance: 1 });
    const rec = await resumeRecord(page);
    expect(rec?.source.isLive).toBe(true);
    expect(rec?.source.title).toBe(channel);
    await expect(page.locator('[data-channel-row="1"]').getByTestId('guide-playing-mark')).toBeVisible();

    // Open survives a reload; hidden does too.
    await page.reload();
    await expect(band).toBeVisible();
    await toggle.click();
    await expect(band).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('epg-grid')).toBeVisible();
    await expect(band).toHaveCount(0);
    await expect(toggle).toHaveAccessibleName('Show preview');

    // Opened, the band still gives way on a narrow or short window, and the toggle goes with it.
    await toggle.click();
    await expect(band).toBeVisible();
    for (const size of [
      { width: 760, height: 800 },
      { width: 1280, height: 690 },
    ]) {
      await page.setViewportSize(size);
      await expect(band, `${size.width}x${size.height}`).toHaveCount(0);
      await expect(toggle, `${size.width}x${size.height}`).toHaveCount(0);
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(band).toBeVisible();
    }
  });
});
