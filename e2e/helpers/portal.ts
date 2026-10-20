import { expect, type Page } from '@playwright/test';

import { favorites } from './api';
import { expectPlaying, resumeRecord } from './media';
import { channelButton, gotoLive, openAllTitlesGrid, playerRegion } from './ui';

/** Steps shared by the Xtream and Stalker flows (check 6). */

/** Opens the live view, plays the first channel and waits for HLS playback. */
export async function playFirstLiveChannel(page: Page, sourceId: string, channel = 'BBC One'): Promise<void> {
  await gotoLive(page, sourceId);
  for (const g of ['News', 'Sports', 'Entertainment']) {
    await expect(page.getByRole('navigation', { name: 'Groups' }).getByRole('link', { name: new RegExp(`^${g} \\d+$`) })).toBeVisible();
  }
  await channelButton(page, channel).click();
  await expect(playerRegion(page).getByRole('heading', { level: 2, name: channel, exact: true })).toBeVisible();
  await expectPlaying(page, { advance: 2 });
  const rec = await resumeRecord(page);
  expect(rec?.source.isLive).toBe(true);
}

/**
 * From a playing archive channel, picks the latest ended programme in the EPG
 * ribbon that offers catch-up and checks the player switched to a timeshift
 * source (`pathPart` is what the provider's archive url contains).
 */
export async function openCatchup(page: Page, pathPart: RegExp): Promise<void> {
  const ribbon = page.getByTestId('epg-ribbon');
  await expect(ribbon).toBeVisible();
  const past = ribbon.getByRole('group', { name: 'Timeline' }).getByRole('button', { name: /, catch-up available$/ });
  await expect(past.first()).toBeVisible();
  await past.last().click();
  await expect.poll(async () => (await resumeRecord(page))?.source.url ?? '').toMatch(pathPart);
  const rec = await resumeRecord(page);
  expect(rec?.source.isLive, 'catch-up plays as a seekable recording').toBe(false);
  // The archive (an MPEG-TS stream) actually plays.
  await expectPlaying(page, { advance: 1 });
  // The ribbon offers the way back to the live stream.
  await expect(ribbon.getByRole('button', { name: 'Back to live' })).toBeVisible();
}

/** Opens a movie detail page from the "All movies" category grid. */
export async function openMovieFromGrid(page: Page, sourceId: string, title: string): Promise<void> {
  await page.goto(`/s/${sourceId}/movies`);
  await expect(page.getByTestId('vod-landing-movie')).toBeVisible();
  await openAllTitlesGrid(page);
  await expect(page.getByTestId('vod-grid-movie')).toBeVisible();
  await expect(page.getByTestId('page-title')).toHaveText('All movies');
  const card = page.getByTestId('vod-grid-movie').getByRole('listbox').getByRole('option', { name: new RegExp(title) }).first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId('vod-movie-detail')).toBeVisible();
  await expect(page.getByTestId('vod-movie-detail').getByRole('heading', { level: 1, name: new RegExp(title) })).toBeVisible();
}

/** Plays the movie on its detail page and waits for it to advance; returns the media url. */
export async function playMovieOnDetail(page: Page): Promise<string> {
  await page.getByTestId('vod-movie-detail').getByRole('button', { name: 'Play', exact: true }).click();
  const nowPlaying = page.getByRole('region', { name: 'Now playing' });
  await expect(nowPlaying).toBeVisible();
  await expect(nowPlaying.getByRole('button', { name: 'Pause' })).toBeVisible();
  const st = await expectPlaying(page, { advance: 2 });
  expect(st.duration ?? 0).toBeGreaterThan(30);
  return st.src;
}

/**
 * Toggles the favorite from the detail page's More menu off and on, and checks /favorites. The
 * hero keeps My List, watched and download as buttons; the favorite is a menu item whose label
 * says which way it goes (Add to favorites, Remove from favorites).
 */
export async function favoriteFromDetail(page: Page, detailTestId: string, title: string): Promise<void> {
  const more = page.getByTestId(detailTestId).getByRole('button', { name: 'More actions', exact: true });
  const item = (name: string) => page.getByRole('menu').getByRole('menuitem', { name, exact: true });
  const isFav = async () => (await favorites(page.request)).some((f) => f.snapshot.title.includes(title));
  /** Opens the menu, checks it offers `offered` (the state the page shows), and picks it. */
  const toggle = async (offered: string) => {
    await more.click();
    await expect(item(offered)).toBeVisible();
    await item(offered).click();
    // The menu has played its exit before the next opens.
    await expect(page.getByRole('menu')).toHaveCount(0);
  };
  await toggle('Add to favorites');
  await expect.poll(isFav).toBe(true);
  // Toggle off and back on; each time the menu offers the other way.
  await toggle('Remove from favorites');
  await expect.poll(isFav).toBe(false);
  await toggle('Add to favorites');
  await expect.poll(isFav).toBe(true);
  await more.click();
  await expect(item('Remove from favorites')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto('/favorites');
  await expect(page.getByTestId('favorites-page')).toBeVisible();
  await expect(page.getByTestId('favorites-page').getByText(title).first()).toBeVisible();
}

/** Opens a series detail page, switches season tabs, and plays S01E01. Returns the media url. */
export async function playFirstEpisode(page: Page, sourceId: string, title: string): Promise<string> {
  await page.goto(`/s/${sourceId}/series`);
  await expect(page.getByTestId('vod-landing-series')).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: new RegExp(title) }).first().click();
  const detail = page.getByTestId('vod-series-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('heading', { level: 1, name: title })).toBeVisible();

  // Season tabs are driven by keyboard (roving tabindex): a pointer click is
  // intercepted by the DetailHero backdrop gradient (reported to U4).
  const seasons = detail.getByRole('tablist', { name: 'Seasons' });
  const s1 = seasons.getByRole('tab', { name: /^Season 1/ });
  const s2 = seasons.getByRole('tab', { name: /^Season 2/ });
  await expect(s1).toHaveAttribute('aria-selected', 'true');
  await s1.focus();
  await page.keyboard.press('ArrowRight');
  await expect(s2).toHaveAttribute('aria-selected', 'true');
  await expect(detail.getByRole('button', { name: /^Play S02E01/ })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(s1).toHaveAttribute('aria-selected', 'true');
  const ep = detail.getByRole('button', { name: /^Play S01E01/ }).first();
  await ep.focus();
  await page.keyboard.press('Enter');
  const st = await expectPlaying(page, { advance: 2 });
  return st.src;
}

/** Global search (header search box on /search) finds a movie by a word of its title. */
export async function searchFindsMovie(page: Page, query: string, title: string, sourceId: string): Promise<void> {
  await page.goto('/search');
  const box = page.getByRole('banner').getByRole('searchbox');
  await box.fill(query);
  const tab = page.getByRole('main').getByRole('tab', { name: /^Movies/ });
  await tab.click();
  const movies = page.getByRole('main').getByRole('tabpanel', { name: /^Movies/ });
  await expect(movies).toBeVisible();
  const hit = movies.getByRole('link', { name: new RegExp(title) }).first();
  await expect(hit).toBeVisible();
  await expect(hit).toHaveAttribute('href', new RegExp(`^/s/${sourceId}/movie/`));
  await hit.click();
  await expect(page.getByTestId('vod-movie-detail').getByRole('heading', { level: 1, name: new RegExp(title) })).toBeVisible();
}
