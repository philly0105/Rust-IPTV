import type { APIRequestContext } from '@playwright/test';

import type { Download, Page as RpcPage, SeriesDetail, SeriesItem, Source, VodItem } from '../src/api/types';
import { resetApp, rpc } from './helpers/api';
import { MOCK } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { resumeRecord } from './helpers/media';
import { playFirstEpisode, playMovieOnDetail } from './helpers/portal';
import { addM3uFromText, channelButton, gotoLive } from './helpers/ui';

// Films and series in a plain M3U playlist (F-M3U-SERIES, crates/iptv-core src/m3u/series.rs).
// Entries named "Show S01E02" group into one series with seasons and never show up as movies;
// a movie entry with its own User-Agent (#EXTVLCOPT) plays through the server's media proxy with
// that header, and downloads as an .mp4 with it. The streams are the mock's Xtream VOD files,
// which answer any id with fixtures/sample.mp4 (crates/iptv-mock src/xtream.rs, vod_file).

const NAME = 'M3U VOD';
const SHOW = 'Harbor Lights';
const MOVIE = 'Black Harbor (2026)';
const MOVIE_URL = `${MOCK}/xtream/movie/demo/secret/201.mp4`;
const UA = 'TsrustE2E/1.0';

const PLAYLIST = [
  '#EXTM3U',
  `#EXTINF:-1 tvg-id="vod.news" tvg-chno="1" group-title="VOD News",VOD News One`,
  `${MOCK}/xtream/live/demo/secret/101.m3u8`,
  `#EXTINF:-1 group-title="Series | Drama",${SHOW} S01E01`,
  `${MOCK}/xtream/series/demo/secret/3001.mp4`,
  `#EXTINF:-1 group-title="Series | Drama",${SHOW} S01E02`,
  `${MOCK}/xtream/series/demo/secret/3002.mp4`,
  `#EXTINF:-1 group-title="Series | Drama",${SHOW} S02E01`,
  `${MOCK}/xtream/series/demo/secret/3003.mp4`,
  `#EXTINF:-1 group-title="Movies | Thriller",${MOVIE}`,
  `#EXTVLCOPT:http-user-agent=${UA}`,
  MOVIE_URL,
  '',
].join('\n');

/** Downloads outlive their source, and a start for a title already downloaded answers with that row: drop this spec's file. */
async function removeMovieDownloads(request: APIRequestContext): Promise<void> {
  for (const d of await rpc<Download[]>(request, 'downloads.list')) {
    if (d.url === MOVIE_URL) await rpc(request, 'downloads.remove', { id: d.id, deleteFile: true });
  }
}

test.describe.serial('m3u movies and series', () => {
  let source: Source;

  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    await removeMovieDownloads(request);
  });

  test.afterAll(async ({ request }) => {
    await removeMovieDownloads(request);
  });

  test('episodes group into one series with two seasons, and none of them is a movie', async ({ page }) => {
    source = await addM3uFromText(page, NAME, PLAYLIST);
    expect(source.channelCount).toBe(1);
    expect(source.movieCount, 'episodes are not movies').toBe(1);
    expect(source.seriesCount).toBe(1);

    const movies = await rpc<RpcPage<VodItem>>(page.request, 'catalog.movies', { sourceId: source.id, query: { offset: 0, limit: 50 } });
    expect(movies.items.map((m) => m.title)).toEqual([MOVIE]);
    const series = await rpc<RpcPage<SeriesItem>>(page.request, 'catalog.series', { sourceId: source.id, query: { offset: 0, limit: 50 } });
    expect(series.items.map((s) => s.title)).toEqual([SHOW]);
    const detail = await rpc<SeriesDetail>(page.request, 'm3u.seriesDetail', { ref: series.items[0]!.ref });
    expect(detail.seasons.map((s) => [s.number, s.episodes.map((e) => e.episode)])).toEqual([
      [1, [1, 2]],
      [2, [1]],
    ]);

    // The live channel stays a channel.
    await gotoLive(page, source.id);
    await expect(channelButton(page, 'VOD News One')).toBeVisible();

    // Movies lists the film and no episode.
    await page.goto(`/s/${source.id}/movies`);
    await expect(page.getByTestId('vod-landing-movie')).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: /Black Harbor/ }).first()).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: new RegExp(SHOW) })).toHaveCount(0);

    // Series: one show, season tabs, and S01E01 plays from its own entry's URL.
    const src = await playFirstEpisode(page, source.id, SHOW);
    expect(src).toContain('/xtream/series/demo/secret/3001.mp4');
    const seriesDetail = page.getByTestId('vod-series-detail');
    await expect(seriesDetail.getByRole('tablist', { name: 'Seasons' }).getByRole('tab')).toHaveCount(2);
    await expect(seriesDetail.getByRole('list', { name: 'Episodes' }).getByRole('listitem')).toHaveCount(2);
    const rec = await resumeRecord(page);
    expect(rec?.source.isLive).toBe(false);
    expect(rec?.source.ref?.itemId).toBe(series.items[0]!.ref.itemId);
  });

  test('a movie plays through the proxy with its User-Agent and downloads as an .mp4', async ({ page }) => {
    await page.goto(`/s/${source.id}/movies`);
    await expect(page.getByTestId('vod-landing-movie')).toBeVisible();
    await page.getByRole('main').getByRole('link', { name: /Black Harbor/ }).first().click();
    const detail = page.getByTestId('vod-movie-detail');
    await expect(detail.getByRole('heading', { level: 1, name: /Black Harbor/ })).toBeVisible();

    // The browser cannot set a User-Agent itself, so the stream goes through /api/proxy, which sends it.
    const src = new URL(await playMovieOnDetail(page));
    expect(src.pathname).toBe('/api/proxy');
    expect(src.searchParams.get('url')).toBe(MOVIE_URL);
    expect(src.searchParams.get('ua')).toBe(UA);
    expect((await resumeRecord(page))?.source.url).toBe(MOVIE_URL);

    // Download: the request carries the entry's header, and the file lands as an .mp4.
    const started = page.waitForRequest((r) => r.url().endsWith('/api/rpc/downloads.start'));
    const button = page.getByTestId('vod-download-button');
    await expect(button).toHaveCount(1);
    await expect(button).toHaveAccessibleName('Download');
    await button.click();
    const args = (await started).postDataJSON() as { url: string; headers?: { userAgent?: string }; fileNameHint?: string };
    expect(args.url).toBe(MOVIE_URL);
    expect(args.headers?.userAgent).toBe(UA);
    expect(args.fileNameHint).toMatch(/\.mp4$/);
    await expect(page.locator('[data-toast-id]').filter({ hasText: 'Download queued' })).toBeVisible();

    await expect
      .poll(
        async () => {
          const d = (await rpc<Download[]>(page.request, 'downloads.list')).find((x) => x.url === MOVIE_URL && x.ref.sourceId === source.id);
          if (d?.status === 'failed') throw new Error(`download failed: ${d.errorMessage}`);
          return d ? `${d.status} ${d.fileName ?? ''}` : 'none';
        },
        { timeout: 30_000, message: 'the movie download completes' },
      )
      .toMatch(/^completed .+\.mp4$/);
    await expect(button).toHaveAccessibleName('Downloaded', { timeout: 15_000 });
  });
});
