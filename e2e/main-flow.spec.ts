import type { Source, WatchlistEntry } from '../src/api/types';
import { resetApp, rpc } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { playFirstLiveChannel } from './helpers/portal';
import { addXtream, blurFocus, channelButton, gotoLive, playerRegion } from './helpers/ui';

// Check 12, the round's main flow in one go: add the mock Xtream portal, play a channel and see
// the zap banner, save a movie to My List from its poster, then open multi-view with two
// channels from the channel list's context menu.

const NAME = 'Main Flow Xtream';

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
