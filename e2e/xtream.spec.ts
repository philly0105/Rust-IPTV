import type { Source } from '../src/api/types';
import { resetApp } from './helpers/api';
import { MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { favoriteFromDetail, openCatchup, openMovieFromGrid, playFirstEpisode, playFirstLiveChannel, playMovieOnDetail, searchFindsMovie } from './helpers/portal';
import { addXtream, expectCardStat } from './helpers/ui';

// Check 6 (SC4), Xtream half: add the mock portal through the UI, browse
// live/movies/series, open details, play, favorite, search, catch-up.

const NAME = 'Mock Xtream';

test.describe.serial('xtream flow', () => {
  let source: Source;

  test.beforeAll(async ({ request }) => {
    await resetApp(request);
  });

  test('add the portal through the Sources page', async ({ page }) => {
    source = await addXtream(page, NAME);
    expect(source.kind).toBe('xtream');
    expect(source.channelCount).toBe(MOCK_FACTS.xtreamLive);
    expect(source.radioCount).toBe(MOCK_FACTS.xtreamRadio);
    expect(source.movieCount).toBe(MOCK_FACTS.xtreamMovies);
    expect(source.seriesCount).toBe(MOCK_FACTS.xtreamSeries);
    // Sync records the portal's XMLTV endpoint as a detected guide.
    expect(source.epg.detectedUrls.some((u) => u.includes('/xtream/xmltv.php'))).toBe(true);
    await expectCardStat(page, NAME, /^channels$/, MOCK_FACTS.xtreamLive);
    await expectCardStat(page, NAME, /^radio$/, MOCK_FACTS.xtreamRadio);
  });

  test('live: browse groups and play a channel', async ({ page }) => {
    await playFirstLiveChannel(page, source.id);
  });

  test('live: catch-up opens a timeshift source', async ({ page }) => {
    await playFirstLiveChannel(page, source.id);
    await openCatchup(page, /\/xtream\/timeshift\/demo\/secret\/\d+\/\d{4}-\d{2}-\d{2}:\d{2}-\d{2}\/101\.ts/);
  });

  test('movies: grid, detail page, and playback', async ({ page }) => {
    await openMovieFromGrid(page, source.id, MOCK_FACTS.firstMovie.title);
    await expect(page.getByTestId('vod-movie-detail').getByRole('heading', { name: 'Cast' })).toBeVisible();
    const src = await playMovieOnDetail(page);
    expect(src).toContain(`/xtream/movie/demo/secret/${MOCK_FACTS.firstMovie.id}.mp4`);
  });

  test('movies: favorite toggles and appears in /favorites', async ({ page }) => {
    await page.goto(`/s/${source.id}/movie/${MOCK_FACTS.firstMovie.id}`);
    await expect(page.getByTestId('vod-movie-detail')).toBeVisible();
    await favoriteFromDetail(page, 'vod-movie-detail', MOCK_FACTS.firstMovie.title);
  });

  test('series: seasons and episode playback', async ({ page }) => {
    const src = await playFirstEpisode(page, source.id, MOCK_FACTS.firstSeries.title);
    expect(src).toMatch(/\/xtream\/series\/demo\/secret\/3001\.mp4/);
  });

  test('search finds a movie', async ({ page }) => {
    await searchFindsMovie(page, 'paper astro', 'The Paper Astronaut', source.id);
  });
});
