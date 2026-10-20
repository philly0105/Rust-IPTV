import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

import type { Source } from '../src/api/types';
import { favorites, listSources, resetApp, rpc } from './helpers/api';
import { MOCK, MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { expectPlaying, resumeRecord } from './helpers/media';
import {
  addM3uFromFile,
  addM3uFromText,
  addM3uFromUrl,
  blurFocus,
  channelButton,
  channelList,
  channelRow,
  expectCardStat,
  gotoLive,
  playerRegion,
} from './helpers/ui';

// Check 7 (SC5): M3U from URL, pasted text and file upload; groups; search;
// number zap; favorites; EPG ribbon now/next from the playlist's XMLTV; re-importing a pasted
// playlist and replacing its text.

const URL_NAME = 'M3U from URL';
const TEXT_NAME = 'M3U from text';

/** A small hand-written playlist pointing at the mock's live HLS streams. */
const PASTED = [
  '#EXTM3U',
  `#EXTINF:-1 tvg-id="paste.one" tvg-chno="1" group-title="Pasted News",Pasted One`,
  `${MOCK}/xtream/live/demo/secret/101.m3u8`,
  `#EXTINF:-1 tvg-id="paste.two" tvg-chno="2" group-title="Pasted News",Pasted Two`,
  `${MOCK}/xtream/live/demo/secret/102.m3u8`,
  `#EXTINF:-1 tvg-id="paste.three" tvg-chno="3" group-title="Pasted Sports",Pasted Three`,
  `${MOCK}/xtream/live/demo/secret/108.m3u8`,
  '',
].join('\n');

/** What the pasted playlist is replaced with from its Edit dialog. */
const REPLACED = [
  '#EXTM3U',
  `#EXTINF:-1 tvg-id="replaced.one" tvg-chno="1" group-title="Replaced",Replaced One`,
  `${MOCK}/xtream/live/demo/secret/103.m3u8`,
  `#EXTINF:-1 tvg-id="replaced.two" tvg-chno="2" group-title="Replaced",Replaced Two`,
  `${MOCK}/xtream/live/demo/secret/104.m3u8`,
  '',
].join('\n');

/** A source card by its exact name. */
function sourceCard(page: Page, name: string) {
  return page.getByTestId('source-card').filter({ has: page.getByTestId('source-name').getByText(name, { exact: true }) });
}

test.describe.serial('m3u flow', () => {
  let source: Source;

  test.beforeAll(async ({ request }) => {
    await resetApp(request);
  });

  test('add from URL lists every channel and group', async ({ page }) => {
    source = await addM3uFromUrl(page, URL_NAME);
    expect(source.kind).toBe('m3u');
    expect(source.channelCount).toBe(MOCK_FACTS.m3uChannels);
    expect(source.radioCount).toBe(MOCK_FACTS.m3uRadio);
    // The playlist header's url-tvg becomes a detected EPG url.
    expect(source.epg.detectedUrls.some((u) => u.includes('/xmltv/sample.xml'))).toBe(true);
    await expectCardStat(page, URL_NAME, /^channels$/, MOCK_FACTS.m3uChannels);
    await expectCardStat(page, URL_NAME, /^radio$/, MOCK_FACTS.m3uRadio);

    await gotoLive(page, source.id);
    const groups = page.getByRole('navigation', { name: 'Groups' });
    await expect(groups.getByRole('link', { name: new RegExp(`^All channels ${MOCK_FACTS.m3uChannels}$`) })).toBeVisible();
    for (const g of MOCK_FACTS.m3uGroups) {
      await expect(groups.getByRole('link', { name: new RegExp(`^${g} \\d+$`) })).toBeVisible();
    }
    await expect(channelButton(page, 'BBC One')).toBeVisible();
  });

  test('a group link narrows the channel list', async ({ page }) => {
    await gotoLive(page, source.id);
    await page.getByRole('navigation', { name: 'Groups' }).getByRole('link', { name: /^Sports \d+$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${source.id}/live/[0-9a-f]+$`));
    await expect(channelButton(page, 'Sky Sports F1')).toBeVisible();
    await expect(channelButton(page, 'BBC One')).toHaveCount(0);
  });

  test('search filters the channel list', async ({ page }) => {
    await gotoLive(page, source.id);
    const before = await channelList(page).getByRole('listitem').count();
    await page.getByRole('searchbox', { name: 'Search channels' }).fill('sky');
    await expect(channelButton(page, 'BBC One')).toHaveCount(0);
    await expect(channelButton(page, 'Sky News')).toBeVisible();
    const rows = channelList(page).getByRole('button', { name: /^\d+, / });
    const names = await rows.allInnerTexts();
    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBeLessThan(before);
    for (const n of names) expect(n.toLowerCase()).toContain('sky');

    await page.getByRole('searchbox', { name: 'Search channels' }).fill('');
    await expect(channelButton(page, 'BBC One')).toBeVisible();
  });

  test('playing a channel starts HLS playback and shows the EPG ribbon now/next', async ({ page }) => {
    await gotoLive(page, source.id);
    // The row itself carries now-playing from the XMLTV guide.
    await expect(channelButton(page, 'BBC One')).toHaveAccessibleName(/^1, BBC One, now: .+/);
    await channelButton(page, 'BBC One').click();
    await expect(playerRegion(page).getByRole('heading', { level: 2, name: 'BBC One' })).toBeVisible();
    await expectPlaying(page, { advance: 2 });

    const ribbon = page.getByTestId('epg-ribbon');
    await expect(ribbon).toBeVisible();
    const now = ribbon.getByRole('button', { name: /, on now(, start over available)?$/ });
    await expect(now).toHaveCount(1);
    // The programme after "now" is in the timeline too.
    const blocks = ribbon.getByRole('group', { name: 'Timeline' }).getByRole('button');
    const labels = await blocks.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));
    const nowIndex = labels.findIndex((l) => /, on now(, start over available)?$/.test(l));
    expect(nowIndex).toBeGreaterThanOrEqual(0);
    expect(labels.length, 'a next programme follows the current one').toBeGreaterThan(nowIndex + 1);

    const rec = await resumeRecord(page);
    expect(rec?.source.isLive).toBe(true);
    expect(rec?.source.url).toContain('/xtream/live/demo/secret/101.m3u8');
  });

  test('typing 1 then 2 zaps to channel 12', async ({ page }) => {
    await gotoLive(page, source.id);
    await blurFocus(page);
    await page.keyboard.press('1');
    await expect(page.getByTestId('digit-osd')).toContainText('1');
    // The list tops out at 24, so no digit can extend 12: it tunes at once instead of after the
    // 1 s pause, and the digit OSD may never show "12" (useDigitEntry digitsComplete).
    await page.keyboard.press('2');
    await expect(playerRegion(page).getByRole('heading', { level: 2, name: 'ESPN' })).toBeVisible({ timeout: 8_000 });
    await expectPlaying(page, { advance: 1 });
    expect((await resumeRecord(page))?.source.title).toBe('ESPN');
  });

  test('favorite a channel and find it in /favorites', async ({ page }) => {
    await gotoLive(page, source.id);
    const row = channelRow(page, 'BBC News');
    await row.getByRole('button', { name: 'Add to favorites' }).click();
    await expect(row.getByRole('button', { name: 'Remove from favorites' })).toBeVisible();
    await expect.poll(async () => (await favorites(page.request)).map((f) => f.snapshot.title)).toContain('BBC News');

    await page.goto('/favorites');
    await expect(page.getByTestId('favorites-page')).toBeVisible();
    await expect(page.getByTestId('favorites-page').getByText('BBC News').first()).toBeVisible();

    await page.goto(`/s/${source.id}/favorites`);
    await expect(page.getByRole('main').getByText('BBC News').first()).toBeVisible();
  });

  test('add from pasted text', async ({ page }) => {
    const pasted = await addM3uFromText(page, TEXT_NAME, PASTED);
    expect(pasted.channelCount).toBe(3);
    await gotoLive(page, pasted.id);
    for (const name of ['Pasted One', 'Pasted Two', 'Pasted Three']) await expect(channelButton(page, name)).toBeVisible();
    const groups = page.getByRole('navigation', { name: 'Groups' });
    await expect(groups.getByRole('link', { name: /^Pasted News 2$/ })).toBeVisible();
    await expect(groups.getByRole('link', { name: /^Pasted Sports 1$/ })).toBeVisible();
    const raw = await rpc<{ text: string }>(page.request, 'm3u.raw', { sourceId: pasted.id });
    expect(raw.text).toContain('Pasted Three');
  });

  test('a pasted playlist re-imports from its card, and its text can be replaced', async ({ page }) => {
    const before = (await listSources(page.request)).find((s) => s.name === TEXT_NAME)!;
    expect(before, `${TEXT_NAME} from the previous test`).toBeTruthy();
    await page.goto('/sources');
    const card = sourceCard(page, TEXT_NAME);
    await expect(card.getByTestId('source-origin')).toHaveText('Pasted playlist');

    // There is no address to fetch again: the card's button re-reads the stored text.
    const reimported = page.waitForResponse((r) => r.url().endsWith('/api/rpc/sources.refresh'));
    await card.getByRole('button', { name: `Re-import ${TEXT_NAME}`, exact: true }).click();
    const res = await reimported;
    expect(res.ok(), 'the re-import succeeds').toBe(true);
    const after = (await res.json()) as Source;
    expect(after.id).toBe(before.id);
    expect(after.lastError ?? null).toBeNull();
    expect(after.channelCount).toBe(3);
    expect(Date.parse(after.lastRefreshAt!)).toBeGreaterThanOrEqual(Date.parse(before.lastRefreshAt!));
    await expect(card.getByTestId('source-error')).toHaveCount(0);

    // Edit: new text replaces the channels of the same source.
    await card.getByRole('button', { name: `Edit ${TEXT_NAME}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Edit ${TEXT_NAME}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('m3u-text-origin-note')).toBeVisible();
    const text = dialog.getByTestId('m3u-replace-text');
    await expect(text).toHaveAccessibleName('New playlist text');
    await expect(text).toHaveValue('');
    await text.fill(REPLACED);
    await expect(dialog.getByTestId('preview-channel-count')).toHaveText('2');
    await dialog.getByTestId('edit-source-save').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-toast-id]').filter({ hasText: `Saved ${TEXT_NAME}` })).toBeVisible();

    await expect
      .poll(async () => (await rpc<Source>(page.request, 'sources.get', { id: before.id })).channelCount, { timeout: 30_000, message: 'the new text is imported' })
      .toBe(2);
    // Still one source by that name, the same one.
    expect((await listSources(page.request)).filter((s) => s.name === TEXT_NAME).map((s) => s.id)).toEqual([before.id]);
    const raw = await rpc<{ text: string }>(page.request, 'm3u.raw', { sourceId: before.id });
    expect(raw.text).toContain('Replaced Two');
    expect(raw.text).not.toContain('Pasted Three');

    await gotoLive(page, before.id);
    for (const name of ['Replaced One', 'Replaced Two']) await expect(channelButton(page, name)).toBeVisible();
    await expect(channelButton(page, 'Pasted One')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Groups' }).getByRole('link', { name: /^Replaced 2$/ })).toBeVisible();
  });

  test('add from file upload', async ({ page }) => {
    // fixtures/sample.m3u targets the default mock port; retarget it when the mock runs elsewhere.
    const text = (await readFile(resolve(import.meta.dirname, '../fixtures/sample.m3u'), 'utf8')).replaceAll('http://127.0.0.1:7290', MOCK);
    const fromFile = await addM3uFromFile(page, 'M3U from file', { name: 'sample.m3u', buffer: Buffer.from(text, 'utf8') });
    expect(fromFile.channelCount).toBe(MOCK_FACTS.m3uChannels);
    expect(fromFile.radioCount).toBe(MOCK_FACTS.m3uRadio);
    await gotoLive(page, fromFile.id);
    await expect(channelButton(page, 'BBC One')).toBeVisible();
  });
});
