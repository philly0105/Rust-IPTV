import { resetApp } from './helpers/api';
import { XTREAM } from './helpers/env';
import { expect, test } from './helpers/fixtures';
import { openAddSourceDialog, submitAndWaitForImport } from './helpers/ui';

// Subscription warnings: the mock's `expiring` Xtream user is a trial that
// expires 3 days from now with 1 of 2 connections in use (crates/iptv-mock,
// xtream.rs). The default 7-day warning window flags it on the dashboard and on
// its source card.

const NAME = 'Expiring Xtream';

test.describe.serial('account warnings', () => {
  test.beforeAll(async ({ request }) => {
    await resetApp(request);
  });

  test('an expiring subscription shows on its source card', async ({ page }) => {
    const dialog = await openAddSourceDialog(page);
    await dialog.getByRole('tab', { name: 'Xtream Codes' }).click();
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(NAME);
    await dialog.getByRole('textbox', { name: 'Server URL' }).fill(XTREAM.serverUrl);
    await dialog.getByRole('textbox', { name: 'Username', exact: true }).fill('expiring');
    await dialog.getByRole('textbox', { name: 'Password', exact: true }).fill(XTREAM.password);
    const source = await submitAndWaitForImport(page, dialog, NAME);
    expect(source.kind).toBe('xtream');

    const card = page.getByTestId('source-card').filter({ hasText: NAME });
    const badge = card.getByTestId('account-badge-expiring');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/^Expires /);
    await expect(card.getByTestId('account-badge-trial')).toBeVisible();
    await expect(card.getByTestId('account-badge-expired')).toHaveCount(0);
  });

  test('the dashboard warns before the subscription runs out', async ({ page }) => {
    await page.goto('/dashboard');
    const alerts = page.getByTestId('account-alerts');
    await expect(alerts).toBeVisible();
    const alert = alerts.getByTestId('account-alert').filter({ hasText: NAME });
    await expect(alert).toHaveCount(1);
    await expect(alert).toContainText(`${NAME} expires`);

    // "View subscription" opens the source's account details.
    await alert.getByTestId('account-alert-open').click();
    // The page drops `?account=` once the dialog opens, so assert the dialog, not the query.
    await expect(page).toHaveURL(/\/sources/);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab', { selected: true })).toHaveText(/account|subscription/i);
  });
});
