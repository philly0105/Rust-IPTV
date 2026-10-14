import { join } from 'node:path';

import type {
  CustomList,
  CustomListEntry,
  GuideSearchHit,
  RecordingCapabilities,
  RecordingRule,
  Source,
  WatchStats,
  WatchlistEntry,
} from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { expectPlaying } from './helpers/media';
import { openMovieFromGrid, playFirstLiveChannel, playMovieOnDetail } from './helpers/portal';
import { addXtream, blurFocus, channelButton, gotoLive, playerRegion } from './helpers/ui';

// Check 12, the round's main flow in one go: add the mock Xtream portal, play a channel and see
// the zap banner, save a movie to My List from its poster, then open multi-view with two
// channels from the channel list's context menu.
//
// Check 15 (Run 2), the second test: add the mock Xtream portal, rename a channel and hide
// another, build a list from two sources and zap through it, search the guide and add a series
// rule, load an .srt into a movie, filter movies by decade with Hide watched on, and see the
// time watched on the stats page.

const NAME = 'Main Flow Xtream';
const NAME2 = 'Main Flow 2 Xtream';
const PLAYLIST = 'Main Flow 2 Playlist';

/** Local date `YYYY-MM-DD` (the stats page asks with the browser's local day). */
function localDay(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test.afterAll(async ({ request }) => {
  // A series rule schedules real recordings: never leave one behind for later specs.
  for (const r of await rpc<RecordingRule[]>(request, 'recordings.rules')) {
    await rpc(request, 'recordings.removeRule', { id: r.id, keepScheduled: false });
  }
  await rpc(request, 'settings.update', { patch: { vodHideWatched: false } });
});

test('main flow: channel with zap banner, a movie in My List, multi-view with two channels', async ({ page, request }) => {
  test.setTimeout(180_000);
  await resetApp(request);

  // A fresh profile adds the portal through the Sources page.
  const source: Source = await addXtream(page, NAME);
  expect(source.channelCount).toBe(MOCK_FACTS.xtreamLive);

  // Live: play a channel, then zap by number; the banner names the new channel.
  await playFirstLiveChannel(page, source.id);
  const stage = playerRegion(page);
  await blurFocus(page);
  await page.keyboard.press('3');
  const banner = stage.getByTestId('zap-banner');
  await expect(banner).toBeVisible({ timeout: 8_000 });
  await expect(banner.getByTestId('zap-title')).toHaveText('CNN International');
  await expect(banner.getByTestId('zap-number')).toHaveText('3');

  // Movies: the poster's My List toggle saves the title without opening it.
  const { title } = MOCK_FACTS.firstMovie;
  await page.goto(`/s/${source.id}/movies`);
  await expect(page.getByTestId('vod-landing-movie')).toBeVisible();
  const toggle = page.getByTestId('vod-landing-movie').getByRole('button', { name: `Save ${title} to My List` }).first();
  await toggle.scrollIntoViewIfNeeded();
  await toggle.hover();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(`Added ${title} to My List`).first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/s/${source.id}/movies$`));
  await expect.poll(async () => (await rpc<WatchlistEntry[]>(request, 'watchlist.list', {})).map((e) => e.snapshot.title)).toEqual([title]);
  await page.goto('/my-list');
  await expect(page.getByTestId('mylist-row')).toHaveCount(1);
  await expect(page.getByTestId('mylist-row').first()).toContainText(title);

  // Multi-view: "Add to multi-view" on two channels; each add opens the wall.
  for (const [i, name] of ['BBC One', 'BBC News'].entries()) {
    await gotoLive(page, source.id);
    await channelButton(page, name).click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Add to multi-view' }).click();
    await expect(page).toHaveURL(/\/multiview$/);
    await expect(page.getByTestId('multiview-tile')).toHaveCount(i + 1);
  }
  const tiles = page.getByTestId('multiview-tile');
  await expect(tiles.filter({ hasText: 'BBC One' })).toHaveCount(1);
  await expect(tiles.filter({ hasText: 'BBC News' })).toHaveCount(1);
  // Both tiles play: each video has data and its clock moves on.
  const clocks = () =>
    page.getByTestId('multiview-video').evaluateAll((els) =>
      els.map((el) => {
        const v = el as HTMLVideoElement;
        return v.readyState >= 3 && !v.paused && !v.error ? v.currentTime : -1;
      }),
    );
  await expect.poll(async () => (await clocks()).filter((t) => t >= 0).length, { timeout: 45_000 }).toBe(2);
  const t0 = await clocks();
  await expect.poll(async () => (await clocks()).every((t, i) => t - (t0[i] ?? 0) >= 1), { timeout: 30_000 }).toBe(true);
});

test('main flow (Run 2): rename and hide, a two-source list, guide search and a series rule, subtitles, decades, stats', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  await resetApp(request);
  for (const l of await rpc<CustomList[]>(request, 'lists.list')) await rpc(request, 'lists.remove', { id: l.id });
  await rpc(request, 'stats.clear');
  const toast = (text: string) => page.locator('[data-toast-id]').filter({ hasText: text });
  const rows = page.getByTestId('channel-list').locator('button[data-row-index]');

  // 1. The portal through the Sources page, and a playlist for the list's second source.
  const xtream: Source = await addXtream(page, NAME2);
  const playlist = await ensureSource(request, 'm3u', PLAYLIST);

  // 2. Rename one channel from its menu, hide another with Shift+Delete.
  await gotoLive(page, xtream.id);
  await channelButton(page, 'BBC One').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  const rename = page.getByTestId('channel-rename-dialog');
  await expect(rename).toBeVisible();
  await rename.getByTestId('channel-rename-input').fill('Morning Desk');
  await rename.getByTestId('channel-rename-save').click();
  await expect(rename).toBeHidden();
  await expect(channelButton(page, 'Morning Desk')).toBeVisible();
  await channelButton(page, 'BBC News').focus();
  await page.keyboard.press('Shift+Delete');
  await expect(toast('BBC News hidden')).toBeVisible();
  await expect(channelButton(page, 'BBC News')).toHaveCount(0);

  // 3. A list from two sources: L on the renamed channel starts it, the playlist's menu adds to it.
  await channelButton(page, 'Morning Desk').focus();
  await page.keyboard.press('l');
  const picker = page.getByTestId('list-picker');
  await expect(picker).toBeVisible();
  await picker.getByLabel('New list name').fill('Main flow');
  await picker.getByRole('button', { name: 'Create' }).click();
  await expect(picker.getByRole('checkbox', { checked: true })).toHaveCount(1);
  await picker.getByRole('button', { name: 'Done' }).click();
  await expect(picker).toBeHidden();

  await gotoLive(page, playlist.id);
  await rows.first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to list…' }).click();
  await expect(picker).toBeVisible();
  // The check box is visually hidden under its drawn box, so click the row's label as a user would.
  const option = picker.getByTestId('list-picker-options').locator('label').first();
  await option.click();
  await expect(option.getByRole('checkbox')).toBeChecked();
  await picker.getByRole('button', { name: 'Done' }).click();
  await expect(picker).toBeHidden();
  const [list] = await rpc<CustomList[]>(request, 'lists.list');
  expect(list?.name).toBe('Main flow');
  await expect
    .poll(async () => (await rpc<CustomListEntry[]>(request, 'lists.items', { id: list!.id })).map((e) => e.ref.sourceId))
    .toEqual([xtream.id, playlist.id]);
  const second = (await rpc<CustomListEntry[]>(request, 'lists.items', { id: list!.id }))[1]!;

  // Zap through the list: Page Down goes on to the playlist's channel, Page Up comes back.
  await page.getByTestId('lists-section').getByRole('link', { name: /Main flow/ }).click();
  await expect(page).toHaveURL(new RegExp(`/lists/${list!.id}$`));
  const listRows = page.getByTestId('list-page').getByTestId('channel-list').locator('button[data-row-index]');
  await expect(listRows).toHaveCount(2);
  await listRows.first().click();
  await expectPlaying(page, { advance: 1 });
  await blurFocus(page);
  await page.keyboard.press('PageDown');
  const banner = page.getByTestId('zap-banner');
  await expect(banner).toBeVisible({ timeout: 8_000 });
  await expect(banner.getByTestId('zap-title')).toContainText(second.snapshot.title);
  await blurFocus(page);
  await page.keyboard.press('PageUp');
  await expect(banner.getByTestId('zap-title')).toHaveText('Morning Desk');

  // 4. Guide search, and a series rule from a hit (where this machine can record).
  await expect
    .poll(async () => (await rpc<GuideSearchHit[]>(request, 'epg.search', { sourceId: xtream.id, query: 'news' })).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  await page.goto(`/epg?source=${encodeURIComponent(xtream.id)}`);
  await expect(page.getByTestId('epg-grid')).toBeVisible();
  await blurFocus(page);
  await page.keyboard.press('/');
  const field = page.getByRole('searchbox', { name: 'Search the guide' });
  await expect(field).toBeFocused();
  await field.fill('news');
  const panel = page.getByTestId('guide-search-panel');
  await expect(panel).toHaveAttribute('data-state', 'results');
  const caps = await rpc<RecordingCapabilities>(request, 'recordings.capabilities');
  if (caps.supported) {
    const hit = panel.getByTestId('guide-search-hit').first();
    const title = (await hit.locator('[data-hit]').getAttribute('aria-label'))!.split(', ')[0]!;
    await hit.getByTestId('program-record-series').click();
    const confirm = page.getByTestId('series-confirm');
    await expect(confirm).toContainText(title);
    await confirm.getByTestId('series-confirm-ok').click();
    await expect(toast(`Recording every “${title}”`)).toBeVisible();
    await expect.poll(async () => (await rpc<RecordingRule[]>(request, 'recordings.rules')).map((r) => r.title)).toEqual([title]);
  }

  // 5. An .srt file in a movie, from the player's subtitle menu (Shift+C).
  await openMovieFromGrid(page, xtream.id, MOCK_FACTS.firstMovie.title);
  await playMovieOnDetail(page);
  await blurFocus(page);
  await page.keyboard.press('Shift+C');
  const menu = page.getByRole('menu', { name: 'Playback options' });
  await expect(menu.getByTestId('subtitle-menu')).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await menu.getByTestId('subtitle-load').click();
  await (await chooser).setFiles(join(import.meta.dirname, 'fixtures', 'subtitles', 'sample.srt'));
  await expect(toast('Showing subtitles from sample.srt')).toBeVisible();

  // 6. Movies by decade with Hide watched on: the watched film drops out of the 2020s.
  const film = { sourceId: xtream.id, contentType: 'movie' as const, itemId: MOCK_FACTS.firstMovie.id };
  await rpc(request, 'userstate.setWatched', { ref: film, watched: true });
  await page.goto(`/s/${xtream.id}/movies/c/all?sort=name`);
  const options = page.getByTestId('vod-grid-movie').getByRole('listbox').getByRole('option');
  await expect(options.first()).toBeVisible();
  const hide = page.getByRole('switch', { name: 'Hide watched' });
  await hide.click();
  await expect(hide).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('vod-filter-bar').getByRole('group', { name: 'Year' }).getByRole('button', { name: /^2020s, \d+ titles$/ }).click();
  await expect(page).toHaveURL(/[?&]yf=2020&yt=2029/);
  await expect(options.first()).toBeVisible();
  await expect(options.filter({ hasText: MOCK_FACTS.firstMovie.title })).toHaveCount(0);

  // 7. The stats page counts what played above: the list's channels and the film.
  await expect
    .poll(async () => (await rpc<WatchStats>(request, 'stats.summary', { days: 7, today: localDay() })).totalSeconds, { timeout: 15_000 })
    .toBeGreaterThan(0);
  await page.goto('/stats');
  await expect(page.getByTestId('stats-page')).toBeVisible();
  await expect(page.getByTestId('stats-total')).toContainText('watched in the last 7 days');
  await expect(page.getByTestId('stats-total')).not.toHaveText(/^0 min/);
  await expect(page.getByTestId('stats-top-titles')).toContainText(MOCK_FACTS.firstMovie.title);
});
