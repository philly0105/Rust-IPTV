import { removeAllSources, resetApp } from './helpers/api';
import { M3U_URL, MOCK_FACTS } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { channelButton, submitAndWaitForImport } from './helpers/ui';

// Home on a fresh install (SH-welcome-generic, src/shell/dashboard/Welcome.tsx): each source tile
// opens Add a source right on Home with its kind picked, and closing it leaves the user on Home
// (SH-cancel-returns). The first source added from there opens on its own channels (SS-6).

const NAME = 'Welcome M3U';

const TILES = [
  { kind: 'xtream', tab: 'Xtream Codes' },
  { kind: 'm3u', tab: 'M3U playlist' },
  { kind: 'stalker', tab: 'Stalker portal' },
] as const;

test.describe.serial('Home welcome', () => {
  test.beforeAll(async ({ request }) => {
    await resetApp(request);
  });

  test.afterAll(async ({ request }) => {
    await removeAllSources(request);
  });

  test('each tile opens Add a source on its kind, and closing it stays on Home', async ({ page }) => {
    await page.goto('/dashboard');
    const welcome = page.getByTestId('dashboard-welcome');
    await expect(welcome).toBeVisible();
    const dialog = page.getByRole('dialog', { name: 'Add a source' });
    for (const { kind, tab } of TILES) {
      const tile = welcome.getByTestId(`onboard-${kind}`);
      await tile.click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('tablist', { name: 'Source type' }).getByRole('tab', { selected: true })).toHaveAccessibleName(tab);
      // Nothing typed yet, so Cancel closes at once.
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId('discard-prompt')).toHaveCount(0);
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(tile).toBeFocused();
    }
  });

  test('an M3U playlist added from Home opens on its channels', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByTestId('dashboard-welcome').getByTestId('onboard-m3u').click();
    const dialog = page.getByRole('dialog', { name: 'Add a source' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'URL', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Playlist URL' }).fill(M3U_URL);
    await dialog.getByRole('textbox', { name: /^Name/ }).fill(NAME);
    const source = await submitAndWaitForImport(page, dialog, NAME);
    expect(source.channelCount).toBe(MOCK_FACTS.m3uChannels);

    await expect(page).toHaveURL(new RegExp(`/s/${source.id}/live$`));
    await expect(page.getByTestId('live-page')).toBeVisible();
    await expect(channelButton(page, 'BBC One')).toBeVisible();
    await expect(page.locator('[data-toast-id]').filter({ hasText: `Added ${NAME}` })).toBeVisible();
  });
});
