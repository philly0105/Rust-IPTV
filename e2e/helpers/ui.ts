import { expect, type Locator, type Page } from '@playwright/test';

import type { EpgSourceStatus, Source } from '../../src/api/types';
import { listSources, rpc } from './api';
import { M3U_URL, STALKER, XTREAM } from './env';

/** The add-source dialog, opened through the Sources page button (or the onboarding tile on a fresh install). */
export async function openAddSourceDialog(page: Page): Promise<Locator> {
  await page.goto('/sources');
  await expect(page.getByTestId('sources-page')).toBeVisible();
  const add = page.getByTestId('sources-add');
  const tile = page.getByTestId('onboard-m3u');
  await expect(add.or(tile).first()).toBeVisible();
  if (await add.isVisible()) await add.click();
  else await tile.click();
  const dialog = page.getByRole('dialog', { name: 'Add a source' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Submits the add-source dialog and waits for the import to finish: the dialog
 * closes on success; on failure the dialog shows `add-source-error`, which this
 * turns into a test failure with the message. Returns the new source.
 */
export async function submitAndWaitForImport(page: Page, dialog: Locator, name: string): Promise<Source> {
  await page.getByTestId('add-source-submit').click();
  const error = page.getByTestId('add-source-error');
  await expect
    .poll(
      async () => {
        if (await error.isVisible()) throw new Error(`import failed: ${await error.innerText()}`);
        return dialog.isVisible();
      },
      { timeout: 90_000, message: 'add-source dialog should close when the import is done' },
    )
    .toBe(false);
  const source = (await listSources(page.request)).find((s) => s.name === name);
  if (!source) throw new Error(`source "${name}" not in sources.list after import`);
  expect(source.lastError, `import error for ${name}`).toBeFalsy();
  expect(source.lastRefreshAt, `${name} has a refresh timestamp`).toBeTruthy();
  return source;
}

/** Name first: the URL field suggests a name on blur only while the name is untouched. */
async function fillName(dialog: Locator, name: string): Promise<void> {
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
}

export async function addM3uFromUrl(page: Page, name: string, url: string = M3U_URL): Promise<Source> {
  const dialog = await openAddSourceDialog(page);
  await dialog.getByRole('tab', { name: 'M3U playlist' }).click();
  await fillName(dialog, name);
  await dialog.getByRole('tab', { name: 'URL' }).click();
  await dialog.getByRole('textbox', { name: 'Playlist URL' }).fill(url);
  return submitAndWaitForImport(page, dialog, name);
}

export async function addM3uFromText(page: Page, name: string, text: string): Promise<Source> {
  const dialog = await openAddSourceDialog(page);
  await dialog.getByRole('tab', { name: 'M3U playlist' }).click();
  await fillName(dialog, name);
  await dialog.getByRole('tab', { name: 'Paste' }).click();
  await dialog.getByRole('textbox', { name: /playlist/i }).fill(text);
  // The preview parses the pasted text before submit.
  await expect(dialog.getByTestId('preview-channel-count')).toBeVisible();
  return submitAndWaitForImport(page, dialog, name);
}

export async function addM3uFromFile(page: Page, name: string, file: { name: string; buffer: Buffer }): Promise<Source> {
  const dialog = await openAddSourceDialog(page);
  await dialog.getByRole('tab', { name: 'M3U playlist' }).click();
  await fillName(dialog, name);
  await dialog.getByRole('tab', { name: 'File' }).click();
  await dialog.getByTestId('m3u-file-input').setInputFiles({ name: file.name, mimeType: 'audio/x-mpegurl', buffer: file.buffer });
  await expect(dialog.getByText(file.name)).toBeVisible();
  await expect(dialog.getByTestId('preview-channel-count')).toBeVisible();
  return submitAndWaitForImport(page, dialog, name);
}

export async function addXtream(page: Page, name: string): Promise<Source> {
  const dialog = await openAddSourceDialog(page);
  await dialog.getByRole('tab', { name: 'Xtream Codes' }).click();
  await fillName(dialog, name);
  await dialog.getByRole('textbox', { name: 'Server URL' }).fill(XTREAM.serverUrl);
  await dialog.getByRole('textbox', { name: 'Username', exact: true }).fill(XTREAM.username);
  await dialog.getByRole('textbox', { name: 'Password', exact: true }).fill(XTREAM.password);
  return submitAndWaitForImport(page, dialog, name);
}

export async function addStalker(page: Page, name: string): Promise<Source> {
  const dialog = await openAddSourceDialog(page);
  await dialog.getByRole('tab', { name: 'Stalker portal' }).click();
  await fillName(dialog, name);
  await dialog.getByRole('textbox', { name: 'Portal URL' }).fill(STALKER.portalUrl);
  await dialog.getByRole('textbox', { name: 'MAC address' }).fill(STALKER.macAddress);
  return submitAndWaitForImport(page, dialog, name);
}

/** The live channel list of the current page. */
export function channelList(page: Page): Locator {
  return page.getByRole('list', { name: 'Channels' });
}

/** Accessible name of a channel row button: "<number>, <name>, now: ...". */
export function channelName(name: string): RegExp {
  return new RegExp(`^(\\d+, )?${escapeRe(name)}(,|$)`);
}

/** A channel row button in the live list. */
export function channelButton(page: Page, name: string | RegExp): Locator {
  return channelList(page).getByRole('button', { name: typeof name === 'string' ? channelName(name) : name });
}

/** The list item (row plus its favorite button) of a channel. */
export function channelRow(page: Page, name: string): Locator {
  return channelList(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: channelName(name) }) });
}

/** The "Player" region of the live view (stage + EPG ribbon). */
export function playerRegion(page: Page): Locator {
  return page.getByRole('region', { name: 'Player' });
}

export async function gotoLive(page: Page, sourceId: string, categoryId?: string): Promise<void> {
  await page.goto(categoryId ? `/s/${sourceId}/live/${categoryId}` : `/s/${sourceId}/live`);
  await expect(page.getByTestId('live-page')).toBeVisible();
  await expect(channelList(page).getByRole('listitem').first()).toBeVisible();
}

/** Moves focus off any control so global single-key shortcuts reach the shell registry. */
export async function blurFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.activeElement;
    if (el instanceof HTMLElement) el.blur();
  });
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The named source card's visible stat whose label matches `label` (`channels`, `radio`) reads `value`. */
export async function expectCardStat(page: Page, name: string, label: RegExp, value: number): Promise<void> {
  const stats = page.getByTestId('source-card').filter({ hasText: name }).locator('dl:visible');
  const stat = stats.locator('div').filter({ has: page.locator('dt').filter({ hasText: label }) });
  await expect(stat.locator('dd')).toContainText(String(value));
}

/**
 * Adds a global XMLTV address in Settings > EPG and waits until the server
 * has parsed programmes from it.
 */
export async function addGlobalEpgUrl(page: Page, url: string): Promise<void> {
  await page.goto('/settings/epg');
  await page.getByTestId('epg-add-input').fill(url);
  await page.getByTestId('epg-add').click();
  await expect(page.getByTestId('epg-global-url').filter({ hasText: url })).toBeVisible();
  await expect
    .poll(async () => (await rpc<EpgSourceStatus[]>(page.request, 'epg.sources')).find((s) => s.url === url)?.programCount ?? 0, {
      timeout: 60_000,
      message: `guide ${url} parsed`,
    })
    .toBeGreaterThan(0);
}
