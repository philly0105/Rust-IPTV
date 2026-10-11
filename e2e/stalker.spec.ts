import type { Source } from '../src/api/types';
import { resetApp } from './helpers/api';
import { MOCK, STALKER } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { expectPlaying } from './helpers/media';
import { favoriteFromDetail, openCatchup, openMovieFromGrid, playFirstEpisode, playFirstLiveChannel, playMovieOnDetail, searchFindsMovie } from './helpers/portal';
import { addGlobalEpgUrl, addStalker } from './helpers/ui';

// Check 6 (SC4), Stalker half: add the mock portal with the registered MAC
// through the UI, then the same live/catch-up/movies/series/favorites/search
// journey as Xtream. The mock maps every Stalker link onto its Xtream media.

const NAME = 'Mock Stalker';

test.describe.serial('stalker flow', () => {
  let source: Source;

  test.beforeAll(async ({ request }) => {
    await resetApp(request);
  });

  test('add the portal with the registered MAC', async ({ page }) => {
    source = await addStalker(page, NAME);
    expect(source.kind).toBe('stalker');
    expect(source.channelCount).toBeGreaterThanOrEqual(30);
    await expect(page.getByTestId('source-card').filter({ hasText: NAME })).toBeVisible();
    expect(STALKER.macAddress).toBe('00:1A:79:00:00:01');
  });

  test('live: browse groups and play a channel', async ({ page }) => {
    await playFirstLiveChannel(page, source.id);
  });

  test('live: catch-up opens an archive link', async ({ page }) => {
    // The live view merges the portal's own guide (stalker.epg) with XMLTV, but
    // the portal guide carries only now/next. Past programmes (the catch-up
    // targets) come from a global XMLTV address, added the way a user would;
    // the portal's xmltv_id values match the mock guide's channel ids.
    await addGlobalEpgUrl(page, `${MOCK}/xmltv/sample.xml`);
    await playFirstLiveChannel(page, source.id);
    await openCatchup(page, /\/xtream\/timeshift\/demo\/secret\/\d+\/\d{4}-\d{2}-\d{2}:\d{2}-\d{2}\/101\.m3u8/);
  });

  test('movies: grid, detail page, and playback', async ({ page }) => {
    await openMovieFromGrid(page, source.id, 'Black Harbor');
    const src = await playMovieOnDetail(page);
    // Stalker media goes through the server's header proxy (/api/proxy?url=...).
    expect(decodeURIComponent(src)).toContain('/xtream/movie/demo/secret/201.mp4');
  });

  test('movies: favorite toggles and appears in /favorites', async ({ page }) => {
    await page.goto(`/s/${source.id}/movie/5001`);
    await expect(page.getByTestId('vod-movie-detail')).toBeVisible();
    await favoriteFromDetail(page, 'vod-movie-detail', 'Black Harbor');
  });

  test('series: seasons and episode playback', async ({ page }) => {
    const src = await playFirstEpisode(page, source.id, 'Harbor Lights');
    expect(decodeURIComponent(src)).toMatch(/\/xtream\/series\/demo\/secret\/3001\.mp4/);
  });

  test('box set filed among the films opens as a series and plays an episode', async ({ page }) => {
    // The mock's VOD-as-series row (fixtures/README.md, "Stalker VOD-as-series
    // row"): id 5030 in category 11, two seasons of 3 and 2 episodes.
    await page.goto('/search');
    await page.getByRole('banner').getByRole('searchbox').fill('lantern');
    const hit = page.getByRole('main').getByRole('link', { name: /The Lantern Keepers/ }).first();
    await expect(hit).toBeVisible();
    await expect(hit).toHaveAttribute('href', new RegExp(`^/s/${source.id}/series/`));
    await expect(page.getByRole('main').getByRole('region', { name: /^Series/ }).getByRole('link', { name: /The Lantern Keepers/ })).toBeVisible();
    await hit.click();

    const detail = page.getByTestId('vod-series-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('heading', { level: 1, name: 'The Lantern Keepers' })).toBeVisible();
    const seasons = detail.getByRole('tablist', { name: 'Seasons' });
    await expect(seasons.getByRole('tab')).toHaveCount(2);
    const s1 = seasons.getByRole('tab', { name: /^Season 1/ });
    const s2 = seasons.getByRole('tab', { name: /^Season 2/ });
    const episodes = detail.getByRole('list', { name: 'Episodes' }).getByRole('listitem');
    await expect(s1).toHaveAttribute('aria-selected', 'true');
    await expect(episodes).toHaveCount(3);
    for (const title of ['The Lamp Room', 'Fog Signal', 'Low Tide Ledger']) {
      await expect(detail.getByRole('button', { name: new RegExp(`^Play S01E[0-9]+ ${title}$`) })).toBeVisible();
    }
    // Keyboard, as in playFirstEpisode: the hero backdrop intercepts pointer clicks on the tabs.
    await s1.focus();
    await page.keyboard.press('ArrowRight');
    await expect(s2).toHaveAttribute('aria-selected', 'true');
    await expect(episodes).toHaveCount(2);
    for (const title of ['The Relief Keeper', 'Last Light']) {
      await expect(detail.getByRole('button', { name: new RegExp(`^Play S02E[0-9]+ ${title}$`) })).toBeVisible();
    }
    await page.keyboard.press('ArrowLeft');
    await expect(s1).toHaveAttribute('aria-selected', 'true');

    const fog = detail.getByRole('button', { name: /^Play S01E02 Fog Signal$/ });
    await fog.focus();
    await page.keyboard.press('Enter');
    const st = await expectPlaying(page, { advance: 2 });
    expect(st.src).toContain('/api/proxy');
    expect(decodeURIComponent(st.src)).toContain('/xtream/series/demo/secret/503012.mp4');
  });

  test('search finds a movie', async ({ page }) => {
    await searchFindsMovie(page, 'paper astro', 'The Paper Astronaut', source.id);
  });
});
