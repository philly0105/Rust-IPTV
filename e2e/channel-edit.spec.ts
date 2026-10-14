import type { APIRequestContext, Locator, Page } from '@playwright/test';

import type { ChannelEdit, Source } from '../src/api/types';
import { ensureSource, resetApp, rpc } from './helpers/api';
import { expect, test } from './helpers/fixtures';
import { channelButton, gotoLive } from './helpers/ui';

// Channel edits (C2): rename from the channel menu and with F2, reset to the
// provider's name, hide with Shift+Delete and Undo, and unhide from the
// Hidden channels dialog beside the group list.
//
// Relies on I-integration's wiring: the edit entries in the live context
// menu, ChannelEditDialogHost in the shell, useChannelEditShortcuts fed the
// focused row in LivePage, and a "Hidden channels" button in the group
// sidebar that opens HiddenChannelsDialog.

const XTREAM_NAME = 'Channel Edit Xtream';

const edits = (request: APIRequestContext, sourceId: string) => rpc<ChannelEdit[]>(request, 'channels.edits', { sourceId });

function toast(page: Page, text: string): Locator {
  return page.locator('[data-toast-id]').filter({ hasText: text });
}

async function menuItem(page: Page, channel: string, item: string): Promise<void> {
  await channelButton(page, channel).click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: item, exact: true }).click();
}

test.describe.serial('channel edits', () => {
  let xtream: Source;

  test.beforeAll(async ({ request }) => {
    await resetApp(request);
    xtream = await ensureSource(request, 'xtream', XTREAM_NAME);
    await rpc(request, 'channels.reset', { sourceId: xtream.id });
  });

  test.afterAll(async ({ request }) => {
    if (xtream) await rpc(request, 'channels.reset', { sourceId: xtream.id });
  });

  test('rename from the channel menu, then reset to the provider name', async ({ page }) => {
    await gotoLive(page, xtream.id);
    await menuItem(page, 'BBC One', 'Rename…');

    const dialog = page.getByTestId('channel-rename-dialog');
    await expect(dialog).toBeVisible();
    const input = dialog.getByTestId('channel-rename-input');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('BBC One');
    await expect(dialog.getByTestId('channel-rename-provider')).toContainText('BBC One');

    // Too long is flagged before anything is sent.
    await input.fill('x'.repeat(121));
    await expect(dialog).toContainText('Use at most 120 characters.');
    await input.fill('  Morning Desk  ');
    await page.getByTestId('channel-rename-save').click();
    await expect(dialog).toBeHidden();
    await expect(toast(page, 'Renamed to Morning Desk')).toBeVisible();
    await expect(channelButton(page, 'Morning Desk')).toBeVisible();
    await expect(channelButton(page, 'BBC One')).toHaveCount(0);
    expect((await edits(page.request, xtream.id)).find((e) => e.originalName === 'BBC One')?.name).toBe('Morning Desk');

    await menuItem(page, 'Morning Desk', 'Reset name');
    await expect(toast(page, 'Name reset to BBC One')).toBeVisible();
    await expect(channelButton(page, 'BBC One')).toBeVisible();
    await expect.poll(async () => (await edits(page.request, xtream.id)).length).toBe(0);
  });

  test('F2 renames the focused channel', async ({ page }) => {
    await gotoLive(page, xtream.id);
    await channelButton(page, 'BBC News').focus();
    await page.keyboard.press('F2');

    const dialog = page.getByTestId('channel-rename-dialog');
    await expect(dialog).toBeVisible();
    const input = dialog.getByTestId('channel-rename-input');
    await expect(input).toHaveValue('BBC News');
    await input.fill('Headlines');
    await input.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(channelButton(page, 'Headlines')).toBeVisible();

    // Undo from the toast puts the provider's name back.
    await toast(page, 'Renamed to Headlines').getByRole('button', { name: 'Undo' }).click();
    await expect(channelButton(page, 'BBC News')).toBeVisible();
  });

  test('Shift+Delete hides the focused channel, and Undo brings it back', async ({ page }) => {
    await gotoLive(page, xtream.id);
    await channelButton(page, 'BBC One').focus();
    await page.keyboard.press('Shift+Delete');

    const hidden = toast(page, 'BBC One hidden');
    await expect(hidden).toBeVisible();
    await expect(hidden).toContainText('Find it under Hidden channels.');
    await expect(channelButton(page, 'BBC One')).toHaveCount(0);

    await hidden.getByRole('button', { name: 'Undo' }).click();
    await expect(channelButton(page, 'BBC One')).toBeVisible();
    await expect.poll(async () => (await edits(page.request, xtream.id)).filter((e) => e.hidden).length).toBe(0);
  });

  test('the Hidden channels dialog lists and unhides', async ({ page }) => {
    await gotoLive(page, xtream.id);
    await menuItem(page, 'BBC One', 'Hide channel');
    await expect(toast(page, 'BBC One hidden')).toBeVisible();
    await expect(channelButton(page, 'BBC One')).toHaveCount(0);

    await page.getByRole('button', { name: /^Hidden channels/ }).click();
    const dialog = page.getByTestId('hidden-channels-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('hidden-channels-summary')).toHaveText('1 hidden channel');
    const row = dialog.getByTestId('hidden-channel-row').filter({ hasText: 'BBC One' });
    await expect(row).toBeVisible();

    await dialog.getByTestId('hidden-channels-filter').fill('nothing like it');
    await expect(dialog).toContainText('No hidden channel matches.');
    await dialog.getByTestId('hidden-channels-filter').fill('bbc');
    await row.getByRole('button', { name: 'Unhide BBC One' }).click();

    await expect(toast(page, 'BBC One is back')).toBeVisible();
    await expect(dialog).toContainText('No hidden channels');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    await expect(channelButton(page, 'BBC One')).toBeVisible();
  });
});
